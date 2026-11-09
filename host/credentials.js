/**
 * Where the CPAMP admin key comes from.
 *
 * The DSH app is usually launched from the Dock, so its process environment is
 * clean and carries no CPA keys. Reading the shell's `process.env` alone would
 * therefore always miss. Three sources are tried in order:
 *
 *   1. `process.env.CPAMP_ADMIN_KEY` — when DSH was started from a shell.
 *   2. `~/.dsh/cpamc-pill.json`      — a per-plugin file, `{ "adminKey": "..." }`.
 *   3. `~/Applications/cpa-stack/credentials.env` — the file the stack already
 *      maintains, parsed for `CPAMP_ADMIN_KEY=` so nothing is duplicated.
 *
 * A missing key is not an error: the capsule reports `unconfigured` and keeps
 * rendering, because a sidebar that disappears teaches nothing.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the capsule looks, in priority order. Reported so the UI can say which. */
export const KEY_SOURCES = [
  { id: 'env', label: 'CPAMP_ADMIN_KEY' },
  { id: 'file', label: '~/.dsh/cpamc-pill.json' },
  { id: 'stack', label: '~/Applications/cpa-stack/credentials.env' },
]

function home() {
  return process.env.HOME || homedir()
}

/** Parse a dotenv-style text body for one key. Comments and quotes are handled. */
export function parseEnvText(text, key = 'CPAMP_ADMIN_KEY') {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    if (line.slice(0, eq).trim() !== key) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value === '' ? null : value
  }
  return null
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Resolve the admin key and remember where it came from.
 * @returns {Promise<{key: string|null, source: string|null, path: string|null}>}
 */
export async function resolveAdminKey(options = {}) {
  const env = options.env ?? process.env

  const fromEnv = env.CPAMP_ADMIN_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: 'env', path: null }
  }

  const configPath = options.configPath ?? join(home(), '.dsh', 'cpamc-pill.json')
  const configText = await readText(configPath)
  if (configText) {
    try {
      const parsed = JSON.parse(configText)
      const value = typeof parsed?.adminKey === 'string' ? parsed.adminKey.trim() : ''
      if (value !== '') return { key: value, source: 'file', path: configPath }
    } catch {
      /* a malformed config falls through to the stack file */
    }
  }

  const stackPath = options.stackPath ?? join(home(), 'Applications', 'cpa-stack', 'credentials.env')
  const stackText = await readText(stackPath)
  if (stackText) {
    const value = parseEnvText(stackText, 'CPAMP_ADMIN_KEY')
    if (value) return { key: value, source: 'stack', path: stackPath }
  }

  return { key: null, source: null, path: null }
}

/** The credential file the stack ships; used as the fallback panel link. */
export function stackPaths(options = {}) {
  const base = options.stackDir ?? join(home(), 'Applications', 'cpa-stack')
  return {
    base,
    credentials: join(base, 'credentials.env'),
    usageDb: join(base, 'cpamp', 'data', 'usage.sqlite'),
  }
}
