import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { ConfigScope, PreloadConfig, RerankMatcherConfig, RuntimeFileConfig, RuntimeScope, ToolSearchConfig } from './types.ts'
import { validateGroups } from './groups.ts'

export const RUNTIME_FILE = 'dsh-tool-search.json'

/**
 * Resolve the harness home: `$DSH_HOME` when set (tilde-expanded), else
 * `~/.dsh`. Local mirror of the harness `resolveDshHome` so the plugin needs
 * no extra peer dependency.
 * @returns the absolute harness home directory.
 */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env !== '') {
    return env.startsWith('~') ? join(homedir(), env.slice(1)) : resolve(env)
  }
  return join(homedir(), '.dsh')
}

/** Absolute path of the user-global runtime config file. */
export function userConfigPath(): string {
  return join(resolveDshHome(), RUNTIME_FILE)
}

/** Absolute path of a project-level runtime config file. */
export function projectConfigPath(cwd: string): string {
  return join(cwd, '.dsh', RUNTIME_FILE)
}

/** Static engine tuning schema for cordis.yml. */
export const ToolSearchConfigSchema: z<ToolSearchConfig> = z.object({
  enabled: z.union([z.const('auto'), z.const('on'), z.const('off')]).default('auto'),
  thresholdPct: z.number().default(5).min(1).max(100),
  listingMaxTokens: z.number().default(4000).min(100),
  contextWindow: z.number().default(128000).min(1000),
  searchDefaultLimit: z.number().default(5).min(1),
  maxSearchLimit: z.number().default(20).min(1),
  minCatalogSize: z.number().default(12).min(0),
  configScope: z.union([z.const('user'), z.const('project'), z.const('auto')]).default('auto'),
  core: z.array(z.string()).default(['todo_write']),
  matcherTimeoutMs: z.number().default(15000).min(1000),
})

/**
 * Parse and shape-validate a runtime config file. Throws with the offending
 * path and a concrete reason so a malformed file is never silently ignored.
 * @param text - the raw file text.
 * @param path - the file path, used in diagnostics.
 * @returns the validated runtime config.
 */
export function parseRuntimeFile(text: string, path: string): RuntimeFileConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`dsh-tool-search: malformed runtime config ${path}: not valid JSON`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`dsh-tool-search: malformed runtime config ${path}: expected a JSON object`)
  }
  const record = raw as Record<string, unknown>
  const config: {
    version?: number
    scope?: RuntimeScope
    groups?: { name: string; tools?: string[]; prefixes?: string[] }[]
    matcher?: RerankMatcherConfig
    preload?: PreloadConfig
    core?: string[]
  } = {}
  if (record.version !== undefined) {
    if (typeof record.version !== 'number') throw new Error(`dsh-tool-search: ${path}: "version" must be a number`)
    config.version = record.version
  }
  if (record.scope !== undefined) {
    if (record.scope !== 'user' && record.scope !== 'project') {
      throw new Error(`dsh-tool-search: ${path}: "scope" must be "user" or "project"`)
    }
    config.scope = record.scope
  }
  if (record.groups !== undefined) {
    if (!Array.isArray(record.groups)) throw new Error(`dsh-tool-search: ${path}: "groups" must be an array`)
    const groups = record.groups.map((entry): { name: string; tools?: string[]; prefixes?: string[] } => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`dsh-tool-search: ${path}: each group must be an object`)
      }
      const group = entry as Record<string, unknown>
      if (typeof group.name !== 'string') throw new Error(`dsh-tool-search: ${path}: each group needs a string "name"`)
      const tools = arrayOfStrings(group.tools, `${path}: group "${group.name}" "tools"`)
      const prefixes = arrayOfStrings(group.prefixes, `${path}: group "${group.name}" "prefixes"`)
      return { name: group.name, ...tools !== undefined ? { tools } : {}, ...prefixes !== undefined ? { prefixes } : {} }
    })
    const reason = validateGroups(groups)
    if (reason !== undefined) throw new Error(`dsh-tool-search: ${path}: invalid groups: ${reason}`)
    config.groups = groups
  }
  if (record.matcher !== undefined) {
    if (record.matcher === null || typeof record.matcher !== 'object' || Array.isArray(record.matcher)) {
      throw new Error(`dsh-tool-search: ${path}: "matcher" must be an object`)
    }
    const matcher = record.matcher as Record<string, unknown>
    for (const key of ['endpoint', 'apiKey', 'model'] as const) {
      if (typeof matcher[key] !== 'string' || matcher[key] === '') {
        throw new Error(`dsh-tool-search: ${path}: matcher "${key}" must be a non-empty string`)
      }
    }
    const topN = matcher.topN
    if (topN !== undefined && (typeof topN !== 'number' || !Number.isInteger(topN) || topN <= 0)) {
      throw new Error(`dsh-tool-search: ${path}: matcher "topN" must be a positive integer`)
    }
    config.matcher = {
      endpoint: matcher.endpoint as string,
      apiKey: matcher.apiKey as string,
      model: matcher.model as string,
      ...topN !== undefined ? { topN } : {},
    }
  }
  if (record.preload !== undefined) {
    if (record.preload === null || typeof record.preload !== 'object' || Array.isArray(record.preload)) {
      throw new Error(`dsh-tool-search: ${path}: "preload" must be an object`)
    }
    const preload = record.preload as Record<string, unknown>
    if (typeof preload.enabled !== 'boolean') {
      throw new Error(`dsh-tool-search: ${path}: preload "enabled" must be a boolean`)
    }
    if (typeof preload.topK !== 'number' || !Number.isInteger(preload.topK) || preload.topK <= 0) {
      throw new Error(`dsh-tool-search: ${path}: preload "topK" must be a positive integer`)
    }
    config.preload = { enabled: preload.enabled, topK: preload.topK }
  }
  if (record.core !== undefined) {
    const core = arrayOfStrings(record.core, `${path}: "core"`)
    if (core !== undefined) config.core = core
  }
  return config as RuntimeFileConfig
}

function arrayOfStrings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`dsh-tool-search: ${where} must be an array of strings`)
  }
  return value as string[]
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Reads and caches runtime config files with mtime-based invalidation. A
 * missing file resolves to `undefined`; a malformed file logs a warning and
 * is treated as absent so a broken user file cannot break sessions.
 */
export class RuntimeConfigStore {
  private readonly cache = new Map<string, { mtimeMs: number; data: RuntimeFileConfig }>()
  private readonly warn: (message: string) => void

  constructor(warn: (message: string) => void) {
    this.warn = warn
  }

  /** Absolute path of the user-global config file. */
  userPath(): string {
    return userConfigPath()
  }

  /** Absolute path of the project config file for a workspace. */
  projectPath(cwd: string): string {
    return projectConfigPath(cwd)
  }

  /**
   * Resolve the effective runtime config for a workspace.
   * @param configScope - `user` (global only), `project` (project only, user
   *   fallback when absent), or `auto` (project when present, else user).
   * @param cwd - the session workspace, required for project resolution.
   * @returns the effective config, its scope, and the file path it came from.
   */
  async resolve(configScope: ConfigScope, cwd: string | undefined): Promise<{ config: RuntimeFileConfig; scope: RuntimeScope; path: string }> {
    const user = await this.read(this.userPath())
    if (configScope === 'user') {
      return { config: user ?? {}, scope: 'user', path: this.userPath() }
    }
    if (cwd !== undefined) {
      const project = await this.read(this.projectPath(cwd))
      if (project !== undefined) {
        return { config: project, scope: 'project', path: this.projectPath(cwd) }
      }
      if (configScope === 'project') {
        this.warn(`dsh-tool-search: no project config at ${this.projectPath(cwd)}; falling back to the user config`)
      }
    } else if (configScope === 'project') {
      this.warn('dsh-tool-search: configScope "project" but the session has no workspace; falling back to the user config')
    }
    return { config: user ?? {}, scope: 'user', path: this.userPath() }
  }

  /**
   * Persist a runtime config file and invalidate its cache entry.
   * @param scope - where to write (`project` requires a workspace).
   * @param cwd - the session workspace for project writes.
   * @param data - the config to persist (version/scope stamped by the caller).
   * @returns the absolute path written.
   */
  async write(scope: RuntimeScope, cwd: string | undefined, data: RuntimeFileConfig): Promise<string> {
    if (scope === 'project' && cwd === undefined) {
      throw new Error('dsh-tool-search: cannot write a project config without a workspace (cwd)')
    }
    const path = scope === 'project' ? this.projectPath(cwd!) : this.userPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ version: 1, scope, ...data }, null, 2)}\n`, 'utf8')
    this.cache.delete(path)
    return path
  }

  /** Drop all cached reads (used by tests and by the update tool). */
  invalidateAll(): void {
    this.cache.clear()
  }

  private async read(path: string): Promise<RuntimeFileConfig | undefined> {
    try {
      const meta = await stat(path)
      const cached = this.cache.get(path)
      if (cached !== undefined && cached.mtimeMs === meta.mtimeMs) {
        return cached.data
      }
      const text = await readFile(path, 'utf8')
      const data = parseRuntimeFile(text, path)
      this.cache.set(path, { mtimeMs: meta.mtimeMs, data })
      return data
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      this.warn(`dsh-tool-search: ignoring unreadable runtime config ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}
