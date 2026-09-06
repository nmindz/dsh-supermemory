/**
 * Turn-delta extraction, ported from the Claude Code plugin's transcript
 * reader. Claude Code parses a JSONL transcript file; DSH exposes no artifact
 * path, so the same delta is read from the durable session log instead. The
 * emitted text — the `<|start|>role<|message|>…<|end|>` lines inside a
 * `<|turn_start|>`/`<|turn_end|>` envelope — is byte-identical to what the
 * Claude Code plugin sends, so both harnesses write memories in one shape.
 *
 * The cursor is a `SessionSeq` rather than a message uuid, stored in the same
 * tracker directory the Claude Code plugin uses.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getIncludeTools,
  shouldIncludeTool,
  getSignalConfig,
} from './lib/settings.ts'

const MAX_TOOL_RESULT_LENGTH = 500
const TRACKER_DIR = path.join(os.homedir(), '.supermemory-claude', 'trackers')

/** Structural view of the content blocks this module reads. */
export type TranscriptBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool-call'; id?: string; name?: string; arguments?: string }
  | { type: 'tool-result'; toolCallId?: string; content?: TranscriptBlock[]; isError?: boolean }
  | { type: string; [key: string]: unknown }

/** A Claude-Code-shaped conversation entry derived from one session event. */
export interface TranscriptEntry {
  type: 'user' | 'assistant'
  seq: number
  timestamp: string
  content: TranscriptBlock[]
}

/** Structural view of the session-log events this module consumes. */
export interface TranscriptEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
}

/** Structural view of the session this module reads its delta from. */
export interface TranscriptSession {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly TranscriptEvent[]
}

export interface TranscriptDelta {
  formatted: string
  lastSeq: number
}

let toolUseMap = new Map<string, string>()
let currentIncludeList: string[] = []

function ensureTrackerDir(): void {
  if (!fs.existsSync(TRACKER_DIR)) {
    fs.mkdirSync(TRACKER_DIR, { recursive: true })
  }
}

/** The last captured sequence number for a session, or null before the first capture. */
export function getLastCapturedSeq(sessionId: string): number | null {
  ensureTrackerDir()
  const trackerFile = path.join(TRACKER_DIR, `${sessionId}.txt`)
  if (fs.existsSync(trackerFile)) {
    const raw = fs.readFileSync(trackerFile, 'utf-8').trim()
    const seq = Number.parseInt(raw, 10)
    return Number.isFinite(seq) ? seq : null
  }
  return null
}

export function setLastCapturedSeq(sessionId: string, seq: number): void {
  ensureTrackerDir()
  const trackerFile = path.join(TRACKER_DIR, `${sessionId}.txt`)
  fs.writeFileSync(trackerFile, String(seq))
}

function blocksOf(value: unknown): TranscriptBlock[] {
  const content = (value as { content?: unknown })?.content
  return Array.isArray(content) ? content as TranscriptBlock[] : []
}

/**
 * Project session-log events onto the user/assistant entry list the Claude
 * Code formatter expects. A `tool/result` event becomes a user entry carrying
 * one tool-result block, exactly where Claude Code's transcript puts it.
 */
export function entriesFromEvents(events: readonly TranscriptEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const event of events) {
    const timestamp = new Date(event.time ?? Date.now()).toISOString()
    if (event.type === 'user/message') {
      entries.push({ type: 'user', seq: event.seq, timestamp, content: blocksOf(event.data) })
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: unknown })?.message
      entries.push({ type: 'assistant', seq: event.seq, timestamp, content: blocksOf(message) })
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: unknown })?.message
      entries.push({ type: 'user', seq: event.seq, timestamp, content: blocksOf(message) })
    }
  }
  return entries
}

function textOfBlocks(blocks: TranscriptBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type: 'text'; text?: string } => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
}

function formatUserEntry(entry: TranscriptEntry): string | null {
  const parts: string[] = []

  for (const block of entry.content) {
    if (block.type === 'text') {
      const cleaned = cleanContent((block as { text?: string }).text ?? '')
      if (cleaned) {
        parts.push(`<|start|>user<|message|>${cleaned}<|end|>`)
      }
    } else if (block.type === 'tool-result') {
      const result = block as { toolCallId?: string; content?: TranscriptBlock[]; isError?: boolean }
      const toolName = toolUseMap.get(result.toolCallId ?? '') || 'Unknown'
      if (!shouldIncludeTool(toolName, currentIncludeList)) {
        continue
      }
      const resultContent = truncate(
        cleanContent(textOfBlocks(result.content)),
        MAX_TOOL_RESULT_LENGTH,
      )
      const status = result.isError ? 'error' : 'success'
      if (resultContent) {
        parts.push(
          `<|start|>assistant:tool_result<|message|>${toolName}(${status}): ${resultContent}<|end|>`,
        )
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : null
}

function formatAssistantEntry(entry: TranscriptEntry): string | null {
  const parts: string[] = []

  for (const block of entry.content) {
    if (block.type === 'reasoning') continue

    if (block.type === 'text') {
      const cleaned = cleanContent((block as { text?: string }).text ?? '')
      if (cleaned) {
        parts.push(`<|start|>assistant<|message|>${cleaned}<|end|>`)
      }
    } else if (block.type === 'tool-call') {
      const call = block as { id?: string; name?: string; arguments?: string }
      const toolName = call.name || 'Unknown'
      const toolId = call.id || ''
      if (toolId) {
        toolUseMap.set(toolId, toolName)
      }
      if (!shouldIncludeTool(toolName, currentIncludeList)) {
        continue
      }
      parts.push(
        `<|start|>assistant:tool<|message|>${toolName}: ${formatToolInputCompact(call.arguments)}<|end|>`,
      )
    }
  }

  return parts.length > 0 ? parts.join('\n') : null
}

export function formatEntry(entry: TranscriptEntry): string {
  const formatted = entry.type === 'user' ? formatUserEntry(entry) : formatAssistantEntry(entry)
  return formatted ?? ''
}

export function formatToolInputCompact(rawArguments: string | undefined): string {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(rawArguments ?? '{}')
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>
  } catch {
    return truncate(rawArguments ?? '', 100) ?? ''
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(input)) {
    let valueStr = typeof value === 'string' ? value : JSON.stringify(value)
    valueStr = truncate(valueStr, 100) ?? ''
    parts.push(`${key}="${valueStr}"`)
  }
  return parts.join(' ')
}

export function cleanContent(text: unknown): string {
  if (!text || typeof text !== 'string') return ''

  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>/g, '')
    .replace(/<supermemory-recall>[\s\S]*?<\/supermemory-recall>/g, '')
    .replace(/<supermemory-status>[\s\S]*?<\/supermemory-status>/g, '')
    .trim()
}

export function truncate(text: string | undefined, maxLength: number): string | undefined {
  if (!text || text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

export function getTextFromEntry(entry: TranscriptEntry): string {
  return cleanContent(textOfBlocks(entry.content))
}

function hasTextContent(entry: TranscriptEntry): boolean {
  return getTextFromEntry(entry).length > 0
}

export interface TranscriptTurn {
  userEntries: TranscriptEntry[]
  assistantEntries: TranscriptEntry[]
  allEntries: TranscriptEntry[]
}

export function groupEntriesIntoTurns(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let currentTurn: TranscriptTurn = { userEntries: [], assistantEntries: [], allEntries: [] }

  for (const entry of entries) {
    if (entry.type === 'user') {
      if (currentTurn.assistantEntries.length > 0) {
        turns.push(currentTurn)
        currentTurn = { userEntries: [], assistantEntries: [], allEntries: [] }
      }
      currentTurn.userEntries.push(entry)
      currentTurn.allEntries.push(entry)
    } else {
      currentTurn.assistantEntries.push(entry)
      currentTurn.allEntries.push(entry)
    }
  }

  if (currentTurn.allEntries.length > 0) {
    turns.push(currentTurn)
  }

  return turns
}

function groupEntriesIntoSignalTurns(entries: TranscriptEntry[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  let currentTurn: { userEntries: TranscriptEntry[] } = { userEntries: [] }
  let lastAssistantEntry: TranscriptEntry | null = null

  const pushTurn = (): void => {
    if (currentTurn.userEntries.length === 0 && !lastAssistantEntry) return
    const assistantEntries = lastAssistantEntry ? [lastAssistantEntry] : []
    const allEntries = [...currentTurn.userEntries, ...assistantEntries]
    turns.push({
      userEntries: currentTurn.userEntries,
      assistantEntries,
      allEntries,
    })
    currentTurn = { userEntries: [] }
    lastAssistantEntry = null
  }

  for (const entry of entries) {
    if (!hasTextContent(entry)) continue

    if (entry.type === 'user') {
      if (lastAssistantEntry) {
        pushTurn()
      }
      currentTurn.userEntries.push(entry)
    } else {
      lastAssistantEntry = entry
    }
  }

  pushTurn()

  return turns
}

function getTurnUserText(turn: TranscriptTurn): string {
  const texts: string[] = []
  for (const entry of turn.userEntries) {
    const text = getTextFromEntry(entry)
    if (text) texts.push(text)
  }
  return texts.join(' ').toLowerCase()
}

export function findSignalTurnIndices(turns: TranscriptTurn[], keywords: string[]): number[] {
  const signalIndices: number[] = []

  for (let i = 0; i < turns.length; i++) {
    const userText = getTurnUserText(turns[i]!)

    for (const keyword of keywords) {
      if (userText.includes(keyword)) {
        signalIndices.push(i)
        break
      }
    }
  }

  return signalIndices
}

export function getTurnsAroundSignals(
  turns: TranscriptTurn[],
  signalIndices: number[],
  turnCount: number,
): TranscriptTurn[] {
  if (signalIndices.length === 0) return []

  const includeSet = new Set<number>()

  for (const signalIdx of signalIndices) {
    const startIdx = Math.max(0, signalIdx - (turnCount - 1))
    for (let i = startIdx; i <= signalIdx; i++) {
      includeSet.add(i)
    }
  }

  return Array.from(includeSet).sort((a, b) => a - b).map(idx => turns[idx]!)
}

function formatEntryTextOnly(entry: TranscriptEntry): string | null {
  const role = entry.type
  const parts: string[] = []
  for (const block of entry.content) {
    if (block.type !== 'text') continue
    const cleaned = cleanContent((block as { text?: string }).text ?? '')
    if (cleaned) parts.push(`<|start|>${role}<|message|>${cleaned}<|end|>`)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function envelope(entries: TranscriptEntry[], format: (entry: TranscriptEntry) => string | null): string {
  const timestamp = entries[0]?.timestamp || new Date().toISOString()
  const formattedParts: string[] = [`<|turn_start|>${timestamp}`]

  for (const entry of entries) {
    const formatted = format(entry)
    if (formatted) formattedParts.push(formatted)
  }

  formattedParts.push('<|turn_end|>')
  return formattedParts.join('\n\n')
}

function newEntries(session: TranscriptSession, sessionId: string): TranscriptEntry[] {
  const lastSeq = getLastCapturedSeq(sessionId)
  const events = session.snapshotEvents(lastSeq === null ? undefined : lastSeq + 1)
  return entriesFromEvents(events)
}

/** Signal-extraction mode: only the turns around keyword-bearing prompts. */
export function formatSignalEntries(
  session: TranscriptSession,
  sessionId: string,
  cwd: string,
): TranscriptDelta | null {
  toolUseMap = new Map()
  currentIncludeList = getIncludeTools(cwd)

  const { keywords, turnsBefore } = getSignalConfig(cwd)

  const entries = newEntries(session, sessionId)
  if (entries.length === 0) return null

  const turns = groupEntriesIntoSignalTurns(entries)
  if (turns.length === 0) return null

  const signalIndices = findSignalTurnIndices(turns, keywords)
  if (signalIndices.length === 0) return null

  const turnsToFormat = getTurnsAroundSignals(turns, signalIndices, turnsBefore)
  if (turnsToFormat.length === 0) return null

  const allEntriesToFormat = turnsToFormat.flatMap(turn => turn.allEntries)
  if (allEntriesToFormat.length === 0) return null

  const result = envelope(allEntriesToFormat, formatEntryTextOnly)
  if (result.length < 100) return null

  // The caller advances the cursor only after the save succeeds — advancing
  // here would silently drop this delta whenever the API call fails.
  return { formatted: result, lastSeq: entries[entries.length - 1]!.seq }
}

/** Default mode: every new user and assistant entry since the last capture. */
export function formatNewEntries(
  session: TranscriptSession,
  sessionId: string,
  cwd: string,
): TranscriptDelta | null {
  toolUseMap = new Map()
  currentIncludeList = getIncludeTools(cwd)

  const entries = newEntries(session, sessionId)
  if (entries.length === 0) return null

  const result = envelope(entries, entry => formatEntry(entry) || null)
  if (result.length < 100) return null

  // The caller advances the cursor only after the save succeeds — advancing
  // here would silently drop this delta whenever the API call fails.
  return { formatted: result, lastSeq: entries[entries.length - 1]!.seq }
}
