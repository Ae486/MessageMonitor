/**
 * OpenAI-compatible chat-completions producer. The API key is read from the
 * environment at call time and never logged; requests are bounded by an
 * AbortSignal timeout so a hung provider cannot pin the queue.
 */
import type { BuiltPrompt } from "./prompt-builder.ts";

export interface ProducerOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  requestTimeoutMs: number;
}

export interface SummaryProducer {
  produce(prompt: BuiltPrompt): Promise<string>;
}

export class ProducerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ProducerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function createOpenAiCompatibleProducer(options: ProducerOptions): SummaryProducer {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async produce(prompt) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey !== undefined
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: options.model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(options.requestTimeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === "TimeoutError";
        throw new ProducerError(
          timedOut ? "PRODUCER_TIMEOUT" : "PRODUCER_UNREACHABLE",
          timedOut ? "summary producer request timed out" : "summary producer is unreachable",
          true,
        );
      }

      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        throw new ProducerError(
          `PRODUCER_HTTP_${String(response.status)}`,
          `summary producer returned HTTP ${String(response.status)}`,
          retryable,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProducerError("PRODUCER_BAD_RESPONSE", "producer response is not JSON", true);
      }

      const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
        ?.message?.content;
      if (typeof content !== "string" || content === "") {
        throw new ProducerError(
          "PRODUCER_EMPTY_CONTENT",
          "producer response has no message content",
          true,
        );
      }
      return content;
    },
  };
}
