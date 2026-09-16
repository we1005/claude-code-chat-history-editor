import { describe, expect, it } from 'vitest'
import type { Message } from '$lib/api'
import {
  highlightParts,
  indexSessionMessages,
  recordKeys,
  searchSessionMessages,
} from './session-search'

const message = (value: Record<string, unknown>) => value as unknown as Message

describe('session-local search', () => {
  it('indexes user, assistant, thinking, tool input/output and compact summaries', () => {
    const messages = [
      message({ type: 'user', uuid: 'u1', message: { content: 'USER_MARKER' } }),
      message({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'thinking', thinking: 'THINKING_MARKER' },
            { type: 'text', text: 'ASSISTANT_MARKER' },
            { type: 'tool_use', name: 'Read', input: { file: 'INPUT_MARKER' } },
          ],
        },
      }),
      message({
        type: 'user',
        uuid: 'u2',
        message: {
          content: [{ type: 'tool_result', content: [{ type: 'text', text: 'OUTPUT_MARKER' }] }],
        },
      }),
      message({
        type: 'user',
        uuid: 'u3',
        isCompactSummary: true,
        message: { content: 'COMPACT_MARKER' },
      }),
    ]
    const index = indexSessionMessages(messages)
    for (const query of [
      'USER_MARKER',
      'ASSISTANT_MARKER',
      'THINKING_MARKER',
      'INPUT_MARKER',
      'OUTPUT_MARKER',
      'COMPACT_MARKER',
    ])
      expect(searchSessionMessages(index, query)).toHaveLength(1)
    expect(searchSessionMessages(index, 'INPUT_MARKER')[0].matches[0].path).toBe(
      '/message/content/2/input'
    )
    expect(searchSessionMessages(index, 'OUTPUT_MARKER')[0].matches[0].path).toBe(
      '/message/content/0/content/0/text'
    )
    expect(searchSessionMessages(index, 'COMPACT_MARKER')[0].label).toContain('Compact')
  })

  it('finds text near the end of a long stored output and builds a relevant snippet', () => {
    const text = 'unrelated '.repeat(2000) + 'LATE_TARGET at the end'
    const hits = searchSessionMessages(
      indexSessionMessages([
        message({
          type: 'user',
          uuid: 'u1',
          message: { content: [{ type: 'tool_result', content: text }] },
        }),
      ]),
      'late_target'
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('LATE_TARGET')
    expect(hits[0].snippet.startsWith('…')).toBe(true)
    expect(hits[0].matches[0].text).toBe(text)
  })

  it('treats regex punctuation as literal input and preserves highlighted text', () => {
    const text = '<script>[a+b] 中文 [A+B]</script>'
    const indexed = indexSessionMessages([
      message({ type: 'user', uuid: 'u1', message: { content: text } }),
    ])
    expect(searchSessionMessages(indexed, '[a+b]')).toHaveLength(1)
    expect(searchSessionMessages(indexed, '[a.b]')).toHaveLength(0)
    const parts = highlightParts(text, '[a+b]')
    expect(parts.filter((part) => part.match)).toHaveLength(2)
    expect(parts.map((part) => part.text).join('')).toBe(text)
  })

  it('includes metadata only when requested, and does not mistake image data for prose', () => {
    const messages = [
      message({
        type: 'system',
        uuid: 'METADATA_UUID',
        subtype: 'compact_boundary',
        metadata: { marker: 'HIDDEN_META' },
      }),
      message({
        type: 'user',
        uuid: 'u',
        message: { content: [{ type: 'image', source: { data: 'BASE64_MARKER' } }] },
      }),
    ]
    expect(searchSessionMessages(indexSessionMessages(messages), 'HIDDEN_META')).toHaveLength(0)
    expect(
      searchSessionMessages(indexSessionMessages(messages, true), 'HIDDEN_META')[0].matches[0].path
    ).toBe('$record')
    expect(searchSessionMessages(indexSessionMessages(messages), 'BASE64_MARKER')).toHaveLength(0)
  })

  it('counts matching messages rather than duplicating results for multiple fields', () => {
    const hits = searchSessionMessages(
      indexSessionMessages([
        message({
          type: 'assistant',
          uuid: 'a',
          message: {
            content: [
              { type: 'text', text: 'needle A' },
              { type: 'thinking', thinking: 'needle B' },
            ],
          },
        }),
      ]),
      'needle'
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].matches).toHaveLength(2)
  })

  it('uses stable record identities and makes no-ID locators snapshot-specific', () => {
    const messages = [
      message({ type: 'user', uuid: 'same' }),
      message({ type: 'assistant', uuid: 'same' }),
      message({ type: 'queue-operation' }),
    ]
    const keys = recordKeys(messages)
    expect(new Set(keys).size).toBe(3)
    expect(recordKeys(messages)).toEqual(keys)
    const refreshed = recordKeys([...messages])
    expect(refreshed.slice(0, 2)).toEqual(keys.slice(0, 2))
    expect(refreshed[2]).not.toBe(keys[2])
  })

  it('bounds DOM highlight nodes while retaining every character', () => {
    const text = 'a '.repeat(1000)
    const parts = highlightParts(text, 'a')
    expect(parts.filter((part) => part.match).length).toBeLessThanOrEqual(200)
    expect(parts.map((part) => part.text).join('')).toBe(text)
    expect(searchSessionMessages(indexSessionMessages([]), '')).toEqual([])
  })
})
