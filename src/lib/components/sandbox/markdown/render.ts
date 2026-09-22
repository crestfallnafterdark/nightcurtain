/**
 * @file Markdown prose renderer for untrusted LLM output.
 *
 * Pipeline: a single module-level `marked` instance (GFM, synchronous) renders
 * markdown to HTML, then DOMPurify sanitizes that HTML with the conservative
 * allowlist defined below. Rendering is synchronous by contract; the
 * `async: false` parse option pins the string overload of `marked.parse` and
 * removes the library's `string | Promise<string>` union.
 *
 * Fail-closed guarantee: without a DOM (headless Node) DOMPurify exposes
 * `isSupported === false` and no `sanitize`; its own `sanitize` would silently
 * return unsanitized input in that state. This module detects that case and
 * instead returns the source text fully HTML-escaped. Raw `marked` output is
 * never returned without passing through the sanitizer.
 */

import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Elements permitted in rendered chat prose. Deliberately excludes executable
 * or embedding surfaces (`script`, `style`, `iframe`, `object`, `embed`,
 * `form`, `input`, `img`, `svg`, `math`, ...).
 */
const ALLOWED_TAGS: string[] = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
];

/**
 * Attributes permitted in rendered chat prose. Excludes every `on*` handler,
 * `style`, `src` and other active-content attributes.
 */
const ALLOWED_ATTR: string[] = ['align', 'class', 'href', 'start', 'title'];

/** DOMPurify options pinned by this renderer. */
export interface MarkdownSanitizeConfig {
  ALLOWED_TAGS: string[];
  ALLOWED_ATTR: string[];
  ALLOW_ARIA_ATTR: boolean;
  ALLOW_DATA_ATTR: boolean;
  ALLOW_UNKNOWN_PROTOCOLS: boolean;
}

/**
 * Conservative DOMPurify configuration applied to every call.
 * `ALLOWED_URI_REGEXP` is intentionally omitted so DOMPurify's default URI
 * policy stays in force, neutralizing `javascript:` and `data:` URLs.
 */
const SANITIZE_CONFIG: MarkdownSanitizeConfig = Object.freeze({
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false
});

/** Sanitizer contract used by the renderer and its test seam. */
export interface MarkdownPurifier {
  sanitize(dirtyHtml: string, config: MarkdownSanitizeConfig): string;
}

/** Single shared `marked` instance; GFM matches the module's prior behavior. */
const markdown = new Marked({ gfm: true, async: false });

/** Hoisted options that pin the synchronous `marked.parse` overload. */
const SYNC_PARSE_OPTIONS = { async: false } as const;

/**
 * Escapes every HTML-significant character in a string.
 *
 * @param text - Text to escape.
 * @returns Text safe to insert into an HTML document as character data.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolves the DOMPurify sanitizer for the current environment.
 *
 * DOMPurify without a DOM (headless Node) exposes `isSupported === false` and
 * no `sanitize`, and its `sanitize` silently returns unsanitized input in that
 * state; resolution is therefore explicit here rather than delegated.
 *
 * @returns A DOMPurify-backed sanitizer, or `null` when unavailable.
 */
function resolvePurifier(): MarkdownPurifier | null {
  if (DOMPurify.isSupported === false) return null;
  if (typeof DOMPurify.sanitize !== 'function') return null;
  return {
    sanitize: (dirtyHtml, config) => DOMPurify.sanitize(dirtyHtml, config)
  };
}

/**
 * Internal test seam: renders with an explicit purifier or fails closed with
 * `null`, independent of the current environment. Not re-exported from
 * `./index.ts`; application code must call `renderMarkdownProse`.
 *
 * @param markdownText - Untrusted markdown source.
 * @param purifier - Sanitizer to apply, or `null` to fail closed.
 * @returns Sanitized HTML or fully HTML-escaped plain text.
 */
export function __renderMarkdownProseWithPurifier(
  markdownText: unknown,
  purifier: MarkdownPurifier | null
): string {
  if (typeof markdownText !== 'string' || markdownText.trim() === '') return '';

  if (purifier === null) return escapeHtml(markdownText);

  let rawHtml: string;
  try {
    rawHtml = markdown.parse(markdownText, SYNC_PARSE_OPTIONS);
  } catch (error) {
    console.error('Markdown parsing error:', error);
    return escapeHtml(markdownText);
  }

  if (typeof rawHtml !== 'string') return escapeHtml(markdownText);

  try {
    return purifier.sanitize(rawHtml, SANITIZE_CONFIG);
  } catch (error) {
    console.error('Markdown sanitization error:', error);
    return escapeHtml(markdownText);
  }
}

/**
 * Safely renders markdown prose to sanitized HTML.
 *
 * @param markdownText - Untrusted markdown source (typically LLM output).
 * @returns Sanitized HTML; fully HTML-escaped plain text when sanitization is
 *   unavailable; `''` for empty or non-string input.
 */
export function renderMarkdownProse(markdownText: unknown): string {
  return __renderMarkdownProseWithPurifier(markdownText, resolvePurifier());
}
