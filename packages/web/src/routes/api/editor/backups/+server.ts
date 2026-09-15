import { json } from '@sveltejs/kit'
import {
  listMessageFieldBackups,
  restoreMessageField,
  MessageEditorError,
} from '@claude-sessions/core'
import { editorLocation, editorBody, editorFailure } from '$lib/server/editor-http'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ url }) => {
  try {
    const { project, session, uuid } = editorLocation(url)
    return json(await listMessageFieldBackups(project, session, uuid), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return editorFailure(error)
  }
}

export const POST: RequestHandler = async ({ url, request }) => {
  try {
    const { project, session, uuid } = editorLocation(url)
    const body = await editorBody(request)
    if (typeof body.revision !== 'string' || typeof body.backupId !== 'string')
      throw new MessageEditorError(400, 'INVALID_RESTORE', '需要当前版本和备份 ID。')
    return json(
      await restoreMessageField(project, session, uuid, {
        revision: body.revision,
        backupId: body.backupId,
      })
    )
  } catch (error) {
    return editorFailure(error)
  }
}
