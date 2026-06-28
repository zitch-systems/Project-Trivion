/**
 * NEXUS Gold Backtester — Cloudflare Worker
 *
 * Responsibilities:
 *   1. Serve the static frontend (via the [assets] binding).
 *   2. /api/gold   -> proxy REAL gold OHLC data (Yahoo Finance, Stooq fallback).
 *   3. /api/quote  -> latest gold price.
 *   4. /api/ai     -> proxy chat completions to Claude / Grok / Gemini using the
 *                     user-supplied API key (avoids browser CORS restrictions).
 *
 * No secrets are stored server-side. AI keys are forwarded per-request from the
 * client and never logged or persisted.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      if (path === '/api/gold') return await handleGold(url);
      if (path === '/api/quote') return await handleQuote();
      if (path === '/api/ai') return await handleAI(request);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }

    // Fall through to static assets (the frontend app).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

/* ----------------------------- Gold OHLC data ----------------------------- */

// Maps UI interval/range to Yahoo Finance params.
const YF_SYMBOLS = ['GC=F', 'XAUUSD=X', 'GLD'];

// Yahoo's `range` token only accepts an enumerated set; "20y" / "730d" are NOT
// valid and cause a 422 -> silent wrong-data fallback. So for long daily windows
// we use period1/period2 (unix seconds, which override range and have no daily
// lookback cap), and for intraday we use the valid "2y" token (~730d, the 1h max).
async function handleGold(url) {
  const interval = url.searchParams.get('interval') || '1d'; // 1h,1d,1wk,1mo
  const range = url.searchParams.get('range') || '20y';
  const intraday = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '4h'].includes(interval);

  // Build Yahoo querystring per case.
  let qs, yfInterval;
  if (intraday) {
    yfInterval = '60m'; // Yahoo has no native 4h — caller resamples 1h->4h
    qs = `range=2y&interval=60m&includePrePost=false`;
  } else {
    yfInterval = interval;
    const years = range === 'max' ? 30 : (parseInt(range) || 20);
    const p2 = Math.floor(Date.now() / 1000);
    const p1 = p2 - Math.ceil(years * 365.25 * 86400);
    qs = `period1=${p1}&period2=${p2}&interval=${interval}&includePrePost=false`;
  }

  // Try Yahoo Finance across a few symbols/hosts.
  for (const sym of YF_SYMBOLS) {
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const y = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?${qs}`;
        const r = await fetch(y, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!r.ok) continue;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if (!res || !res.timestamp) continue;
        const q = res.indicators.quote[0];
        const bars = [];
        for (let i = 0; i < res.timestamp.length; i++) {
          const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
          if (o == null || h == null || l == null || c == null) continue;
          bars.push({
            time: res.timestamp[i],
            open: +o, high: +h, low: +l, close: +c,
            volume: q.volume && q.volume[i] != null ? +q.volume[i] : 0,
          });
        }
        if (bars.length) {
          return json({ source: `yahoo:${sym}`, interval: yfInterval, range, bars });
        }
      } catch (_) { /* try next */ }
    }
  }

  // Stooq fallback — DAILY/WEEKLY/MONTHLY only. Stooq has no intraday for xauusd,
  // so refuse intraday rather than silently returning daily bars mislabelled as 1H.
  if (!intraday) {
    try {
      const iv = interval === '1wk' ? 'w' : interval === '1mo' ? 'm' : 'd';
      const s = `https://stooq.com/q/d/l/?s=xauusd&i=${iv}`;
      const r = await fetch(s, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (r.ok) {
        const text = await r.text();
        const lines = text.trim().split('\n');
        const bars = [];
        for (let i = 1; i < lines.length; i++) {
          const [d, o, h, l, c, v] = lines[i].split(',');
          if (!d || !c || c === 'N/D') continue;
          bars.push({
            time: Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000),
            open: +o, high: +h, low: +l, close: +c, volume: v ? +v : 0,
          });
        }
        // Trim to requested range (years).
        const years = range === 'max' ? 30 : (parseInt(range) || 20);
        const cutoff = bars.length ? bars[bars.length - 1].time - years * 365 * 86400 : 0;
        const trimmed = bars.filter((b) => b.time >= cutoff);
        if (trimmed.length) return json({ source: 'stooq:xauusd', interval, range, bars: trimmed });
      }
    } catch (_) { /* ignore */ }
    return json({ error: 'Unable to fetch gold data from any provider right now.' }, 502);
  }

  return json({ error: 'Intraday gold data is temporarily unavailable (provider blocked). Try the 1D/1W/1M timeframes, which have 20 years of history.' }, 502);
}

async function handleQuote() {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `https://${host}/v8/finance/chart/GC=F?range=1d&interval=1m`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const meta = res?.meta;
      if (meta?.regularMarketPrice != null) {
        return json({
          price: meta.regularMarketPrice,
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
          time: meta.regularMarketTime ?? null,
          symbol: meta.symbol || 'GC=F',
        });
      }
    } catch (_) { /* next */ }
  }
  return json({ error: 'Quote unavailable' }, 502);
}

/* ------------------------------- AI proxy -------------------------------- */

async function handleAI(request) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const body = await request.json();
  const { provider, model, apiKey, system, prompt, temperature = 0.4, maxTokens = 2000 } = body;

  if (!apiKey) return json({ error: 'Missing API key' }, 400);

  if (provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        temperature,
        system: system || 'You are an expert quantitative forex/gold trading strategist.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || 'Claude error', raw: j }, r.status);
    return json({ text: (j.content || []).map((c) => c.text || '').join('\n'), raw: j });
  }

  if (provider === 'grok') {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || 'grok-4',
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system || 'You are an expert quantitative forex/gold trading strategist.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || 'Grok error', raw: j }, r.status);
    return json({ text: j.choices?.[0]?.message?.content || '', raw: j });
  }

  if (provider === 'gemini') {
    const m = model || 'gemini-2.5-flash';
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system || 'You are an expert quantitative forex/gold trading strategist.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      }
    );
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || 'Gemini error', raw: j }, r.status);
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
    return json({ text, raw: j });
  }

  return json({ error: `Unknown provider: ${provider}` }, 400);
}
