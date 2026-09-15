import { test, expect, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const project = '-demo-project'
let session: string
let file: string
let original: string
let pageErrors: string[]

test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', (cause) => pageErrors.push(cause.message))
  const home = process.env.CLAUDE_EDITOR_TEST_HOME!
  expect(home).toContain('.editor-test')
  session = randomUUID()
  const directory = path.join(home, '.claude/projects', project)
  await fs.mkdir(directory, { recursive: true })
  file = path.join(directory, `${session}.jsonl`)
  const stamp = new Date().toISOString()
  const common = { sessionId: session, timestamp: stamp, cwd: '/demo/project' }
  original =
    [
      JSON.stringify({
        ...common,
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        message: { role: 'user', content: 'Original user message' },
      }),
      JSON.stringify({
        ...common,
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Older duplicate' }] },
      }),
      JSON.stringify({
        ...common,
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        message: {
          role: 'assistant',
          model: 'fixture-model',
          usage: { input_tokens: 12, output_tokens: 24 },
          content: [
            { type: 'thinking', thinking: 'Saved reasoning', signature: 'fixture-signature' },
            { type: 'text', text: 'FIRST_TEXT' },
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { file_path: '/demo/theme.ts' },
            },
            { type: 'text', text: 'SECOND_TEXT' },
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [{ type: 'text', text: 'Original tool output' }],
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        ...common,
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: 'Later message must stay' },
      }),
    ].join('\r\n') + '\r\n'
  await fs.writeFile(file, original, { mode: 0o600 })
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
  })
})

test.afterEach(() => {
  expect(pageErrors).toEqual([])
})

async function openEditor(page: Page, uuid = 'a1') {
  const response = await page.goto(`/session/${project}/${session}`)
  expect(response?.status()).toBe(200)
  await page.getByRole('button', { name: 'All', exact: true }).first().click()
  const message = page.locator(`[data-msg-id="${uuid}"]`)
  await expect(message).toBeVisible()
  await message.hover()
  await message.getByTitle('Edit message content', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /编辑历史消息/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('field-text')).toBeVisible()
  return dialog
}

test('edits a selected assistant block and restores it without removing later history', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await expect(dialog.getByText(/检测到 2 条相同 UUID/)).toBeVisible()
  await dialog.locator('[data-field-id="/message/content/3/text"]').click()
  await expect(dialog.getByTestId('field-text')).toHaveValue('SECOND_TEXT')
  await dialog.getByTestId('field-text').fill('Revised second block\n保留其他内容')
  await dialog.getByTestId('save-field').click()
  await expect(dialog.getByTestId('editor-success')).toContainText('已保存当前字段')
  const edited = original.replace(
    '"SECOND_TEXT"',
    JSON.stringify('Revised second block\n保留其他内容')
  )
  await expect.poll(() => fs.readFile(file, 'utf8')).toBe(edited)
  const appended =
    '{"type":"user","uuid":"new-later","parentUuid":"u2","message":{"content":"APPENDED_AFTER_EDIT"}}\r\n'
  await fs.appendFile(file, appended)
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click()
  await expect(dialog.getByTestId('field-text')).toHaveValue('Revised second block\n保留其他内容')
  await dialog.getByRole('button', { name: '历史备份', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '恢复这个字段' })).toHaveCount(1)
  page.once('dialog', (confirmation) => confirmation.accept())
  await dialog.getByRole('button', { name: '恢复这个字段' }).click()
  await expect(dialog.getByTestId('editor-success')).toContainText('已恢复该字段')
  await expect.poll(() => fs.readFile(file, 'utf8')).toBe(original + appended)
})

test('keeps user drafts when an external append makes the revision stale', async ({ page }) => {
  const dialog = await openEditor(page, 'u1')
  await dialog.getByTestId('field-text').fill('UNSAVED_USER_DRAFT')
  const appended = '{"type":"user","uuid":"external","message":{"content":"EXTERNAL_NEW_RECORD"}}\n'
  await fs.appendFile(file, appended)
  const response = page.waitForResponse(
    (r) => r.url().includes('/api/editor/message') && r.request().method() === 'PATCH'
  )
  await dialog.getByTestId('save-field').click()
  expect((await response).status()).toBe(409)
  await expect(dialog.getByTestId('editor-error')).toContainText('草稿已保留')
  await expect(dialog.getByTestId('field-text')).toHaveValue('UNSAVED_USER_DRAFT')
  expect(await fs.readFile(file, 'utf8')).toBe(original + appended)
})

test('saves empty user text while preserving the original string representation', async ({
  page,
}) => {
  const dialog = await openEditor(page, 'u1')
  await dialog.getByTestId('field-text').fill('')
  await dialog.getByTestId('save-field').click()
  await expect(dialog.getByTestId('editor-success')).toContainText('已保存')
  await expect
    .poll(() => fs.readFile(file, 'utf8'))
    .toBe(original.replace('"Original user message"', '""'))
})

test('shows the full raw record and sanitizes Markdown preview', async ({ page }) => {
  const dialog = await openEditor(page)
  await dialog.getByRole('button', { name: '原始记录', exact: true }).click()
  await expect(dialog.locator('pre')).toContainText('fixture-signature')
  await expect(dialog.locator('pre')).toContainText('tool_1')
  await dialog.getByRole('button', { name: '文本编辑', exact: true }).click()
  await dialog
    .getByTestId('field-text')
    .fill('<script>window.__history_xss = true</script>\n**SAFE_PREVIEW**')
  await dialog.getByRole('button', { name: '预览', exact: true }).click()
  await expect(dialog.locator('strong')).toHaveText('SAFE_PREVIEW')
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__history_xss)
  ).toBeUndefined()
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

test('asks before discarding a draft when switching fields', async ({ page }) => {
  const dialog = await openEditor(page)
  await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '复制会话 ID', exact: true })).toBeFocused()
  await dialog.getByTestId('field-text').fill('KEEP_THIS_DRAFT')
  let prompted = false
  page.once('dialog', (confirmation) => {
    prompted = true
    return confirmation.dismiss()
  })
  await dialog.locator('[data-field-id="/message/content/3/text"]').click()
  expect(prompted).toBe(true)
  await expect(dialog.getByTestId('field-text')).toHaveValue('KEEP_THIS_DRAFT')
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

test('supports the editor on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, 'u1')
  await expect(dialog.getByTestId('field-text')).toHaveValue('Original user message')
  const bounds = await dialog.boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390)
  await dialog.getByTestId('field-text').fill('Mobile edit')
  await dialog.getByTestId('save-field').click()
  await expect(dialog.getByTestId('editor-success')).toContainText('已保存')
})
