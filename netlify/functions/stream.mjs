// Bluesky stream function — CORS, UA, edge cache, strict matching
import { readFile } from 'fs/promises';

// ---------- CORS ----------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

// ---------- identify ourselves upstream ----------
const OUTBOUND_HEADERS = {
  'User-Agent': 'HoopsHype-Stream/1.0 (+https://hoopshype.com; contact: newsroom@hoopshype.com)'
};

// ---------- tunables (override via Netlify env) ----------
const CONCURRENCY      = Number(process.env.CONCURRENCY || 6);   // parallel author requests
const MAX_REPORTERS    = Number(process.env.MAX_REPORTERS || 40); // authors scanned per call
const TIME_BUDGET_MS   = 8000;   // stop work ~8s in so we return something, not a 504
const PER_AUTHOR_LIMIT = 50;     // posts per author feed request
const REQ_TIMEOUT_MS   = 1500;   // per-request upstream timeout (ms)

// ---------- handler ----------
export default async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const started = Date.now();
  try {
    const url = new URL(req.url);

    // editors can bypass CDN/browser cache: …&nocache=1
    const NO_CACHE = url.searchParams.get('nocache') === '1';

    // quick liveness probe
    if (url.searchParams.get('ping') === '1') {
      return json({ ok: true, ts: new Date().toISOString() }, { noCache: NO_CACHE });
    }

    const qTokens = (url.searchParams.get('q') || '')
      .split('|').map(s => s.trim()).filter(Boolean);
    const tz = url.searchParams.get('tz') || (process.env.TIMEZONE || 'America/New_York');

    // per-request override: ?limitReporters=40
    const maxReporters = Number(url.searchParams.get('limitReporters') || MAX_REPORTERS);

    // 1) Load reporters (GitHub raw via env, fallback to bundled file)
    const reportersCsv = await loadReportersCsv();
    const reportersAll = parseCsv(reportersCsv);
    const reporters = reportersAll.slice(0, Math.max(1, maxReporters));

    // 2) Resolve missing DIDs (small pool)
    await pool(
      reporters.map(r => async () => {
        if (!r.did && r.handle) r.did = await resolveDid(r.handle);
      }),
      CONCURRENCY
    );
    const ready = reporters.filter(r => r.did);

    // 3) Fetch author feeds in parallel, respect time budget
    const items = [];
    await pool(
      ready.map(r => async () => {
        if (Date.now() - started > TIME_BUDGET_MS) return;

        const feed = await fetchJSON(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(r.did)}&limit=${PER_AUTHOR_LIMIT}`,
          REQ_TIMEOUT_MS
        );

        for (const entry of (feed.feed || [])) {
          const post = entry.post;
          if (!post || post.author?.did !== r.did) continue;

          // originals only
          if (post.reason) continue;                       // reposts
          if (post.record?.reply) continue;                // replies
          if (post.embed?.$type === 'app.bsky.embed.record' || post.embed?.record) continue; // quotes

          const created = Date.parse(post.record?.createdAt || post.indexedAt || '');
          if (!created || created < Date.now() - 7 * 24 * 60 * 60 * 1000) continue; // last 7 days

          const text = post.record?.text || '';
          if (qTokens.length && !matchesAny(text, qTokens)) continue; // strict match

          const postId = (post.uri || '').split('/').pop();
          const link = `https://bsky.app/profile/${post.author?.did}/post/${postId}`;

          items.push({
            ts: created,
            tsLocal: new Intl.DateTimeFormat('en-US', {
              timeStyle: 'short',
              dateStyle: 'medium',
              timeZone: tz
            }).format(new Date(created)),
            authorDisplay: post.author?.displayName || post.author?.handle || 'Reporter',
            authorHandle: post.author?.handle || '',
            authorAvatar: post.author?.avatar || '',
            html: escapeHtml(text).replace(/\n/g, '<br>'),
            mediaUrl: firstImage(post),
            url: addUtm(link, 'hoopshype')
          });
        }
      }),
      CONCURRENCY
    );

    items.sort((a, b) => b.ts - a.ts);
    return json({ items, scanned: ready.length, took_ms: Date.now() - started }, { noCache: NO_CACHE });

  } catch (e) {
    console.error('[stream] error', e && (e.stack || e.message || e));
    return new Response(JSON.stringify({ error: e.message || 'error' }), {
      status: 500,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' }
    });
  }
};

// ---------- matching helpers (ignore URLs; whole-word for short aliases like "KD") ----------
function stripUrls(s) { return s.replace(/https?:\/\/\S+/gi, ' '); }
function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // Dončić -> doncic
    .replace(/\s+/g, ' ').trim();
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mkRegex(token) {
  const t = normalize(token);
  if (t.includes(' ')) return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(t)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  if (t.length <= 3) return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(t)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return new RegExp(`\\b${escapeRegExp(t)}\\b`, 'iu');
}
function matchesAny(text, tokens) {
  const clean = normalize(stripUrls(text));
  return tokens.some(tok => mkRegex(tok).test(clean));
}

// ---------- misc helpers ----------
function json(obj, opts = {}) {
  // Browser TTL ~60s, CDN TTL ~300s by default; editors can disable via &nocache=1
  const browserTTL = opts.noCache ? 0 : 60;   // seconds
  const cdnTTL     = opts.noCache ? 0 : 300;  // seconds
  const swr        = opts.noCache ? 0 : 120;  // serve-stale-while-revalidate

  const headers = {
    ...CORS,
    'content-type': 'application/json',
    'cache-control': browserTTL
      ? `public, max-age=${browserTTL}, s-maxage=${cdnTTL}, stale-while-revalidate=${swr}`
      : 'no-store',
    'Netlify-CDN-Cache-Control': cdnTTL ? `public, s-maxage=${cdnTTL}` : 'no-store'
  };
  return new Response(JSON.stringify(obj), { headers });
}

async function fetchJSON(u, timeoutMs) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs || 0);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: OUTBOUND_HEADERS });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

async function resolveDid(handle) {
  try {
    const u = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
    const r = await fetchJSON(u, REQ_TIMEOUT_MS);
    return r.did || null;
  } catch { return null; }
}

function firstImage(p) {
  return p?.embed?.images?.[0]?.fullsize || p?.record?.embed?.images?.[0]?.fullsize || null;
}
function addUtm(u, source) {
  const url = new URL(u);
  url.searchParams.set('utm_source', source);
  return url.toString();
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [handle = '', did = ''] = line.split(',');
    if (!handle) continue;
    out.push({ handle: handle.trim(), did: did.trim() });
  }
  return out;
}

async function loadReportersCsv() {
  const remote = process.env.REPORTERS_CSV_URL;
  if (remote) {
    const r = await fetch(remote, { headers: { ...OUTBOUND_HEADERS, 'cache-control': 'no-cache' } });
    if (r.ok) return await r.text();
  }
  const local = new URL('../../reporters.csv', import.meta.url);
  return await readFile(local, 'utf8');
}

async function pool(tasks, size) {
  const q = tasks.slice();
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (q.length) {
      const job = q.shift();
      try { await job(); } catch {}
    }
  });
  await Promise.all(workers);
}
