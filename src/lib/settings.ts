import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadCredentials } from './auth.ts'
import { loadProjectConfig, type ProjectConfig } from './project-config.ts'

const BASE_URL = 'https://api.supermemory.ai'
/**
 * Shared with the Claude Code plugin on purpose: one browser login, one
 * credentials file, and one settings document serve both harnesses.
 */
export const SETTINGS_DIR = path.join(os.homedir(), '.supermemory-claude')
export const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')

export interface Settings {
  includeTools: string[]
  maxProfileItems: number
  debug: boolean
  injectProfile: boolean
  recallDirective: string | null
  signalExtraction: boolean
  signalKeywords: string[]
  signalTurnsBefore: number
}

export const DEFAULT_SETTINGS: Settings = {
  includeTools: [],
  maxProfileItems: 5,
  debug: false,
  injectProfile: true,
  recallDirective: null,
  signalExtraction: false,
  signalKeywords: [
    'remember',
    'implementation',
    'refactor',
    'architecture',
    'decision',
    'important',
    'bug',
    'fix',
    'solved',
    'solution',
    'pattern',
    'approach',
    'design',
    'tradeoff',
    'migrate',
    'upgrade',
    'deprecate',
  ],
  signalTurnsBefore: 3,
}

export function loadSettings(): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS }
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')))
    }
  } catch (err) {
    console.error(`Settings: Failed to load ${SETTINGS_FILE}: ${(err as Error).message}`)
  }
  if (process.env.SUPERMEMORY_DEBUG === 'true') settings.debug = true
  return settings
}

export function getApiKey(cwd?: string, projectConfig?: ProjectConfig | null): string {
  if (process.env.SUPERMEMORY_CC_API_KEY) {
    return process.env.SUPERMEMORY_CC_API_KEY
  }

  const resolved = projectConfig ?? loadProjectConfig(cwd || process.cwd())
  if (resolved?.apiKey) return resolved.apiKey

  const credentials = loadCredentials()
  if (credentials?.apiKey) return credentials.apiKey

  throw new Error('NO_API_KEY')
}

function normalizeBaseUrl(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null

  const trimmed = baseUrl.trim()
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return trimmed
  } catch {
    return null
  }
}

export function getBaseUrl(cwd?: string, projectConfig?: ProjectConfig | null): string {
  const resolved = projectConfig ?? loadProjectConfig(cwd || process.cwd())
  const configured = process.env.SUPERMEMORY_API_URL || resolved?.baseUrl || BASE_URL
  const normalized = normalizeBaseUrl(configured)
  if (!normalized) {
    throw new Error('Invalid baseUrl: expected an absolute http(s) URL')
  }
  return normalized
}

export function debugLog(settings: Settings, message: string, data?: unknown): void {
  if (settings.debug) {
    const timestamp = new Date().toISOString()
    console.error(
      data
        ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
        : `[${timestamp}] ${message}`,
    )
  }
}

export function getIncludeTools(cwd?: string): string[] {
  const settings = loadSettings()
  const projectConfig = loadProjectConfig(cwd || process.cwd())
  const merged = [
    ...new Set([
      ...(settings.includeTools || []),
      ...(projectConfig?.includeTools || []),
    ]),
  ]
  return merged.map(t => t.toLowerCase())
}

export function shouldIncludeTool(toolName: string, includeList: string[]): boolean {
  if (includeList.length === 0) return false
  return includeList.includes(toolName.toLowerCase())
}

export interface SignalConfig {
  enabled: boolean
  keywords: string[]
  turnsBefore: number
}

export function getSignalConfig(cwd?: string): SignalConfig {
  const settings = loadSettings()
  const projectConfig = loadProjectConfig(cwd || process.cwd())

  const enabled = projectConfig?.signalExtraction !== undefined
    ? projectConfig.signalExtraction
    : settings.signalExtraction || false

  const keywords = [
    ...new Set([
      ...(settings.signalKeywords || DEFAULT_SETTINGS.signalKeywords),
      ...(projectConfig?.signalKeywords || []),
    ]),
  ].map(k => k.toLowerCase())

  const turnsBefore = projectConfig?.signalTurnsBefore
    || settings.signalTurnsBefore
    || DEFAULT_SETTINGS.signalTurnsBefore

  return { enabled, keywords, turnsBefore }
}

export function getRecallConfig(cwd?: string): { directive: string | null } {
  const settings = loadSettings()
  const projectConfig = loadProjectConfig(cwd || process.cwd())
  return {
    directive: projectConfig?.recallDirective || settings.recallDirective || null,
  }
}
