window.__ModuleLoader__.load({
  id: '@local/dsh-cpamc-pill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Dictionary namespace; also used as the slot locale seat. */
    const NS = 'cpamc-pill'
    /**
     * Same row as the DeepSeek token pill, one step to its right: slot entries
     * sort ascending by `order` and render inline inside `footerActions`.
     */
    const SLOT = 'sidebar.footer.action'
    const ENTRY_ID = 'cpamc-pill'
    const ORDER = 21
    /** Host route serving the CPAMP reading. */
    const ROUTE = '/dsh-cpamc-pill/status'

    const REFRESH_MS = 60_000
    const STALE_MS = 20_000
    const HOVER_CLOSE_MS = 140
    const PANEL_URL = 'http://127.0.0.1:18317/management.html'

    const DICTIONARIES = {
      en: {
        label: 'CPA proxy status and today’s tokens',
        today: 'Today',
        tokens: 'tokens',
        input: 'Input',
        output: 'Output',
        cached: 'Cache read',
        reasoning: 'Reasoning',
        okay: 'OK',
        degraded: 'Degraded',
        offline: 'Offline',
        unconfigured: 'No admin key',
        pool: 'Account pool',
        accounts: '{n} accounts',
        active: 'active',
        cooling: 'cooling',
        disabled: 'disabled',
        calls: 'Calls',
        successRate: 'Success rate',
        latency: 'Avg latency',
        rolling: 'Last 30 minutes',
        rpm: '{value} req/min',
        tpm: '{value} tokens/min',
        models: 'Top models',
        openPanel: 'Open CPAMP panel',
        detail: 'Details',
        hide: 'Collapse',
        empty: 'No CPA traffic today',
        loading: 'Reading CPAMP…',
        failed: 'Could not read CPAMP',
        hintMissingKey: 'Set CPAMP_ADMIN_KEY in ~/.dsh/cpamc-pill.json or cpa-stack/credentials.env',
        hintOffline: 'CPAMP is not answering on 127.0.0.1:18317',
        hintDegraded: 'Every upstream account is cooling or disabled',
        keyFrom: 'Key from {source}',
      },
      zh: {
        label: 'CPA 反代连接状态与今日 token 用量',
        today: '今日',
        tokens: 'tokens',
        input: '输入',
        output: '输出',
        cached: '缓存读',
        reasoning: '推理',
        okay: '正常',
        degraded: '受限',
        offline: '离线',
        unconfigured: '未配置密钥',
        pool: '账号池',
        accounts: '{n} 个账号',
        active: '可用',
        cooling: '冷却中',
        disabled: '已禁用',
        calls: '调用',
        successRate: '成功率',
        latency: '平均延迟',
        rolling: '近 30 分钟',
        rpm: '{value} 次/分',
        tpm: '{value} tokens/分',
        models: '模型 TOP',
        openPanel: '打开 CPAMP 面板',
        detail: '查看明细',
        hide: '收起',
        empty: '今天还没有 CPA 流量',
        loading: '正在读取 CPAMP…',
        failed: '读取 CPAMP 失败',
        hintMissingKey: '在 ~/.dsh/cpamc-pill.json 或 cpa-stack/credentials.env 里设 CPAMP_ADMIN_KEY',
        hintOffline: 'CPAMP 没有在 127.0.0.1:18317 应答',
        hintDegraded: '上游账号全部在冷却或被禁用',
        keyFrom: '密钥来源 {source}',
      },
    }

    // ---------------------------------------------------------------- helpers

    function fmtTokens(value) {
      const n = Number(value) || 0
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
      return String(Math.round(n))
    }

    function fmtMs(value) {
      const n = Number(value) || 0
      if (n >= 1000) return `${(n / 1000).toFixed(1)}s`
      return `${Math.round(n)}ms`
    }

    function fmtPercent(value) {
      const n = Number(value) || 0
      return `${(n * 100).toFixed(n >= 0.9995 ? 0 : 1)}%`
    }

    function formatDay(date, locale) {
      try {
        return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short' }).format(date)
      } catch {
        return `${date.getMonth() + 1}/${date.getDate()}`
      }
    }

    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        Promise.resolve(promise).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    // ----------------------------------------------------------------- reading

    function emptyPayload() {
      return {
        day: '',
        reachable: false,
        reason: 'unknown',
        keySource: null,
        panelUrl: PANEL_URL,
        health: 'unknown',
        today: { total: 0, input: 0, output: 0, cached: 0, reasoning: 0 },
        calls: { total: 0, failed: 0, successRate: 0, averageLatencyMs: 0 },
        rolling: { rpm: 0, tpm: 0 },
        models: [],
        accounts: [],
      }
    }

    async function readStatus(fetchImpl, signal) {
      const request = fetchImpl ?? ((input, init) => window.fetch(input, init))
      const response = await withTimeout(
        request(ROUTE, { credentials: 'same-origin', cache: 'no-store', signal }),
        10_000,
        'status',
      )
      if (!response.ok) throw new Error(`status route answered ${response.status}`)
      const payload = await response.json()
      return { ...emptyPayload(), ...payload, panelUrl: payload?.panelUrl ?? PANEL_URL }
    }

    // ---------------------------------------------------------------- styling

    const CSS = `
.dshc-root{position:relative;display:flex;align-items:center;min-width:0;flex:1}
.dshc-pill{display:inline-flex;align-items:center;justify-content:flex-start;gap:6px;min-width:0;flex:1;height:32px;padding:0 9px;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}
@media (hover:hover){.dshc-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.dshc-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshc-pill[data-pinned='yes']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshc-rail{flex:none;width:28px;min-width:0;padding:0;justify-content:center}
.dshc-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dshc-dot[data-health='ok']{background:var(--dsw-alias-state-success-primary)}
.dshc-dot[data-health='degraded']{background:var(--dsw-alias-state-warn-primary)}
.dshc-dot[data-health='offline'],.dshc-dot[data-health='unconfigured']{background:var(--dsw-alias-state-error-primary)}
.dshc-value{font-variant-numeric:tabular-nums;color:inherit;white-space:nowrap}
.dshc-muted{color:var(--dsw-alias-label-tertiary)}

.dshc-card{position:fixed;z-index:60;width:312px;padding:16px 16px 14px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dshc-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshc-title{display:flex;align-items:center;gap:8px;margin-top:4px}
.dshc-amount{font-size:24px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums}
.dshc-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshc-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;box-sizing:border-box;
  border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary)}
.dshc-chip[data-health='ok']{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dshc-chip[data-health='degraded']{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshc-chip[data-health='offline'],.dshc-chip[data-health='unconfigured']{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dshc-rule{height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}
.dshc-row{display:flex;align-items:baseline;gap:8px;margin:3px 0}
.dshc-row-label{width:52px;flex:none;color:var(--dsw-alias-label-secondary)}
.dshc-row-value{font-variant-numeric:tabular-nums}
.dshc-row-note{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right}
.dshc-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dshc-table th{font-weight:400;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:right;padding:1px 0}
.dshc-table th:first-child,.dshc-table td:first-child{text-align:left}
.dshc-table td{padding:1px 0;text-align:right}
.dshc-list{margin:2px 0 0}
.dshc-item{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:3px 0}
.dshc-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshc-badge{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}
.dshc-badge[data-state='active']{color:var(--dsw-alias-state-success-primary)}
.dshc-badge[data-state='cooling']{color:var(--dsw-alias-state-warn-primary)}
.dshc-badge[data-state='disabled']{color:var(--dsw-alias-state-error-primary)}
.dshc-foot{display:flex;align-items:center;gap:6px;margin-top:10px}
.dshc-btn{flex:1;height:26px;padding:0 8px;box-sizing:border-box;border-radius:7px;cursor:pointer;
  background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshc-btn[data-primary='yes']{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dshc-hint{margin-top:8px;color:var(--dsw-alias-state-warn-primary);font-size:11px}
.dshc-detail{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dshc-detail-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:3px 0}
`.trim()

    // -------------------------------------------------------------- component

    function makeCpamcPill(ctx) {
      return function CpamcPill(props) {
        const wide = props?.wide !== false
        const [data, setData] = useState(null)
        const [error, setError] = useState(null)
        const [loading, setLoading] = useState(true)
        const [open, setOpen] = useState(false)
        const [pinned, setPinned] = useState(false)
        const [position, setPosition] = useState(null)

        const anchorRef = useRef(null)
        const closeTimer = useRef(0)
        const dataAt = useRef(0)

        const load = useCallback(async (options) => {
          try {
            const value = await readStatus(window.fetch.bind(window), options?.signal)
            setData(value)
            setError(null)
            dataAt.current = Date.now()
          } catch (cause) {
            if (cause && cause.name === 'AbortError') return
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setLoading(false)
          }
        }, [])

        useEffect(() => {
          const controller = new window.AbortController()
          void load({ signal: controller.signal })
          const refresh = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return
            void load({})
          }, REFRESH_MS)
          return () => {
            controller.abort()
            window.clearInterval(refresh)
          }
        }, [load])

        useEffect(() => {
          if (!open) return undefined
          const onKey = (event) => {
            if (event.key !== 'Escape') return
            setPinned(false)
            setOpen(false)
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [open])

        useEffect(() => {
          if (!open) return undefined
          const onDown = (event) => {
            const card = document.querySelector('.dshc-card')
            if (anchorRef.current?.contains(event.target)) return
            if (card?.contains(event.target)) return
            setPinned(false)
            setOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          return () => document.removeEventListener('mousedown', onDown, true)
        }, [open])

        const measure = useCallback(() => {
          const anchor = anchorRef.current?.getBoundingClientRect()
          if (!anchor) return
          setPosition({ left: anchor.left, bottom: Math.max(8, window.innerHeight - anchor.top + 8) })
        }, [])

        const openCard = useCallback(() => {
          window.clearTimeout(closeTimer.current)
          measure()
          setOpen(true)
          if (Date.now() - dataAt.current > STALE_MS) void load({})
        }, [load, measure])

        const scheduleClose = useCallback(() => {
          window.clearTimeout(closeTimer.current)
          closeTimer.current = window.setTimeout(() => {
            if (!pinned) setOpen(false)
          }, HOVER_CLOSE_MS)
        }, [pinned])

        useEffect(() => {
          if (!pinned) return undefined
          measure()
          const id = window.setInterval(measure, 1_000)
          window.addEventListener('resize', measure)
          return () => {
            window.clearInterval(id)
            window.removeEventListener('resize', measure)
          }
        }, [pinned, measure])

        useEffect(() => () => window.clearTimeout(closeTimer.current), [])

        const translate = ctx.locale.bind(NS)
        const localeId = ctx.locale.getLocale?.()?.id ?? 'zh-CN'
        const view = data ?? emptyPayload()
        const health = error ? 'offline' : (view.health ?? 'unknown')
        const today = view.today ?? emptyPayload().today
        const calls = view.calls ?? emptyPayload().calls
        const accounts = Array.isArray(view.accounts) ? view.accounts : []
        const models = Array.isArray(view.models) ? view.models : []
        const healthLabel = {
          ok: translate('okay'),
          degraded: translate('degraded'),
          offline: translate('offline'),
          unconfigured: translate('unconfigured'),
        }[health] ?? translate('offline')

        const hint = error
          ? `${translate('failed')}: ${error}`
          : health === 'unconfigured'
            ? translate('hintMissingKey')
            : health === 'offline'
              ? translate('hintOffline')
              : health === 'degraded'
                ? translate('hintDegraded')
                : null

        const accountState = (account) => {
          if (account.disabled) return 'disabled'
          if (account.cooling) return 'cooling'
          return 'active'
        }

        const detailSection = () =>
          h(
            'div',
            { className: 'dshc-detail' },
            h('div', { className: 'dshc-badge' }, translate('models')),
            models.length === 0
              ? h('div', { className: 'dshc-muted' }, translate('empty'))
              : models.map((row) =>
                  h(
                    'div',
                    { className: 'dshc-detail-row', key: row.model },
                    h(
                      'span',
                      { className: 'dshc-item-name' },
                      row.model,
                      h('span', { className: 'dshc-badge' }, ` · ${row.calls}`),
                    ),
                    h('span', { className: 'dshc-value' }, fmtTokens(row.tokens)),
                  ),
                ),
            accounts.length > 0
              ? h(
                  'div',
                  null,
                  h('div', { className: 'dshc-badge', style: { marginTop: '8px' } }, translate('pool')),
                  accounts.map((account) =>
                    h(
                      'div',
                      { className: 'dshc-item', key: `${account.provider}:${account.label}` },
                      h('span', { className: 'dshc-item-name' }, account.label || account.provider),
                      h(
                        'span',
                        { className: 'dshc-badge', 'data-state': accountState(account) },
                        translate(accountState(account)),
                      ),
                    ),
                  ),
                )
              : null,
            view.keySource
              ? h('div', { className: 'dshc-badge', style: { marginTop: '8px' } },
                  translate('keyFrom', { source: view.keySource }))
              : null,
            h(
              'div',
              { className: 'dshc-foot' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshc-btn',
                  onClick: () => window.open(view.panelUrl ?? PANEL_URL, '_blank', 'noopener,noreferrer'),
                },
                translate('openPanel'),
              ),
            ),
          )

        const card =
          open && position
            ? h(
                'div',
                {
                  className: 'dshc-card',
                  style: { left: `${position.left}px`, bottom: `${position.bottom}px` },
                  onMouseEnter: () => window.clearTimeout(closeTimer.current),
                  onMouseLeave: scheduleClose,
                },
                h(
                  'div',
                  { className: 'dshc-head' },
                  h('span', null, translate('today')),
                  h('span', null, formatDay(new Date(), localeId)),
                ),
                h(
                  'div',
                  { className: 'dshc-title' },
                  h('span', { className: 'dshc-amount' }, fmtTokens(today.total)),
                  h('span', { className: 'dshc-unit' }, translate('tokens')),
                  h(
                    'span',
                    { className: 'dshc-chip', 'data-health': health },
                    h('span', { className: 'dshc-dot', 'data-health': health }),
                    healthLabel,
                  ),
                ),
                h('div', { className: 'dshc-rule' }),
                h(
                  'div',
                  { className: 'dshc-row' },
                  h('span', { className: 'dshc-row-label' }, translate('input')),
                  h('span', { className: 'dshc-row-value' }, fmtTokens(today.input)),
                  h(
                    'span',
                    { className: 'dshc-row-note' },
                    `${translate('cached')} ${fmtTokens(today.cached)}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'dshc-row' },
                  h('span', { className: 'dshc-row-label' }, translate('output')),
                  h('span', { className: 'dshc-row-value' }, fmtTokens(today.output)),
                  h(
                    'span',
                    { className: 'dshc-row-note' },
                    `${translate('reasoning')} ${fmtTokens(today.reasoning)}`,
                  ),
                ),
                h('div', { className: 'dshc-rule' }),
                h(
                  'div',
                  { className: 'dshc-row' },
                  h('span', { className: 'dshc-row-label' }, translate('calls')),
                  h('span', { className: 'dshc-row-value' }, String(calls.total)),
                  h(
                    'span',
                    { className: 'dshc-row-note' },
                    `${translate('successRate')} ${fmtPercent(calls.successRate)}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'dshc-row' },
                  h('span', { className: 'dshc-row-label' }, translate('latency')),
                  h('span', { className: 'dshc-row-value' }, fmtMs(calls.averageLatencyMs)),
                  h('span', { className: 'dshc-row-note' }, translate('accounts', { n: accounts.length })),
                ),
                h('div', { className: 'dshc-rule' }),
                h(
                  'div',
                  { className: 'dshc-head' },
                  h('span', null, translate('rolling')),
                  h('span', null, translate('rpm', { value: view.rolling?.rpm ?? 0 })),
                ),
                h(
                  'div',
                  { className: 'dshc-row' },
                  h('span', { className: 'dshc-row-value dshc-muted' }, translate('tpm', { value: fmtTokens(view.rolling?.tpm ?? 0) })),
                ),
                pinned ? detailSection() : null,
                h(
                  'div',
                  { className: 'dshc-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshc-btn',
                      'data-primary': 'yes',
                      onClick: () => {
                        setPinned((value) => !value)
                        setOpen(true)
                      },
                    },
                    pinned ? translate('hide') : translate('detail'),
                  ),
                ),
                hint ? h('div', { className: 'dshc-hint' }, hint) : null,
                loading ? h('div', { className: 'dshc-badge' }, translate('loading')) : null,
              )
            : null

        const pill = h(
          'button',
          {
            type: 'button',
            className: wide ? 'dshc-pill' : 'dshc-pill dshc-rail',
            'data-health': health,
            'data-pinned': pinned ? 'yes' : 'no',
            'aria-label': translate('label'),
            onMouseEnter: openCard,
            onMouseLeave: scheduleClose,
            onFocus: openCard,
            onBlur: scheduleClose,
            onClick: (event) => {
              event.preventDefault()
              if (open && !pinned) {
                setPinned(true)
                return
              }
              if (pinned) {
                setPinned(false)
                setOpen(false)
                return
              }
              openCard()
            },
          },
          h('span', { className: 'dshc-dot', 'data-health': data ? health : 'unknown' }),
          wide ? h('span', { className: 'dshc-value' }, data ? fmtTokens(today.total) : '—') : null,
        )

        return h('div', { className: 'dshc-root', ref: anchorRef }, h('style', null, CSS), pill, card)
      }
    }

    /** Keeps a capsule on screen even when the reading component throws. */
    class PillBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        if (!this.state.failed) return this.props.children
        return h(
          'button',
          { type: 'button', className: 'dshc-pill', 'data-health': 'offline', title: DICTIONARIES.en.failed },
          h('span', { className: 'dshc-dot', 'data-health': 'offline' }),
          h('span', { className: 'dshc-value' }, '—'),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'cpamc-pill dictionaries')
        const CpamcPill = makeCpamcPill(ctx)
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: ENTRY_ID, order: ORDER, locale: NS, label: () => ctx.locale.bind(NS)('label') },
            /** Never let a render error empty the sidebar foot. */
            function Guarded(props) {
              return h(PillBoundary, null, h(CpamcPill, props))
            },
          ),
        )
      },
      /** Pure helpers the offline harness exercises without a Host. */
      __test__: {
        DICTIONARIES,
        CSS,
        readStatus,
        fmtTokens,
        fmtMs,
        fmtPercent,
        emptyPayload,
      },
    }
  },
})
