/**
 * Read CPAMP's read-only management API and turn it into the capsule payload.
 *
 * Two endpoints carry everything the capsule shows:
 *
 *   GET /v0/management/dashboard/summary?today_start_ms=<ms>
 *     → today.total_tokens / total_calls / success_rate / average_latency_ms,
 *       rolling_30m.rpm / .tpm, top_models_today
 *   GET /v0/management/auth-files
 *     → one row per upstream account: provider, status, disabled, cooldowns
 *
 * Money is deliberately absent. These accounts are reverse-proxied
 * subscriptions with no real invoice, and CPAMP's price table is empty until a
 * price sync runs, so `total_cost` is always 0. Reporting 0 as a real number
 * would be worse than reporting nothing.
 *
 * Every failure mode resolves to a payload rather than a throw: an unreachable
 * service has to render as "offline", not as an empty sidebar slot.
 */

import { createQuotaReader } from './quota.js'

/** Result is reused across requests inside this window. */
const CACHE_MS = 15_000

/** Per-request deadline against CPAMP. It is a local service; 6s is generous. */
const TIMEOUT_MS = 6_000

/** Panel the capsule's footer button opens. */
export const PANEL_URL = 'http://127.0.0.1:18317/management.html'

/** Start of the local day in epoch milliseconds. */
export function todayStartMs(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local `YYYY-MM-DD`, the day key the client compares against. */
export function dayKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function emptyAccount() {
  return {
    label: '',
    provider: '',
    status: 'unknown',
    disabled: false,
    cooling: false,
    cooldownUntilMs: 0,
    failed: 0,
    success: 0,
  }
}

/**
 * CPAMP's counters, with the double-count removed.
 *
 * The load-bearing fact, measured against the live panel:
 *   total_tokens = input_tokens + output_tokens
 * and `input_tokens` ALREADY contains `cache_read_tokens`. Adding cache reads on
 * top (the naive fold) inflated one real day from 9.09M to 17.61M. So:
 *   - `fresh` = input - cached is the un-cached prompt side,
 *   - `total` keeps CPAMP's own definition, which is what the panel shows.
 * `reasoning` is reported apart because DeepSeek bills it inside output.
 */
export function tokensOf(today) {
  const input = Number(today?.input_tokens) || 0
  const output = Number(today?.output_tokens) || 0
  const cached = (Number(today?.cache_read_tokens) || 0) + (Number(today?.cache_tokens) || 0)
  const reasoning = Number(today?.reasoning_tokens) || 0
  /* Cache reads can never exceed the prompt side; clamp so a malformed row
     cannot produce a negative "fresh" bucket. */
  const fresh = Math.max(0, input - cached)
  const reported = Number(today?.total_tokens) || 0
  /* The parts are authoritative when CPAMP reports nothing; otherwise its own
     total wins, since that is the number the panel displays. */
  return { input, output, cached, reasoning, fresh, total: reported > 0 ? reported : input + output }
}

/**
 * Health of the upstream pool, in the one word the pill's dot can carry:
 *   ok       — at least one active account, no failures today
 *   degraded — service reachable but every account cooling/disabled, or calls failed
 *   offline  — CPAMP did not answer
 *   unconfigured — no admin key was resolvable
 */
export function healthOf({ reachable, accounts, successRate, failureCalls, totalCalls }) {
  if (reachable !== true) return 'offline'
  const usable = accounts.filter((account) => account.disabled !== true && account.cooling !== true)
  if (accounts.length > 0 && usable.length === 0) return 'degraded'
  if (totalCalls > 0 && (failureCalls > 0 || successRate < 1)) return 'degraded'
  return 'ok'
}

/** Fetch JSON with a deadline and an abort signal; returns `{ok, value, error}`. */
async function getJson(fetchImpl, url, key, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener?.('abort', abort)
  const timer = setTimeout(abort, TIMEOUT_MS)
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

/** Normalise one `auth-files` row. */
export function accountOf(row, now = Date.now()) {
  const base = emptyAccount()
  if (!row || typeof row !== 'object') return base
  const cooldowns = Array.isArray(row.cooldowns) ? row.cooldowns : []
  const until = cooldowns.reduce((max, item) => {
    const value = Number(item?.until_ms ?? item?.until ?? 0) || 0
    return value > max ? value : max
  }, 0)
  return {
    label: String(row.label ?? row.name ?? row.id ?? ''),
    provider: String(row.provider ?? row.type ?? ''),
    authIndex: String(row.auth_index ?? row.authIndex ?? ''),
    status: String(row.status ?? 'unknown'),
    disabled: row.disabled === true,
    cooling: until > now,
    cooldownUntilMs: until,
    failed: Number(row.failed) || 0,
    success: Number(row.success) || 0,
  }
}

/**
 * Build the reader the Host route calls.
 * @param options.resolveAdminKey credential resolver
 * @param options.fetchImpl fetch implementation (injected for offline tests)
 * @param options.baseUrl CPAMP origin
 */
export function createStatusReader(options = {}) {
  const resolve = options.resolveAdminKey
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:18317'
  const now = options.now ?? (() => Date.now())

  let cache

  return async function read(signal) {
    const at = now()
    if (cache !== undefined && at - cache.at < CACHE_MS) return cache.payload

    let key = null
    let source = null
    if (typeof resolve === 'function') {
      const resolved = await resolve()
      key = resolved?.key ?? null
      source = resolved?.source ?? null
    }

    if (!key) {
      const payload = {
        at,
        day: dayKey(at),
        reachable: false,
        reason: 'unconfigured',
        keySource: null,
        panelUrl: PANEL_URL,
        health: 'unconfigured',
        today: { total: 0, input: 0, output: 0, cached: 0, reasoning: 0 },
        calls: { total: 0, failed: 0, successRate: 0, averageLatencyMs: 0 },
        rolling: { rpm: 0, tpm: 0 },
        models: [],
        accounts: [],
      }
      cache = { at, payload }
      return payload
    }

    const dayStart = todayStartMs(at)
    const [summary, files] = await Promise.all([
      getJson(fetchImpl, `${baseUrl}/v0/management/dashboard/summary?today_start_ms=${dayStart}`, key, signal),
      getJson(fetchImpl, `${baseUrl}/v0/management/auth-files`, key, signal),
    ])

    const reachable = summary.ok === true
    const today = summary.ok ? (summary.value?.today ?? {}) : {}
    const rolling = summary.ok ? (summary.value?.rolling_30m ?? {}) : {}
    const tokens = tokensOf(today)
    const totalCalls = Number(today.total_calls) || 0
    const failureCalls = Number(today.failure_calls) || 0
    const successRate = Number(today.success_rate)
    const accounts = (files.ok ? (files.value?.files ?? []) : []).map((row) => accountOf(row, at))

    const payload = {
      at,
      day: dayKey(at),
      reachable,
      reason: reachable ? null : (summary.error ?? 'unreachable'),
      keySource: source,
      panelUrl: PANEL_URL,
      health: healthOf({
        reachable,
        accounts,
        successRate: Number.isFinite(successRate) ? successRate : 1,
        failureCalls,
        totalCalls,
      }),
      today: tokens,
      calls: {
        total: totalCalls,
        failed: failureCalls,
        successRate: Number.isFinite(successRate) ? successRate : 0,
        averageLatencyMs: Number(today.average_latency_ms) || 0,
      },
      rolling: {
        rpm: Number(rolling.rpm) || 0,
        tpm: Number(rolling.tpm) || 0,
      },
      models: (Array.isArray(summary.value?.top_models_today) ? summary.value.top_models_today : [])
        .slice(0, 6)
        .map((row) => ({
          model: String(row?.model ?? ''),
          calls: Number(row?.calls) || 0,
          tokens: Number(row?.tokens) || 0,
        })),
      accounts,
      accountsError: files.ok ? null : (files.error ?? 'unavailable'),
    }

    cache = { at, payload }
    return payload
  }
}
