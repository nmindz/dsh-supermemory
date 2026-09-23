import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'

import { getProfile, type SearchHit } from './lib/api.ts'
import { gray, red } from './lib/colors.ts'
import { getContainerTag } from './lib/container-tag.ts'
import { getUserFriendlyError } from './lib/error-helpers.ts'
import { loadProjectConfig } from './lib/project-config.ts'
import { loadSettings, getApiKey, getBaseUrl, debugLog, getRecallConfig } from './lib/settings.ts'
import { atomicWriteJson, getSessionDir, readState, writeState } from './lib/statusline-state.ts'
import {
  cwdOf,
  defaultsToProject,
  isSubagent,
  sessionIdOf,
  PLUGIN_SOURCE,
  type SupermemoryRuntime,
} from './runtime.ts'
import type { PluginConfig } from './config.ts'

// Recall is performed HERE, not delegated to the model: the plugin searches
// supermemory with the prompt itself and injects the top matches, so recall
// happens on every substantive prompt instead of only when the model chooses
// to spend a tool call. A configured recallDirective restores advisory mode.
const MIN_PROMPT_LENGTH = 12
const MAX_QUERY_LENGTH = 500
const MAX_RESULTS = 5
const MAX_RESULT_CHARS = 300
const MIN_SIMILARITY = 0.55
const SEARCH_TIMEOUT_MS = 4000
const MAX_SEEN_HASHES = 500

/** `AbortSignal.timeout` rejects with TimeoutError; a plain abort with AbortError. */
export function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export function shouldSkip(prompt: string): boolean {
  if (prompt.length < MIN_PROMPT_LENGTH) return true
  return ['/', '!', '#'].includes(prompt[0] ?? '')
}

// Search hits are memory-shaped (.memory) or document/chunk-shaped
// (.chunk/.content/.text, usually with a filepath) — read whichever carries
// the text.
export function resultText(r: SearchHit | undefined): string | null {
  const text = [r?.memory, r?.chunk, r?.content, r?.text].find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  )
  return text || null
}

// A memory injected once this session stays in the conversation, so
// re-injecting it wastes context and makes the banner repeat the same
// number every turn. The seen set lives next to the statusline state and
// is pruned with it.
export function hashText(text: string): string {
  return crypto
    .createHash('sha256')
    .update(text.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16)
}

function readSeenHashes(sessionDir: string): string[] {
  try {
    const list: unknown = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'recalled.json'), 'utf8'),
    )
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : []
  } catch {
    return []
  }
}

// The hook can only inject what it finds. When a project has no stored memories
// the model gets silence — and silence reads as "there is nothing to search",
// so it never reaches for the tool and any history living in another container
// stays invisible. Say once per session that the tool exists, what to scope it
// to, and that the call is free. Once per session, because this fires on a miss
// and misses are the common case in an empty project: repeating it would tax
// every prompt and invite a search on turns where memory is irrelevant.
const DISCOVERY_MARKER = 'discovery.json'

function discoverySent(sessionDir: string): boolean {
  return fs.existsSync(path.join(sessionDir, DISCOVERY_MARKER))
}

function markDiscoverySent(sessionDir: string): void {
  try {
    atomicWriteJson(path.join(sessionDir, DISCOVERY_MARKER), { sentAt: new Date().toISOString() })
  } catch {
    // Best effort: a failed marker only risks repeating the notice.
  }
}

/** How the model reaches the search tool in this session. */
export interface SearchGuidance {
  /** Model-visible name of the search tool. */
  toolName: string
  /** A search without containerTag already lands in this project's container. */
  defaultsToProject: boolean
  /** Read-only supermemory calls run without an approval prompt. */
  autoApproved: boolean
}

// DSH has no deferred tool loading, so the exact mounted name is the pointer.
export function formatDiscovery(containerTag: string, guidance: SearchGuidance): string {
  const bullets = [
    `- Scope to this project with containerTag: "${containerTag}"`,
    guidance.defaultsToProject
      ? '- Omitting containerTag also lands here; pass another tag only to search a\n  different space (list_spaces finds them).'
      : '- Always pass it here: a search without containerTag does not land in this\n  project\'s container.',
    guidance.autoApproved ? '- Read-only supermemory calls are auto-approved; they never prompt the user.' : null,
  ].filter(Boolean)
  return `<supermemory-recall>
No stored memories matched this prompt for this project.

Deeper history may still exist. Search it with the supermemory search_memory
tool — exposed here as ${guidance.toolName}.

${bullets.join('\n')}

Worth a call when the user refers to past decisions, earlier sessions, or says
"remember" / "we decided" / "last time". Skip it for self-contained tasks.
</supermemory-recall>`
}

export function formatRecall(results: SearchHit[], containerTag: string, defaultsToProject = true): string {
  const lines = results.map((r) => {
    const text = (resultText(r) ?? '').replace(/\s+/g, ' ').slice(0, MAX_RESULT_CHARS)
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null
    const prefix = title && !text.startsWith(title) ? `${title} — ` : ''
    const where = typeof r.filepath === 'string' && r.filepath ? ` (${r.filepath})` : ''
    return `- ◪ ${prefix}${text}${where}`
  })
  const deeper = defaultsToProject
    ? `For deeper history, call the supermemory search_memory tool — it defaults to this project's container (${containerTag}). Pass containerTag only to search a different space. Or launch the supermemory-context-gatherer skill.`
    : `For deeper history, call the supermemory search_memory tool (containerTag: "${containerTag}") or launch the supermemory-context-gatherer skill.`
  return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join('\n')}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". ${deeper}
</supermemory-recall>`
}

/** Memory is material lifted out of earlier sessions, which is exactly `form: 'recall'`. */
function contextMessage(text: string): UserMessage {
  const content: ContentBlock[] = [{ type: 'text', text }]
  return createUserMessage({ content, source: { ...PLUGIN_SOURCE, form: 'recall' } })
}

/** Flatten the direct human prompt out of the messages claimed for this step. */
export function promptFrom(messages: readonly UserMessage[]): string {
  return messages
    .filter(message => message.source.kind === 'user')
    .flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

async function recallFor(
  rt: SupermemoryRuntime,
  config: PluginConfig,
  cwd: string,
  sessionId: string,
  prompt: string,
): Promise<string | null> {
  const settings = loadSettings()

  try {
    const { directive } = getRecallConfig(cwd)
    if (directive) return directive

    if (shouldSkip(prompt)) return null

    const projectConfig = loadProjectConfig(cwd)
    let apiKey: string
    try {
      apiKey = getApiKey(cwd, projectConfig)
    } catch {
      return null
    }

    const containerTag = getContainerTag(cwd)
    const response = await getProfile(
      getBaseUrl(cwd, projectConfig),
      apiKey,
      containerTag,
      prompt.slice(0, MAX_QUERY_LENGTH),
      { timeoutMs: SEARCH_TIMEOUT_MS },
    )

    const results = (response?.searchResults?.results || [])
      .filter(r => resultText(r))
      .filter(r => !Number.isFinite(r.similarity) || (r.similarity as number) >= MIN_SIMILARITY)
      .slice(0, MAX_RESULTS)

    const sessionDir = getSessionDir(sessionId)
    const seen = sessionDir ? readSeenHashes(sessionDir) : []
    const seenSet = new Set(seen)
    const fresh = results.filter(r => !seenSet.has(hashText(resultText(r) as string)))
    const repeats = results.length - fresh.length

    if (sessionId) {
      const prev = readState(sessionId).search
      writeState(sessionId, 'search', {
        results: fresh.length,
        count: ((prev?.count as number | undefined) ?? 0) + 1,
        memories: ((prev?.memories as number | undefined) ?? 0) + fresh.length,
      })
    }

    debugLog(settings, 'Prompt recall', {
      query: prompt.slice(0, 80),
      hits: results.length,
      fresh: fresh.length,
    })

    const defaults = defaultsToProject(rt, containerTag)

    if (fresh.length === 0) {
      // Only when the container is genuinely empty: if results came back but
      // were all repeats, formatRecall already delivered the same guidance
      // earlier this session.
      if (results.length === 0 && sessionDir && !discoverySent(sessionDir)) {
        markDiscoverySent(sessionDir)
        rt.notify('no memories yet for this project')
        return formatDiscovery(containerTag, {
          toolName: `mcp__${config.mcpServerName ?? 'supermemory'}__search_memory`,
          defaultsToProject: defaults,
          autoApproved: config.autoApprove !== false,
        })
      }
      return null
    }

    if (sessionDir) {
      try {
        atomicWriteJson(
          path.join(sessionDir, 'recalled.json'),
          [...seen, ...fresh.map(r => hashText(resultText(r) as string))].slice(-MAX_SEEN_HASHES),
        )
      } catch {
        // Dedup is best effort; recall itself must still go through.
      }
    }

    const context = formatRecall(fresh, containerTag, defaults)
    // ~4 chars/token: close enough to show what the injection costs.
    const tok = gray(`(${Math.round(context.length / 4)} tok)`)
    rt.notify(
      repeats
        ? `recalled ${fresh.length} new ${tok}${gray(` · ${repeats} already in context`)}`
        : `recalled ${fresh.length} ${fresh.length === 1 ? 'memory' : 'memories'} ${tok}`,
    )
    return context
  } catch (err) {
    debugLog(settings, 'Recall directive error', { error: (err as Error).message })
    // A slow recall should not interrupt every prompt with an error banner.
    if (isTimeout(err)) return null
    rt.notify(red(`recall failed: ${getUserFriendlyError(err).slice(0, 80)}`))
    return null
  }
}

/**
 * One `agent/pre-step` listener owns both injections. It delegates first so a
 * later listener may still reject or rewrite the step, then folds the session
 * bootstrap (once) and this prompt's recall onto the resulting `enter`.
 */
export function registerRecall(
  ctx: Context,
  rt: SupermemoryRuntime,
  config: PluginConfig,
): void {
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (isSubagent(agent) && !config.includeSubagents) return next()
    const sessionId = sessionIdOf(agent)
    const cwd = cwdOf(agent)
    const prompt = promptFrom(messages)

    // The session-start fetch is parked, not injected: awaiting it here is
    // what guarantees the first request carries this project's memory.
    const pending = config.injectProfile !== false && !rt.delivered.has(sessionId)
      ? rt.bootstraps.get(sessionId)
      : undefined
    const bootstrapText = pending ? await pending : null

    const recallText = config.recall !== false && prompt.length > 0
      ? await recallFor(rt, config, cwd, sessionId, prompt)
      : null

    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream

    const additions: UserMessage[] = []
    if (bootstrapText) {
      rt.delivered.add(sessionId)
      additions.push(contextMessage(bootstrapText))
    }
    if (recallText) additions.push(contextMessage(recallText))
    if (additions.length === 0) return downstream

    return { ...downstream, messages: [...downstream.messages, ...additions] }
  })
}
