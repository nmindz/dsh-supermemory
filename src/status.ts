import type { Context } from '@deepseek-ai/cordis'
// Declaration-merges `ctx.commands` onto Context.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CREDENTIALS_FILE, loadCredentials, AUTH_BASE_URL } from './lib/auth.ts'
import { getContainerTag, getProjectName } from './lib/container-tag.ts'
import { loadProjectConfig } from './lib/project-config.ts'
import { getBaseUrl, SETTINGS_FILE } from './lib/settings.ts'
import { cwdOf } from './runtime.ts'
import type { PluginConfig } from './config.ts'

const PROBE_TIMEOUT_MS = 8000

/**
 * dsh-tui renders a host command's result as a one-line toast: it strips ANSI,
 * collapses newlines to spaces, and truncates at 200 cells. Every report here
 * therefore leads with a summary that fits, and puts the field-per-line detail
 * after it for clients that render newlines.
 */
export const TOAST_CELLS = 200

/** Join summary fields the way the toast will show them. */
export function summaryLine(fields: readonly string[]): string {
  return `◪ supermemory · ${fields.filter(Boolean).join(' · ')}`
}

/** Never print a full key: at most the first 6 and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

interface ResolvedKey {
  key: string
  /** Full provenance for the detail block. */
  source: string
  /** Budget-sized provenance for the summary line. */
  shortSource: string
}

function resolveKey(cwd: string): ResolvedKey | null {
  if (process.env.SUPERMEMORY_CC_API_KEY) {
    return {
      key: process.env.SUPERMEMORY_CC_API_KEY,
      source: 'env SUPERMEMORY_CC_API_KEY',
      shortSource: 'env',
    }
  }
  const projectConfig = loadProjectConfig(cwd)
  if (projectConfig?.apiKey) {
    return {
      key: projectConfig.apiKey,
      source: '.claude/.supermemory-claude/config.json',
      shortSource: 'project config',
    }
  }
  const credentials = loadCredentials()
  if (credentials?.apiKey) {
    return { key: credentials.apiKey, source: CREDENTIALS_FILE, shortSource: 'credentials.json' }
  }
  return null
}

/** A short verdict for the summary line, plus the sentence for the detail block. */
interface ProbeResult {
  short: string
  detail: string
}

/**
 * A stored key proves nothing by itself, so the report always probes the API.
 * Interpret loudly: 401/403 is the silent-failure case the probe exists to
 * catch.
 */
async function probe(baseUrl: string, key: string, containerTag: string): Promise<ProbeResult> {
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
    if (response.status === 200) {
      return { short: 'api 200', detail: 'reachable — 200, the key works' }
    }
    if (response.status === 401 || response.status === 403) {
      return {
        short: `api ${response.status} KEY REVOKED`,
        detail: `reachable, but the key is invalid or revoked — ${response.status}. Re-authenticate at ${AUTH_BASE_URL}`,
      }
    }
    if (response.status >= 500) {
      return {
        short: `api ${response.status}`,
        detail: `API error — ${response.status}, service temporarily unavailable`,
      }
    }
    return { short: `api ${response.status}`, detail: `unexpected response — ${response.status}` }
  } catch (err) {
    const error = err as Error
    const why = error.name === 'TimeoutError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : error.message
    return { short: 'api UNREACHABLE', detail: `UNREACHABLE — ${why}` }
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

        const mcpShort = mcpTools.length > 0 ? `mcp ${mcpTools.length} tools` : 'mcp NONE'

        if (!resolved) {
          // Summary first, always. A client that renders a command result as a
          // one-line toast (dsh-tui collapses newlines and truncates at 200
          // cells) then still shows the part that matters.
          return {
            kind: 'success',
            text: [
              summaryLine([
                'NOT authenticated',
                'set SUPERMEMORY_CC_API_KEY or start a new session to log in',
                projectName,
              ]),
              '',
              `container tag  ${containerTag}`,
              `settings       ${SETTINGS_FILE}`,
              `login page     ${AUTH_BASE_URL}`,
            ].join('\n'),
          }
        }

        const baseUrl = getBaseUrl(cwd)
        const probed = await probe(baseUrl, resolved.key, containerTag)
        return {
          kind: 'success',
          text: [
            summaryLine([
              `auth ok (${resolved.shortSource})`,
              probed.short,
              mcpShort,
              containerTag,
            ]),
            '',
            `project        ${projectName}`,
            `container tag  ${containerTag}`,
            `authenticated  yes`,
            `key            ${maskKey(resolved.key)} (from ${resolved.source})`,
            `api            ${baseUrl}`,
            `api probe      ${probed.detail}`,
            `mcp            ${mcpTools.length > 0 ? `${mcpTools.length} tool${mcpTools.length === 1 ? '' : 's'} under ${prefix}` : `no ${prefix}* tools registered`}`,
            `settings       ${SETTINGS_FILE}`,
          ].join('\n'),
        }
      },
    })
  })
}
