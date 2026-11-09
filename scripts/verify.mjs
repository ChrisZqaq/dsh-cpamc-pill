/**
 * Offline harness: no browser, no Host, no network.
 *
 * It fakes the ModuleLoader / React / Cordis surfaces the bundle touches, then
 * checks the slot contract, the dictionary pairs, the CPAMP payload fold, the
 * key resolution order, and the client read of the Host route.
 *
 * Run: node scripts/verify.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ------------------------------------------------------------------ fake shell
globalThis.window = {
  innerHeight: 900,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  open: () => {},
  AbortController,
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'dsh-app://app/' },
  fetch: async () => ({ ok: true, status: 204, json: async () => ({}) }),
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
}

let loaded
globalThis.window.__ModuleLoader__ = { load: (definition) => (loaded = definition) }

/** Minimal hook shim: enough to call the component without a renderer. */
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    children,
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial ?? null }),
  useCallback: (fn) => fn,
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...next }
    }
  },
}

await import(pathToFileURL(join(root, 'client.js')).href)
const client = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})
const { DICTIONARIES, readStatus, fmtTokens, fmtMs, fmtPercent, emptyPayload } = client.__test__

const cpamc = await import(pathToFileURL(join(root, 'host/cpamc.js')).href)
const creds = await import(pathToFileURL(join(root, 'host/credentials.js')).href)

// ------------------------------------------------------------------- contract
console.log('\npackage + slot contract')
check('bundle id matches the package name', loaded.id === '@local/dsh-cpamc-pill', loaded?.id)
check('client reads over the host route, not a remote RPC', !client.inject.some((name) => name.startsWith('remote')))
check('client injects the locale service', client.inject.includes('locale'))
check('client injects the slot service', client.inject.includes('slots'))

const registrations = []
const declared = new Set(client.inject.flatMap((name) => [name, name.split('.')[0]]))
const services = {
  locale: { register: () => {}, bind: () => (key) => key, getLocale: () => ({ id: 'zh-CN' }) },
  slots: { inject: (name, fn) => fn(), register: (options, component) => registrations.push({ options, component }) },
}
/**
 * Cordis throws on a property read for anything the plugin did not declare in
 * `inject`, so the shim does too: an undeclared read must fail here, not on
 * the user's screen.
 */
const fakeCtx = new Proxy(services, {
  get(target, key) {
    if (typeof key === 'symbol' || key === 'then') return target[key]
    if (key === 'effect') return (fn) => fn()
    if (key in target) {
      if (!declared.has(key) && key !== 'effect') throw new Error(`cannot get property "${key}" without inject`)
      return target[key]
    }
    throw new Error(`cannot get property "${key}" without inject`)
  },
})
check('the shim refuses undeclared services like Cordis does', (() => {
  try {
    fakeCtx.remote
    return false
  } catch {
    return true
  }
})())
client.apply(fakeCtx)
check('apply registers exactly one sidebar-foot entry', registrations.length === 1, String(registrations.length))
check('entry uses the footer list slot', registrations[0]?.options?.name === 'sidebar.footer.action')
check('entry carries a stable id', registrations[0]?.options?.id === 'cpamc-pill')
check('entry sits to the right of the token pill', registrations[0]?.options?.order === 21, String(registrations[0]?.options?.order))
check('entry is labelled from the dictionary', registrations[0]?.options?.label() === 'label')

// ---------------------------------------------------------------- dictionaries
console.log('\ndictionaries')
const zhKeys = Object.keys(DICTIONARIES.zh).sort()
const enKeys = Object.keys(DICTIONARIES.en).sort()
check('zh and en define the same keys', zhKeys.join() === enKeys.join(), `${zhKeys.length} vs ${enKeys.length}`)
const { readFile } = await import('node:fs/promises')
const clientSource = await readFile(join(root, 'client.js'), 'utf8')
const used = new Set([...clientSource.matchAll(/translate\('([a-zA-Z]+)'/g)].map((match) => match[1]))
const missingKeys = [...used].filter((key) => !(key in DICTIONARIES.zh) || !(key in DICTIONARIES.en))
check('every translate() key exists in both dictionaries', missingKeys.length === 0, missingKeys.join())

// ------------------------------------------------------------------- calendar
console.log('\ncalendar helpers')
const wed = new Date(2026, 10, 11, 15, 30).getTime()
check('todayStartMs lands on local midnight', new Date(cpamc.todayStartMs(wed)).getHours() === 0)
check('todayStartMs never moves into the future', cpamc.todayStartMs(wed) <= wed)
check('dayKey is a zero-padded local date', cpamc.dayKey(wed) === '2026-11-11', cpamc.dayKey(wed))

// ------------------------------------------------------------------- token fold
console.log('\ntoken fold')
const folded = cpamc.tokensOf({
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 3000,
  cache_tokens: 0,
  reasoning_tokens: 50,
  total_tokens: 4000,
})
check('prompt and completion sides are read as reported', folded.input === 1000 && folded.output === 200)
check('cache reads are surfaced as their own bucket', folded.cached === 3000)
check('reasoning tokens are kept apart', folded.reasoning === 50)
check('fresh prompt tokens exclude the cache reads', folded.fresh === 0, String(folded.fresh))
const realDay = { input_tokens: 9_040_222, output_tokens: 47_646, cache_read_tokens: 8_516_992, total_tokens: 9_087_868 }
check('cache reads are never added on top of the prompt side', cpamc.tokensOf(realDay).total === 9_087_868, String(cpamc.tokensOf(realDay).total))
check(
  'the naive fold would have doubled it',
  cpamc.tokensOf(realDay).total !== realDay.input_tokens + realDay.output_tokens + realDay.cache_read_tokens,
)
check('fresh prompt tokens of that day exclude its cache reads', cpamc.tokensOf(realDay).fresh === 523_230, String(cpamc.tokensOf(realDay).fresh))
check('a missing reported total falls back to input plus output', cpamc.tokensOf({ input_tokens: 500, output_tokens: 500 }).total === 1000)
check('reasoning is not added on top of a reported total', cpamc.tokensOf({ input_tokens: 100, output_tokens: 100, reasoning_tokens: 50, total_tokens: 200 }).total === 200)
check('a malformed cache count cannot go negative', cpamc.tokensOf({ input_tokens: 10, cache_read_tokens: 99 }).fresh === 0)
check('an empty bucket reads as zero', cpamc.tokensOf({}).total === 0)

// ------------------------------------------------------------------ the reader
console.log('\nreader')
const summaryOk = {
  today: {
    total_calls: 47,
    failure_calls: 0,
    success_rate: 1,
    input_tokens: 2_673_403,
    output_tokens: 16_936,
    cache_read_tokens: 2_222_848,
    reasoning_tokens: 10_097,
    total_tokens: 2_690_339,
    average_latency_ms: 10_691.7,
  },
  rolling_30m: { rpm: 1.57, tpm: 171_069 },
  top_models_today: [
    { model: 'deepseek-v4-flash', calls: 44, tokens: 2_340_516 },
    { model: 'hy4std', calls: 3, tokens: 349_823 },
  ],
}
const filesOk = {
  files: [
    { label: '阿罗拉潮玩空间 [CN]', provider: 'workbuddy', status: 'active', disabled: false, cooldowns: [] },
    { label: 'kimi', provider: 'kimi', status: 'active', disabled: false, cooldowns: [] },
  ],
}

const seen = []
const okFetch = async (url) => {
  seen.push(url)
  if (url.includes('/dashboard/summary')) return { ok: true, status: 200, json: async () => summaryOk }
  if (url.includes('/auth-files')) return { ok: true, status: 200, json: async () => filesOk }
  throw new Error(`unexpected url ${url}`)
}
const readOk = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: 'cpamp_test', source: 'stack', path: null }),
  fetchImpl: okFetch,
  now: () => wed,
})
const payload = await readOk()
check('the reader asks the daily-summary route', seen.some((url) => url.includes('/v0/management/dashboard/summary?today_start_ms=')), seen.join())
check('the reader asks the account route', seen.some((url) => url.includes('/v0/management/auth-files')))
check('a healthy pool reports ok', payload.health === 'ok', payload.health)
check('today token total is carried through', payload.today.total === 2_690_339, String(payload.today.total))
check('cache reads are reported separately', payload.today.cached === 2_222_848)
check('call counts are carried through', payload.calls.total === 47 && payload.calls.failed === 0)
check('success rate is a fraction', payload.calls.successRate === 1)
check('rolling rate is carried through', payload.rolling.rpm === 1.57 && payload.rolling.tpm === 171_069)
check('models are trimmed to the top six', payload.models.length === 2 && payload.models[0].model === 'deepseek-v4-flash')
check('accounts are normalised', payload.accounts.length === 2 && payload.accounts[0].label === '阿罗拉潮玩空间 [CN]')
check('the key source is reported, never the key', payload.keySource === 'stack' && !JSON.stringify(payload).includes('cpamp_test'))
check('the panel url is shipped for the footer button', payload.panelUrl === 'http://127.0.0.1:18317/management.html')
check('a second read inside the cache window reuses the payload', (await readOk()) === payload)

const readNoKey = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: null, source: null, path: null }),
  fetchImpl: async () => {
    throw new Error('should not be called')
  },
  now: () => wed,
})
const missing = await readNoKey()
check('a missing key reports unconfigured instead of throwing', missing.health === 'unconfigured', missing.health)
check('an unconfigured capsule still carries a zero shape', missing.today.total === 0 && missing.accounts.length === 0)

const readDown = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: 'cpamp_test', source: 'env', path: null }),
  fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  now: () => wed,
})
const down = await readDown()
check('an unreachable CPAMP reports offline', down.health === 'offline', down.health)
check('an offline capsule explains itself', typeof down.reason === 'string' && down.reason.length > 0, String(down.reason))

const coolingFiles = {
  files: [
    { label: 'a', provider: 'workbuddy', status: 'active', disabled: false, cooldowns: [{ until_ms: wed + 60_000 }] },
    { label: 'b', provider: 'workbuddy', status: 'active', disabled: true, cooldowns: [] },
  ],
}
const readCooling = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: 'cpamp_test', source: 'env', path: null }),
  fetchImpl: async (url) =>
    url.includes('/dashboard/summary')
      ? { ok: true, status: 200, json: async () => summaryOk }
      : { ok: true, status: 200, json: async () => coolingFiles },
  now: () => wed,
})
const cooling = await readCooling()
check('a pool with no usable account reports degraded', cooling.health === 'degraded', cooling.health)
check('a live cooldown is marked', cooling.accounts[0].cooling === true && cooling.accounts[0].cooldownUntilMs === wed + 60_000)
check('a disabled account is marked', cooling.accounts[1].disabled === true)

const readFailures = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: 'cpamp_test', source: 'env', path: null }),
  fetchImpl: async (url) =>
    url.includes('/dashboard/summary')
      ? { ok: true, status: 200, json: async () => ({ ...summaryOk, today: { ...summaryOk.today, failure_calls: 3, success_rate: 0.93 } }) }
      : { ok: true, status: 200, json: async () => filesOk },
  now: () => wed,
})
check('today failures report degraded', (await readFailures()).health === 'degraded')

const partial = cpamc.createStatusReader({
  resolveAdminKey: async () => ({ key: 'cpamp_test', source: 'env', path: null }),
  fetchImpl: async (url) =>
    url.includes('/dashboard/summary')
      ? { ok: true, status: 200, json: async () => summaryOk }
      : { ok: false, status: 401, json: async () => ({}) },
  now: () => wed,
})
const partialPayload = await partial()
check('a failed account read still reports today usage', partialPayload.today.total === 2_690_339)
check('a failed account read is surfaced, not swallowed', typeof partialPayload.accountsError === 'string')

// --------------------------------------------------------------- key resolution
console.log('\nkey resolution')
const dir = await mkdtemp(join(tmpdir(), 'cpamc-'))
try {
  const stackPath = join(dir, 'credentials.env')
  const configPath = join(dir, 'cpamc-pill.json')
  await writeFile(
    stackPath,
    ['# comment', 'CPA_API_KEY=sk-abc', 'CPAMP_ADMIN_KEY=cpamp_from_stack', 'CPA_MANAGEMENT_KEY=m1'].join('\n'),
  )
  check('dotenv parsing picks the right key', creds.parseEnvText(await (await import('node:fs/promises')).readFile(stackPath, 'utf8')) === 'cpamp_from_stack')
  check('dotenv parsing ignores other keys', creds.parseEnvText('CPA_API_KEY=x', 'CPAMP_ADMIN_KEY') === null)
  check('dotenv parsing strips quotes', creds.parseEnvText('CPAMP_ADMIN_KEY="quoted-value"') === 'quoted-value')
  check('dotenv parsing skips commented lines', creds.parseEnvText('# CPAMP_ADMIN_KEY=nope') === null)

  const fromStack = await creds.resolveAdminKey({ env: {}, configPath, stackPath })
  check('the stack credentials file is the last resort', fromStack.key === 'cpamp_from_stack' && fromStack.source === 'stack')

  await writeFile(configPath, JSON.stringify({ adminKey: 'cpamp_from_file' }))
  const fromFile = await creds.resolveAdminKey({ env: {}, configPath, stackPath })
  check('the plugin config file outranks the stack file', fromFile.key === 'cpamp_from_file' && fromFile.source === 'file')

  const fromEnv = await creds.resolveAdminKey({ env: { CPAMP_ADMIN_KEY: 'cpamp_from_env' }, configPath, stackPath })
  check('the environment outranks both files', fromEnv.key === 'cpamp_from_env' && fromEnv.source === 'env')

  await writeFile(configPath, '{ not json')
  const brokenConfig = await creds.resolveAdminKey({ env: {}, configPath, stackPath })
  check('a malformed config falls through to the stack file', brokenConfig.key === 'cpamp_from_stack')

  const nothing = await creds.resolveAdminKey({
    env: {},
    configPath: join(dir, 'absent.json'),
    stackPath: join(dir, 'absent.env'),
  })
  check('no source at all resolves to null, not a throw', nothing.key === null && nothing.source === null)
} finally {
  await rm(dir, { recursive: true, force: true })
}

// -------------------------------------------------------------- client reading
console.log('\nclient reading')
let askedUrl
const clientPayload = { ...payload, at: wed }
const okClientFetch = async (url) => {
  askedUrl = url
  return { ok: true, status: 200, json: async () => clientPayload }
}
const result = await readStatus(okClientFetch)
check('the client reads the host route', askedUrl === '/dsh-cpamc-pill/status', String(askedUrl))
check('the client keeps the token total', result.today.total === 2_690_339)
check('the client keeps health', result.health === 'ok')
check('the client keeps the account rows', result.accounts.length === 2)
check('a failing route fails loudly', await readStatus(async () => ({ ok: false, status: 500, json: async () => ({}) })).then(() => false, () => true))
const bare = await readStatus(async () => ({ ok: true, status: 200, json: async () => ({}) }))
check('an empty payload still yields a renderable shape', bare.today.total === 0 && bare.panelUrl === 'http://127.0.0.1:18317/management.html')

console.log('\nformatting')
check('millions format as M', fmtTokens(5_132_071) === '5.13M')
check('thousands format as k', fmtTokens(12_345) === '12.3k')
check('hundreds stay integral', fmtTokens(47) === '47')
check('zero renders as zero', fmtTokens(0) === '0')
check('sub-second latency keeps milliseconds', fmtMs(880) === '880ms')
check('second latency keeps one decimal', fmtMs(10_691.7) === '10.7s')
check('a perfect rate prints without decimals', fmtPercent(1) === '100%')
check('a partial rate keeps one decimal', fmtPercent(0.93) === '93.0%')
check('an unknown anything has a safe shape', emptyPayload().today.total === 0 && emptyPayload().health === 'unknown')

// --------------------------------------------------------------------- render
console.log('\nrender')
const registered = registrations[0].component
// The registered entry is the guard; render through it the way React would.
const guarded = registered({ wide: true })
const guardInstance = new guarded.type(guarded.props)
const child = guardInstance.render()
const tree = typeof child?.type === 'function' ? child.type(child.props) : child
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node === 'object') {
    out.push(node)
    for (const item of node.children ?? []) flatten(item, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  return out
}
const flat = flatten(tree)
const text = flat.filter((node) => typeof node === 'string').join(' ')
check('renders without a Host', tree?.props?.className === 'dshc-root')
check('the pill names the proxy', text.includes('CPA'), text.slice(0, 120))
check('the pill shows a placeholder before data arrives', text.includes('—'), text.slice(0, 120))
check('the pill carries the entry label for screen readers', flat.some((node) => node?.props?.['aria-label'] === 'label'))
check('the health dot is decided at render time', flat.some((node) => node?.props?.['data-health'] !== undefined))
check('the card is closed until hovered', !flat.some((node) => node?.props?.className === 'dshc-card'))

const boundary = new guardInstance.constructor({})
boundary.state = { failed: true }
const fallback = boundary.render()
check('the error boundary still renders a capsule', fallback?.props?.className === 'dshc-pill', fallback?.props?.className)

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
