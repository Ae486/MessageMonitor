/**
 * Producer output validation per docs/architecture.md 7.3: summaryText must
 * be a string, findings must target configured dimensions only, and every
 * evidence id must belong to the frozen unit. Any violation fails THIS
 * attempt; retries reuse the same frozen boundary.
 */
import type { FindingInput } from "../storage/repositories/summary-units.ts";

export interface ValidatedSummary {
  summaryText: string;
  findings: FindingInput[];
}

export class SummaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryValidationError";
  }
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new SummaryValidationError("producer output is not valid JSON");
  }
}

export function validateSummaryOutput(
  content: string,
  dimensionKeys: readonly string[],
  unitMessageIds: ReadonlySet<number>,
): ValidatedSummary {
  const parsed = extractJson(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SummaryValidationError("producer output is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;

  const summaryText = record["summaryText"];
  if (typeof summaryText !== "string" || summaryText.trim() === "") {
    throw new SummaryValidationError("summaryText must be a non-empty string");
  }

  const rawFindings = record["findings"] ?? [];
  if (!Array.isArray(rawFindings)) {
    throw new SummaryValidationError("findings must be an array");
  }

  const known = new Set(dimensionKeys);
  const findings: FindingInput[] = [];
  for (const raw of rawFindings) {
    if (typeof raw !== "object" || raw === null) {
      throw new SummaryValidationError("finding entries must be objects");
    }
    const entry = raw as Record<string, unknown>;
    const dimension = entry["dimension"];
    if (typeof dimension !== "string" || !known.has(dimension)) {
      throw new SummaryValidationError(`unknown finding dimension: ${String(dimension)}`);
    }
    const text = entry["text"];
    if (typeof text !== "string" || text.trim() === "") {
      throw new SummaryValidationError("finding text must be a non-empty string");
    }
    const rawIds = entry["messageIds"];
    if (!Array.isArray(rawIds)) {
      throw new SummaryValidationError("finding messageIds must be an array");
    }
    const evidenceMessageIds: number[] = [];
    for (const id of rawIds) {
      const numeric = typeof id === "number" ? id : Number.parseInt(String(id), 10);
      if (!Number.isSafeInteger(numeric)) {
        throw new SummaryValidationError(`finding messageId is not an integer: ${String(id)}`);
      }
      if (!unitMessageIds.has(numeric)) {
        throw new SummaryValidationError(
          `finding references message ${String(numeric)} outside the frozen unit`,
        );
      }
      evidenceMessageIds.push(numeric);
    }
    findings.push({ dimensionKey: dimension, text: text.trim(), evidenceMessageIds });
  }

  return { summaryText: summaryText.trim(), findings };
}
