import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SETTINGS_DIR = path.join(os.homedir(), '.supermemory-claude')
export const LAST_SESSION_FILE = path.join(SETTINGS_DIR, 'last-session.json')
export const OLD_PLAIN_ID_FILE = path.join(SETTINGS_DIR, 'last-session-document-id')

function ensureDir(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true })
  }
}

/** Save the current session's Supermemory document info for deep links. */
export function saveLastSession({ id, containerTag }: { id?: string; containerTag?: string }): void {
  if (!id) return

  ensureDir()

  const data = {
    id,
    containerTag: containerTag || null,
    savedAt: new Date().toISOString(),
  }

  fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify(data, null, 2))

  // Clean up legacy plain-text file
  try {
    if (fs.existsSync(OLD_PLAIN_ID_FILE)) {
      fs.unlinkSync(OLD_PLAIN_ID_FILE)
    }
  } catch {}
}
