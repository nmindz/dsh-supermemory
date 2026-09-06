import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BRAND, gray } from './lib/colors.ts'

/** The `{kind:'plugin'}` source stamped on every context this plugin injects. */
export const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'supermemory' } as const

/**
 * Shared per-process state for the plugin's four behaviors.
 *
 * `bootstraps` holds the session-start memory fetch. `agent/session-start` is
 * an emit point that is never awaited, so the fetch is parked here and the
 * first `agent/pre-step` — a waterfall that IS awaited — folds the result into
 * that step's messages. Claude Code's detached SessionStart hook can miss the
 * first request; this cannot.
 */
export interface SupermemoryRuntime {
  readonly ctx: Context
  readonly bootstraps: Map<string, Promise<string | null>>
  readonly delivered: Set<string>
  /**
   * User-facing one-liner. Claude Code renders these as hook `systemMessage`s;
   * DSH exposes no equivalent transient channel, so they go to the logger and
   * the statusline state files carry the same numbers.
   */
  notify(text: string): void
  warn(text: string): void
}

export function createRuntime(ctx: Context): SupermemoryRuntime {
  const logger = ctx.logger('supermemory')
  return {
    ctx,
    bootstraps: new Map(),
    delivered: new Set(),
    notify(text: string) {
      logger.info(`${BRAND} ${gray('·')} ${text}`)
    },
    warn(text: string) {
      logger.warn(`${BRAND} ${gray('·')} ${text}`)
    },
  }
}

/** The session workspace an agent runs in, matching every other DSH plugin. */
export function cwdOf(agent: Agent | undefined): string {
  return agent?.session.header.cwd ?? process.cwd()
}

export function sessionIdOf(agent: Agent | undefined): string {
  return String(agent?.session.header.id ?? '')
}

/**
 * Claude Code fires SessionStart, UserPromptSubmit, and Stop for the main
 * session only — a Task subagent gets SubagentStart/SubagentStop, which this
 * plugin does not hook. DSH dispatches the same extension points to every
 * agent, so delegated sessions are filtered out to keep the behavior identical.
 */
export function isSubagent(agent: Agent | undefined): boolean {
  return agent?.session.header.origin === 'subagent'
}
