import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { getSessionsDir } from '../paths.js'
import {
  getMessageEditorSnapshot,
  saveMessageField,
  listMessageFieldBackups,
  restoreMessageField,
} from '../session/editor.js'

vi.mock('../paths.js', () => ({ getSessionsDir: vi.fn() }))

describe('versioned, field-level transcript editing', () => {
  let root: string
  let file: string
  const project = '-fixture-project'
  const session = 'session-fixture'
  const source =
    '\uFEFF  {"type":"user","uuid":"u1","message":{"content":"USER_ORIGINAL"}}\r\n' +
    '\r\n' +
    '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"OLD_DUPLICATE"}]}}\r\n' +
    ' { "type":"assistant", "uuid":"a1", "parentUuid":"u1", "usage":{"tokens":900719925474099312345}, "message":{"content":[' +
    '{"type":"thinking","thinking":"THINKING_ORIGINAL","signature":"keep-signature"},' +
    '{"type":"text","text":"FIRST_ORIGINAL"},' +
    '{"type":"tool_use","id":"call_1","name":"read","input":{"path":"fixture.txt"}},' +
    '{"type":"text","text":"SECOND_ORIGINAL"},' +
    '{"type":"tool_result","tool_use_id":"call_1","is_error":false,"content":[{"type":"text","text":"TOOL_ORIGINAL"},{"type":"image","source":{"data":"fixture"}}]}]}} \r\n' +
    '{"type":"future-event","unknown":{"value":900719925474099312345}}\r\n' +
    '{"type":"user","uuid":"u2","parentUuid":"a1","message":{"content":"LATER_ORIGINAL"}}'

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-editor-test-'))
    vi.mocked(getSessionsDir).mockReturnValue(root)
    await fs.mkdir(path.join(root, project))
    file = path.join(root, project, `${session}.jsonl`)
    await fs.writeFile(file, source)
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  const snapshot = () => getMessageEditorSnapshot(project, session, 'a1')

  it('edits the second text block of the latest duplicate and preserves all other bytes', async () => {
    const current = await snapshot()
    expect(current.duplicateCount).toBe(2)
    expect(current.lineNumber).toBe(4)
    const result = await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/3/text',
      value: '修改\n"quoted" 😀',
    })
    const expected = source.replace('"SECOND_ORIGINAL"', JSON.stringify('修改\n"quoted" 😀'))
    expect(await fs.readFile(file, 'utf8')).toBe(expected)
    expect(
      result.snapshot.fields.find((field) => field.id === '/message/content/1/text')?.value
    ).toBe('FIRST_ORIGINAL')
    expect(result.backupId).toBeTruthy()
  })

  it('keeps string content as a string and allows empty values', async () => {
    const current = await getMessageEditorSnapshot(project, session, 'u1')
    await saveMessageField(project, session, 'u1', {
      revision: current.revision,
      targetId: '/message/content',
      value: '',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(source.replace('"USER_ORIGINAL"', '""'))
  })

  it('edits nested tool-result text without losing tool references or attachments', async () => {
    const current = await snapshot()
    await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/4/content/0/text',
      value: 'new result',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(source.replace('"TOOL_ORIGINAL"', '"new result"'))
  })

  it('preserves thinking signatures and surfaces the limitation', async () => {
    const current = await snapshot()
    expect(current.fields.find((field) => field.kind === 'thinking')?.signed).toBe(true)
    expect(current.warnings.join(' ')).toContain('签名')
    await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/0/thinking',
      value: 'revised thinking',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(
      source.replace('"THINKING_ORIGINAL"', '"revised thinking"')
    )
  })

  it('refuses a stale draft after another process appends history', async () => {
    const current = await snapshot()
    const appended = '\n{"type":"user","uuid":"u3","message":{"content":"EXTERNAL_APPEND"}}\n'
    await fs.appendFile(file, appended)
    await expect(
      saveMessageField(project, session, 'a1', {
        revision: current.revision,
        targetId: '/message/content/1/text',
        value: 'stale',
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(await fs.readFile(file, 'utf8')).toBe(source + appended)
    expect(await listMessageFieldBackups(project, session, 'a1')).toEqual([])
  })

  it('serializes competing editor writes rather than silently overwriting', async () => {
    const current = await snapshot()
    const results = await Promise.allSettled(
      ['first writer', 'second writer'].map((value) =>
        saveMessageField(project, session, 'a1', {
          revision: current.revision,
          targetId: '/message/content/1/text',
          value,
        })
      )
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await listMessageFieldBackups(project, session, 'a1')).toHaveLength(1)
    expect(
      (await fs.readdir(path.dirname(file))).some(
        (name) => name.endsWith('.tmp') || name.endsWith('.lock')
      )
    ).toBe(false)
  })

  it('restores only the selected field, retaining later edits and appended messages', async () => {
    const first = await snapshot()
    const saveA = await saveMessageField(project, session, 'a1', {
      revision: first.revision,
      targetId: '/message/content/1/text',
      value: 'FIELD_A_EDITED',
    })
    await saveMessageField(project, session, 'a1', {
      revision: saveA.snapshot.revision,
      targetId: '/message/content/3/text',
      value: 'FIELD_B_EDITED',
    })
    const appended = '\n{"type":"user","uuid":"u3","message":{"content":"KEEP_LATER_APPEND"}}\n'
    await fs.appendFile(file, appended)
    const latest = await snapshot()
    await restoreMessageField(project, session, 'a1', {
      revision: latest.revision,
      backupId: saveA.backupId!,
    })
    expect(await fs.readFile(file, 'utf8')).toBe(
      source.replace('"SECOND_ORIGINAL"', '"FIELD_B_EDITED"') + appended
    )
    const backups = await listMessageFieldBackups(project, session, 'a1')
    expect(backups).toHaveLength(3)
    expect(backups.some((backup) => backup.kind === 'restore')).toBe(true)
  })

  it('does not write or back up a no-op', async () => {
    const current = await snapshot()
    const result = await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/1/text',
      value: 'FIRST_ORIGINAL',
    })
    expect(result.backupId).toBeNull()
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  })

  it('rejects malformed lines instead of discarding them during a save', async () => {
    await fs.appendFile(file, '\n{"incomplete":')
    const before = await fs.readFile(file)
    await expect(snapshot()).rejects.toMatchObject({ status: 422, code: 'INVALID_JSONL' })
    expect(await fs.readFile(file)).toEqual(before)
  })

  it('rejects duplicate JSON property names in a target record', async () => {
    await fs.writeFile(
      file,
      '{"type":"user","uuid":"a1","message":{"content":"A","content":"B"}}\n'
    )
    await expect(snapshot()).rejects.toMatchObject({ code: 'AMBIGUOUS_JSON' })
  })

  it('rejects arbitrary paths and non-text field targets', async () => {
    await expect(getMessageEditorSnapshot('..', session, 'a1')).rejects.toMatchObject({
      status: 400,
    })
    await expect(getMessageEditorSnapshot(project, '../other', 'a1')).rejects.toMatchObject({
      status: 400,
    })
    const current = await snapshot()
    await expect(
      saveMessageField(project, session, 'a1', {
        revision: current.revision,
        targetId: '/parentUuid',
        value: 'changed',
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  })

  it('rejects symlink session files', async () => {
    const outside = path.join(root, 'outside.jsonl')
    await fs.rename(file, outside)
    await fs.symlink(outside, file)
    await expect(snapshot()).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it('does not overwrite if the backup directory is invalid', async () => {
    await fs.writeFile(path.join(root, project, '.history-editor-backups'), 'not a directory')
    const current = await snapshot()
    await expect(
      saveMessageField(project, session, 'a1', {
        revision: current.revision,
        targetId: '/message/content/1/text',
        value: 'no backup',
      })
    ).rejects.toMatchObject({ code: 'UNSAFE_BACKUP' })
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  })

  it('validates backup content before restoring and refuses cross-message restore', async () => {
    const current = await snapshot()
    const saved = await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/1/text',
      value: 'changed',
    })
    await expect(
      restoreMessageField(project, session, 'u1', {
        revision: saved.snapshot.revision,
        backupId: saved.backupId!,
      })
    ).rejects.toMatchObject({ code: 'BACKUP_MISMATCH' })
    const backupPath = path.join(
      root,
      project,
      '.history-editor-backups',
      session,
      `${saved.backupId}.json`
    )
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    backup.before = 'tampered metadata'
    await fs.writeFile(backupPath, JSON.stringify(backup))
    await expect(
      restoreMessageField(project, session, 'a1', {
        revision: saved.snapshot.revision,
        backupId: saved.backupId!,
      })
    ).rejects.toMatchObject({ code: 'INVALID_BACKUP' })
    expect(
      (await snapshot()).fields.find((field) => field.id === '/message/content/1/text')?.value
    ).toBe('changed')
  })

  it('keeps file mode and restricts backup permissions', async () => {
    if (process.platform === 'win32') return
    await fs.chmod(file, 0o640)
    const current = await snapshot()
    const saved = await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/1/text',
      value: 'mode check',
    })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
    expect(
      (
        await fs.stat(
          path.join(root, project, '.history-editor-backups', session, `${saved.backupId}.json`)
        )
      ).mode & 0o777
    ).toBe(0o600)
  })

  it('respects a live lock and can reclaim a dead editor lock', async () => {
    const current = await snapshot()
    await fs.writeFile(
      `${file}.history-editor.lock`,
      JSON.stringify({ pid: process.pid, host: os.hostname() })
    )
    await expect(
      saveMessageField(project, session, 'a1', {
        revision: current.revision,
        targetId: '/message/content/1/text',
        value: 'blocked',
      })
    ).rejects.toMatchObject({ code: 'EDITOR_BUSY' })
    await fs.writeFile(
      `${file}.history-editor.lock`,
      JSON.stringify({ pid: 99999999, host: os.hostname() })
    )
    await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/1/text',
      value: 'reclaimed',
    })
    expect(
      (await snapshot()).fields.find((field) => field.id === '/message/content/1/text')?.value
    ).toBe('reclaimed')
  })

  it('rejects restoring an old field into a structurally changed message', async () => {
    const current = await snapshot()
    const saved = await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/1/text',
      value: 'changed',
    })
    const changed = (await fs.readFile(file, 'utf8')).replace(
      '"parentUuid":"u1"',
      '"parentUuid":"different-parent"'
    )
    await fs.writeFile(file, changed)
    await expect(
      restoreMessageField(project, session, 'a1', {
        revision: (await snapshot()).revision,
        backupId: saved.backupId!,
      })
    ).rejects.toMatchObject({ code: 'TARGET_CHANGED' })
    expect(await fs.readFile(file, 'utf8')).toBe(changed)
  })

  it('supports a single tool-result content object without normalizing its shape', async () => {
    const raw =
      '{"type":"user","uuid":"a1","message":{"content":{"type":"tool_result","tool_use_id":"t1","content":"before"}}}\n'
    await fs.writeFile(file, raw)
    const current = await snapshot()
    await saveMessageField(project, session, 'a1', {
      revision: current.revision,
      targetId: '/message/content/content',
      value: 'after',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(raw.replace('"before"', '"after"'))
  })
})
