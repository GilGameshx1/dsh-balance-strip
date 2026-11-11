window.__ModuleLoader__.load({
  id: '@local/dsh-balance-strip',
  /**
   * Browser half: one strip in `shell.bottom` reporting the account balance and
   * the token spend of the Session on screen. Every value comes from this
   * package's Host route; this half only renders.
   */
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this package. */
    const NS = 'balance-strip'
    /** Same-origin route registered by the Host half. */
    const ROUTE = '/_dsh/balance-strip/status'
    /** Poll interval until the Host reports its configured one. */
    const FALLBACK_REFRESH_MS = 20000
    /** Never poll faster than this, whatever the Host reports. */
    const MIN_REFRESH_MS = 5000

    const en = {
      'label.balance': 'Balance',
      'label.session': 'Session',
      'label.tokens': 'tok',
      'label.loading': '…',
      'label.unavailable': 'unavailable',
      'label.signedOut': 'sign in',
      'label.cost': '≈',
      'tip.balance': 'Total available balance: topped-up credit plus granted credit.',
      'tip.session': 'Tokens spent in the session on screen.',
      'tip.prompt': 'Prompt',
      'tip.cacheRead': 'Cache read',
      'tip.cacheWrite': 'Cache write',
      'tip.output': 'Completion',
      'tip.cost': 'Estimated from the configured prices per million tokens; it is not billing data.',
      'tip.stale': 'The last read failed; showing the previous value.',
    }

    const ru = {
      'label.balance': 'Баланс',
      'label.session': 'Сессия',
      'label.tokens': 'ток',
      'label.loading': '…',
      'label.unavailable': 'нет данных',
      'label.signedOut': 'войдите',
      'label.cost': '≈',
      'tip.balance': 'Всего доступно: пополнения плюс начисленные бонусы.',
      'tip.session': 'Израсходовано токенов в открытой сейчас сессии.',
      'tip.prompt': 'Запрос',
      'tip.cacheRead': 'Из кеша',
      'tip.cacheWrite': 'В кеш',
      'tip.output': 'Ответ',
      'tip.cost': 'Оценка по заданным в конфиге ценам за миллион токенов; это не данные биллинга.',
      'tip.stale': 'Последнее чтение не удалось; показано предыдущее значение.',
    }

    const zh = {
      'label.balance': '余额',
      'label.session': '会话',
      'label.tokens': 'token',
      'label.loading': '…',
      'label.unavailable': '不可用',
      'label.signedOut': '未登录',
      'label.cost': '≈',
      'tip.balance': '可用总额：充值余额与赠送余额之和。',
      'tip.session': '当前会话已消耗的 token。',
      'tip.prompt': '输入',
      'tip.cacheRead': '缓存读取',
      'tip.cacheWrite': '缓存写入',
      'tip.output': '输出',
      'tip.cost': '按配置的每百万 token 价格估算，不是计费数据。',
      'tip.stale': '最近一次读取失败，显示的是上一次的值。',
    }

    const DICTS = { en, ru, zh }

    const CSS = [
      '.dshbs-root{box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;',
      'gap:16px;height:26px;padding:0 16px;overflow:hidden;',
      'background:var(--dsw-alias-bg-base);border-top:0.5px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;',
      'font-variant-numeric:tabular-nums;user-select:none;white-space:nowrap}',
      '.dshbs-item{display:inline-flex;align-items:baseline;gap:5px;min-width:0}',
      '.dshbs-label{color:var(--dsw-alias-label-secondary);opacity:.8}',
      '.dshbs-value{color:var(--dsw-alias-label-primary);font-weight:500;overflow:hidden;text-overflow:ellipsis}',
      '.dshbs-root[data-phase=stale] .dshbs-value{color:var(--dsw-alias-state-warn-primary)}',
      '.dshbs-root[data-phase=failed] .dshbs-value{color:var(--dsw-alias-label-secondary);font-weight:400}',
    ].join('')

    /**
     * Install the strip.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      const locale = service(ctx, 'locale')
      if (locale !== undefined && typeof locale.register === 'function') {
        effect(ctx, () => locale.register(NS, { en, zh }), 'balance-strip: dictionaries')
        // A Russian UI is not shipped by the product; its dictionary is simply
        // inert until such a language pack registers the language itself.
        effect(ctx, () => locale.register(NS, 'ru', ru), 'balance-strip: ru dictionary')
      }

      const translate = translator(ctx)
      const Strip = createStrip(ctx, translate)

      ctx.slots.inject('shell.bottom', () => ctx.slots.register({ name: 'shell.bottom' }, Strip))
    }

    /**
     * Build the strip component over the plugin context.
     * @param ctx - Client plugin context.
     * @param translate - current dictionary lookup.
     * @returns the slot component.
     */
    function createStrip(ctx, translate) {
      return function BalanceStrip() {
        const locale = service(ctx, 'locale')
        const localeSnapshot = useExternal(locale)
        const language = languageOf(localeSnapshot)
        const t = (key) => translate(key, language)

        const mounted = mountedStore(ctx)
        const sessionId = useExternal(mounted)

        const [state, setState] = React.useState({ phase: 'loading', value: undefined })
        const interval = React.useRef(FALLBACK_REFRESH_MS)

        React.useEffect(() => {
          let cancelled = false
          let timer = 0
          const load = () => {
            window.clearTimeout(timer)
            void (async () => {
              const query = new URLSearchParams()
              if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId)
              query.set('locale', language)
              query.set('tz', String(-new Date().getTimezoneOffset() * 60))
              const version = bootVersion()
              if (version !== '') query.set('version', version)
              try {
                const response = await fetch(`${ROUTE}?${query.toString()}`, {
                  credentials: 'same-origin',
                  cache: 'no-store',
                  headers: { accept: 'application/json' },
                })
                const body = await response.json()
                if (cancelled) return
                if (response.ok && body !== null && body !== undefined && body.ok === true && body.value) {
                  const value = body.value
                  if (typeof value.refreshMs === 'number' && value.refreshMs >= MIN_REFRESH_MS) {
                    interval.current = value.refreshMs
                  }
                  setState({ phase: 'ready', value, error: undefined })
                } else {
                  setState((previous) => ({
                    phase: previous.value === undefined ? 'failed' : 'stale',
                    value: previous.value,
                    error: describe(response, body),
                  }))
                }
              } catch (error) {
                if (cancelled) return
                setState((previous) => ({
                  phase: previous.value === undefined ? 'failed' : 'stale',
                  value: previous.value,
                  error: error instanceof Error ? error.message : String(error),
                }))
              }
              if (!cancelled) timer = window.setTimeout(load, interval.current)
            })()
          }
          const onVisible = () => {
            if (document.visibilityState === 'visible') load()
          }
          load()
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            cancelled = true
            window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, [sessionId, language])

        const value = state.value
        const balance = value !== undefined && value !== null ? value.balance : undefined
        const usage = value !== undefined && value !== null ? value.usage : undefined
        const priced = usage !== undefined && usage.priced === true && typeof usage.cost === 'number'
        const currency = usage !== undefined && typeof usage.currency === 'string' ? usage.currency : 'CNY'

        const wallets = visibleWallets(balance !== undefined ? balance.wallets : undefined)
        const emptyLabel = state.phase === 'loading' ? t('label.loading') : t('label.unavailable')
        const balanceText =
          wallets.length > 0
            ? wallets.map((wallet) => money(wallet.total, wallet.currency, language)).join(' · ')
            : balance !== undefined && balance.status === 'signed-out'
              ? t('label.signedOut')
              : emptyLabel

        const live = typeof sessionId === 'string' && sessionId !== ''
        const ready = usage !== undefined && usage.status === 'ready'
        const sessionText = ready
          ? `${compact(usage.totalTokens, language)} ${t('label.tokens')}${
              priced ? ` · ${t('label.cost')}${cost(usage.cost, currency, language)}` : ''
            }`
          : emptyLabel

        const tip = [t('tip.balance'), walletTip(wallets, language)]
        if (live) {
          tip.push('', t('tip.session'))
          if (ready) {
            tip.push(
              `${t('tip.prompt')}: ${count(usage.inputTokens, language)}`,
              `${t('tip.cacheRead')}: ${count(usage.cacheReadTokens, language)}`,
              `${t('tip.cacheWrite')}: ${count(usage.cacheWriteTokens, language)}`,
              `${t('tip.output')}: ${count(usage.outputTokens, language)}`,
            )
            if (priced) tip.push(`${t('label.cost')}${cost(usage.cost, currency, language)} — ${t('tip.cost')}`)
          }
          if (state.phase === 'stale') tip.push('', t('tip.stale'))
        }
        if (typeof state.error === 'string' && state.error !== '') tip.push('', state.error)

        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h(
            'div',
            {
              className: 'dshbs-root',
              'data-balance-strip': 'status',
              'data-phase': state.phase,
              title: tip.filter((line) => line !== undefined).join('\n'),
              'aria-label': `${t('label.balance')} ${balanceText}${live ? `, ${t('label.session')} ${sessionText}` : ''}`,
            },
            h(
              'span',
              { className: 'dshbs-item' },
              h('span', { className: 'dshbs-label' }, t('label.balance')),
              h('span', { className: 'dshbs-value' }, balanceText),
            ),
            live
              ? h(
                  'span',
                  { className: 'dshbs-item' },
                  h('span', { className: 'dshbs-label' }, t('label.session')),
                  h('span', { className: 'dshbs-value' }, sessionText),
                )
              : null,
          ),
        )
      }
    }

    /** The store naming the Session on screen, when this composition has one. */
    function mountedStore(ctx) {
      const sidebarRight = service(ctx, 'sidebarRight')
      const mounted = sidebarRight !== undefined ? sidebarRight.mounted : undefined
      return mounted !== undefined && typeof mounted.getSnapshot === 'function' && typeof mounted.subscribe === 'function'
        ? mounted
        : undefined
    }

    /** Subscribe a component to one observable snapshot. */
    function useExternal(observable) {
      const subscribe = React.useCallback(
        (onChange) => (observable !== undefined ? observable.subscribe(onChange) : () => {}),
        [observable],
      )
      const snapshot = React.useCallback(
        () => (observable !== undefined ? observable.getSnapshot() : undefined),
        [observable],
      )
      return React.useSyncExternalStore(subscribe, snapshot, snapshot)
    }

    /** One optional Cordis service. */
    function service(ctx, key) {
      try {
        return ctx.get(key)
      } catch {
        return undefined
      }
    }

    /** Run a registration as an effect, tolerating a composition without its owner. */
    function effect(ctx, register, label) {
      try {
        ctx.effect(register, label)
      } catch (error) {
        console.error(`${NS}: ${label} failed`, error)
      }
    }

    /**
     * Resolve visible copy through the Client locale service, falling back to
     * this package's own dictionaries when the service is unavailable.
     * @param ctx - Client plugin context.
     * @returns `(key, language) => string`.
     */
    function translator(ctx) {
      const locale = service(ctx, 'locale')
      const bound = locale !== undefined && typeof locale.bind === 'function' ? safeBind(locale) : undefined
      return (key, language) => {
        if (bound !== undefined) {
          const value = bound(key)
          if (typeof value === 'string' && value !== key && value !== '') return value
        }
        const dict = DICTS[language] ?? DICTS.en
        return dict[key] ?? DICTS.en[key] ?? key
      }
    }

    /** Bind one namespace without letting a missing registration break rendering. */
    function safeBind(locale) {
      try {
        return locale.bind(NS)
      } catch {
        return undefined
      }
    }

    /** The active language id, reduced to its primary subtag. */
    function languageOf(snapshot) {
      const id = snapshot !== undefined && snapshot !== null && typeof snapshot.locale === 'string' ? snapshot.locale : 'en'
      return id.toLowerCase().split('-')[0]
    }

    /** One line describing why a status read did not produce a value. */
    function describe(response, body) {
      const status = response !== undefined && response !== null && typeof response.status === 'number' ? `HTTP ${response.status}` : 'no response'
      const failure = body !== undefined && body !== null ? body.error : undefined
      if (failure === undefined || failure === null) return status
      const code = typeof failure.code === 'string' ? ` ${failure.code}` : ''
      const message = typeof failure.message === 'string' ? `: ${failure.message}` : ''
      return `${status}${code}${message}`
    }

    /** The build version the boot payload reports, if it reports one. */
    function bootVersion() {
      try {
        const boot = window.__DSH_BOOT__
        const release = boot !== undefined && boot !== null ? boot.release : undefined
        return release !== undefined && release !== null && typeof release.version === 'string' ? release.version : ''
      } catch {
        return ''
      }
    }

    /** Format a currency amount with the interface language. */
    function money(amount, currency, language) {
      const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
      try {
        return new Intl.NumberFormat(language, {
          style: 'currency',
          currency: String(currency || 'CNY'),
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value)
      } catch {
        return `${value.toFixed(2)} ${currency}`
      }
    }

    /** Format an estimated cost, keeping sub-cent values visible. */
    function cost(amount, currency, language) {
      const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
      try {
        return new Intl.NumberFormat(language, {
          style: 'currency',
          currency: String(currency || 'CNY'),
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: value < 1 ? 4 : 2,
        }).format(value)
      } catch {
        return `${value.toFixed(4)} ${currency}`
      }
    }

    /** Format a token total compactly (`12.4K`). */
    function compact(amount, language) {
      const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
      try {
        return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(Math.round(value))
      }
    }

    /** Format one exact token count for the tooltip. */
    function count(amount, language) {
      const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
      try {
        return new Intl.NumberFormat(language).format(value)
      } catch {
        return String(Math.round(value))
      }
    }

    /**
     * The wallets worth showing: a funded currency first, and never a row of
     * zero-only wallets beside it. An account with no credit at all keeps its
     * first wallet so the strip reports a real zero.
     */
    function visibleWallets(wallets) {
      if (!Array.isArray(wallets)) return []
      const funded = wallets.filter((wallet) => {
        const total = typeof wallet.total === 'number' && Number.isFinite(wallet.total) ? wallet.total : 0
        const toppedUp = typeof wallet.toppedUp === 'number' && Number.isFinite(wallet.toppedUp) ? wallet.toppedUp : 0
        const bonus = typeof wallet.bonus === 'number' && Number.isFinite(wallet.bonus) ? wallet.bonus : 0
        return total !== 0 || toppedUp !== 0 || bonus !== 0
      })
      if (funded.length > 0) return funded
      return wallets.length > 0 ? [wallets[0]] : []
    }

    /** The balance tooltip's wallet lines. */
    function walletTip(wallets, language) {      if (!Array.isArray(wallets) || wallets.length === 0) return undefined
      return wallets
        .map((wallet) => `${money(wallet.total, wallet.currency, language)} (${money(wallet.toppedUp, wallet.currency, language)} + ${money(wallet.bonus, wallet.currency, language)})`)
        .join(' · ')
    }

    return {
      inject: ['slots'],
      apply,
    }
  },
})
