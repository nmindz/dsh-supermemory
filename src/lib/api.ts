export const AGENT_ENTITY_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Try to remember things that a human would remember — a teammate recalls decisions and lessons, not what state the working tree was in
- Preserve durable context that helps a coding agent continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Transient repo state git already tracks: uncommitted file lists, current branch position, in-flight commit/push status
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`

// Listeners sit between the user and the model — a slow or dead network must
// never hold the session hostage, so every request is capped hard at 3s and
// callers treat failure as "no memory this time", not a blocker.
export const REQUEST_TIMEOUT_MS = 3000

export interface ProfileResult {
  profile?: {
    static?: string[]
    dynamic?: string[]
  }
  searchResults?: {
    results?: SearchHit[]
  }
}

export interface SearchHit {
  memory?: string
  chunk?: string
  content?: string
  text?: string
  title?: string
  filepath?: string
  similarity?: number
}

export interface AddMemoryResult {
  id?: string
}

async function post<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-sm-source': 'claude-code',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw Object.assign(
      new Error(`Supermemory API ${response.status}: ${text.slice(0, 200)}`),
      { status: response.status },
    )
  }
  return await response.json() as T
}

export function getProfile(
  baseUrl: string,
  apiKey: string,
  containerTag: string,
  query: string,
  options: { timeoutMs?: number } = {},
): Promise<ProfileResult> {
  return post<ProfileResult>(baseUrl, apiKey, '/v4/profile', { containerTag, q: query }, options.timeoutMs)
}

export function addMemory(
  baseUrl: string,
  apiKey: string,
  content: string,
  containerTag: string,
  metadata: Record<string, unknown>,
  options: { customId?: string; entityContext?: string; timeoutMs?: number } = {},
): Promise<AddMemoryResult> {
  const body: Record<string, unknown> = {
    content,
    containerTag,
    metadata: { sm_source: 'claude-code', ...metadata },
  }
  if (options.customId) body.customId = options.customId
  if (options.entityContext) body.entityContext = options.entityContext
  return post<AddMemoryResult>(baseUrl, apiKey, '/v3/documents', body, options.timeoutMs)
}
