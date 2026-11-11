/**
 * Host half of the balance strip.
 *
 * The browser half may not touch the Platform credential, so this half owns
 * every read: it exposes one same-origin JSON route that reports the total
 * available balance of the signed-in DeepSeek account and the token spend of
 * one Session, folded from that Session's committed log.
 *
 * Nothing is written anywhere: every value is derived per request.
 */

/** Exact route the browser half polls. */
const ROUTE = '/_dsh/balance-strip/status'

/** Default poll interval when the row config omits `refreshSeconds`. */
const DEFAULT_REFRESH_SECONDS = 20

/** How long one Platform balance result may serve later polls. */
const BALANCE_TTL_MS = 60_000

/** A Platform balance read longer than this becomes a failed field, not a hung route. */
const BALANCE_TIMEOUT_MS = 8_000

/** Folded Sessions kept in memory; the on-screen one is always among the newest. */
const FOLD_LIMIT = 64

/** Values above this are not plausible token counts and are ignored. */
const TOKEN_LIMIT = 1e12

export const name = 'balance-strip'

/**
 * Install the status route.
 * @param ctx - plugin context.
 * @param config - the row's `config` object from the patch layer.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const folds = new Map()
  const balance = { at: 0, value: undefined, pending: undefined }

  /**
   * Fold one Session's unread log tail into its cached totals.
   * @param sessionId - Session the fold belongs to.
   * @param events - that Session's committed events.
   * @returns the fold state.
   */
  const foldOf = (sessionId, events) => {
    let state = folds.get(sessionId)
    if (state === undefined) {
      state = createFold()
      folds.set(sessionId, state)
      if (folds.size > FOLD_LIMIT) folds.delete(folds.keys().next().value)
    }
    foldInto(state, events)
    return state
  }

  /**
   * Resolve the token spend of one Session from its committed log.
   * @param sessionId - the Session on screen.
   * @returns a usage field for the response.
   */
  const usageOf = async (sessionId) => {
    const sessions = optional(ctx, 'sessions')
    const live = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (live !== undefined && Array.isArray(live.events)) {
      return readyUsage(foldOf(sessionId, live.events))
    }
    const state = folds.get(sessionId)
    const now = Date.now()
    if (state !== undefined && now - state.coldAt < options.refreshMs) return readyUsage(state)
    const query = optional(ctx, 'sessionQuery')
    if (query !== undefined && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(sessionId)
        const events = isRecord(snapshot) && Array.isArray(snapshot.events) ? snapshot.events : undefined
        if (events !== undefined) {
          const folded = foldOf(sessionId, events)
          folded.coldAt = Date.now()
          return readyUsage(folded)
        }
      } catch (error) {
        warn(ctx, 'session %s could not be read: %s', sessionId, messageOf(error))
        return { status: 'failed' }
      }
    }
    return { status: 'unavailable' }
  }

  const probe = { requests: 0, recent: [] }

  const handler = (req, res) => {
    void (async () => {
      const entry = {
        at: Date.now(),
        fetchSite: req.headers['sec-fetch-site'] ?? null,
        origin: req.headers.origin ?? null,
        status: 0,
      }
      probe.requests += 1
      probe.recent.push(entry)
      if (probe.recent.length > 4) probe.recent.shift()
      const answer = (status, body, headers) => {
        entry.status = status
        respond(res, status, body, headers)
      }
      if (req.method !== 'GET') {
        answer(405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } }, { Allow: 'GET' })
        return
      }
      if (!sameOrigin(req)) {
        answer(403, {
          ok: false,
          probe,
          error: { code: 'origin-rejected', message: 'The request must originate from this DSH Web application' },
        })
        return
      }
      let url
      try {
        url = new URL(req.url ?? ROUTE, 'http://dsh.internal')
      } catch (error) {
        answer(400, { ok: false, probe, error: { code: 'invalid-request', message: messageOf(error) } })
        return
      }
      const sessionId = sessionParam(url)
      if (sessionId === null) {
        answer(400, {
          ok: false,
          probe,
          error: { code: 'invalid-request', message: 'session must be given at most once, as a plain identifier' },
        })
        return
      }
      try {
        const meta = clientMetadata(url)
        const [balanceField, usage] = await Promise.all([
          balanceOf(ctx, meta, balance),
          sessionId === undefined ? Promise.resolve({ status: 'none' }) : usageOf(sessionId),
        ])
        const pricing = options.pricing
        const configured = priced(pricing)
        answer(200, {
          ok: true,
          value: {
            schemaVersion: 1,
            revision: 4,
            refreshMs: options.refreshMs,
            probe,
            balance: balanceField,
            usage: {
              ...usage,
              cost: configured && usage.status === 'ready' ? costOf(usage, pricing) : undefined,
              currency: pricing.currency,
              priced: configured,
            },
          },
        })
      } catch (error) {
        warn(ctx, 'status request failed: %s', messageOf(error))
        answer(500, { ok: false, probe, error: { code: 'status-failed', message: 'The status is unavailable' } })
      }
    })()
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({ kind: 'exact', path: ROUTE, handler })
      return () => {
        dispose()
      }
    }, 'balance-strip: status route')
  })
}

/**
 * Read the account balance through the Host-only account service.
 * @param ctx - plugin context.
 * @param meta - identity of the requesting UI.
 * @param cache - last successful read and any read in flight.
 * @returns a balance field for the response.
 */
async function balanceOf(ctx, meta, cache) {
  if (cache.value !== undefined && Date.now() - cache.at < BALANCE_TTL_MS) return cache.value
  if (cache.pending !== undefined) return cache.pending
  const account = optional(ctx, 'deepseekAccount')
  if (account === undefined || typeof account.getBalance !== 'function') return { status: 'unavailable' }
  const pending = (async () => {
    try {
      const details = await withTimeout(async () => account.getBalance(meta), BALANCE_TIMEOUT_MS)
      const field = summarizeBalance(details)
      if (field.status === 'ready') {
        cache.value = field
        cache.at = Date.now()
      }
      return field
    } catch (error) {
      warn(ctx, 'balance read failed: %s', messageOf(error))
      return { status: 'failed' }
    } finally {
      cache.pending = undefined
    }
  })()
  cache.pending = pending
  return pending
}

/**
 * Sum the recharge and bonus wallets per currency.
 * @param details - the account service's balance outcome.
 * @returns a balance field for the response.
 */
function summarizeBalance(details) {
  if (details === null || details === undefined) return { status: 'signed-out' }
  if (!isRecord(details) || details.status !== 'ready') return { status: 'failed' }
  const wallets = Array.isArray(details.value) ? details.value : []
  const bonusWallets = Array.isArray(details.bonusWallets) ? details.bonusWallets : []
  const totals = new Map()
  const add = (wallet, bonus) => {
    if (!isRecord(wallet) || typeof wallet.currency !== 'string' || wallet.currency === '') return
    const amount = Number(wallet.balance)
    if (!Number.isFinite(amount)) return
    const row = totals.get(wallet.currency) ?? { currency: wallet.currency, toppedUp: 0, bonus: 0, total: 0 }
    if (bonus) row.bonus += amount
    else row.toppedUp += amount
    row.total = row.toppedUp + row.bonus
    totals.set(wallet.currency, row)
  }
  for (const wallet of wallets) add(wallet, false)
  for (const wallet of bonusWallets) add(wallet, true)
  return { status: 'ready', wallets: [...totals.values()] }
}

/** A fold state for one Session. */
function createFold() {
  return {
    length: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    steps: 0,
    coldAt: 0,
  }
}

/**
 * Accumulate the usage reported by assistant messages not yet folded.
 * @param state - the Session's fold state.
 * @param events - that Session's committed events.
 */
function foldInto(state, events) {
  if (state.length > events.length) Object.assign(state, createFold())
  for (let index = state.length; index < events.length; index += 1) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'assistant/message') continue
    const data = isRecord(event.data) ? event.data : undefined
    const usage = data !== undefined && isRecord(data.usage) ? data.usage : undefined
    if (usage === undefined) continue
    state.inputTokens += tokens(usage.inputTokens)
    state.outputTokens += tokens(usage.outputTokens)
    state.cacheReadTokens += tokens(usage.cacheReadTokens)
    state.cacheWriteTokens += tokens(usage.cacheWriteTokens)
    state.steps += 1
  }
  state.length = events.length
}

/** The wire view of one fold state. */
function readyUsage(state) {
  return {
    status: 'ready',
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    totalTokens: state.inputTokens + state.outputTokens,
    steps: state.steps,
  }
}

/**
 * Price one Session's usage with the configured per-million prices.
 *
 * The provider reports a cached prompt read separately from the prompt tokens
 * it bills at the full price, so the four token classes are disjoint here.
 * @param usage - the ready usage field.
 * @param pricing - resolved prices.
 * @returns the estimated cost in `pricing.currency`.
 */
function costOf(usage, pricing) {
  const perMillion =
    usage.inputTokens * pricing.inputPerMillion +
    usage.cacheReadTokens * pricing.cacheReadPerMillion +
    usage.cacheWriteTokens * pricing.cacheWritePerMillion +
    usage.outputTokens * pricing.outputPerMillion
  return perMillion / 1e6
}

/** Whether the row config carries at least one usable price. */
function priced(pricing) {
  return (
    pricing.inputPerMillion > 0 ||
    pricing.cacheReadPerMillion > 0 ||
    pricing.cacheWritePerMillion > 0 ||
    pricing.outputPerMillion > 0
  )
}

/**
 * Resolve the row config into the values the route uses.
 * @param config - raw row config.
 * @returns refresh interval and prices.
 */
function resolveOptions(config) {
  const raw = isRecord(config) ? config : {}
  const pricing = isRecord(raw.pricing) ? raw.pricing : {}
  const seconds =
    typeof raw.refreshSeconds === 'number' && Number.isFinite(raw.refreshSeconds)
      ? Math.min(600, Math.max(5, raw.refreshSeconds))
      : DEFAULT_REFRESH_SECONDS
  return {
    refreshMs: Math.round(seconds * 1000),
    pricing: {
      currency: typeof pricing.currency === 'string' && pricing.currency.trim() !== '' ? pricing.currency.trim() : 'CNY',
      inputPerMillion: price(pricing.inputPerMillion),
      cacheReadPerMillion: price(pricing.cacheReadPerMillion),
      cacheWritePerMillion: price(pricing.cacheWritePerMillion),
      outputPerMillion: price(pricing.outputPerMillion),
    },
  }
}

/**
 * Read the Session identifier, refusing ambiguous or malformed values.
 * @param url - parsed request URL.
 * @returns the identifier, `undefined` when absent, `null` when rejected.
 */
function sessionParam(url) {
  const values = url.searchParams.getAll('session')
  if (values.length === 0) return undefined
  if (values.length > 1) return null
  const value = values[0]
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return null
  return value
}

/**
 * Describe the requesting UI the way the account service expects.
 * @param url - parsed request URL.
 * @returns client metadata.
 */
function clientMetadata(url) {
  const version = url.searchParams.get('version') ?? ''
  const locale = url.searchParams.get('locale') ?? ''
  const offset = Number(url.searchParams.get('tz') ?? '')
  return {
    version: /^[0-9A-Za-z.+-]{1,32}$/u.test(version) ? version : '0.0.0',
    locale: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(locale) ? locale : 'en',
    timezoneOffsetSeconds:
      Number.isFinite(offset) && Math.abs(offset) <= 18 * 3600 ? Math.trunc(offset) : 0,
  }
}

/**
 * Accept only a request that carries no cross-origin evidence.
 *
 * A browser `fetch` from the page itself sends `Sec-Fetch-Site: same-origin`
 * and no `Origin`; the Desktop build carries the same fetch over an IPC bridge
 * that sends neither header, so an absent pair is accepted. A `null` origin is
 * a document outside HTTP (the Desktop shell's own page). A page on another
 * origin always announces itself and is rejected — the response also carries no
 * CORS headers, so such a page could not read it anyway.
 */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === null || origin === '' || origin === 'null') return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Answer one JSON response; the strip never caches one. */
function respond(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  for (const [header, value] of Object.entries(headers)) res.setHeader(header, value)
  res.writeHead(status)
  res.end(bytes)
}

/** Bound one optional read so a stalled provider cannot hold the route. */
async function withTimeout(operation, ms) {
  let timer
  try {
    return await Promise.race([
      operation(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** One optional Cordis service, or `undefined` in a composition without it. */
function optional(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

/** Log a warning when the composition provides a logger. */
function warn(ctx, template, ...args) {
  try {
    ctx.logger?.warn?.(template, ...args)
  } catch {
    // A warning must never fail the request it describes.
  }
}

/** A provider-reported token count, or zero when the value is unusable. */
function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < TOKEN_LIMIT ? value : 0
}

/** A configured per-million price. */
function price(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Narrow a value to a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Render any thrown value as one log line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
