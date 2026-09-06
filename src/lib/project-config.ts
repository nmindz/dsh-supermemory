import fs from 'node:fs'
import path from 'node:path'
import { getGitRoot } from './git-utils.ts'

/**
 * Project-local overrides live beside the Claude Code plugin's own file so a
 * repository configured for one tool is already configured for the other.
 */
const CONFIG_DIR = path.join('.claude', '.supermemory-claude')
const CONFIG_FILE = 'config.json'

export interface ProjectConfig {
  apiKey?: string
  baseUrl?: string
  repoContainerTag?: string
  includeTools?: string[]
  signalExtraction?: boolean
  signalKeywords?: string[]
  signalTurnsBefore?: number
  recallDirective?: string | null
}

export function getConfigPath(cwd: string): string {
  const gitRoot = getGitRoot(cwd)
  const basePath = gitRoot || cwd
  return path.join(basePath, CONFIG_DIR, CONFIG_FILE)
}

export function loadProjectConfig(cwd: string): ProjectConfig | null {
  try {
    const configPath = getConfigPath(cwd)
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ProjectConfig
    }
  } catch {}
  return null
}

export function saveProjectConfig(cwd: string, config: ProjectConfig): string {
  const gitRoot = getGitRoot(cwd)
  const basePath = gitRoot || cwd
  const dirPath = path.join(basePath, CONFIG_DIR)
  const configPath = path.join(dirPath, CONFIG_FILE)

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }

  const existing = loadProjectConfig(cwd) || {}
  const data = {
    ...existing,
    ...config,
  }
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2))
  return configPath
}
