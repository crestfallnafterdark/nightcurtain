import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox, setupMockLLM } from './helpers.js';

test.describe('04: Turn Execution & Chat Log Rendering', () => {
  test('executes a chat turn with reasoning, tool calls, and markdown response, verifying all bubble elements and tool badges', async ({ page }) => {
    const auditor = attachAuditor(page);

    // Setup mock LLM: the first completion dispatches the tool call (no prose),
    // the follow-up completion streams the markdown response so the tool loop
    // concludes the turn deterministically.
    await setupMockLLM(page, {
      reasoning: 'I need to check the filesystem status and write an initial report to the global workspace.',
      toolCalls: [
        {
          id: 'call_fs_write_001',
          type: 'function',
          function: {
            name: 'fs_writeFile',
            arguments: JSON.stringify({
              workspaceId: 'global',
              path: '/system_init.json',
              content: '{\n  "status": "online",\n  "version": "3.0"\n}'
            })
          }
        }
      ],
      toolCallsOnce: true,
      prose: '### System Analysis Complete\n\nI have initialized the workspace and created `/system_init.json`.\n\n* **Status**: Operational\n* **Workspace**: Global'
    });

    await gotoSandbox(page);

    // Switch to Chat Studio tab
    await page.locator('.tab-btn:has-text("Chat Studio")').click();

    // Select Director
    await page.locator('.agent-card:has-text("Director")').click();

    // Verify Chat Log Header
    await expect(page.locator('.agent-chronicle-header .agent-title')).toHaveText('Director');
    await expect(page.locator('.agent-chronicle-header .agent-id-pill')).toHaveText('director');

    // Type prompt into action input
    const textarea = page.locator('.action-textarea');
    await textarea.fill('Initialize the system and report status.');

    // Click Send
    const sendBtn = page.locator('.btn-submit-action');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // 1. Verify User Message Card
    const userTurn = page.locator('.turn-user').first();
    await expect(userTurn).toBeVisible();
    await expect(userTurn.locator('.action-prefix-label')).toContainText('User Directive');
    await expect(userTurn.locator('.book-blockquote')).toContainText('Initialize the system and report status.');

    // 2. Verify the tool-call assistant turn (first completion)
    const assistantTurns = page.locator('.turn-assistant');
    const toolTurn = assistantTurns.first();
    await expect(toolTurn).toBeVisible({ timeout: 15000 });

    // 3. Verify Collapsible Thought Process Accordion
    const thinkingContainer = toolTurn.locator('.thinking-container');
    await expect(thinkingContainer).toBeVisible();
    await expect(thinkingContainer.locator('.thinking-title')).toContainText('Thought Process');
    // Expand thought process
    await thinkingContainer.locator('.thinking-header').click();
    await expect(thinkingContainer.locator('.thinking-prose-stream')).toContainText('I need to check the filesystem status');

    // 4. Verify Tool Invocation Badge
    const toolBadge = toolTurn.locator('.inline-tool-badge').first();
    await expect(toolBadge).toBeVisible();
    await expect(toolBadge.locator('.tool-name')).toHaveText('fs_writeFile');
    // Toggle arguments
    await toolBadge.locator('.tool-badge-header').click();
    await expect(toolBadge.locator('.tool-badge-body')).toBeVisible();
    await expect(toolBadge.locator('.tool-args-pre')).toContainText('/system_init.json');

    // 5. Verify the tool result receipt card
    const toolResult = page.locator('.tool-result-card').first();
    await expect(toolResult).toBeVisible();
    await expect(toolResult.locator('.tool-concise-summary')).toContainText('/system_init.json');

    // 6. Verify the follow-up assistant turn renders the Markdown prose (turn concludes)
    await expect(assistantTurns).toHaveCount(2);
    const finalTurn = assistantTurns.last();
    const prose = finalTurn.locator('.turn-narrative-prose');
    await expect(prose).toBeVisible();
    await expect(prose.locator('h3')).toHaveText('System Analysis Complete');
    await expect(prose.locator('strong:has-text("Status")')).toBeVisible();

    // 7. Test Inline Message Editing (Hover to reveal micro-toolbar)
    await userTurn.hover();
    const editBtn = userTurn.locator('.micro-btn:has-text("Edit")');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    const inlineEditArea = userTurn.locator('.inline-edit-textarea');
    await expect(inlineEditArea).toBeVisible();
    await inlineEditArea.fill('Initialize the system with verbose telemetry.');
    await userTurn.locator('.btn-save').click();
    await expect(userTurn.locator('.book-blockquote')).toContainText('Initialize the system with verbose telemetry.');

    expect(auditor.pageErrors).toEqual([]);
  });
});
