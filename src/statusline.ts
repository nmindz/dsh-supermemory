/**
 * Self-contained statusline renderer. Reads per-session state written by the
 * plugin from the fixed ~/.supermemory-claude/statusline directory.
 *
 * DSH's own status line is host-owned, so this renderer is not installed into
 * a harness setting the way the Claude Code plugin installs one. It stays a
 * first-class entry point (`dsh-supermemory/statusline`) so any status bar that
 * can run a command — tmux, starship, a wrapper shell, or Claude Code itself —
 * renders the identical line from the identical state.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const STATE_ROOT = path.join(
  os.homedir(),
  '.supermemory-claude',
  'statusline',
  'statusline-state',
)
const SCHEMA_VERSION = 1

export const SAVING_TTL_MS = 30 * 1000
export const ERROR_TTL_MS = 60 * 1000
export const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000
export const STATUSLINE_INPUT_TIMEOUT_MS = 500

// Mid-luminance tint of the brand blue (#3B35F3): terminals can't report
// their theme, so the palette must clear both dark and light backgrounds.
const BLUE = '\x1b[38;2;124;120;250m'
const WHITE = '\x1b[97m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

// Animation engine. A status bar re-runs this script on activity and on an
// idle timer — there is no persistent process, so every frame must be a pure
// function of (state, now). The idle floor is one render per second, so frames
// are choreographed as big distinct poses: the shimmer crest jumps 3 letters
// and the spinner 3 steps per tick (both strides coprime with their cycle
// lengths, so every pose is visited). At a faster refresh the same math plays
// back smoothly.
export const TICK_MS = 1000
const EMPHASIS_TICKS = 2
const PANE_TICKS = 4
const CREST_STRIDE = 3
const SPINNER_STRIDE = 3
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SHIMMER_HI = '\x1b[38;2;224;223;255m'
const SHIMMER_MID = '\x1b[38;2;170;167;255m'
const GRAY = '\x1b[38;5;245m'

interface StateRecord {
  version?: number
  event?: string
  updatedAt?: number
  status?: string
  memoryItemsLoaded?: number
  count?: number
  results?: number
  memories?: number
}

export interface StatuslineState {
  context?: StateRecord | null
  capture?: StateRecord | null
  search?: StateRecord | null
}

type Status =
  | { kind: 'saving' }
  | { kind: 'error' }
  | { kind: 'ready' }
  | { kind: 'tally'; parts: string[]; savedAt?: number; recalledAt?: number }

function formatAge(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

function shimmer(word: string, tick: number): string {
  const crest = (tick * CREST_STRIDE) % word.length
  let out = ''
  for (let i = 0; i < word.length; i++) {
    const d = Math.abs(i - crest)
    out += (d === 0 ? SHIMMER_HI : d <= 2 ? SHIMMER_MID : BLUE) + word[i]
  }
  return out + RESET
}

function readEvent(sessionDir: string, event: string): StateRecord | null {
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(sessionDir, `${event}.json`), 'utf8'),
    ) as StateRecord | null
    if (
      record?.version !== SCHEMA_VERSION
      || record?.event !== event
      || !Number.isFinite(record?.updatedAt)
    ) {
      return null
    }
    return record
  } catch {
    return null
  }
}

export function readState(sessionId: unknown): StatuslineState {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return {}
  const sessionDir = path.join(
    STATE_ROOT,
    crypto.createHash('sha256').update(sessionId.trim()).digest('hex'),
  )
  return {
    context: readEvent(sessionDir, 'context'),
    capture: readEvent(sessionDir, 'capture'),
    search: readEvent(sessionDir, 'search'),
  }
}

function isFresh(
  record: StateRecord | null | undefined,
  ttl: number,
  now: number,
  contextUpdatedAt = 0,
): record is StateRecord & { updatedAt: number } {
  return Boolean(
    record
    && typeof record.updatedAt === 'number'
    && record.updatedAt >= contextUpdatedAt
    && now - record.updatedAt >= 0
    && now - record.updatedAt < ttl,
  )
}

// Resting status is a live session tally — the captured count ticks up on
// every turn and recalls on every search, so the line is always moving.
// Transient states (saving, errors) briefly take over.
function getStatus(state: StatuslineState, now: number): Status | null {
  const { context, capture, search } = state
  const generation = Number.isFinite(context?.updatedAt) ? context!.updatedAt! : 0

  if (capture?.status === 'saving' && isFresh(capture, SAVING_TTL_MS, now, generation)) {
    return { kind: 'saving' }
  }
  if (capture?.status === 'error' && isFresh(capture, ERROR_TTL_MS, now, generation)) {
    return { kind: 'error' }
  }

  const contextReady = isFresh(context, CONTEXT_TTL_MS, now) && context!.status === 'ready'
  const parts: string[] = []
  if (contextReady && (context!.memoryItemsLoaded ?? 0) > 0) {
    parts.push(`${context!.memoryItemsLoaded} loaded`)
  }
  let savedAt: number | undefined
  let recalledAt: number | undefined
  if ((capture?.count ?? 0) > 0 && (capture!.updatedAt ?? 0) >= generation) {
    parts.push(`${capture!.count} captured`)
    savedAt = capture!.updatedAt
  }
  if ((search?.count ?? 0) > 0 && (search!.updatedAt ?? 0) >= generation) {
    // Memories in context beats event counts; MCP-tool searches inject
    // nothing trackable, so those sessions fall back to the recall tally.
    parts.push(
      (search!.memories ?? 0) > 0
        ? `${search!.memories} recalled`
        : `${search!.count} ${search!.count === 1 ? 'recall' : 'recalls'}`,
    )
    recalledAt = search!.updatedAt
  }

  if (parts.length > 0) {
    return {
      kind: 'tally',
      parts,
      ...savedAt !== undefined ? { savedAt } : {},
      ...recalledAt !== undefined ? { recalledAt } : {},
    }
  }
  return contextReady ? { kind: 'ready' } : null
}

export function getStatusLabel(state: StatuslineState, now = Date.now()): string | null {
  const status = getStatus(state, now)
  if (!status) return null
  if (status.kind === 'saving') return 'saving session'
  if (status.kind === 'error') return 'session sync failed'
  if (status.kind === 'ready') return 'ready'
  return status.parts.join(' · ')
}

export function renderStatusline(
  state: StatuslineState,
  options: { now?: number; color?: boolean } = {},
): string {
  const now = options.now ?? Date.now()
  const status = getStatus(state, now)
  if (!status) return ''
  if (options.color === false) {
    return `◪ supermemory · ${getStatusLabel(state, now)}`
  }

  const tick = Math.floor(now / TICK_MS)
  const brand = `${BLUE}${BOLD}◪${RESET} ${BOLD}${shimmer('supermemory', tick)}${RESET}`

  if (status.kind === 'saving') {
    const spin = SPINNER[(tick * SPINNER_STRIDE) % SPINNER.length]
    return `${brand} ${BLUE}${spin}${RESET} ${WHITE}saving session${RESET}`
  }
  if (status.kind === 'error') {
    return `${brand} ${WHITE}· session sync failed${RESET}`
  }
  if (status.kind === 'ready') {
    return `${brand} ${WHITE}· ready${RESET}`
  }

  // Rotate real content, not just paint: the tally pane alternates with live
  // relative ages that tick upward, so the words themselves keep changing.
  const panes: (string | null)[] = [null]
  if (status.savedAt) panes.push(`saved ${formatAge(now - status.savedAt)} ago`)
  if (status.recalledAt) {
    panes.push(`recalled ${formatAge(now - status.recalledAt)} ago`)
  }
  const pane = panes[Math.floor(tick / PANE_TICKS) % panes.length]
  if (pane) return `${brand} ${WHITE}·${RESET} ${WHITE}${pane}${RESET}`

  const emphasized = Math.floor(tick / EMPHASIS_TICKS) % status.parts.length
  const parts = status.parts.map((part, i) =>
    i === emphasized ? `${WHITE}${BOLD}${part}${RESET}` : `${GRAY}${part}${RESET}`,
  )
  return `${brand} ${WHITE}·${RESET} ${parts.join(`${GRAY} · ${RESET}`)}`
}

export function readStatuslineInput(
  input: Readable & { isTTY?: boolean } = process.stdin,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? STATUSLINE_INPUT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let data = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      try {
        input.pause()
        ;(input as { unref?: () => void }).unref?.()
      } catch {}
    }

    const finish = (callback: (value: never) => void, value: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      callback(value as never)
    }

    const parse = (final: boolean): void => {
      const value = data.trim()
      if (!value) {
        if (final) finish(resolve as never, {})
        return
      }
      try {
        finish(resolve as never, JSON.parse(value))
      } catch (error) {
        if (final) {
          finish(
            reject as never,
            new Error(`Failed to parse statusline JSON: ${(error as Error).message}`),
          )
        }
      }
    }

    function onData(chunk: string | Buffer): void {
      data += chunk
      parse(false)
    }
    function onEnd(): void {
      parse(true)
    }
    function onError(error: unknown): void {
      finish(reject as never, error)
    }

    input.setEncoding('utf8')
    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onError)

    if (input.isTTY) {
      finish(resolve as never, {})
      return
    }
    if (!settled) timer = setTimeout(() => parse(true), timeoutMs)
  })
}

async function main(): Promise<void> {
  try {
    const input = await readStatuslineInput()
    const sessionId = (input as { session_id?: unknown }).session_id
    if (!sessionId) return
    const output = renderStatusline(readState(sessionId))
    if (output) process.stdout.write(output)
  } catch {
    // A status line must fail silently so it never disrupts its host.
  }
}

/**
 * Whether this module was run as the entry point.
 *
 * Comparing `import.meta.url` to `file://${process.argv[1]}` is wrong twice
 * over: the template leaves spaces and other reserved characters unescaped,
 * and `import.meta.url` is already resolved through symlinks while `argv[1]`
 * is not — so on macOS a script under `/tmp` (a symlink to `/private/tmp`)
 * never matched and the renderer silently printed nothing. Compare real paths.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry)
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  void main()
}
