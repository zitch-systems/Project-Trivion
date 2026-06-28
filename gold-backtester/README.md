# NEXUS Gold Lab — XAU/USD Backtester

A self-contained tool for **gold (XAU/USD) trading strategy testing**: a live chart
with **10 years of real historical data**, full **forex indicator suite**, a
**bar-by-bar replay engine** where you can enter and execute trades on historical
data, full P/L / equity tracking, and an **AI strategy assistant** (Claude, Grok,
or Gemini) you can teach your strategy to. Deployable to **Cloudflare** in one
command.

## What it does

- **Live + historical gold chart** (TradingView Lightweight Charts) — real OHLC
  data pulled from Yahoo Finance (`GC=F` / `XAUUSD=X`) with a Stooq fallback.
  Live spot price ticks in the header (refreshed every 15s).
- **Timeframes**: 1H, 4H, 1D (10yr), 1W, 1M.
- **Indicators**: SMA (20/50), EMA (21/200), Bollinger Bands, RSI, MACD, ATR,
  Stochastic, **VWAP, ADX (+DI/-DI), CCI, Williams %R**, and an auto
  **Fibonacci retracement** overlay — all computed client-side and toggleable.
- **Replay / backtest**: pick any start date, then step the chart forward
  (buttons, ▶ autoplay with speed control, or ← / → arrow keys). The future is
  hidden so you trade exactly as you would live.
- **Manual trade execution on historical bars**: BUY / SELL with lot size and
  auto or manual SL/TP (ATR-based by default). Stop-loss and take-profit fill
  automatically as replay advances. Open positions, closed trades, balance,
  equity, open P/L, and win rate all update in real time.
- **AI strategy assistant**:
  - **Teach** — describe a strategy in plain English; the AI formalizes it into
    precise entry/exit/risk rules.
  - **Signal Now** — the AI reads the current bar's live indicator snapshot and
    returns a BUY / SELL / HOLD with confidence, reason, stop and target.
  - **Auto-Backtest** — the AI compiles your strategy into a deterministic JSON
    rule spec (one API call), then a local engine runs it bar-by-bar over the
    full 10-year history and reports **net P/L, trade count, win rate, profit
    factor, max drawdown, and an equity curve** — with entry/exit markers on the
    chart. No per-bar API calls, so it's fast and repeatable.
- **Settings tab**: enter API keys + pick a model for **Claude**, **Grok**, and
  **Gemini**. Keys are stored only in your browser and proxied directly to the
  provider (no server-side storage/logging) to avoid CORS.

## Keyboard shortcuts (during replay)

| Key | Action |
|-----|--------|
| → | Step forward one bar |
| ← | Step back one bar |
| Space | Play / pause autoplay |
| B | Buy at current close |
| S | Sell at current close |

## Architecture

```
gold-backtester/
├── worker.js          # Cloudflare Worker: serves app + /api/gold, /api/quote, /api/ai
├── public/index.html  # The full single-page tool
├── wrangler.toml      # Cloudflare config (static assets + worker)
├── package.json
└── README.md
```

The Worker proxies data and AI so the browser never hits CORS walls and your API
keys go straight to the provider you chose.

## Deploy to Cloudflare

Requires a free Cloudflare account.

```bash
cd gold-backtester
npm install
npx wrangler login        # one-time browser auth
npm run deploy            # publishes the Worker (serves app + APIs)
```

Wrangler prints a `*.workers.dev` URL — open it and the tool is live. To use a
custom domain, add a route in the Cloudflare dashboard or `wrangler.toml`.

### Local dev

```bash
npm run dev               # http://localhost:8787
```

## Notes & limits

- Intraday (1H/4H) history from Yahoo is limited to ~730 days; daily/weekly/
  monthly go back the full 10 years.
- This is a **simulation / research tool**, not a live brokerage. No real orders
  are placed. P/L uses a configurable `$/pip per lot` (default $10/lot, gold
  pip = $0.10).
- Nothing here is financial advice.
