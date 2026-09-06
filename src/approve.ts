import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { loadSettings, debugLog } from './lib/settings.ts'
import { readState, writeState } from './lib/statusline-state.ts'
import { sessionIdOf, type SupermemoryRuntime } from './runtime.ts'
import type { PluginConfig } from './config.ts'

// Supermemory MCP tool names arrive as mcp__supermemory__<tool> (the name this
// plugin mounts), and as the Claude Code variants a shared config may still
// carry: mcp__plugin_supermemory_supermemory__<tool> (plugin-scoped) and
// mcp__claude_ai_supermemory__<tool> (claude.ai connector). Only read-only
// tools run without a prompt; writes (add_memory, save-memory, …) still ask.
const TOOL_NAME_RE = /^mcp__(?:plugin_supermemory_|claude_ai_)?supermemory__(.+)$/
const READ_ONLY_TOOLS = new Set([
  'search_memory',
  'listSpaces',
  'listMemories',
  'listDocuments',
  'getDocument',
  'whoAmI',
  'memory-graph',
  'fetch-graph-data',
])

/** The read-only tool name behind a supermemory MCP call, or null. */
export function readOnlyToolOf(toolName: string, serverName: string): string | null {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const configured = new RegExp(`^mcp__${escaped}__(.+)$`)
  const tool = configured.exec(toolName)?.[1] ?? TOOL_NAME_RE.exec(toolName)?.[1]
  return tool && READ_ONLY_TOOLS.has(tool) ? tool : null
}

/**
 * Registered with `prepend: true` so it sits outermost in the waterfall and
 * returns without delegating: no later listener — including a composed Claude
 * Code hooks bridge that would answer `ask` — can turn a read-only recall into
 * an approval prompt. Monotonic guards still apply, by design.
 */
export function registerApprove(
  ctx: Context,
  rt: SupermemoryRuntime,
  config: PluginConfig,
): void {
  const serverName = config.mcpServerName ?? 'supermemory'

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const settings = loadSettings()
    try {
      const tool = readOnlyToolOf(exec.name, serverName)
      if (!tool) return next()

      debugLog(settings, 'Auto-approving supermemory recall', { tool })
      const sessionId = sessionIdOf(exec.agent)
      const query = typeof (exec.arguments as { query?: unknown })?.query === 'string'
        ? (exec.arguments as { query: string }).query
        : null

      if (tool === 'search_memory' && sessionId) {
        const prev = readState(sessionId).search
        writeState(sessionId, 'search', {
          results: 0,
          count: ((prev?.count as number | undefined) ?? 0) + 1,
          memories: (prev?.memories as number | undefined) ?? 0,
        })
      }

      rt.notify(query ? `recalling: ${query}` : 'recalling memories')
      return { kind: 'allow' }
    } catch (err) {
      debugLog(settings, 'Recall approve error', { error: (err as Error).message })
      return next()
    }
  }, { prepend: true })
}
