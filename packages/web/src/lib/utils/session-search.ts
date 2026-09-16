import type { Message } from '$lib/api'

export interface SearchDocument {
  path: string
  label: string
  text: string
}
export interface IndexedMessage {
  key: string
  index: number
  message: Message
  documents: SearchDocument[]
}
export interface SessionSearchHit extends IndexedMessage {
  matches: SearchDocument[]
  snippet: string
  label: string
}

const snapshots = new WeakMap<Message[], number>()
let snapshotSequence = 0
export function recordKeys(messages: Message[]): string[] {
  if (!snapshots.has(messages)) snapshots.set(messages, ++snapshotSequence)
  const seen = new Map<string, number>()
  return messages.map((message, index) => {
    const id = message.uuid || message.messageId || message.leafUuid
    if (!id) return `row:${snapshots.get(messages)}:${index}`
    const count = seen.get(id) || 0
    seen.set(id, count + 1)
    return `id:${id}:${count}`
  })
}

export function literalPattern(query: string, global = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), global ? 'giu' : 'iu')
}

export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  if (!query.trim()) return [{ text, match: false }]
  const parts: { text: string; match: boolean }[] = []
  const pattern = literalPattern(query.trim(), true)
  let offset = 0
  let count = 0
  for (let match = pattern.exec(text); match && count < 200; match = pattern.exec(text)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index), match: false })
    parts.push({ text: match[0], match: true })
    offset = match.index + match[0].length
    count++
  }
  // Bound highlight nodes, never truncate the readable content.
  if (offset < text.length) parts.push({ text: text.slice(offset), match: false })
  return parts.length ? parts : [{ text, match: false }]
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const printable = (value: unknown) =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)

export function indexSessionMessages(
  messages: Message[],
  includeMetadata = false
): IndexedMessage[] {
  const keys = recordKeys(messages)
  return messages.map((message, index) => {
    const record = message as unknown as Record<string, unknown>
    const documents: SearchDocument[] = []
    const add = (path: string, label: string, value: unknown) => {
      const text = printable(value)
      if (text) documents.push({ path, label, text })
    }
    const compact = record.isCompactSummary === true
    function visit(value: unknown, path: string, label: string) {
      if (typeof value === 'string') {
        add(path, label, value)
        return
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, `${path}/${i}`, label))
        return
      }
      const block = object(value)
      if (block.type === 'text') add(`${path}/text`, label, block.text)
      else if (block.type === 'thinking') add(`${path}/thinking`, '思考过程', block.thinking)
      else if (block.type === 'tool_use') {
        add(`${path}/name`, '工具名称', block.name)
        add(`${path}/input`, `工具输入 · ${String(block.name || 'tool')}`, block.input)
      } else if (block.type === 'tool_result') visit(block.content, `${path}/content`, '工具输出')
      else if (block.type === 'image' || block.type === 'document') {
        add(`${path}/filename`, '附件名称', block.filename ?? block.title)
      } else if (value !== undefined && value !== null) add(path, label, value)
    }
    const nested = object(record.message)
    const content = Object.hasOwn(nested, 'content') ? nested.content : record.content
    const path = Object.hasOwn(nested, 'content') ? '/message/content' : '/content'
    const firstText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? object(content.find((item) => object(item).type === 'text')).text
          : object(content).text
    const continuation =
      typeof firstText === 'string' && firstText.startsWith('This session is being continued from')
    visit(content, path, compact || continuation ? 'Compact 压缩总结' : '消息正文')
    if (typeof record.summary === 'string') add('/summary', '摘要记录', record.summary)
    if (record.error !== undefined) add('/error', '错误信息', record.error)
    if (record.type === 'progress') add('/data', '运行输出', record.data)
    if (includeMetadata) add('$record', '完整记录 / 元数据', record)
    return { key: keys[index], index, message, documents }
  })
}

export function searchSessionMessages(index: IndexedMessage[], query: string): SessionSearchHit[] {
  const needle = query.trim()
  if (!needle) return []
  const pattern = literalPattern(needle)
  return index.flatMap((entry) => {
    const matches = entry.documents.filter((document) => pattern.test(document.text))
    if (!matches.length) return []
    const primary = matches[0]
    const at = pattern.exec(primary.text)!.index
    const start = Math.max(0, at - 65)
    const end = Math.min(primary.text.length, Math.max(at + needle.length, start + 230))
    const snippet = `${start ? '…' : ''}${primary.text.slice(start, end)}${end < primary.text.length ? '…' : ''}`
    return [{ ...entry, matches, snippet, label: primary.label }]
  })
}
