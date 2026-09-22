/**
 * @file Public surface of the sandbox markdown rendering module.
 *
 * Consumers import `renderMarkdownProse` from this folder; the implementation,
 * sanitizer allowlist and fail-closed behavior live in `./render.ts`.
 */

/**
 * Safely renders markdown prose to sanitized HTML.
 *
 * Uses GFM `marked` for rendering and DOMPurify with a conservative allowlist
 * for sanitization. When DOMPurify is unavailable (headless/no-DOM), the
 * source text is returned fully HTML-escaped instead of unsanitized markup.
 *
 * @param markdownText - Untrusted markdown source (typically LLM output).
 * @returns Sanitized HTML; fully HTML-escaped plain text when sanitization is
 *   unavailable; `''` for empty or non-string input.
 */
export { renderMarkdownProse } from './render.ts';
