import type { Database } from "./database.ts";
import { createCaptureGapsRepo, type CaptureGapsRepo } from "./repositories/capture-gaps.ts";
import { createConversationsRepo, type ConversationsRepo } from "./repositories/conversations.ts";
import { createMessagesRepo, type MessagesRepo } from "./repositories/messages.ts";
import { createProgressRepo, type ProgressRepo } from "./repositories/progress.ts";
import { createRuntimeStateRepo, type RuntimeStateRepo } from "./repositories/runtime-state.ts";
import { createSummaryUnitsRepo, type SummaryUnitsRepo } from "./repositories/summary-units.ts";

export interface Storage {
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  captureGaps: CaptureGapsRepo;
  progress: ProgressRepo;
  runtimeState: RuntimeStateRepo;
  summaryUnits: SummaryUnitsRepo;
}

export function createStorage(db: Database): Storage {
  const conversations = createConversationsRepo(db);
  return {
    conversations,
    messages: createMessagesRepo(db, conversations),
    captureGaps: createCaptureGapsRepo(db),
    progress: createProgressRepo(db),
    runtimeState: createRuntimeStateRepo(db),
    summaryUnits: createSummaryUnitsRepo(db),
  };
}
