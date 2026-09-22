/**
 * @file tests/e2e/helpers.js
 * E2E Test Helpers & Auditor for Sandbox Studio
 */

/**
 * Attaches console error and pageerror auditors to the page.
 * @param {import('@playwright/test').Page} page
 */
export function attachAuditor(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const consoleLogs = [];

  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    consoleLogs.push({ type, text, location: msg.location() });
    if (type === 'error') {
      consoleErrors.push({ text, location: msg.location() });
    }
  });

  page.on('pageerror', err => {
    pageErrors.push({
      message: err.message,
      name: err.name,
      stack: err.stack
    });
  });

  page.on('requestfailed', req => {
    failedRequests.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText
    });
  });

  page.on('response', resp => {
    const status = resp.status();
    const url = resp.url();
    // Exclude deliberate test mock 404s or favicons
    if (status >= 400 && !url.includes('favicon') && !url.includes('chrome-extension')) {
      failedRequests.push({
        url,
        status,
        statusText: resp.statusText()
      });
    }
  });

  return {
    get consoleErrors() { return [...consoleErrors]; },
    get pageErrors() { return [...pageErrors]; },
    get failedRequests() { return [...failedRequests]; },
    get consoleLogs() { return [...consoleLogs]; },
    clear() {
      consoleErrors.length = 0;
      pageErrors.length = 0;
      failedRequests.length = 0;
      consoleLogs.length = 0;
    }
  };
}

/**
 * Navigates to /sandbox and waits for the Sandbox Studio root to mount.
 * @param {import('@playwright/test').Page} page
 */
export async function gotoSandbox(page) {
  await page.goto('/sandbox');
  await page.waitForSelector('.sandbox-studio-root', { state: 'visible', timeout: 15000 });
}

/**
 * Sets up a deterministic mock LLM SSE streaming route on the page.
 *
 * With `toolCallsOnce: true`, the page answers only the first completion with
 * tool calls (no prose), then every subsequent completion with reasoning +
 * prose. The sandbox turn engine loops on tool calls until the model stops
 * emitting them, so this option lets a mocked tool turn conclude instead of
 * re-issuing the same tool call forever.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} [options]
 * @param {string} [options.prose]
 * @param {string} [options.reasoning]
 * @param {Array<Object>} [options.toolCalls]
 * @param {number} [options.delayMs=20]
 * @param {boolean} [options.toolCallsOnce=false] Emit `toolCalls` only on the first completion; later completions stream prose only.
 */
export async function setupMockLLM(page, {
  prose = 'I have received your directive and executed the necessary operations.',
  reasoning = 'Analyzing directive requirements and verifying filesystem state...',
  toolCalls = null,
  delayMs = 15,
  toolCallsOnce = false
} = {}) {
  let requestCount = 0;

  await page.route('**/chat/completions**', async (route) => {
    requestCount += 1;

    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    const emitToolCalls = hasToolCalls && (!toolCallsOnce || requestCount === 1);
    const emitProse = Boolean(prose) && (!toolCallsOnce || requestCount > 1);

    const sseChunks = [];

    // 1. Thinking / Reasoning chunk
    if (reasoning) {
      sseChunks.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock-reasoning',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-v4-flash',
          choices: [{
            index: 0,
            delta: { reasoning_content: reasoning },
            finish_reason: null
          }]
        })}\n\n`
      );
    }

    // 2. Tool Calls chunk
    if (emitToolCalls) {
      sseChunks.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock-tools',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-v4-flash',
          choices: [{
            index: 0,
            delta: { tool_calls: toolCalls },
            finish_reason: null
          }]
        })}\n\n`
      );
    }

    // 3. Prose tokens chunk
    if (emitProse) {
      sseChunks.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mock-prose',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-v4-flash',
          choices: [{
            index: 0,
            delta: { content: prose },
            finish_reason: null
          }]
        })}\n\n`
      );
    }

    // 4. Finish chunk
    sseChunks.push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-mock-finish',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      })}\n\n`
    );

    sseChunks.push('data: [DONE]\n\n');

    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      headers: {
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      },
      body: sseChunks.join('')
    });
  });
}
