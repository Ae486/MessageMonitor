import type { SummaryConfig } from "../../../src/config/schema.ts";
import type { BuiltPrompt } from "../../../src/summary/prompt-builder.ts";
import type { SummaryProducer } from "../../../src/summary/summary-producer.ts";
import { groupConversation, incomingMessage, type TestDb } from "../storage/helpers.ts";

export function summaryConfig(overrides: Partial<SummaryConfig> = {}): SummaryConfig {
  return {
    enabled: true,
    groupWhitelist: ["123456789"],
    threshold: 3,
    maxConcurrentTasks: 1,
    maxInputTokensPerCall: 12000,
    maxRetries: 2,
    retryBaseDelayMs: 1000,
    requestTimeoutMs: 5000,
    additionalPrompt: "",
    producer: { type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" },
    dimensions: {
      keyPoints: { description: "值得注意的关键事实" },
      conflicts: { description: "明确出现的分歧" },
    },
    ...overrides,
  };
}

/** Scripted producer: each call shifts the next behavior; records prompts. */
export interface FakeProducer extends SummaryProducer {
  prompts: BuiltPrompt[];
  script: (
    | { kind: "ok"; content: (prompt: BuiltPrompt) => string; gate?: Promise<void> }
    | { kind: "error"; error: Error }
  )[];
}

export function fakeProducer(): FakeProducer {
  const producer: FakeProducer = {
    prompts: [],
    script: [],
    async produce(prompt) {
      producer.prompts.push(prompt);
      const step = producer.script.shift();
      if (step === undefined) throw new Error("fake producer script exhausted");
      if (step.kind === "error") throw step.error;
      if (step.gate !== undefined) await step.gate;
      return step.content(prompt);
    },
  };
  return producer;
}

export function okContent(summaryText: string, findings: unknown[] = []): (p: BuiltPrompt) => string {
  return () => JSON.stringify({ summaryText, findings });
}

export function ingestBatch(t: TestDb, count: number, startId = 1, summaryEnabled = true): number {
  let conversationId = 0;
  for (let index = 0; index < count; index += 1) {
    const id = startId + index;
    const result = t.storage.messages.ingest(
      { ...groupConversation(), summaryEnabled },
      incomingMessage({
        sourceMessageId: `msg-${String(id)}`,
        sourceTimestamp: 1_700_000_000_000 + id * 1000,
        projection: `消息内容${String(id)}`,
      }),
      1_700_000_000_000 + id * 1000,
    );
    conversationId = result.conversationId;
  }
  return conversationId;
}

export function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}
