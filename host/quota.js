/**
 * Quota windows for the CPA pill.
 *
 * Two shapes are read, both from CPAMP's read-only management API:
 *   - kimi/… usage windows via `POST /v0/management/api-call`
 *   - WorkBuddy credits via `GET /v0/management/plugins/workbuddy/credits`
 *
 * Only read paths are touched. Nothing here sends a model call, consumes a
 * credit, or writes to the upstream account.
 */

/** The only upstream endpoints this module is willing to relay. */
export const QUOTA_ENDPOINTS = {
  kimi: 'https://api.kimi.com/coding/v1/usages',
  claude: 'https://api.anthropic.com/api/oauth/usage',
  codex: 'https://chatgpt.com/backend-api/wham/usage',
}

/**
 * Anything matching these markers is a billing or completion surface.
 * A relay request is refused outright if it names one — deep defence against
 * a future edit accidentally spending quota.
 */
export const FORBIDDEN_MARKERS = ['/consume', '/completions', '/chat/completions', 'reset-credits']

const QUOTA_TIMEOUT_MS = 9000
const QUOTA_CACHE_MS = 60000

function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function pick(row, ...keys) {
  if (!row || typeof row !== 'object') return undefined
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key]
  }
  return undefined
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return null
  const raw = typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(raw)) return null
  const ms = typeof value === 'number' && raw < 1e12 ? raw * 1000 : raw
  return Number.isFinite(ms) ? ms : null
}

/** `{duration, timeUnit}` → hours. Unknown units yield null rather than a guess. */
export function periodHours(duration, timeUnit) {
  const amount = toInt(duration)
  if (amount === null || amount <= 0) return null
  const unit = String(timeUnit ?? '').toUpperCase()
  if (unit.includes('MINUTE')) return Math.round((amount / 60) * 100) / 100
  if (unit.includes('HOUR')) return amount
  if (unit.includes('DAY')) return amount * 24
  if (unit.includes('WEEK')) return amount * 168
  if (unit.includes('MONTH')) return amount * 720
  return null
}

/** Label a window by its period when the upstream gives no name. */
export function windowLabel(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return 'limit'
  if (hours <= 6) return `${Math.round(hours)}h`
  if (hours <= 36) return `${Math.round(hours)}h`
  if (hours <= 192) return `${Math.round(hours / 24)}d`
  return `${Math.round(hours / 168)}w`
}

/**
 * Flatten a kimi `usages` body into `{id, label, percent, remaining, resetsAt, periodHours}`.
 *
 * `percent` is the USED share, 0–100 — the caller renders `100 - percent`.
 * Rows without a positive limit are dropped rather than shown as empty bars.
 */
export function parseKimiUsage(payload, now = Date.now()) {
  const source = payload && typeof payload === 'object' ? payload : {}
  const windows = []

  const addRow = (data, windowSource, fallbackLabel) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const limit = toInt(pick(data, 'limit'))
    let used = toInt(pick(data, 'used'))
    if (used === null) {
      const remaining = toInt(pick(data, 'remaining'))
      if (remaining !== null && limit !== null) used = limit - remaining
    }
    if (limit === null || limit <= 0 || used === null) return
    const hours = periodHours(
      pick(windowSource ?? {}, 'duration') ?? pick(data, 'duration'),
      pick(windowSource ?? {}, 'timeUnit', 'time_unit') ?? pick(data, 'timeUnit', 'time_unit'),
    )
    const label = String(
      pick(data, 'name', 'title', 'scope') ?? fallbackLabel ?? windowLabel(hours),
    )
    windows.push({
      id: `kimi:${label}`,
      label,
      percent: clampPercent((used / limit) * 100),
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: parseTime(pick(data, 'resetTime', 'reset_time', 'resetsAt')),
      periodHours: hours,
    })
  }

  // The top-level `usage` block is one window with no explicit period.
  if (source.usage && typeof source.usage === 'object') {
    addRow(source.usage, null, 'weekly')
  }

  // `limits[]` carries the short windows (5h style) with an explicit duration.
  for (const item of Array.isArray(source.limits) ? source.limits : []) {
    if (!item || typeof item !== 'object') continue
    const nested = pick(item, 'detail')
    const data = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : item
    const windowSource = pick(item, 'window')
    addRow(
      data,
      windowSource && typeof windowSource === 'object' ? windowSource : null,
      pick(item, 'name', 'title', 'scope'),
    )
  }

  // Deduplicate by id, keeping the tightest (most used) reading.
  const byId = new Map()
  for (const window of windows) {
    const previous = byId.get(window.id)
    if (!previous || window.percent > previous.percent) byId.set(window.id, window)
  }
  const ordered = [...byId.values()].sort((a, b) => (a.periodHours ?? 1e9) - (b.periodHours ?? 1e9))

  // A window that has already reset is not a current constraint.
  return ordered.filter((window) => window.resetsAt === null || window.resetsAt > now)
}

/**
 * Sum WorkBuddy credit packs for one account.
 * `remain`/`size` are absolute amounts, so this is a credits reading, not a percent.
 */
export function parseWorkbuddyCredits(entry) {
  const credits = entry?.credits
  if (!credits || typeof credits !== 'object') return null
  const packages = Array.isArray(credits.packages) ? credits.packages : []
  const totalSize = Number(credits.total_size)
  const totalRemain = Number(credits.total_remain)
  const size = Number.isFinite(totalSize) && totalSize > 0
    ? totalSize
    : packages.reduce((sum, item) => sum + (Number(item?.size) || 0), 0)
  const remain = Number.isFinite(totalRemain)
    ? totalRemain
    : packages.reduce((sum, item) => sum + (Number(item?.remain) || 0), 0)
  if (size <= 0) return null
  const used = Math.max(0, size - remain)

  // The nearest expiry is the one that actually constrains spending.
  let resetsAt = null
  for (const item of packages) {
    if ((Number(item?.remain) || 0) <= 0) continue
    const end = parseTime(pick(item, 'cycle_end', 'cycleEnd'))
    if (end !== null && (resetsAt === null || end < resetsAt)) resetsAt = end
  }

  return {
    id: `credits:${entry?.auth_index ?? ''}`,
    label: 'credits',
    percent: clampPercent((used / size) * 100),
    limit: size,
    used,
    remaining: remain,
    resetsAt,
    periodHours: null,
  }
}

/** Upstream error envelope: `{status_code, body}` where `body` is JSON text. */
export function unwrapEnvelope(envelope) {
  const status = Number(envelope?.status_code)
  if (!Number.isInteger(status)) return { ok: false, error: 'bad envelope' }
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` }
  if (typeof envelope?.body !== 'string') return { ok: false, error: 'bad body' }
  try {
    return { ok: true, value: JSON.parse(envelope.body) }
  } catch {
    return { ok: false, error: 'bad json' }
  }
}

function assertReadOnly(url) {
  const text = String(url ?? '')
  for (const marker of FORBIDDEN_MARKERS) {
    if (text.includes(marker)) return false
  }
  return true
}

async function postJson(fetchImpl, url, key, body, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort)
  const timer = setTimeout(abort, QUOTA_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, value: await response.json() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: signal?.aborted ? 'aborted' : message }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}

async function getJson(fetchImpl, url, key, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort)
  const timer = setTimeout(abort, QUOTA_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, value: await response.json() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: signal?.aborted ? 'aborted' : message }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abort)
  }
}

/**
 * Read quota windows for every account CPAMP knows about.
 *
 * Returns `{at, windows, credits, errors}` where `windows` carries the tightest
 * window per provider (used by the pill face) and `credits` the WorkBuddy totals.
 */
export function createQuotaReader(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:18317'
  const now = options.now ?? (() => Date.now())
  let cache

  return async function read(key, accounts, signal) {
    const at = now()
    if (cache !== undefined && at - cache.at < QUOTA_CACHE_MS) return cache.payload

    const payload = { at, windows: [], credits: [], errors: [] }
    if (!key || !Array.isArray(accounts) || accounts.length === 0) {
      cache = { at, payload }
      return payload
    }

    // WorkBuddy credits: one call returns every account.
    const hasWorkbuddy = accounts.some((account) => account.provider === 'workbuddy')
    if (hasWorkbuddy) {
      const response = await getJson(
        fetchImpl,
        `${baseUrl}/v0/management/plugins/workbuddy/credits`,
        key,
        signal,
      )
      if (response.ok) {
        for (const entry of Array.isArray(response.value?.accounts) ? response.value.accounts : []) {
          const window = parseWorkbuddyCredits(entry)
          if (window) payload.credits.push({ authIndex: String(entry.auth_index ?? ''), ...window })
        }
      } else {
        payload.errors.push(`credits: ${response.error}`)
      }
    }

    // Usage windows: api-call relays a read-only GET per account.
    for (const account of accounts) {
      const endpoint = QUOTA_ENDPOINTS[account.provider]
      if (!endpoint) continue
      if (!account.authIndex) continue
      if (!assertReadOnly(endpoint)) {
        payload.errors.push(`${account.provider}: blocked`)
        continue
      }
      const response = await postJson(
        fetchImpl,
        `${baseUrl}/v0/management/api-call`,
        key,
        {
          auth_index: account.authIndex,
          method: 'GET',
          url: endpoint,
          header: { Authorization: 'Bearer $TOKEN$' },
        },
        signal,
      )
      if (!response.ok) {
        payload.errors.push(`${account.provider}: ${response.error}`)
        continue
      }
      const inner = unwrapEnvelope(response.value)
      if (!inner.ok) {
        payload.errors.push(`${account.provider}: ${inner.error}`)
        continue
      }
      const parser = account.provider === 'kimi' ? parseKimiUsage : null
      if (!parser) continue
      for (const window of parser(inner.value, at)) {
        payload.windows.push({ provider: account.provider, label: account.label, ...window })
      }
    }

    cache = { at, payload }
    return payload
  }
}
