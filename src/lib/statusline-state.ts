import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCHEMA_VERSION = 1
const STATE_DIR_NAME = 'statusline-state'
const EVENT_NAMES = new Set(['context', 'capture', 'search'])
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type StatuslineEvent = 'context' | 'capture' | 'search'

export interface StatuslineRecord {
  version: number
  event: StatuslineEvent
  updatedAt: number
  [key: string]: unknown
}

export interface StatuslineState {
  context?: StatuslineRecord | null
  capture?: StatuslineRecord | null
  search?: StatuslineRecord | null
}

// Fixed location: the plugin and the statusline renderer run in different
// process environments, so neither may trust env vars to find the other's state.
export function resolveStatuslineDataDir(explicitDir?: string): string {
  return explicitDir || path.join(os.homedir(), '.supermemory-claude', 'statusline')
}

function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function normalizeCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.floor(count))
}

function getStateRoot(dataDir?: string): string {
  return path.join(resolveStatuslineDataDir(dataDir), STATE_DIR_NAME)
}

export function getSessionDir(sessionId: unknown, dataDir?: string): string | null {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null
  return path.join(getStateRoot(dataDir), hashValue(sessionId.trim()))
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

export function atomicWriteJson(file: string, value: unknown): void {
  const dir = path.dirname(file)
  ensurePrivateDir(dir)
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )

  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    fs.renameSync(temporary, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The rename already removed the temporary file in the normal path.
    }
  }
}

function sanitizeEvent(event: StatuslineEvent, data: Record<string, unknown>): Record<string, unknown> {
  if (event === 'context') {
    const status = ['loading', 'ready', 'error'].includes(data.status as string)
      ? data.status
      : 'ready'
    return {
      status,
      memoryItemsLoaded: normalizeCount(data.memoryItemsLoaded),
    }
  }

  if (event === 'capture') {
    const status = ['saving', 'saved', 'error'].includes(data.status as string)
      ? data.status
      : 'error'
    return { status, count: normalizeCount(data.count) }
  }

  return {
    results: normalizeCount(data.results),
    count: normalizeCount(data.count),
    memories: normalizeCount(data.memories),
  }
}

export function writeState(
  sessionId: unknown,
  event: StatuslineEvent,
  data: Record<string, unknown> = {},
  options: { dataDir?: string; now?: number } = {},
): boolean {
  if (!EVENT_NAMES.has(event)) return false
  const sessionDir = getSessionDir(sessionId, options.dataDir)
  if (!sessionDir) return false

  try {
    const record = {
      version: SCHEMA_VERSION,
      event,
      updatedAt: options.now ?? Date.now(),
      ...sanitizeEvent(event, data),
    }
    atomicWriteJson(path.join(sessionDir, `${event}.json`), record)
    return true
  } catch {
    return false
  }
}

function readEvent(sessionDir: string, event: StatuslineEvent): StatuslineRecord | null {
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(sessionDir, `${event}.json`), 'utf8'),
    ) as StatuslineRecord | null
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

export function readState(sessionId: unknown, options: { dataDir?: string } = {}): StatuslineState {
  const sessionDir = getSessionDir(sessionId, options.dataDir)
  if (!sessionDir) return {}

  return {
    context: readEvent(sessionDir, 'context'),
    capture: readEvent(sessionDir, 'capture'),
    search: readEvent(sessionDir, 'search'),
  }
}

export function countLoadedProfileItems(
  profileResult: { profile?: { static?: unknown[]; dynamic?: unknown[] } } | null | undefined,
  maxItems: number,
): number {
  const limit = normalizeCount(maxItems)
  const staticCount = Math.min(profileResult?.profile?.static?.length || 0, limit)
  const dynamicCount = Math.min(profileResult?.profile?.dynamic?.length || 0, limit)
  return staticCount + dynamicCount
}

export function pruneState(options: { dataDir?: string; now?: number } = {}): void {
  const root = getStateRoot(options.dataDir)
  const cutoff = (options.now ?? Date.now()) - SESSION_RETENTION_MS

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
      const sessionDir = path.join(root, entry.name)
      let newest = 0
      try {
        newest = fs.statSync(sessionDir).mtimeMs
        for (const file of fs.readdirSync(sessionDir)) {
          newest = Math.max(newest, fs.statSync(path.join(sessionDir, file)).mtimeMs)
        }
      } catch {
        // A concurrent writer or cleanup may be changing this directory.
        continue
      }
      if (newest < cutoff) {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    }
  } catch {
    // Cleanup is best effort and must never affect the agent loop.
  }
}
