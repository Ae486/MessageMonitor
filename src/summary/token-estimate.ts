/**
 * Deliberately conservative token estimator for freeze budgeting: CJK counts
 * one token per character, everything else four characters per token. Real
 * tokenizers vary per model; overestimating keeps frozen units inside
 * maxInputTokensPerCall without knowing the provider's tokenizer.
 */
const CJK_PATTERN = /[　-鿿豈-﫿＀-￯]/gu;

export function estimateTokens(text: string): number {
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const otherCount = text.length - cjkCount;
  return cjkCount + Math.ceil(otherCount / 4);
}
