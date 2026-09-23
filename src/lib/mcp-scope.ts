/**
 * Space-scoped supermemory MCP tools: a call without `containerTag` lands in
 * the account's activeSpace on the hosted server. Upstream's camelCase names
 * plus the snake_case ones the hosted server now serves.
 */
export const REPO_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  'search_memory',
  'add_memory',
  'listDocuments',
  'list_documents',
  'listMemories',
  'list_memories',
  'memory-graph',
  'fetch-graph-data',
  'save-memory',
])

/** Parse JSON-string arguments; `undefined` when they are not an object. */
export function argumentRecord(args: unknown): Record<string, unknown> | null | undefined {
  if (args == null) return null
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** The non-blank containerTag a call already names, or null. */
export function explicitContainerTag(args: unknown): string | null {
  const tag = argumentRecord(args)?.containerTag
  return typeof tag === 'string' && tag.trim() ? tag : null
}
