/**
 * qq_monitor_status assembly per docs/mcp-tools.md section 3: no probing, no
 * side effects — only last-known state. Issues carry owner-relayable
 * natural-language messages without secrets or absolute paths.
 */
import type { AppConfig } from "../config/schema.ts";
import type { Database } from "../storage/database.ts";
import type { Storage } from "../storage/index.ts";
import type { LifecycleController } from "../runtime/lifecycle-controller.ts";
import type { SummaryQueue } from "../summary/summary-queue.ts";

export interface ServiceHealth {
  storageDegraded: boolean;
  maintenanceFailed: boolean;
}

export interface StatusDeps {
  db: Database;
  storage: Storage;
  config: AppConfig;
  lifecycle: LifecycleController;
  summaryQueue: SummaryQueue;
  health: ServiceHealth;
}

interface Issue {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  since?: number;
  count?: number;
}

export function createStatusService(deps: StatusDeps) {
  // Trigger-maintained counters: the status tool must not scan the full
  // messages table (requirements 3.2).
  const tableCounter = deps.db.raw.prepare("SELECT count AS c FROM table_counters WHERE name = ?");
  const countFailedUnits = deps.db.raw.prepare(
    "SELECT COUNT(*) AS c FROM summary_units WHERE status = 'failed'",
  );
  const countQueuedUnits = deps.db.raw.prepare(
    "SELECT COUNT(*) AS c FROM summary_units WHERE status = 'queued'",
  );
  const countRunningUnits = deps.db.raw.prepare(
    "SELECT COUNT(*) AS c FROM summary_units WHERE status = 'running'",
  );
  const pendingFeedConversations = deps.db.raw.prepare(
    "SELECT COUNT(DISTINCT conversation_id) AS c FROM feed_events WHERE id > ?",
  );
  const unreadConversations = deps.db.raw.prepare(
    `SELECT COUNT(*) AS c FROM conversations c
     WHERE c.self_uin = ? AND EXISTS (
       SELECT 1 FROM messages m WHERE m.conversation_id = c.id
         AND m.id > COALESCE((
           SELECT crp.last_message_id FROM conversation_read_progress crp
           WHERE crp.consumer_id = ? AND crp.conversation_id = c.id
         ), 0)
     )`,
  );

  // First-seen timestamps back the pinned issues[].since field.
  const issueFirstSeen = new Map<string, number>();

  return {
    snapshot() {
      const lifecycle = deps.lifecycle.getStatus();
      const summary = deps.summaryQueue.getStatus();
      const runtime = deps.storage.runtimeState;
      const now = Date.now();

      const failedUnitCount = (countFailedUnits.get() as { c: number }).c;
      const unresolvedGapCount = deps.storage.captureGaps.unresolvedCount();
      const feedProgress = deps.storage.progress.getFeedProgress(deps.config.agent.consumerId);

      const issues: Issue[] = [];
      const addIssue = (issue: Omit<Issue, "since">): void => {
        let firstSeen = issueFirstSeen.get(issue.code);
        if (firstSeen === undefined) {
          firstSeen = now;
          issueFirstSeen.set(issue.code, now);
        }
        issues.push({ ...issue, since: firstSeen });
      };

      if (lifecycle.accountMismatch) {
        addIssue({
          code: "ACCOUNT_MISMATCH",
          severity: "error",
          message: `桥上登录的账号（${lifecycle.connectedSelfUin ?? "未知"}）不是配置的目标账号，消息采集已停用。请确认在 QQ 中登录的是目标账号。`,
        });
      }
      if (deps.config.summary.enabled && summary.producerState === "unavailable") {
        addIssue({
          code: "SUMMARY_PRODUCER_UNAVAILABLE",
          severity: "warning",
          message: "摘要模型当前不可用，摘要任务在排队等待，消息采集不受影响。请检查模型服务地址与密钥。",
        });
      }
      if (failedUnitCount > 0) {
        addIssue({
          code: "SUMMARY_GAP_CREATED",
          severity: "warning",
          message: `有 ${String(failedUnitCount)} 个消息批次在多次尝试后仍未能生成摘要，原始消息仍可读取。`,
          count: failedUnitCount,
        });
      }
      if (deps.health.storageDegraded) {
        addIssue({
          code: "STORAGE_DEGRADED",
          severity: "error",
          message: "本地数据库当前写入异常，采集与摘要已暂停，已有数据仍可读取。",
        });
      }
      if (deps.health.maintenanceFailed) {
        addIssue({
          code: "MAINTENANCE_FAILED",
          severity: "warning",
          message: "最近一次数据清理未能完成，不影响采集与读取，将在下个周期重试。",
        });
      }
      for (const code of issueFirstSeen.keys()) {
        if (!issues.some((issue) => issue.code === code)) issueFirstSeen.delete(code);
      }

      const healthState = issues.some((issue) => issue.severity !== "info") ? "degraded" : "healthy";
      const active = lifecycle.state === "active";

      return {
        // The transient in-process CONNECTING state maps to dormant for the
        // documented enum (architecture.md 4.1).
        lifecycleState: lifecycle.state === "connecting" ? "dormant" : lifecycle.state,
        healthState,
        readyForReads: !deps.health.storageDegraded,
        readyForCapture: active,
        account: {
          targetSelfUin: deps.config.account.targetSelfUin,
          connectedSelfUin: lifecycle.connectedSelfUin ?? null,
          verified: active,
        },
        bridge: {
          provider: deps.config.bridge.provider,
          connected: active,
          connectedAt: lifecycle.connectedAt ?? null,
          lastEventAt: lifecycle.lastEventAt ?? runtime.get<number>("lastEventAt") ?? null,
          nextReconnectAt: null,
        },
        capture: {
          monitoringBaseline: runtime.get<number>("monitoringBaseline") ?? null,
          lastMessageAt: deps.storage.messages.latestCheckpointAt() ?? null,
          monitoredGroupCount: deps.config.capture.groups.whitelist.length,
          friendMode: deps.config.capture.friends.mode,
          unresolvedGapCount,
        },
        storage: {
          available: !deps.health.storageDegraded,
          messageCount: (tableCounter.get("messages") as { c: number }).c,
          summaryUnitCount: (tableCounter.get("summary_units") as { c: number }).c,
          messageRetentionDays: deps.config.storage.messageRetentionDays,
          summaryRetentionDays: deps.config.storage.summaryRetentionDays,
          lastCleanupAt: runtime.get<number>("lastCleanupAt") ?? null,
        },
        summary: {
          enabled: deps.config.summary.enabled,
          producerState: summary.producerState,
          threshold: deps.config.summary.threshold,
          queuedTaskCount: (countQueuedUnits.get() as { c: number }).c,
          runningTaskCount: (countRunningUnits.get() as { c: number }).c,
          failedUnitCount,
          lastCompletedAt: summary.lastCompletedAt ?? null,
          schemaHash: summary.schemaHash,
        },
        agentProgress: {
          pendingFeedConversationCount: (pendingFeedConversations.get(feedProgress) as { c: number }).c,
          unreadConversationCount: (
            unreadConversations.get(deps.config.account.targetSelfUin, deps.config.agent.consumerId) as {
              c: number;
            }
          ).c,
        },
        issues,
        generatedAt: now,
      };
    },
  };
}

export type StatusService = ReturnType<typeof createStatusService>;
