import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { getContainerTag } from './lib/container-tag.ts'
import { explicitContainerTag, REPO_SCOPED_TOOLS } from './lib/mcp-scope.ts'
import { loadSettings, debugLog } from './lib/settings.ts'
import { readState, writeState } from './lib/statusline-state.ts'
import { cwdOf, sessionIdOf, type SupermemoryRuntime } from './runtime.ts'
import type { PluginConfig } from './config.ts'

// Supermemory MCP tool names arrive as mcp__supermemory__<tool> (the name this
// plugin mounts), and as the Claude Code variants a shared config may still
// carry: mcp__plugin_supermemory_supermemory__<tool> (plugin-scoped) and
// mcp__claude_ai_supermemory__<tool> (claude.ai connector). Only read-only
// tools run without a prompt; writes (add_memory, save-memory, …) still ask.
const TOOL_NAME_RE = /^mcp__(?:plugin_supermemory_|claude_ai_)?supermemory__(.+)$/
// Upstream's camelCase names plus the snake_case twins the hosted server now serves.
const READ_ONLY_TOOLS = new Set([
  'search_memory',
  'listSpaces',
  'list_spaces',
  'listMemories',
  'list_memories',
  'listDocuments',
  'list_documents',
  'getDocument',
  'get_document',
  'whoAmI',
  'who_am_i',
  'memory-graph',
  'fetch-graph-data',
])
// Upstream's /supermemory:index pre-approves these through its allowed-tools.
const INDEX_WRITE_TOOLS = new Set(['add_memory'])

interface SupermemoryTool {
  tool: string
  /** Served by the proxy this plugin mounts, as opposed to a shared namespace. */
  ours: boolean
}

function supermemoryToolOf(toolName: string, serverName: string): SupermemoryTool | null {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const configured = new RegExp(`^mcp__${escaped}__(.+)$`).exec(toolName)?.[1]
  if (configured) return { tool: configured, ours: true }
  const shared = TOOL_NAME_RE.exec(toolName)?.[1]
  return shared ? { tool: shared, ours: false } : null
}

/** The read-only tool name behind a supermemory MCP call, or null. */
export function readOnlyToolOf(toolName: string, serverName: string): string | null {
  const tool = supermemoryToolOf(toolName, serverName)?.tool
  return tool && READ_ONLY_TOOLS.has(tool) ? tool : null
}

/** The write tool behind a supermemory MCP call that an index run may make unprompted, or null. */
export function indexWriteToolOf(toolName: string, serverName: string): string | null {
  const tool = supermemoryToolOf(toolName, serverName)?.tool
  return tool && INDEX_WRITE_TOOLS.has(tool) ? tool : null
}

/**
 * Why a call through the shared proxy must be retried with an explicit tag, or
 * null when it lands where the session expects. The proxy fills a missing tag
 * from its own cwd, which in a multi-workspace host is not this session's.
 */
export function scopeDenial(
  tool: string,
  args: unknown,
  proxyTag: string | null,
  sessionTag: () => string,
): string | null {
  if (proxyTag === null || !REPO_SCOPED_TOOLS.has(tool) || explicitContainerTag(args)) return null
  const expected = sessionTag()
  if (expected === proxyTag) return null
  return `${tool} needs an explicit containerTag in this session: without one it lands in "${proxyTag}", not this project's container. Retry with containerTag: "${expected}", or pass another space's tag on purpose.`
}

/**
 * Registered with `prepend: true` so it sits outermost in the waterfall and
 * returns without delegating: no later listener — including a composed Claude
 * Code hooks bridge that would answer `ask` — can turn a read-only recall into
 * an approval prompt. Monotonic guards still apply, by design. The scope guard
 * runs first so a mis-scoped write is refused before anyone approves it.
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
      const hit = supermemoryToolOf(exec.name, serverName)
      if (!hit) return next()
      const { tool } = hit

      if (hit.ours) {
        const reason = scopeDenial(
          tool,
          exec.arguments,
          rt.proxyContainerTag(),
          () => getContainerTag(cwdOf(exec.agent)),
        )
        if (reason) {
          debugLog(settings, 'Refusing tag-less supermemory call', { tool })
          return { kind: 'deny', reason }
        }
      }

      if (config.autoApprove === false) return next()
      const sessionId = sessionIdOf(exec.agent)

      if (INDEX_WRITE_TOOLS.has(tool) && rt.indexing.has(sessionId)) {
        debugLog(settings, 'Auto-approving supermemory index write', { tool })
        rt.notify('indexing: saving memory')
        return { kind: 'allow' }
      }
      if (!READ_ONLY_TOOLS.has(tool)) return next()

      debugLog(settings, 'Auto-approving supermemory recall', { tool })
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
