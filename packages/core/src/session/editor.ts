import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import { parseTree, findNodeAtLocation, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { getSessionsDir } from '../paths.js'

export class MessageEditorError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MessageEditorError'
  }
}

export interface MessageTextField {
  id: string
  label: string
  kind: 'text' | 'thinking' | 'tool_result'
  value: string
  signed: boolean
}

export interface MessageEditorSnapshot {
  sessionId: string
  messageUuid: string
  role: string
  revision: string
  lineNumber: number
  duplicateCount: number
  rawRecord: string
  fields: MessageTextField[]
  warnings: string[]
}

export interface MessageFieldBackup {
  id: string
  createdAt: string
  messageUuid: string
  targetId: string
  label: string
  before: string
  after: string
  kind: 'edit' | 'restore'
}

interface StoredBackup extends MessageFieldBackup {
  version: 1
  sessionId: string
  projectName: string
  fieldKind: MessageTextField['kind']
  sourceRevision: string
  nextRevision: string
  recordShapeRevision: string
  source: string
}

interface LocatedField extends MessageTextField {
  start: number
  end: number
}
interface Document {
  source: string
  revision: string
  snapshot: MessageEditorSnapshot
  fields: LocatedField[]
  recordStart: number
}

const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function fail(status: number, code: string, message: string): never {
  throw new MessageEditorError(status, code, message)
}

function safeName(value: string, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[/\\\0]/.test(value)
  ) {
    fail(400, 'INVALID_LOCATION', `${label}不是有效名称。`)
  }
}

async function sessionPath(projectName: string, sessionId: string) {
  safeName(projectName, '项目名称')
  safeName(sessionId, '会话 ID')
  const root = await fs.realpath(getSessionsDir())
  const project = path.join(root, projectName)
  try {
    const directory = await fs.lstat(project)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      fail(400, 'UNSAFE_PATH', '项目目录不能是符号链接。')
    const file = path.join(project, `${sessionId}.jsonl`)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) fail(400, 'UNSAFE_PATH', '仅支持普通 JSONL 文件。')
    return file
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail(404, 'SESSION_NOT_FOUND', '会话文件不存在。')
    throw error
  }
}

function assertUniqueKeys(node: JsonNode) {
  if (node.type === 'object') {
    const keys = (node.children || []).map((property) => property.children?.[0]?.value)
    if (new Set(keys).size !== keys.length)
      fail(422, 'AMBIGUOUS_JSON', '目标记录含重复 JSON 键，无法可靠定位；文件未修改。')
  }
  for (const child of node.children || []) assertUniqueKeys(child)
}

function parseDocument(source: string, sessionId: string, messageUuid: string): Document {
  if (typeof messageUuid !== 'string' || !messageUuid)
    fail(400, 'INVALID_MESSAGE', '需要有效的消息 UUID。')
  let selected:
    { raw: string; start: number; line: number; value: Record<string, unknown> } | undefined
  let duplicateCount = 0
  let compactLine = 0
  let line = 0
  for (let start = 0; start < source.length;) {
    line++
    const newline = source.indexOf('\n', start)
    const end = newline === -1 ? source.length : newline + 1
    const raw = source.slice(start, end)
    const json = start === 0 ? raw.replace(/^\uFEFF/, '') : raw
    if (json.trim()) {
      let value: unknown
      try {
        value = JSON.parse(json)
      } catch {
        fail(
          422,
          'INVALID_JSONL',
          `第 ${line} 行不是完整的 JSON。请确认会话已关闭并修复记录；原文件未修改。`
        )
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(422, 'INVALID_JSONL', `第 ${line} 行不是 JSON 对象，原文件未修改。`)
      const record = value as Record<string, unknown>
      if (
        record.type === 'compact_boundary' ||
        (record.type === 'system' && record.subtype === 'compact_boundary')
      )
        compactLine = line
      // Match the upstream reader: the final occurrence is the effective record.
      if (record.uuid === messageUuid) {
        duplicateCount++
        selected = { raw, start, line, value: record }
      }
    }
    start = end
  }
  if (!selected) fail(404, 'MESSAGE_NOT_FOUND', '消息不存在，请刷新会话。')
  const { raw, start, value } = selected
  const bom = raw.startsWith('\uFEFF') ? 1 : 0
  const errors: ParseError[] = []
  const tree = parseTree(raw.slice(bom), errors, {
    disallowComments: true,
    allowTrailingComma: false,
  })
  if (!tree || errors.length) fail(422, 'INVALID_JSONL', '目标记录无法严格解析。')
  assertUniqueKeys(tree)
  const fields: LocatedField[] = []
  const role = String(value.type || 'unknown')
  const editable = ['user', 'human', 'assistant'].includes(role)
  const nested = object(value.message)
  const contentPath: (string | number)[] = Object.hasOwn(nested, 'content')
    ? ['message', 'content']
    : ['content']
  const content = contentPath.length === 2 ? nested.content : value.content

  function add(
    location: (string | number)[],
    kind: MessageTextField['kind'],
    label: string,
    signed = false
  ) {
    const node = findNodeAtLocation(tree!, location)
    if (node?.type !== 'string') return
    fields.push({
      id: '/' + location.map(String).join('/'),
      label,
      kind,
      value: node.value as string,
      signed,
      start: start + bom + node.offset,
      end: start + bom + node.offset + node.length,
    })
  }
  function visitBlock(
    item: unknown,
    location: (string | number)[],
    prefix: string,
    toolResult = false
  ) {
    const block = object(item)
    if (block.type === 'text')
      add(
        [...location, 'text'],
        toolResult ? 'tool_result' : 'text',
        `${prefix} · ${toolResult ? '工具结果文本' : '正文'}`
      )
    else if (block.type === 'thinking')
      add(
        [...location, 'thinking'],
        'thinking',
        `${prefix} · 已保存的思考`,
        typeof block.signature === 'string' && !!block.signature
      )
    else if (block.type === 'tool_result') {
      if (Array.isArray(block.content)) blocks(block.content, [...location, 'content'], true)
      else
        add(
          [...location, 'content'],
          'tool_result',
          `${prefix} · 工具结果 ${String(block.tool_use_id || '')}`
        )
    }
  }
  function blocks(items: unknown[], base: (string | number)[], toolResult = false) {
    items.forEach((item, index) =>
      visitBlock(item, [...base, index], `块 ${index + 1}`, toolResult)
    )
  }
  if (editable) {
    if (typeof content === 'string') add(contentPath, 'text', '消息正文')
    else if (Array.isArray(content)) blocks(content, contentPath)
    else if (content && typeof content === 'object') visitBlock(content, contentPath, '内容块')
  }
  const warnings: string[] = []
  if (duplicateCount > 1)
    warnings.push(
      `检测到 ${duplicateCount} 条相同 UUID 的记录：编辑最后一条，与会话读取保持一致；早期记录保留。`
    )
  if (compactLine > selected.line)
    warnings.push('此消息之后存在压缩边界。修改历史不会自动更新压缩摘要或当前模型上下文。')
  if (fields.some((field) => field.signed))
    warnings.push(
      '思考块带供应商签名。修改该思考块的文本不会重新生成签名，后续模型是否接受需另行验证。'
    )
  if (!fields.length)
    warnings.push('该记录没有可编辑的文本字段；工具调用、图片和未知结构保留在原始记录中。')
  const revision = digest(source)
  return {
    source,
    revision,
    fields,
    recordStart: start,
    snapshot: {
      sessionId,
      messageUuid,
      role,
      revision,
      lineNumber: selected.line,
      duplicateCount,
      rawRecord: raw,
      fields: fields.map(({ start: _start, end: _end, ...field }) => field),
      warnings,
    },
  }
}

function recordShape(document: Document) {
  let raw = document.snapshot.rawRecord
  for (const field of [...document.fields].sort((a, b) => b.start - a.start)) {
    raw =
      raw.slice(0, field.start - document.recordStart) +
      '"<editable-text>"' +
      raw.slice(field.end - document.recordStart)
  }
  return digest(raw)
}

async function readDocument(file: string, sessionId: string, messageUuid: string) {
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink())
    fail(400, 'UNSAFE_PATH', '会话文件类型发生变化。')
  const bytes = await fs.readFile(file)
  const after = await fs.lstat(file)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    fail(409, 'SESSION_CHANGED', '读取期间会话发生变化，请重试。')
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    fail(422, 'INVALID_ENCODING', '会话不是有效 UTF-8，原文件未修改。')
  }
  return { document: parseDocument(source, sessionId, messageUuid), stat: after }
}

async function withLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.history-editor.lock`
  let lock
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lock = await fs.open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Reclaim only a positively identified dead local editor's lock.
      let stale = false
      try {
        const info = await fs.lstat(lockPath)
        if (info.isFile() && !info.isSymbolicLink()) {
          const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'))
          if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0)
            } catch (cause) {
              stale = (cause as NodeJS.ErrnoException).code === 'ESRCH'
            }
          }
          const latest = await fs.lstat(lockPath)
          if (stale && info.ino === latest.ino && info.mtimeMs === latest.mtimeMs)
            await fs.unlink(lockPath)
          else stale = false
        }
      } catch {
        stale = false
      }
      if (!stale || attempt)
        fail(409, 'EDITOR_BUSY', '另一项编辑操作正在进行，或存在未确认的保存锁。请稍后重试。')
    }
  }
  if (!lock) fail(409, 'EDITOR_BUSY', '无法取得保存锁。')
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString() })
    )
    return await action()
  } finally {
    await lock.close()
    await fs.unlink(lockPath).catch(() => {})
  }
}

async function backupDirectory(file: string, sessionId: string, create = false) {
  const base = path.join(path.dirname(file), '.history-editor-backups')
  const folder = path.join(base, sessionId)
  for (const directory of [base, folder]) {
    if (create)
      await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    try {
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        fail(400, 'UNSAFE_BACKUP', '备份目录类型不安全。')
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return folder
}

async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function getMessageEditorSnapshot(
  projectName: string,
  sessionId: string,
  messageUuid: string
) {
  const file = await sessionPath(projectName, sessionId)
  return (await readDocument(file, sessionId, messageUuid)).document.snapshot
}

async function saveField(
  projectName: string,
  sessionId: string,
  messageUuid: string,
  input: { revision: string; targetId: string; value: string },
  kind: 'edit' | 'restore',
  fieldKind?: MessageTextField['kind'],
  expectedShape?: string
) {
  if (
    typeof input.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    typeof input.targetId !== 'string' ||
    typeof input.value !== 'string'
  )
    fail(400, 'INVALID_EDIT', '需要完整版本、目标字段和字符串内容。')
  if (kind === 'edit' && Buffer.byteLength(input.value) > 8 * 1024 * 1024)
    fail(413, 'EDIT_TOO_LARGE', '单个新文本字段不能超过 8 MiB。')
  const file = await sessionPath(projectName, sessionId)
  return withLock(file, async () => {
    const { document, stat } = await readDocument(file, sessionId, messageUuid)
    if (document.revision !== input.revision)
      fail(409, 'STALE_REVISION', '会话已被修改，草稿已保留。请重新加载最新版本后合并。')
    if (expectedShape && recordShape(document) !== expectedShape)
      fail(
        409,
        'TARGET_CHANGED',
        '消息结构或元数据与备份时不同，无法自动恢复。请核对原始记录后手动编辑。'
      )
    const field = document.fields.find((candidate) => candidate.id === input.targetId)
    if (!field || (fieldKind && fieldKind !== field.kind))
      fail(409, 'TARGET_CHANGED', '目标内容块的结构已经变化，无法应用修改。')
    if (field.value === input.value) return { snapshot: document.snapshot, backupId: null }
    // Replace only the exact JSON string token. Unknown fields, large numbers,
    // whitespace, BOM, CRLF, duplicate records and later messages stay byte-exact.
    const nextSource =
      document.source.slice(0, field.start) +
      JSON.stringify(input.value) +
      document.source.slice(field.end)
    const next = parseDocument(nextSource, sessionId, messageUuid)
    const id = `${Date.now()}-${crypto.randomUUID()}`
    const folder = (await backupDirectory(file, sessionId, true))!
    const backup: StoredBackup = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      projectName,
      sessionId,
      messageUuid,
      targetId: field.id,
      label: field.label,
      fieldKind: field.kind,
      before: field.value,
      after: input.value,
      kind,
      sourceRevision: document.revision,
      nextRevision: next.revision,
      recordShapeRevision: recordShape(document),
      source: document.source,
    }
    const backupFile = await fs.open(path.join(folder, `${id}.json`), 'wx', 0o600)
    try {
      await backupFile.writeFile(JSON.stringify(backup))
      await backupFile.sync()
    } finally {
      await backupFile.close()
    }
    await syncDirectory(folder)
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${crypto.randomUUID()}.tmp`
    )
    let committed = false
    try {
      const handle = await fs.open(temporary, 'wx', stat.mode & 0o777)
      try {
        await handle.writeFile(nextSource, 'utf8')
        await handle.chmod(stat.mode & 0o777)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const current = await fs.lstat(file)
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== stat.ino ||
        digest(await fs.readFile(file)) !== document.revision
      ) {
        fail(409, 'STALE_REVISION', '提交前检测到外部修改，未覆盖会话；草稿已保留。')
      }
      await fs.rename(temporary, file)
      committed = true
      await syncDirectory(path.dirname(file))
      if (digest(await fs.readFile(file)) !== next.revision)
        fail(409, 'CHANGED_AFTER_SAVE', '保存后会话再次变化。请重新加载核对；原文已有备份。')
      return { snapshot: next.snapshot, backupId: id }
    } catch (error) {
      if (error instanceof MessageEditorError) throw error
      fail(
        500,
        'SAVE_FAILED',
        `${committed ? '文件可能已保存，请重新加载核对' : '保存失败，未替换会话文件'}；原文备份：${id}。`
      )
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  })
}

export function saveMessageField(
  projectName: string,
  sessionId: string,
  messageUuid: string,
  input: { revision: string; targetId: string; value: string }
) {
  return saveField(projectName, sessionId, messageUuid, input, 'edit')
}

async function readBackup(
  file: string,
  projectName: string,
  sessionId: string,
  id: string
): Promise<StoredBackup> {
  if (!/^\d+-[a-f0-9-]{36}$/.test(id)) fail(400, 'INVALID_BACKUP', '备份 ID 无效。')
  const folder = await backupDirectory(file, sessionId)
  if (!folder) fail(404, 'BACKUP_NOT_FOUND', '备份不存在。')
  const backupPath = path.join(folder, `${id}.json`)
  const stat = await fs.lstat(backupPath)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(400, 'UNSAFE_BACKUP', '备份不能是符号链接。')
  const backup: StoredBackup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
  if (
    backup.version !== 1 ||
    backup.id !== id ||
    backup.projectName !== projectName ||
    backup.sessionId !== sessionId ||
    typeof backup.source !== 'string' ||
    digest(backup.source) !== backup.sourceRevision
  )
    fail(422, 'INVALID_BACKUP', '备份身份或校验和不匹配。')
  const original = parseDocument(backup.source, sessionId, backup.messageUuid)
  if (recordShape(original) !== backup.recordShapeRevision)
    fail(422, 'INVALID_BACKUP', '备份结构校验失败。')
  const field = original.fields.find((item) => item.id === backup.targetId)
  if (
    !field ||
    field.value !== backup.before ||
    field.kind !== backup.fieldKind ||
    typeof backup.after !== 'string'
  )
    fail(422, 'INVALID_BACKUP', '备份字段与原文不一致。')
  const intended =
    backup.source.slice(0, field.start) +
    JSON.stringify(backup.after) +
    backup.source.slice(field.end)
  if (digest(intended) !== backup.nextRevision)
    fail(422, 'INVALID_BACKUP', '备份的修改后版本校验失败。')
  return backup
}

export async function listMessageFieldBackups(
  projectName: string,
  sessionId: string,
  messageUuid: string
): Promise<MessageFieldBackup[]> {
  const file = await sessionPath(projectName, sessionId)
  const folder = await backupDirectory(file, sessionId)
  if (!folder) return []
  const names = (await fs.readdir(folder))
    .filter((name) => /^\d+-[a-f0-9-]{36}\.json$/.test(name))
    .sort()
    .reverse()
  const result: MessageFieldBackup[] = []
  for (const name of names) {
    const backup = await readBackup(file, projectName, sessionId, name.slice(0, -5))
    if (backup.messageUuid !== messageUuid) continue
    const { id, createdAt, targetId, label, before, after, kind } = backup
    result.push({ id, createdAt, messageUuid, targetId, label, before, after, kind })
    if (result.length === 50) break
  }
  return result
}

export async function restoreMessageField(
  projectName: string,
  sessionId: string,
  messageUuid: string,
  input: { revision: string; backupId: string }
) {
  const file = await sessionPath(projectName, sessionId)
  const backup = await readBackup(file, projectName, sessionId, input.backupId)
  if (backup.messageUuid !== messageUuid) fail(400, 'BACKUP_MISMATCH', '备份不属于当前消息。')
  // Restore one field through the normal save path, never the old whole-session
  // snapshot: later messages and edits to other fields must survive an undo.
  return saveField(
    projectName,
    sessionId,
    messageUuid,
    { revision: input.revision, targetId: backup.targetId, value: backup.before },
    'restore',
    backup.fieldKind,
    backup.recordShapeRevision
  )
}
