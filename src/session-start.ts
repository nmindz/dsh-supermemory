import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { getProfile, type ProfileResult } from './lib/api.ts'
import { getContainerTag, getProjectName } from './lib/container-tag.ts'
import { loadProjectConfig } from './lib/project-config.ts'
import { loadSettings, getApiKey, getBaseUrl, debugLog } from './lib/settings.ts'
import { MARK, bold, gray } from './lib/colors.ts'
import { startAuthFlow, AUTH_BASE_URL } from './lib/auth.ts'
import { getUserFriendlyError } from './lib/error-helpers.ts'
import { LAST_SESSION_FILE } from './lib/last-session.ts'
import { pruneState, resolveStatuslineDataDir, writeState } from './lib/statusline-state.ts'
import { cwdOf, isSubagent, sessionIdOf, type SupermemoryRuntime } from './runtime.ts'
import type { PluginConfig } from './config.ts'

const STATUSLINE_TIP_FILE = path.join(os.homedir(), '.supermemory-claude', 'statusline-tip-shown')
const MARK_TIP_FILE = path.join(os.homedir(), '.supermemory-claude', 'mark-tip-shown')

/**
 * DSH owns its status line, so there is nothing to install into a setting the
 * way the Claude Code plugin installs one. The per-session state files are
 * written all the same, and this one-time tip points at the renderer that
 * turns them into the identical line.
 */
function statuslineTip(): string | null {
  try {
    if (fs.existsSync(STATUSLINE_TIP_FILE)) return null
    fs.mkdirSync(path.dirname(STATUSLINE_TIP_FILE), { recursive: true })
    fs.writeFileSync(STATUSLINE_TIP_FILE, new Date().toISOString())
    return `${MARK} supermemory status is live — render it anywhere with \`echo '{"session_id":"…"}' | node -e "import('dsh-supermemory/statusline')"\`, or read ~/.supermemory-claude/statusline.`
  } catch {
    return null
  }
}

function markTip(): string | null {
  try {
    if (fs.existsSync(MARK_TIP_FILE)) return null
    fs.mkdirSync(path.dirname(MARK_TIP_FILE), { recursive: true })
    fs.writeFileSync(MARK_TIP_FILE, new Date().toISOString())
    return `${MARK} is the supermemory mark — whenever you see it (status, notices, the assistant's answers), that information came from supermemory.`
  } catch {
    return null
  }
}

function welcomeBackNotice(containerTag: string): string | null {
  try {
    const last = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, 'utf-8')) as {
      savedAt?: string
      containerTag?: string
    }
    if (!last.savedAt || last.containerTag !== containerTag) return null
    const hours = (Date.now() - new Date(last.savedAt).getTime()) / 3600000
    if (hours < 6) return null
    const ago = hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)}d ago`
    return `welcome back — last session here ${ago}`
  } catch {
    return null
  }
}

export function formatContext(
  profileResult: ProfileResult | null,
  maxItems: number,
  containerTag: string,
  projectName: string,
): string | null {
  const statics = (profileResult?.profile?.static || []).slice(0, maxItems)
  const dynamics = (profileResult?.profile?.dynamic || []).slice(0, maxItems)
  if (statics.length === 0 && dynamics.length === 0) return null

  const sections: string[] = []
  if (statics.length > 0) {
    sections.push(`## User Profile (Persistent)\n${statics.map(f => `- ◪ ${f}`).join('\n')}`)
  }
  if (dynamics.length > 0) {
    sections.push(`## Recent Context\n${dynamics.map(f => `- ◪ ${f}`).join('\n')}`)
  }

  return `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally (e.g. "◪ last week you told me about X"). If you name the source, say "from supermemory" — never "from memory".
This project's memory container: ${containerTag}

${sections.join('\n\n')}
</supermemory-context>`
}

/**
 * Resolve the memory context for one session. Returns the exact text the
 * Claude Code plugin's SessionStart hook would have produced as
 * `additionalContext`, or null when there is nothing to say.
 */
async function bootstrap(
  rt: SupermemoryRuntime,
  config: PluginConfig,
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const settings = loadSettings()

  try {
    pruneState({ dataDir: resolveStatuslineDataDir() })
    writeState(sessionId, 'context', { status: 'loading', memoryItemsLoaded: 0 })

    const projectConfig = loadProjectConfig(cwd)
    const projectName = getProjectName(cwd)
    const containerTag = getContainerTag(cwd)

    debugLog(settings, 'SessionStart', { cwd, projectName, containerTag })

    let apiKey: string
    try {
      apiKey = getApiKey(cwd, projectConfig)
    } catch {
      if (!config.browserLogin) {
        writeState(sessionId, 'context', { status: 'error', memoryItemsLoaded: 0 })
        return `<supermemory-status>
Supermemory is not authenticated and browser login is disabled for this deployment.
Set the SUPERMEMORY_CC_API_KEY environment variable, or authenticate at: ${AUTH_BASE_URL}
</supermemory-status>`
      }
      try {
        apiKey = await startAuthFlow()
      } catch (authErr) {
        writeState(sessionId, 'context', { status: 'error', memoryItemsLoaded: 0 })
        return `<supermemory-status>
${(authErr as Error).message === 'AUTH_TIMEOUT' ? 'Authentication timed out. Please complete login in the browser window.' : 'Authentication failed.'}
If the browser did not open, visit: ${AUTH_BASE_URL}
Or set the SUPERMEMORY_CC_API_KEY environment variable.
</supermemory-status>`
      }
    }

    const baseUrl = getBaseUrl(cwd, projectConfig)

    let profileResult: ProfileResult | null = null
    let apiError: string | null = null
    try {
      profileResult = await getProfile(baseUrl, apiKey, containerTag, projectName)
    } catch (err) {
      // Fail open, but never silently: a network failure must not be dressed
      // up as "this project has no memories". Only 404 means genuinely empty.
      if ((err as { status?: number })?.status !== 404) apiError = getUserFriendlyError(err)
      debugLog(settings, 'Profile fetch failed', { error: (err as Error).message })
    }

    const context = formatContext(profileResult, settings.maxProfileItems, containerTag, projectName)
    const loaded = Math.min(profileResult?.profile?.static?.length || 0, settings.maxProfileItems)
      + Math.min(profileResult?.profile?.dynamic?.length || 0, settings.maxProfileItems)

    writeState(sessionId, 'context', {
      status: apiError ? 'error' : 'ready',
      memoryItemsLoaded: loaded,
    })

    const memoryNotice = loaded > 0
      ? `${loaded} ${loaded === 1 ? 'memory' : 'memories'} loaded for ${bold(projectName)}`
      : null

    const banner = [memoryNotice, welcomeBackNotice(containerTag)].filter(Boolean).join(gray(' · '))
    if (banner) rt.notify(banner)
    for (const tip of [markTip(), statuslineTip()]) {
      if (tip) rt.notify(tip)
    }

    return (apiError ? `<supermemory-status>\n${apiError}\n</supermemory-status>\n` : '')
      + (context
        || (apiError
          ? `<supermemory-context>
Memory could not be loaded this session — do not assume this project has no memories.
</supermemory-context>`
          : `<supermemory-context>
No previous memories found for this project (container: ${containerTag}).
Memories will be saved as you work.
</supermemory-context>`))
  } catch (err) {
    const friendly = getUserFriendlyError(err)
    rt.warn(friendly)
    writeState(sessionId, 'context', { status: 'error', memoryItemsLoaded: 0 })
    return `<supermemory-status>
Failed to load memories: ${friendly}
Session will continue without memory context.
</supermemory-status>`
  }
}

export function registerSessionStart(
  ctx: Context,
  rt: SupermemoryRuntime,
  config: PluginConfig,
): void {
  ctx.on('agent/session-start', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (!sessionId || rt.bootstraps.has(sessionId)) return
    if (isSubagent(agent) && !config.includeSubagents) return
    rt.bootstraps.set(
      sessionId,
      bootstrap(rt, config, cwdOf(agent), sessionId).catch((err: unknown) => {
        rt.warn(`session bootstrap failed: ${getUserFriendlyError(err)}`)
        return null
      }),
    )
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    rt.bootstraps.delete(sessionId)
    rt.delivered.delete(sessionId)
  })
}
