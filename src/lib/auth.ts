import { execFile } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Templates ship at the package root. The built bundle lives one level down
 * (`lib/*.mjs`) and the sources two (`src/lib/*.ts`), so both candidates are
 * tried. Reading is deferred to the browser flow: nothing else in the plugin
 * needs the pages, and a missing file must not break plugin load.
 */
const TEMPLATE_DIRS = ['../templates/', '../../templates/'].map(
  relative => fileURLToPath(new URL(relative, import.meta.url)),
)

function readTemplate(name: string): string {
  for (const dir of TEMPLATE_DIRS) {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf-8')
    } catch {}
  }
  return `<!DOCTYPE html><html><body><p>Supermemory: ${name} is missing from this installation.</p></body></html>`
}

const SETTINGS_DIR = path.join(os.homedir(), '.supermemory-claude')
export const CREDENTIALS_FILE = path.join(SETTINGS_DIR, 'credentials.json')

export const AUTH_BASE_URL = process.env.SUPERMEMORY_AUTH_URL
  || 'https://console.supermemory.ai/auth/connect'
const AUTH_PORT = 19876
const AUTH_TIMEOUT = 25000

export interface Credentials {
  apiKey: string
  savedAt?: string
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export async function openUrl(url: string | URL): Promise<void> {
  const target = url.toString()
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('Refusing to open non-http URL')
  }
  if (process.platform === 'win32') {
    try {
      await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', target])
      return
    } catch {}
    await execFileAsync('cmd.exe', ['/c', 'start', '""', target])
    return
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [target])
    return
  }
  await execFileAsync('xdg-open', [target])
}

function ensureDir(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true })
  }
}

export function loadCredentials(): Credentials | null {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8')) as Credentials
      if (data.apiKey) return data
    }
  } catch {}
  return null
}

export function saveCredentials(apiKey: string): void {
  ensureDir()
  const data = {
    apiKey,
    savedAt: new Date().toISOString(),
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2))
}

export function clearCredentials(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE)
    }
  } catch {}
}

/**
 * Open the browser login and resolve with the API key the callback delivers.
 * The loopback listener, port, and query parameters match the Claude Code
 * plugin's flow, so a login started from either tool writes the same
 * credentials file.
 */
export function startAuthFlow(): Promise<string> {
  return new Promise((resolve, reject) => {
    let resolved = false

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${AUTH_PORT}`)

      if (url.pathname === '/callback') {
        const apiKey = url.searchParams.get('apikey') || url.searchParams.get('api_key')

        if (apiKey?.startsWith('sm_')) {
          saveCredentials(apiKey)
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(readTemplate('auth-success.html'))
          resolved = true
          server.close()
          resolve(apiKey)
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(readTemplate('auth-error.html'))
        }
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    server.listen(AUTH_PORT, '127.0.0.1', () => {
      const callbackUrl = `http://localhost:${AUTH_PORT}/callback`
      const authUrl = `${AUTH_BASE_URL}?callback=${encodeURIComponent(callbackUrl)}&client=claude_code`
      openUrl(authUrl).catch((error: unknown) => {
        if (!resolved) {
          server.close()
          reject(new Error(`Failed to open browser: ${(error as Error).message}`))
        }
      })
    })

    server.on('error', (err) => {
      if (!resolved) {
        reject(new Error(`Failed to start auth server: ${err.message}`))
      }
    })

    setTimeout(() => {
      if (!resolved) {
        server.close()
        reject(new Error('AUTH_TIMEOUT'))
      }
    }, AUTH_TIMEOUT).unref?.()
  })
}
