import z from '@deepseek-ai/schemastery'

/**
 * Every behavior the Claude Code plugin wires through `hooks.json` is on by
 * default here too; the flags exist so a deployment can drop one without
 * forking the package.
 */
export interface PluginConfig {
  /** Inject this project's memory profile at session start. */
  injectProfile?: boolean
  /** Search supermemory with each prompt and inject the top matches. */
  recall?: boolean
  /** Save each turn's delta back to supermemory. */
  capture?: boolean
  /** Run read-only supermemory MCP tools without an approval prompt. */
  autoApprove?: boolean
  /** Open the browser login when no API key is configured. */
  browserLogin?: boolean
  /** Mount the hosted supermemory MCP server through the bundled stdio proxy. */
  mcp?: boolean
  /** MCP namespace; tools surface as `mcp__<mcpServerName>__<tool>`. */
  mcpServerName?: string
  /** Register the `/supermemory-status` command. */
  command?: boolean
  /** Register the bundled `supermemory-context-gatherer` skill. */
  contextGatherer?: boolean
}

export const PluginConfig: z<PluginConfig> = z.object({
  injectProfile: z.boolean().default(true),
  recall: z.boolean().default(true),
  capture: z.boolean().default(true),
  autoApprove: z.boolean().default(true),
  browserLogin: z.boolean().default(true),
  mcp: z.boolean().default(true),
  mcpServerName: z.string().default('supermemory'),
  command: z.boolean().default(true),
  contextGatherer: z.boolean().default(true),
})
