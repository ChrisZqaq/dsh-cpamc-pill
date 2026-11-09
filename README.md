
# dsh-cpamc-pill

A sidebar-foot capsule for the [DeepSeek Harness](https://github.com/deepseek-ai) Web UI that shows **CPA proxy connection health and today's token usage**, read from [CPA-Manager-Plus](https://github.com/seakee/CPA-Manager-Plus).

It sits to the right of `dsh-token-pill` and is deliberately small: a status dot and one number.

```
● CPA · 18.72M
```

Hover it for today's totals, call health, and the rolling 30-minute rate. Click **Details** for the model breakdown and the upstream account pool.

## What it reads

Two read-only endpoints of CPA-Manager-Plus:

| Endpoint | Used for |
|---|---|
| `GET /v0/management/dashboard/summary?today_start_ms=<ms>` | today's tokens, calls, success rate, latency, rolling rpm/tpm, top models |
| `GET /v0/management/auth-files` | one row per upstream account: provider, status, disable and cooldown state |

The admin key stays on the Host side. The browser only ever calls a same-origin route this plugin registers:

```
GET /dsh-cpamc-pill/status
```

### No money

There is no cost anywhere in this capsule, on purpose. Accounts behind a reverse proxy are subscriptions with no per-call invoice, and CPA-Manager-Plus reports `total_cost: 0` until a price sync runs. Showing `¥0.00` as if it were a real reading would be worse than showing nothing.

### Token accounting

The load-bearing detail, measured against a live panel:

```
total_tokens = input_tokens + output_tokens
input_tokens already contains cache_read_tokens
```

Adding cache reads on top — the obvious "sum every bucket" fold — doubled a real day from 9.09M to 17.61M. This plugin therefore reports CPA-Manager-Plus's own `total_tokens`, and derives `fresh = input - cached` separately so cache hit rate stays visible.

## Health states

| State | Dot | Meaning |
|---|---|---|
| `ok` | green | at least one usable account, no failures today |
| `degraded` | amber | every account is cooling or disabled, or calls failed today |
| `offline` | red | CPA-Manager-Plus did not answer on `127.0.0.1:18317` |
| `unconfigured` | red | no admin key could be resolved |

A capsule always renders. An unreachable service is a red dot, not an empty sidebar.

## Install

```bash
# 1. Link the package into your profile
cd ~/.dsh/profiles/<name>
npm pkg set "dependencies.@local/dsh-cpamc-pill=link:/absolute/path/to/dsh-cpamc-pill"

# 2. Add it to the bundle list
npm pkg set 'dsh.profile.bundles[]=@local/dsh-cpamc-pill'

# 3. Link the module the way the existing @local packages are linked
ln -sfn /absolute/path/to/dsh-cpamc-pill \
  node_modules/@local/dsh-cpamc-pill
```

The desktop profile installs `link:` dependencies with its own installer, so step 3 matters only when you edit `package.json` by hand — plain `npm install` rejects the `link:` protocol with `EUNSUPPORTEDPROTOCOL`.

Restart the harness, or trigger a profile recompose through Plugin Manager, which mounts the plugin without a restart.

## Configure the admin key

Resolved in this order, first hit wins:

1. `CPAMP_ADMIN_KEY` in the environment
2. `~/.dsh/cpamc-pill.json` — `{ "adminKey": "cpamp_..." }`
3. `CPAMP_ADMIN_KEY=` inside `~/Applications/cpa-stack/credentials.env`

Step 3 exists because a Dock-launched harness inherits no shell environment at all: `ps eww <pid>` on the running process shows no `CPA_*` or `CPAMP_*` variables. Resolving from `process.env` alone always missed.

A missing key resolves to the `unconfigured` state; the capsule still renders, and no network call is attempted.

The resolved source is reported as `keySource` in the payload — `env`, `file`, or `stack`. The key itself is never included. The offline suite asserts that too.

## Required services

The package declares these in `dsh.client.inject`, matching `dsh-token-pill`:

- `@deepseek-ai/dsh-api-remotes`
- `@deepseek-ai/dsh-client-locale`
- `@deepseek-ai/dsh-client-ui-sidebar`

## Slot placement

`sidebar.footer.action`, `order: 21`. The renderer sorts slot rows ascending by `order`, and `dsh-token-pill` sits at `20`, so `21` lands immediately to its right.

## Verify

```bash
node scripts/verify.mjs
```

No browser, no Host, no network. The suite fakes the ModuleLoader, React and Cordis surfaces, then checks 80 assertions:

- slot contract: bundle id, inject list, `order === 21`, entry id and label
- every `translate()` key exists in both dictionaries
- the token fold, including the double-count regression
- key resolution precedence, quoted values, commented lines, malformed JSON falling through
- all four health states, including a partial failure where the account read dies but usage survives
- the payload never contains the admin key
- rendering through the crash boundary and its fallback capsule

## Layout

```
client.js               capsule, card, dictionaries, styling
index.js                Host half: the same-origin status route
host/cpamc.js           CPAMP reading, token accounting, health
host/credentials.js     admin-key resolution
locale/{zh,en}.json     package metadata strings
scripts/verify.mjs      offline assertion harness
cordis.patch.yml        bundle patch mounting the Host row
```

## License

MIT.
