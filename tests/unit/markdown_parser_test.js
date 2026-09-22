/**
 * @file tests/unit/markdown_parser_test.js
 * @description Unit tests for the sandbox markdown prose renderer
 * (`src/lib/components/sandbox/markdown/`).
 *
 * The renderer fails closed when DOMPurify is unavailable. Headless Node has
 * no DOM, so the default entry point returns escaped source text; the
 * documented test seam `__renderMarkdownProseWithPurifier` lets these tests
 * exercise the `marked` pipeline and the sanitizer configuration with a
 * recording purifier, without shipping test hooks in the public surface.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownProse } from '../../src/lib/components/sandbox/markdown/index.ts';
import { __renderMarkdownProseWithPurifier } from '../../src/lib/components/sandbox/markdown/render.ts';

/**
 * Records the HTML and configuration handed to the sanitizer.
 *
 * @returns {{ calls: Array<{ dirtyHtml: string, config: object }>, sanitize: (dirtyHtml: string, config: object) => string }}
 */
function createRecordingPurifier() {
  const calls = [];
  return {
    calls,
    sanitize(dirtyHtml, config) {
      calls.push({ dirtyHtml, config });
      return dirtyHtml;
    }
  };
}

/**
 * Renders markdown through the recording purifier.
 *
 * @param {string} markdown - Markdown source.
 * @returns {{ html: string, purifier: ReturnType<typeof createRecordingPurifier> }}
 */
function renderThroughPurifier(markdown) {
  const purifier = createRecordingPurifier();
  const html = __renderMarkdownProseWithPurifier(markdown, purifier);
  return { html, purifier };
}

test('renderMarkdownProse renders inline formatting through the sanitizer', () => {
  const { html, purifier } = renderThroughPurifier('**Bold text** and *italic text*');
  assert.ok(html.includes('<strong>Bold text</strong>'));
  assert.ok(html.includes('<em>italic text</em>'));
  assert.strictEqual(purifier.calls.length, 1, 'sanitizer is called exactly once per render');
  assert.ok(purifier.calls[0].dirtyHtml.includes('<strong>'), 'purifier receives marked HTML');
});

test('renderMarkdownProse renders headings and lists', () => {
  const { html } = renderThroughPurifier(
    '# Heading\n\n## Subheading\n\n- item one\n- item two\n\n1. first\n2. second'
  );
  assert.ok(html.includes('<h1>Heading</h1>'));
  assert.ok(html.includes('<h2>Subheading</h2>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>item one</li>'));
  assert.ok(html.includes('<li>item two</li>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>first</li>'));
});

test('renderMarkdownProse renders fenced code blocks and inline code', () => {
  const { html } = renderThroughPurifier('Inline `code` here.\n\n```js\nconst x = 1;\n```');
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<pre>'));
  assert.ok(html.includes('language-js'));
  assert.ok(html.includes('const x = 1;'));
});

test('renderMarkdownProse renders links with their href and title', () => {
  const { html } = renderThroughPurifier('[Example](https://example.com "Site")');
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(html.includes('title="Site"'));
  assert.ok(html.includes('>Example</a>'));
});

test('renderMarkdownProse renders GFM tables', () => {
  const { html } = renderThroughPurifier('| Name | Value |\n| :--- | ---: |\n| alpha | 1 |');
  for (const tag of ['<table>', '<thead>', '<tbody>', '<tr>', '<th', '<td']) {
    assert.ok(html.includes(tag), `expected rendered output to contain ${tag}`);
  }
  assert.ok(html.includes('alpha'));
});

test('renderMarkdownProse passes DOMPurify an explicit conservative allowlist', () => {
  const { purifier } = renderThroughPurifier('plain prose');
  const config = purifier.calls[0].config;

  for (const tag of [
    'p', 'strong', 'em', 'h1', 'code', 'pre', 'ul', 'ol', 'li',
    'blockquote', 'a', 'br', 'hr', 'table', 'th', 'td', 'tr'
  ]) {
    assert.ok(config.ALLOWED_TAGS.includes(tag), `allowlist should include <${tag}>`);
  }
  for (const tag of [
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
    'img', 'svg', 'math', 'template'
  ]) {
    assert.ok(!config.ALLOWED_TAGS.includes(tag), `allowlist must exclude <${tag}>`);
  }

  assert.ok(config.ALLOWED_ATTR.includes('href'));
  assert.ok(config.ALLOWED_ATTR.includes('title'));
  for (const attr of [
    'onerror', 'onload', 'onclick', 'style', 'src', 'srcset', 'formaction', 'xlink:href'
  ]) {
    assert.ok(!config.ALLOWED_ATTR.includes(attr), `attribute allowlist must exclude ${attr}`);
  }

  assert.strictEqual(config.ALLOW_DATA_ATTR, false);
  assert.strictEqual(config.ALLOW_ARIA_ATTR, false);
  assert.strictEqual(config.ALLOW_UNKNOWN_PROTOCOLS, false);
  assert.strictEqual(
    config.ALLOWED_URI_REGEXP,
    undefined,
    'DOMPurify default URI policy must stay in force'
  );
});

test('fail-closed rendering escapes script tags (XSS safety)', () => {
  const html = __renderMarkdownProseWithPurifier('<script>alert(1)</script>', null);
  assert.ok(!html.includes('<'), 'no raw HTML may survive fail-closed rendering');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('fail-closed rendering escapes inline event handlers (XSS safety)', () => {
  const html = __renderMarkdownProseWithPurifier('<img src=x onerror="alert(1)">', null);
  assert.ok(!html.includes('<'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('fail-closed rendering neutralizes javascript: links (XSS safety)', () => {
  const html = __renderMarkdownProseWithPurifier('[click](javascript:alert(1))', null);
  assert.ok(!html.includes('<'));
  assert.ok(!/<a[\s>]/i.test(html), 'no anchor element may be produced');
});

test('fail-closed rendering neutralizes data: URIs (XSS safety)', () => {
  const html = __renderMarkdownProseWithPurifier(
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    null
  );
  assert.ok(!html.includes('<'));
  assert.ok(!/<a[\s>]/i.test(html), 'no anchor element may be produced');
});

test('fail-closed rendering escapes raw HTML (XSS safety)', () => {
  const vectors = [
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload="alert(1)"></svg>',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<a href="javascript:alert(1)">raw</a>',
    '<form action="javascript:alert(1)"><input autofocus></form>'
  ];
  for (const vector of vectors) {
    const html = __renderMarkdownProseWithPurifier(vector, null);
    assert.ok(!html.includes('<'), `raw HTML survived fail-closed rendering: ${html}`);
  }
});

test('fail-closed rendering escapes angle brackets and quotes', () => {
  assert.strictEqual(
    __renderMarkdownProseWithPurifier('Tom & "Jerry" <b>', null),
    'Tom &amp; &quot;Jerry&quot; &lt;b&gt;'
  );
  const html = renderMarkdownProse('Use < and > safely');
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('&gt;'));
  assert.ok(!html.includes('<'));
});

test('renderMarkdownProse fails closed through the headless default path', () => {
  // Headless Node exposes no DOM, so DOMPurify reports isSupported === false.
  const html = renderMarkdownProse('<script>alert(1)</script>');
  assert.ok(!html.includes('<'), 'default path must not emit raw HTML without a DOM');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdownProse returns empty string for empty or non-string input', () => {
  assert.strictEqual(renderMarkdownProse(''), '');
  assert.strictEqual(renderMarkdownProse('   '), '');
  assert.strictEqual(renderMarkdownProse(null), '');
  assert.strictEqual(renderMarkdownProse(undefined), '');
  assert.strictEqual(renderMarkdownProse(42), '');

  const purifier = createRecordingPurifier();
  assert.strictEqual(__renderMarkdownProseWithPurifier('', purifier), '');
  assert.strictEqual(__renderMarkdownProseWithPurifier(null, purifier), '');
  assert.strictEqual(purifier.calls.length, 0, 'sanitizer is not invoked for empty input');
});
