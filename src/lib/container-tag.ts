import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadProjectConfig } from './project-config.ts'
import { getGitRoot } from './git-utils.ts'

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16)
}

interface RepoInfo {
  name: string | null
  normalizedRemote: string | null
}

const repoInfoCache = new Map<string, RepoInfo>()

export function normalizeGitRemote(remoteUrl: string): string | null {
  const raw = remoteUrl.trim()
  if (!raw) return null

  let normalized: string
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol === 'file:') {
        normalized = `file:${decodeURIComponent(parsed.pathname)}`
      } else {
        normalized = `${parsed.hostname.toLowerCase()}${
          parsed.port ? `:${parsed.port}` : ''
        }/${parsed.pathname.replace(/^\/+/, '')}`
      }
    } catch {
      normalized = raw
    }
  } else {
    const scpStyle = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/)
    normalized = scpStyle
      ? `${scpStyle[1]!.toLowerCase()}/${scpStyle[2]!}`
      : `file:${path.resolve(raw)}`
  }

  return normalized
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase()
}

function getGitRepoInfo(cwd: string): RepoInfo {
  const cached = repoInfoCache.get(cwd)
  if (cached) return cached
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const normalizedRemote = normalizeGitRemote(remoteUrl)
    const displayRemote = remoteUrl.replace(/\/+$/, '').replace(/\.git$/i, '')
    const separator = Math.max(
      displayRemote.lastIndexOf('/'),
      displayRemote.lastIndexOf(':'),
    )
    const name = displayRemote.slice(separator + 1) || null
    const result: RepoInfo = { name, normalizedRemote }
    repoInfoCache.set(cwd, result)
    return result
  } catch {
    const result: RepoInfo = { name: null, normalizedRemote: null }
    repoInfoCache.set(cwd, result)
    return result
  }
}

export function getGitRepoName(cwd: string): string | null {
  return getGitRepoInfo(cwd).name
}

export function getProjectBasePath(cwd: string): string {
  return getGitRoot(cwd) || path.resolve(cwd)
}

export function sanitizeRepoName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return (sanitized || 'unknown').slice(0, 95).replace(/_+$/g, '') || 'unknown'
}

export function getProjectIdentity(cwd: string): string {
  const basePath = getProjectBasePath(cwd)
  const { normalizedRemote } = getGitRepoInfo(basePath)
  const isolateWorktrees = process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true'
  let localIdentity = basePath
  try {
    localIdentity = fs.realpathSync.native(basePath)
  } catch {}
  return sha256(
    !isolateWorktrees && normalizedRemote
      ? normalizedRemote
      : `path:${localIdentity}`,
  )
}

export function getGeneratedContainerTag(cwd: string): string {
  const basePath = getProjectBasePath(cwd)
  const gitRepoName = getGitRepoName(basePath)
  const repoName = gitRepoName || path.basename(basePath) || 'unknown'
  const shortName = sanitizeRepoName(repoName).slice(0, 72).replace(/_+$/g, '')
  return `repo_${shortName || 'unknown'}__${getProjectIdentity(cwd)}`
}

export function getContainerTag(cwd: string): string {
  const projectConfig = loadProjectConfig(cwd)
  return (
    projectConfig?.repoContainerTag
    || process.env.SUPERMEMORY_REPO_TAG
    || getGeneratedContainerTag(cwd)
  )
}

export function getProjectName(cwd: string): string {
  const basePath = getProjectBasePath(cwd)
  return getGitRepoName(basePath) || path.basename(basePath) || 'unknown'
}

export { getGitRoot }
