import { json } from '@sveltejs/kit'
import { MessageEditorError } from '@claude-sessions/core'

export function editorLocation(url: URL) {
  const project = url.searchParams.get('project')
  const session = url.searchParams.get('session')
  const uuid = url.searchParams.get('uuid')
  if (!project || !session || !uuid)
    throw new MessageEditorError(400, 'INVALID_LOCATION', '需要项目、会话 ID 和消息 UUID。')
  return { project, session, uuid }
}

export async function editorBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new MessageEditorError(415, 'INVALID_BODY', '请求必须为 JSON。')
  const reader = request.body?.getReader()
  if (!reader) throw new MessageEditorError(400, 'INVALID_BODY', '请求内容为空。')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 9 * 1024 * 1024) {
        await reader.cancel()
        throw new MessageEditorError(413, 'INVALID_BODY', '请求内容过大。')
      }
      chunks.push(value)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Object required')
    return value
  } catch (error) {
    if (error instanceof MessageEditorError) throw error
    throw new MessageEditorError(400, 'INVALID_BODY', '请求不是有效的 JSON 对象。')
  } finally {
    reader.releaseLock()
  }
}

export function editorFailure(error: unknown) {
  if (error instanceof MessageEditorError)
    return json({ error: error.message, code: error.code }, { status: error.status })
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
    return json({ error: '会话或备份文件不存在。', code: 'NOT_FOUND' }, { status: 404 })
  console.error('[message-editor]', {
    name: (error as Error)?.name,
    code: (error as NodeJS.ErrnoException)?.code,
  })
  return json(
    { error: '操作失败，请检查文件权限或备份完整性。草稿已保留。', code: 'EDITOR_FAILED' },
    { status: 500 }
  )
}
