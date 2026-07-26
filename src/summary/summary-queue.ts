/**
 * Background summarization scheduler: threshold-triggered, budget-bounded
 * freeze, strict per-conversation serialization, bounded global concurrency,
 * retry-with-backoff into Summary Gap (docs/requirements.md 2.7, ADR-0003).
 */
import { createHash } from "node:crypto";
import type { Logger } from "../logging/logger.ts";
import type { SummaryConfig } from "../config/schema.ts";
import type { SummaryUnitsRepo, FrozenUnit } from "../storage/repositories/summary-units.ts";
import { buildPrompt, type DimensionSpec } from "./prompt-builder.ts";
import { ProducerError, type SummaryProducer } from "./summary-producer.ts";
import { SummaryValidationError, validateSummaryOutput } from "./summary-validator.ts";

export type ProducerState = "disabled" | "unknown" | "available" | "unavailable";

export interface SummaryQueueStatus {
  producerState: ProducerState;
  queuedTaskCount: number;
  runningTaskCount: number;
  lastCompletedAt?: number;
  schemaHash: string;
}

export interface SummaryQueue {
  /** Ingest hook: re-evaluates one conversation's threshold. */
  poke(conversationId: number): void;
  /** Boot hook: recovers interrupted units and re-evaluates all summary conversations. */
  recover(): void;
  getStatus(): SummaryQueueStatus;
  close(): Promise<void>;
}

interface QueueDeps {
  units: SummaryUnitsRepo;
  producer: SummaryProducer;
  log: Logger;
  now?(): number;
  /** Test hook: overrides retry backoff delay. */
  retryDelayMs?(attempt: number): number;
}

export function computeSchemaHash(dimensions: Record<string, { description: string }>): string {
  const canonical = JSON.stringify(
    Object.keys(dimensions)
      .sort()
      .map((key) => [key, dimensions[key]?.description.trim()]),
  );
  return `sumcfg_${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
}

const PROMPT_OVERHEAD_TOKENS = 800;

export function createSummaryQueue(config: SummaryConfig, deps: QueueDeps): SummaryQueue {
  const log = deps.log.child({ component: "summary" });
  const now = deps.now ?? Date.now;
  const dimensions: DimensionSpec[] = Object.entries(config.dimensions).map(
    ([key, value]) => ({ key, description: value.description }),
  );
  const dimensionKeys = dimensions.map((dimension) => dimension.key);
  const schemaHash = computeSchemaHash(config.dimensions);
  const schemaSnapshotJson = JSON.stringify({
    dimensions: config.dimensions,
    additionalPrompt: config.additionalPrompt,
  });
  const retryDelayMs =
    deps.retryDelayMs ?? ((attempt: number) => config.retryBaseDelayMs * 2 ** (attempt - 1));

  let producerState: ProducerState = config.enabled ? "unknown" : "disabled";
  let lastCompletedAt: number | undefined;
  let closed = false;
  let runningCount = 0;
  const activeConversations = new Set<number>();
  const pendingConversations: number[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const enqueue = (conversationId: number): void => {
    if (closed || !config.enabled) return;
    if (activeConversations.has(conversationId)) return;
    if (pendingConversations.includes(conversationId)) return;
    pendingConversations.push(conversationId);
    drain();
  };

  const drain = (): void => {
    while (!closed && runningCount < config.maxConcurrentTasks) {
      const conversationId = pendingConversations.shift();
      if (conversationId === undefined) return;
      if (activeConversations.has(conversationId)) continue;
      activeConversations.add(conversationId);
      runningCount += 1;
      void runConversation(conversationId)
        .catch((error: unknown) => {
          // Storage-layer failures must degrade the summary subsystem, never
          // kill the process (docs/architecture.md section 10).
          const reason = error instanceof Error ? error.message : String(error);
          log.error({ conversationId, err: reason }, "summary task crashed; conversation requeued");
          producerState = "unavailable";
          try {
            deps.units.requeueConversation(conversationId);
          } catch {
            // storage still failing; boot recovery will requeue
          }
        })
        .finally(() => {
          runningCount -= 1;
          activeConversations.delete(conversationId);
          drain();
        });
    }
  };

  const shouldFreeze = (conversationId: number): boolean =>
    deps.units.unsummarizedCount(conversationId) >= config.threshold &&
    !deps.units.hasPendingUnit(conversationId);

  async function runConversation(conversationId: number): Promise<void> {
    // Serial per conversation: keep draining units until neither a queued
    // unit nor a threshold-crossing backlog remains (backlog batching).
    for (;;) {
      if (closed) return;
      const unit =
        deps.units.loadQueued(conversationId) ??
        deps.units.freeze({
          conversationId,
          schemaHash,
          schemaSnapshotJson,
          tokenBudget: Math.max(1000, config.maxInputTokensPerCall - PROMPT_OVERHEAD_TOKENS),
          now: now(),
        });
      if (unit === undefined) return;
      const finished = await runUnit(unit);
      if (!finished) return;
      if (!shouldFreeze(conversationId)) return;
    }
  }

  /** Returns true when the unit reached a terminal state (completed or failed). */
  async function runUnit(unit: FrozenUnit): Promise<boolean> {
    const unitMessageIds = new Set(unit.messages.map((message) => message.id));
    const prompt = buildPrompt({
      additionalPrompt: config.additionalPrompt,
      dimensions,
      ...(unit.precedingSummaryText !== undefined
        ? { precedingSummaryText: unit.precedingSummaryText }
        : {}),
      messages: unit.messages,
      maxProjectionChars: config.maxInputTokensPerCall,
    });

    for (;;) {
      if (closed) {
        deps.units.requeue(unit.unitId);
        return false;
      }
      deps.units.markRunning(unit.unitId, now());
      let errorCode: string;
      let errorMessage: string;
      try {
        const content = await deps.producer.produce(prompt);
        const validated = validateSummaryOutput(content, dimensionKeys, unitMessageIds);
        deps.units.complete({
          unitId: unit.unitId,
          summaryText: validated.summaryText,
          findings: validated.findings,
          now: now(),
        });
        producerState = "available";
        lastCompletedAt = now();
        log.info(
          { unitId: unit.unitId, findings: validated.findings.length },
          "summary unit completed",
        );
        return true;
      } catch (error) {
        if (error instanceof ProducerError) {
          errorCode = error.code;
          errorMessage = error.message;
          // Any producer failure (including non-retryable 401/403) means the
          // producer is not usable as configured.
          producerState = "unavailable";
        } else if (error instanceof SummaryValidationError) {
          errorCode = "OUTPUT_INVALID";
          errorMessage = error.message;
        } else {
          errorCode = "INTERNAL";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      }

      const attempt = deps.units.recordFailure(unit.unitId, errorCode, errorMessage);
      log.warn(
        { unitId: unit.unitId, attempt, errorCode },
        "summary attempt failed",
      );
      if (attempt > config.maxRetries) {
        deps.units.markFailed(unit.unitId, now());
        log.warn({ unitId: unit.unitId }, "summary unit failed permanently (summary gap)");
        return true;
      }
      deps.units.requeue(unit.unitId);
      const waited = await delay(retryDelayMs(attempt));
      if (!waited) return false;
    }
  }

  function delay(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve(!closed);
      }, ms);
      timers.add(timer);
    });
  }

  return {
    poke(conversationId) {
      if (!config.enabled) return;
      if (shouldFreeze(conversationId)) enqueue(conversationId);
    },
    recover() {
      if (!config.enabled) return;
      const recovered = deps.units.recoverInterrupted();
      if (recovered > 0) log.info({ recovered }, "recovered interrupted summary units");
      for (const conversationId of deps.units.listQueuedConversationIds()) {
        enqueue(conversationId);
      }
      for (const conversationId of deps.units.summaryEnabledConversationIds()) {
        if (shouldFreeze(conversationId)) enqueue(conversationId);
      }
    },
    getStatus() {
      return {
        producerState,
        queuedTaskCount: pendingConversations.length,
        runningTaskCount: runningCount,
        ...(lastCompletedAt !== undefined ? { lastCompletedAt } : {}),
        schemaHash,
      };
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return Promise.resolve();
    },
  };
}
