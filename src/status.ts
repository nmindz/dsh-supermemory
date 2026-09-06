import type { Context } from '@deepseek-ai/cordis'
// Declaration-merges `ctx.commands` onto Context.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CREDENTIALS_FILE, loadCredentials, AUTH_BASE_URL } from './lib/auth.ts'
import { getContainerTag, getProjectName } from './lib/container-tag.ts'
import { loadProjectConfig } from './lib/project-config.ts'
import { getBaseUrl, SETTINGS_FILE } from './lib/settings.ts'
import { MARK } from './lib/colors.ts'
import { cwdOf } from './runtime.ts'
import type { PluginConfig } from './config.ts'

const PROBE_TIMEOUT_MS = 8000

/** Never print a full key: at most the first 6 and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

interface ResolvedKey {
  key: string
  source: string
}

function resolveKey(cwd: string): ResolvedKey | null {
  if (process.env.SUPERMEMORY_CC_API_KEY) {
    return { key: process.env.SUPERMEMORY_CC_API_KEY, source: 'env SUPERMEMORY_CC_API_KEY' }
  }
  const projectConfig = loadProjectConfig(cwd)
  if (projectConfig?.apiKey) {
    return { key: projectConfig.apiKey, source: '.claude/.supermemory-claude/config.json' }
  }
  const credentials = loadCredentials()
  if (credentials?.apiKey) return { key: credentials.apiKey, source: CREDENTIALS_FILE }
  return null
}

/**
 * A stored key proves nothing by itself, so the report always probes the API.
 * Interpret loudly: 401/403 is the silent-failure case the probe exists to
 * catch.
 */
async function probe(baseUrl: string, key: string, containerTag: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v4/profile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'x-sm-source': 'claude-code',
      },
      body: JSON.stringify({ containerTag, q: 'connectivity probe' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.status === 200) return 'reachable — 200, the key works'
    if (response.status === 401 || response.status === 403) {
      return `reachable, but the key is invalid or revoked — ${response.status}. Re-authenticate at ${AUTH_BASE_URL}`
    }
    if (response.status >= 500) return `API error — ${response.status}, service temporarily unavailable`
    return `unexpected response — ${response.status}`
  } catch (err) {
    const error = err as Error
    return `UNREACHABLE — ${error.name === 'TimeoutError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : error.message}`
  }
}

export function registerStatusCommand(
  ctx: Context,
  config: PluginConfig,
): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'supermemory-status',
      description: 'Show Supermemory authentication and connection status',
      recordInput: false,
      handler: async ({ agent }: CommandInvocation): Promise<CommandResult> => {
        const cwd = cwdOf(agent)
        const projectName = getProjectName(cwd)
        const containerTag = getContainerTag(cwd)
        const resolved = resolveKey(cwd)

        const serverName = config.mcpServerName ?? 'supermemory'
        const prefix = `mcp__${serverName}__`
        const mcpTools = (ctx.get('tools')?.schemas(agent.id) ?? [])
          .map(schema => schema.name)
          .filter(name => name.startsWith(prefix))

        const lines = [
          `${MARK} supermemory`,
          '',
          `project        ${projectName}`,
          `container tag  ${containerTag}`,
          `settings       ${SETTINGS_FILE}`,
        ]

        if (!resolved) {
          lines.push(
            'authenticated  NO',
            '',
            `Start a new session to open the browser login automatically, or set SUPERMEMORY_CC_API_KEY. Login page: ${AUTH_BASE_URL}`,
          )
          return { kind: 'success', text: lines.join('\n') }
        }

        const baseUrl = getBaseUrl(cwd)
        lines.push(
          'authenticated  yes',
          `key            ${maskKey(resolved.key)} (from ${resolved.source})`,
          `api            ${baseUrl}`,
          `api probe      ${await probe(baseUrl, resolved.key, containerTag)}`,
          `mcp            ${mcpTools.length > 0 ? `${mcpTools.length} tool${mcpTools.length === 1 ? '' : 's'} under ${prefix}` : `no ${prefix}* tools registered`}`,
        )
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })
}
