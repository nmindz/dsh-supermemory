/**
 * Persistent memory across DeepSeek Harness sessions using Supermemory.
 *
 * A native port of the Claude Code `supermemory` plugin v0.1.8. The four
 * behaviors its `hooks.json` wires — session-start memory injection, per-prompt
 * recall, auto-approved read-only memory tools, and turn capture — are mapped
 * onto DSH's typed extension points instead of command hooks, and the hosted
 * MCP server is mounted through the same stdio proxy. Credentials, settings,
 * container tags, and the wire format are shared byte-for-byte with the Claude
 * Code plugin, so one login and one memory container serve both harnesses.
 *
 * @module dsh-supermemory
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

import { PluginConfig } from './config.ts'
import { registerApprove } from './approve.ts'
import { registerCapture } from './capture.ts'
import { registerCodebaseIndex } from './codebase-index.ts'
import { registerContextGatherer } from './context-gatherer.ts'
import { registerRecall } from './recall.ts'
import { registerSessionStart } from './session-start.ts'
import { registerStatusCommand } from './status.ts'
import { createRuntime } from './runtime.ts'

export * from './config.ts'
export * from './runtime.ts'
export * from './transcript.ts'
export { formatContext } from './session-start.ts'
export {
  formatDiscovery,
  formatRecall,
  hashText,
  isTimeout,
  promptFrom,
  resultText,
  shouldSkip,
  type SearchGuidance,
} from './recall.ts'
export { indexWriteToolOf, readOnlyToolOf, scopeDenial } from './approve.ts'
export { maskKey, summaryLine, TOAST_CELLS } from './status.ts'
export { resolveSkillDir, splitFrontmatter } from './context-gatherer.ts'
export { INDEX_SKILL_NAME, invokesIndex } from './codebase-index.ts'
export { REPO_SCOPED_TOOLS } from './lib/mcp-scope.ts'

export const name = 'supermemory'
export { PluginConfig as Config }

/** The bundled stdio bridge to the hosted Supermemory MCP server. */
const MCP_PROXY = fileURLToPath(new URL('./mcp-proxy.mjs', import.meta.url))

export function apply(ctx: Context, config: PluginConfig): void {
  // One proxy serves the whole host; pinning its cwd lets the scope guard
  // resolve the same container the proxy injects.
  const proxyCwd = config.mcp !== false ? process.cwd() : null
  const rt = createRuntime(ctx, proxyCwd)

  if (config.injectProfile !== false) registerSessionStart(ctx, rt, config)
  // One pre-step listener owns both the session bootstrap delivery and recall,
  // so it must mount whenever either behavior is enabled.
  if (config.injectProfile !== false || config.recall !== false) {
    registerRecall(ctx, rt, config)
  }
  // Also carries the scope guard, which must run even without auto-approval.
  if (config.autoApprove !== false || config.mcp !== false) registerApprove(ctx, rt, config)
  if (config.capture !== false) registerCapture(ctx, rt, config)
  if (config.command !== false) registerStatusCommand(ctx, rt, config)
  if (config.contextGatherer !== false) registerContextGatherer(ctx, rt)
  if (config.index !== false) registerCodebaseIndex(ctx, rt)

  if (proxyCwd !== null) {
    // DSH scrubs credential-shaped names from the child env, which would
    // leave an env-only key unauthenticated on the MCP path.
    const apiKey = process.env.SUPERMEMORY_CC_API_KEY
    // Mounted as a child plugin rather than a separate patch row: the proxy
    // path is resolved from this module, so no user has to write an absolute
    // path into their profile patch.
    void ctx.plugin(McpClient, {
      transport: 'stdio',
      serverName: config.mcpServerName ?? 'supermemory',
      command: process.execPath,
      args: [MCP_PROXY],
      env: apiKey ? { SUPERMEMORY_CC_API_KEY: apiKey } : {},
      cwd: proxyCwd,
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    } satisfies McpClient.Config)
  }
}
