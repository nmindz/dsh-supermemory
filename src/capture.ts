import type { Context } from '@deepseek-ai/cordis'
import { addMemory, AGENT_ENTITY_CONTEXT } from './lib/api.ts'
import { getContainerTag, getProjectIdentity, getProjectName } from './lib/container-tag.ts'
import { loadProjectConfig } from './lib/project-config.ts'
import { loadSettings, getApiKey, getBaseUrl, debugLog, getSignalConfig } from './lib/settings.ts'
import { getUserFriendlyError } from './lib/error-helpers.ts'
import { saveLastSession } from './lib/last-session.ts'
import { readState, writeState } from './lib/statusline-state.ts'
import {
  formatNewEntries,
  formatSignalEntries,
  setLastCapturedSeq,
  type TranscriptSession,
} from './transcript.ts'
import { cwdOf, sessionIdOf, type SupermemoryRuntime } from './runtime.ts'

/**
 * `agent/turn-stopping` is serial and awaited, so the save completes before the
 * turn commits. Claude Code runs the same work in an async `Stop` hook; here it
 * is a first-class part of closing the turn.
 */
export function registerCapture(ctx: Context, rt: SupermemoryRuntime): void {
  ctx.on('agent/turn-stopping', async ({ agent }): Promise<void> => {
    const settings = loadSettings()
    const sessionId = sessionIdOf(agent)

    try {
      const cwd = cwdOf(agent)
      const projectConfig = loadProjectConfig(cwd)
      if (!sessionId) return

      let apiKey: string
      try {
        apiKey = getApiKey(cwd, projectConfig)
      } catch {
        return
      }

      const session = agent.session as unknown as TranscriptSession
      const delta = getSignalConfig(cwd).enabled
        ? formatSignalEntries(session, sessionId, cwd)
        : formatNewEntries(session, sessionId, cwd)

      if (!delta) {
        debugLog(settings, 'No new content to save')
        return
      }

      const baseUrl = getBaseUrl(cwd, projectConfig)
      const containerTag = getContainerTag(cwd)

      const captured = (readState(sessionId).capture?.count as number) || 0
      writeState(sessionId, 'capture', { status: 'saving', count: captured })

      const result = await addMemory(
        baseUrl,
        apiKey,
        delta.formatted,
        containerTag,
        {
          type: 'session_turn',
          project: getProjectName(cwd),
          sm_project_id: getProjectIdentity(cwd),
          sm_scope: 'personal',
          sm_capture_mode: 'automatic',
          timestamp: new Date().toISOString(),
        },
        { customId: sessionId, entityContext: AGENT_ENTITY_CONTEXT },
      )

      setLastCapturedSeq(sessionId, delta.lastSeq)
      writeState(sessionId, 'capture', { status: 'saved', count: captured + 1 })

      if (result?.id) {
        try {
          saveLastSession({ id: result.id, containerTag })
        } catch {}
      }

      debugLog(settings, 'Session turn saved', { length: delta.formatted.length })
    } catch (err) {
      const friendly = getUserFriendlyError(err)
      debugLog(settings, 'Capture error', { error: friendly })
      rt.warn(friendly)
      writeState(sessionId, 'capture', { status: 'error' })
    }
  })
}
