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
  await page.getByLabel('筛选消息类型', { exact: true }).click()
  await page.getByRole('button', { name: 'All', exact: true }).first().click()
  await page.getByLabel('筛选消息类型', { exact: true }).click()
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
  if (process.env.UPDATE_EDITOR_SCREENSHOTS === '1')
    await page.screenshot({ path: path.resolve('../../docs/history-editor.png') })
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

test('wide workspace uses the viewport, supports sidebar collapse and browser history', async ({
  page,
}) => {
  const alternate = randomUUID()
  await fs.writeFile(
    path.join(path.dirname(file), `${alternate}.jsonl`),
    original
      .replaceAll(session, alternate)
      .replace('Original user message', 'ALTERNATE_SESSION_TITLE')
  )
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`/#${new URLSearchParams({ project, session })}`)
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', session)
  const sidebar = await page.locator('[data-project-sidebar]').boundingBox()
  const content = await page.locator('[data-workspace-content]').boundingBox()
  expect(sidebar!.x).toBe(0)
  expect(sidebar!.width).toBeGreaterThanOrEqual(280)
  expect(sidebar!.width).toBeLessThanOrEqual(340)
  expect(content!.x + content!.width).toBe(1920)
  if (process.env.UPDATE_EDITOR_SCREENSHOTS === '1')
    await page.screenshot({ path: path.resolve('../../docs/workspace.png') })
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight
    )
  ).toBe(true)
  await page.getByRole('button', { name: '收起项目侧栏', exact: true }).click()
  await expect(page.locator('[data-project-sidebar]')).not.toBeVisible()
  expect((await page.locator('[data-workspace-content]').boundingBox())!.x).toBe(0)
  await page.getByRole('button', { name: '打开项目侧栏', exact: true }).click()
  await page.locator(`[data-session-select="${alternate}"]`).click()
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', alternate)
  await page.goBack()
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', session)
  await page.goForward()
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', alternate)
  const icon = await page.locator('link[rel=icon]').getAttribute('href')
  expect(icon).toContain('/favicon.svg')
  expect(icon).not.toContain('data:')
})

test('mobile project drawer opens and closes without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#${new URLSearchParams({ project, session })}`)
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', session)
  await expect(page.locator('[data-project-sidebar]')).not.toBeVisible()
  await page.getByRole('button', { name: '打开项目侧栏', exact: true }).click()
  await expect(page.locator('[data-project-sidebar]')).toBeVisible()
  await page.locator(`[data-session-select="${session}"]`).click()
  await expect(page.locator('[data-project-sidebar]')).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('late session responses cannot replace a newer selection', async ({ page }) => {
  const alternate = randomUUID()
  await fs.writeFile(
    path.join(path.dirname(file), `${alternate}.jsonl`),
    original
      .replaceAll(session, alternate)
      .replace('Original user message', 'NEWER_SELECTION_CONTENT')
  )
  await page.goto(`/#${new URLSearchParams({ project })}`)
  await expect(page.locator(`[data-session-select="${session}"]`)).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === '/api/session' && url.search.includes(session),
    async (route) => {
      await gate
      await route.continue()
    }
  )
  try {
    const oldRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/api/session' && request.url().includes(session)
    )
    await page.locator(`[data-session-select="${session}"]`).click()
    await oldRequest
    await page.locator(`[data-session-select="${alternate}"]`).click()
    await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', alternate)
    await expect(page.locator('[data-msg-id="u1"]')).toContainText('NEWER_SELECTION_CONTENT')
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/session' && response.url().includes(session)
    )
    release()
    await oldResponse
    await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', alternate)
    await expect(page.locator('[data-msg-id="u1"]')).toContainText('NEWER_SELECTION_CONTENT')
  } finally {
    release()
  }
})

test('keyboard search waits for explicit selection and keeps workspace context', async ({
  page,
}) => {
  await page.goto(`/#${new URLSearchParams({ project })}`)
  await expect(page.locator(`[data-session-select="${session}"]`)).toBeVisible()
  const search = page.getByRole('textbox', { name: '搜索会话或 ID', exact: true })
  await page.keyboard.press('ControlOrMeta+k')
  await expect(search).toBeFocused()
  await search.fill(session)
  await expect(page.locator('[data-search-result]')).toHaveCount(1)
  expect(page.url()).not.toContain(`session=${session}`)
  await search.press('ArrowDown')
  await expect(page.locator('[data-search-result]').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-session-id]')).toHaveAttribute('data-session-id', session)
  await expect(page.locator('[data-project-sidebar]')).toBeVisible()
  await search.fill('no_session_matches_this_query_987654')
  await expect(
    page.getByText('没有匹配的会话，可尝试搜索消息内容。', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '搜索消息内容', exact: true })).toBeVisible()
})

test('session search reveals collapsed tool input in its full conversation context', async ({
  page,
}) => {
  await page.goto(`/session/${project}/${session}`)
  await expect(page.locator('[data-msg-id="a1"]')).toBeVisible()
  await page.getByRole('button', { name: '搜索当前会话', exact: true }).click()
  const input = page.getByRole('textbox', { name: '搜索当前会话记录', exact: true })
  await input.fill('theme.ts')
  const result = page.locator('[data-search-hit]')
  await expect(result).toHaveCount(1)
  await expect(result).toContainText('工具输入')
  await result.click()
  await expect(page.locator('[data-search-context]')).toContainText('完整消息流')
  for (const uuid of ['u1', 'a1', 'u2'])
    await expect(page.locator(`[data-msg-id="${uuid}"]`)).toHaveCount(1)
  const active = page.locator('[data-search-active]')
  const match = active.locator('[data-search-path="/message/content/2/input"] mark')
  await expect(match).toHaveText('theme.ts')
  await expect(match).toBeVisible()
  await expect
    .poll(async () =>
      match.evaluate((element) => {
        const container = element.closest('[data-session-scroll]')!.getBoundingClientRect()
        const bounds = element.getBoundingClientRect()
        return bounds.top >= container.top && bounds.bottom <= container.bottom
      })
    )
    .toBe(true)
  await page.getByRole('button', { name: '返回搜索结果', exact: true }).click()
  await expect(input).toHaveValue('theme.ts')
  await expect(page.locator('[data-search-hit]')).toHaveCount(1)
  await expect(page.locator('[data-msg-id="u1"]')).toHaveCount(0)
  expect(await fs.readFile(file, 'utf8')).toBe(original)
})

test('session search finds compact summaries and opt-in hidden metadata records', async ({
  page,
}) => {
  const extra =
    [
      {
        type: 'system',
        uuid: 'compact-boundary',
        subtype: 'compact_boundary',
        parentUuid: 'u2',
        metadata: { marker: 'BOUNDARY_META_ANCHOR' },
      },
      {
        type: 'user',
        uuid: 'compact-summary',
        parentUuid: 'compact-boundary',
        isCompactSummary: true,
        message: { content: 'COMPACT_SUMMARY_ANCHOR retained context' },
      },
      { type: 'queue-operation', operation: 'enqueue', content: 'ANONYMOUS_RECORD_ANCHOR' },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n'
  await fs.appendFile(file, extra)
  await page.goto(`/session/${project}/${session}`)
  await expect(page.locator('[data-msg-id="u1"]')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+f')
  const input = page.getByRole('textbox', { name: '搜索当前会话记录', exact: true })
  await expect(input).toBeFocused()
  await input.fill('COMPACT_SUMMARY_ANCHOR')
  await expect(page.locator('[data-search-hit]')).toHaveCount(1)
  await expect(page.locator('[data-search-hit]')).toContainText('Compact 压缩总结')
  await page.locator('[data-search-hit]').click()
  await expect(page.locator('[data-search-active]')).toContainText('COMPACT_SUMMARY_ANCHOR')
  await input.fill('BOUNDARY_META_ANCHOR')
  await expect(page.getByText('当前会话没有匹配的消息', { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: '包含元数据', exact: true }).check()
  await expect(page.locator('[data-search-hit]')).toHaveCount(1)
  await page.locator('[data-search-hit]').click()
  await expect(page.locator('[data-search-active] [data-search-fallback]')).toContainText(
    'BOUNDARY_META_ANCHOR'
  )
  await expect(page.locator('[data-search-active] mark')).toBeVisible()
  await input.fill('ANONYMOUS_RECORD_ANCHOR')
  await expect(page.locator('[data-search-hit]')).toHaveCount(1)
  await page.locator('[data-search-hit]').click()
  await expect(page.locator('[data-search-active] [data-search-fallback]')).toContainText(
    'ANONYMOUS_RECORD_ANCHOR'
  )
  await expect(page.locator('[data-search-active] mark').first()).toBeVisible()
  expect(await fs.readFile(file, 'utf8')).toBe(original + extra)
})

test('session search moves between message hits and Escape restores the normal stream', async ({
  page,
}) => {
  await page.goto(`/session/${project}/${session}`)
  await expect(page.locator('[data-msg-id="u1"]')).toBeVisible()
  await page.getByRole('button', { name: '搜索当前会话', exact: true }).click()
  const input = page.getByRole('textbox', { name: '搜索当前会话记录', exact: true })
  await input.fill('message')
  await expect(page.locator('[data-search-hit]')).toHaveCount(2)
  await input.press('Enter')
  await expect(page.locator('[data-search-active] [data-msg-id="u1"]')).toBeVisible()
  await page.getByRole('button', { name: '下一条匹配消息', exact: true }).click()
  await expect(page.locator('[data-search-active] [data-msg-id="u2"]')).toBeVisible()
  await page.getByRole('button', { name: '上一条匹配消息', exact: true }).click()
  await expect(page.locator('[data-search-active] [data-msg-id="u1"]')).toBeVisible()
  await input.press('Escape')
  await expect(page.locator('[data-session-find]')).toHaveCount(0)
  await expect(page.locator('[data-search-active]')).toHaveCount(0)
  for (const uuid of ['u1', 'a1', 'u2'])
    await expect(page.locator(`[data-msg-id="${uuid}"]`)).toHaveCount(1)
})
