[Русский](README.md) | English

# DSH Balance Strip

A strip along the bottom of the DeepSeek Harness Web GUI reporting two live
figures:

- **Balance** — the total available credit of the signed-in DeepSeek account:
  topped-up wallets plus granted bonus wallets, summed per currency.
- **Session** — the tokens spent in the Session on screen (prompt, cache read,
  cache write, completion), folded from that Session's committed log. When
  prices are configured, the estimated cost is appended.

Nothing is written anywhere: every value is derived per request, and the plugin
has no dependencies and no build step.

## Install

Requires DeepSeek Harness with the Web GUI. The package is plain JavaScript, so
any DSH Desktop on Windows, macOS, or Linux can take it.

1. Copy this directory anywhere on the target machine.
2. Open **Plugins → Add plugin**, paste the absolute path to the directory, and
   install. The bundle is selected automatically and the strip appears at the
   bottom of the window; no restart is needed.

The same dialog accepts the tarball from `npm pack` by its path, or a Git
repository address.

For a profile the desktop application does not manage (web, tui, headless):

```sh
dsh plugin --profile <profile> add /path/to/dsh-balance-strip
```

The `desktop` profile belongs to the Electron application, so `dsh plugin`
refuses it there; use the Plugins page instead.

Per-profile state — the enable/disable toggle and any price overrides — lives in
the profile's `cordis.patch.yml`, not in this package, so a new machine starts
from the defaults below.

## Where it renders

The Client half registers the `shell.bottom` seat, the frame's full-width strip
below the three columns. The occupant owns its height (26px), so the columns
shrink by exactly that. The strip stays mounted across main-panel navigation and
is independent of the right Sidebar's open state.

## How the data flows

The browser half may not read the Platform credential, so the Host half owns
every read and exposes one same-origin route:

```
GET /_dsh/balance-strip/status?session=<id>&locale=<lang>&tz=<seconds>&version=<build>
```

| Field | Meaning |
|---|---|
| `balance.status` | `ready`, `signed-out`, `failed`, or `unavailable` (no account service) |
| `balance.wallets` | per currency: `toppedUp`, `bonus`, `total` |
| `usage.status` | `ready`, `none` (no Session on screen), `unavailable`, or `failed` |
| `usage.*Tokens` | token counts over every assistant message of the Session |
| `usage.cost` | estimate, present only while a price is configured |
| `refreshMs` | poll interval resolved from `refreshSeconds` |
| `probe` | the last few requests this route answered (`status`, `fetchSite`, `origin`), for diagnosing a strip that shows no values |

The compact figure beside **Session** is the fresh prompt plus completion tokens;
cached prompt reuse is priced and reported separately in the tooltip, because the
provider bills the four token classes at different rates.

The route accepts a request that carries no cross-origin evidence: a page
request sends `Sec-Fetch-Site: same-origin` and no `Origin`, while the Desktop
build carries the same fetch over an IPC bridge that sends neither header. A
page on another origin announces itself and is rejected (403); the response
carries no CORS headers either, so such a page could not read it.

The balance comes from the Host-only `deepseekAccount.getBalance()` and is reused
for 60 seconds; a stalled Platform read becomes a failed field after 8 seconds
instead of holding the route. Session usage is folded incrementally, keyed by
the Session's event count, and cached per Session with the 64 most recent
Sessions retained.

## Configuration

Every value lives on the bundle's own row in `cordis.patch.yml`:

```yaml
- insert:
    - id: balance-strip
      name: '@local/dsh-balance-strip'
      config:
        refreshSeconds: 20            # clamped to 5…600
        pricing:
          currency: CNY
          inputPerMillion: 0
          cacheReadPerMillion: 0
          cacheWritePerMillion: 0
          outputPerMillion: 0
```

`refreshSeconds` sets both the Host's cold-read reuse window and the browser's
poll interval. Money appears only when at least one price is greater than zero;
the numbers are an estimate computed from these prices, not billing data.

Cache reads, cache writes, prompt tokens, and completion tokens are disjoint in
the provider's report, so the estimate is
`(input × input + cacheRead × cacheRead + cacheWrite × cacheWrite + output × output) / 1e6`.
A provider that folds cache reads into its prompt count would be
over-estimated here.

An override in the profile's own `cordis.patch.yml` takes precedence and applies
without a restart:

```yaml
- id: balance-strip
  name: "@local/dsh-balance-strip"
  config:
    refreshSeconds: 20
    pricing:
      currency: CNY
      inputPerMillion: 1
      cacheReadPerMillion: 0.1
      cacheWritePerMillion: 0
      outputPerMillion: 2
```

## Notes and limits

- Without a signed-in account the strip shows the sign-in hint; with an API-key
  model route there is no Platform balance to read.
- A Session that is not live is read through `sessionQuery.readSession()`, once
  per refresh interval.
- `pricing` affects the session estimate only; the balance is always the
  account's own currency amounts.
- The package name `@local/dsh-balance-strip` is the bundle's install name; the
  repository directory name does not have to match it.
- Verified against DSH `0.2.1-rc.2`. The plugin uses `shell.bottom`,
  `ctx.sidebarRight.mounted`, `webServer.register`, `deepseekAccount.getBalance`,
  `sessions.get`, and `sessionQuery.readSession`; a Harness version that moved
  one of those needs that call adjusted.

## License

MIT — see [LICENSE](LICENSE).
