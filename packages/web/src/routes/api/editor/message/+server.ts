import { json } from '@sveltejs/kit'
import { getMessageEditorSnapshot, saveMessageField } from '@claude-sessions/core'
import { editorLocation, editorBody, editorFailure } from '$lib/server/editor-http'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ url }) => {
  try {
    const { project, session, uuid } = editorLocation(url)
    return json(await getMessageEditorSnapshot(project, session, uuid), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return editorFailure(error)
  }
}

export const PATCH: RequestHandler = async ({ url, request }) => {
  try {
    const { project, session, uuid } = editorLocation(url)
    const body = await editorBody(request)
    return json(
      await saveMessageField(
        project,
        session,
        uuid,
        body as { revision: string; targetId: string; value: string }
      )
    )
  } catch (error) {
    return editorFailure(error)
  }
}
