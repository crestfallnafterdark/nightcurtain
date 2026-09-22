/**
 * UI-local approximate token estimator (approx. 4 characters or 0.75 words per token).
 * Non-strings and blank strings estimate to 0; otherwise returns the larger of the
 * character-based and word-based approximations.
 *
 * @param text - Candidate text; non-strings and blanks estimate to 0.
 * @returns Estimated token count (always a finite, non-negative integer).
 */
export function estimateTokens(text: unknown): number {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(trimmed.length / 3.8), Math.ceil(words * 1.33));
}
