import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { BRAND, gray } from './lib/colors.ts'
import { getContainerTag } from './lib/container-tag.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    supermemory: { kind: 'supermemory' } & ContextFormed
  }
}

/** The producer-owned source stamped on every context this plugin injects. */
export const PLUGIN_SOURCE = { kind: 'supermemory' } as const

/**
 * Shared per-process state for the plugin's four behaviors.
 *
 * `bootstraps` holds the session-start memory fetch. `agent/created` awaits its
 * listeners before the agent accepts input, so the fetch is parked here instead
 * of delaying creation, and the first `agent/pre-step` folds the result into
 * that step's messages. Claude Code's detached SessionStart hook can miss the
 * first request; this cannot.
 */
export interface SupermemoryRuntime {
  readonly ctx: Context
  readonly bootstraps: Map<string, Promise<string | null>>
  readonly delivered: Set<string>
  /** Sessions whose latest prompt invoked `/supermemory-index`. */
  readonly indexing: Set<string>
  /**
   * Where a tag-less space-scoped call through the bundled proxy lands: the
   * container of the proxy's cwd. Null when the proxy is not mounted.
   */
  proxyContainerTag(): string | null
  /**
   * User-facing one-liner. Claude Code renders these as hook `systemMessage`s;
   * DSH exposes no equivalent transient channel, so they go to the logger and
   * the statusline state files carry the same numbers.
   */
  notify(text: string): void
  warn(text: string): void
}

/** @param proxyCwd - the cwd the bundled MCP proxy is spawned in, or null when it is not mounted. */
export function createRuntime(ctx: Context, proxyCwd: string | null = null): SupermemoryRuntime {
  const logger = ctx.logger('supermemory')
  let proxyTag: string | null | undefined
  return {
    ctx,
    bootstraps: new Map(),
    delivered: new Set(),
    indexing: new Set(),
    proxyContainerTag() {
      if (proxyTag !== undefined) return proxyTag
      try {
        proxyTag = proxyCwd === null ? null : getContainerTag(proxyCwd)
      } catch {
        proxyTag = null
      }
      return proxyTag
    },
    notify(text: string) {
      logger.info(`${BRAND} ${gray('·')} ${text}`)
    },
    warn(text: string) {
      logger.warn(`${BRAND} ${gray('·')} ${text}`)
    },
  }
}

/** Whether a tag-less space-scoped call from a session in `containerTag` already lands there. */
export function defaultsToProject(rt: SupermemoryRuntime, containerTag: string): boolean {
  return rt.proxyContainerTag() === containerTag
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
