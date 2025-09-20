// Bluesky stream — CORS, UA, edge cache, strict matching, daily rotation, 15-day window,
// and (NEW) include reposts, replies, quotes (on by default)
import { readFile } from 'fs/promises';

// ---------- CORS ----------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

// ---------- identify ourselves upstream ----------
const OUTBOUND_HEADERS = {
  'User-Agent': 'HoopsHype-Stream/1.1 (+https://hoopshype.com; contact: newsroom@hoopshype.com)'
};

// ---------- tunables (override via Netlify env) ----------
const CONCURRENCY      = Number(process.env.CONCURRENCY || 6);
const TIME_BUDGET_MS   = 8000;
const PER_AUTHOR_LIMIT = 50;
const REQ_TIMEOUT_MS   = 1500;
const WINDOW_DAYS      = Number(process.env.WINDOW_DAYS || 15);

// rotation defaults
const ROTATE_TZ    = process.env.ROTATE_TZ || 'America/New_York';
const ROTATE_COUNT = Number(process.env.ROTATE_COUNT || 80);

// ---------- handler ----------
export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const started = Date.now();
  try {
    const url = new URL(req.url);
    const NO_CACHE = url.searchParams.get('nocache') === '1';

    if (url.searchParams.get('ping') === '1') {
      return json({ ok: true, ts: new Date().toISOString() }, { noCache: NO_CACHE });
    }

    const qTokens = (url.searchParams.get('q') || '').split('|').map(s => s.trim()).filter(Boolean);
    const tz = url.searchParams.get('tz') || (process.env.TIMEZONE || 'America/New_York');

    // NEW: inclusion toggles (default ON)
    const INC_REPOSTS = url.searchParams.get('includeReposts') !== '0';
    const INC_REPLIES = url.searchParams.get('includeReplies') !== '0';
    const INC_QUOTES  = url.searchParams.get('includeQuotes')  !== '0';

    // Optional looser matching
    const MATCH_IN_URLS   = url.searchParams.get('matchInUrls')   === '1';
    const MATCH_IN_QUOTED = url.searchParams.get('matchInQuoted') === '1';

    // ----- reporters + daily rotation -----
    const reportersCsv = await loadReportersCsv();
    const reportersAll = parseCsv(reportersCsv);

    const wantCount = Math.max(
      1,
      Math.min(
        reportersAll.length,
        Number(url.searchParams.get('limitReporters')) || ROTATE_COUNT
      )
    );

    const offset = reportersAll.length ? (dayOffset(ROTATE_TZ) % reportersAll.length) : 0;
    const rotated = reportersAll.slice(offset).concat(reportersAll.slice(0, offset));
    const reporters = rotated.slice(0, wantCount);

    // ----- resolve DIDs -----
    await pool(
      reporters.map(r => async () => { if (!r.did && r.handle) r.did = await resolveDid(r.handle); }),
      CONCURRENCY
    );
    const ready = reporters.filter(r => r.did);

    // ----- fetch feeds -----
    const sinceMs = Date.now() - WINDOW_DAYS * 86400000;
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
          if (!post) continue;

          // Determine kind and attribution
          const isRepost = !!entry.reason?.$type?.includes('reasonRepost');
          const isReply  = !!post.record?.reply;
          const isQuote  = !!(post.embed?.$type === 'app.bsky.embed.record' || post.embed?.record);

          // skip types toggled off
          if (isRepost && !INC_REPOSTS) continue;
          if (isReply  && !INC_REPLIES) continue;
          if (isQuote  && !INC_QUOTES)  continue;

          // Accept only items performed by this reporter (originals OR reposts they did)
          const performedByReporter =
            (post.author?.did === r.did) ||                         // originals/replies/quotes
            (isRepost && entry.reason?.by?.did === r.did);          // reposts

          if (!performedByReporter) continue;

          // Timestamp: use repost time for reposts; else post time
          const created = isRepost
            ? Date.parse(entry.reason?.indexedAt || post.indexedAt || '')
            : Date.parse(post.record?.createdAt || post.indexedAt || '');

          if (!created || created < sinceMs) continue;

          // Build text sources for matching
          const postText   = post.record?.text || '';
          const quotedText = isQuote ? (readQuotedText(post) || '') : '';
          const urlText    = collectUrls(post); // for optional MATCH_IN_URLS

          // Matching
          if (qTokens.length) {
            const matchesText   = matchesAny(postText, qTokens);
            const matchesQuoted = MATCH_IN_QUOTED && quotedText ? matchesAny(quotedText, qTokens) : false;
            const matchesUrls   = MATCH_IN_URLS   && urlText    ? matchesAny(urlText, qTokens, { stripUrls: false }) : false;

            // Reposts: match against original post text and (optionally) its URLs
            const sourceForRepost = post.record?.text || '';
            const repostTextMatch = isRepost
              ? (matchesAny(sourceForRepost, qTokens) || (MATCH_IN_URLS && matchesAny(collectUrls(post), qTokens, { stripUrls: false })))
              : false;

            const pass =
              (isRepost ? repostTextMatch : false) ||
              matchesText || matchesQuoted || matchesUrls;

            if (!pass) continue;
          }

          // Presentation
          const postId = (post.uri || '').split('/').pop();
          const link   = `https://bsky.app/profile/${post.author?.did}/post/${postId}`;
          const baseItem = {
            ts: created,
            tsLocal: new Intl.DateTimeFormat('en-US', {
              timeStyle: 'short', dateStyle: 'medium', timeZone: tz
            }).format(new Date(created)),
            authorDisplay: entry.reason?.by?.displayName || post.author?.displayName || r.handle || 'Reporter',
            authorHandle:  entry.reason?.by?.handle      || post.author?.handle      || '',
            authorAvatar:  entry.reason?.by?.avatar      || post.author?.avatar      || '',
            mediaUrl: firstImage(post),
            url: addUtm(link, 'hoopshype')
          };

          if (isRepost) {
            const origName   = post.author?.displayName || post.author?.handle || 'user';
            const origHandle = post.author?.handle ? `@${post.author.handle}` : '';
            const body = `[Repost of ${origName}${origHandle ? ' ' + origHandle : ''}] ` + (post.record?.text || '');
            items.push({ ...baseItem, kind: 'repost', html: escapeHtml(body).replace(/\n/g, '<br>') });
            continue;
          }

          if (isReply) {
            items.push({ ...baseItem, kind: 'reply', html: escapeHtml(postText).replace(/\n/g, '<br>') });
            continue;
          }

          if (isQuote) {
            items.push({ ...baseItem, kind: 'quote', html: escapeHtml(postText).replace(/\n/g, '<br>') });
            continue;
          }

          // original
          items.push({ ...baseItem, kind: 'original', html: escapeHtml(postText).replace(/\n/g, '<br>') });
        }
      }),
      CONCURRENCY
    );

    items.sort((a, b) => b.ts - a.ts);
    return json({ items, scanned: ready.length, took_ms: Date.now() - started, window_days: WINDOW_DAYS }, { noCache: NO_CACHE });

  } catch (e) {
    console.error('[stream] error', e && (e.stack || e.message || e));
    return new Response(JSON.stringify({ error: e.message || 'error' }), {
      status: 500,
      headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' }
    });
  }
};

// ---------- helpers ----------
function dayOffset(tz) {
  const now = new Date();
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now).split('-').map(Number);
  const dayUTC = Date.UTC(y, m - 1, d);
  return Math.floor(dayUTC / 86400000);
}

function stripUrlsFn(s) { return s.replace(/https?:\/\/\S+/gi, ' '); }
function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ').trim();
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mkRegex(token) {
  const t = normalize(token);
  if (t.includes(' ')) return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(t)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  if (t.length <= 3) return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(t)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return new RegExp(`\\b${escapeRegExp(t)}\\b`, 'iu');
}
function matchesAny(text, tokens, opts = {}) {
  const stripUrls = opts.stripUrls !== false; // default true
  const src = stripUrls ? normalize(stripUrlsFn(text)) : normalize(text);
  return tokens.some(tok => mkRegex(tok).test(src));
}

function readQuotedText(post) {
  // attempt to read primary record text of embedded/quoted post if present
  try {
    const rec = post.embed?.record?.value || post.embed?.record?.record?.value;
    return rec?.text || '';
  } catch { return ''; }
}

function collectUrls(post) {
  const parts = [];
  const t = post.record?.text || '';
  const m = t.match(/https?:\/\/\S+/gi);
  if (m) parts.push(m.join(' '));
  // best-effort: pull embed external urls if any (not exhaustive)
  const e = post.embed;
  if (e?.external?.uri) parts.push(String(e.external.uri));
  if (e?.images) for (const im of e.images) if (im?.fullsize) parts.push(String(im.fullsize));
  return parts.join(' ');
}

function json(obj, opts = {}) {
  const browserTTL = opts.noCache ? 0 : 60;
  const cdnTTL     = opts.noCache ? 0 : 300;
  const swr        = opts.noCache ? 0 : 120;

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
  } finally { clearTimeout(to); }
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
function addUtm(u, source) { const url = new URL(u); url.searchParams.set('utm_source', source); return url.toString(); }
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
