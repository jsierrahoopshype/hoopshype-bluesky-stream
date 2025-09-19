// Bluesky stream — concurrency + time budget to avoid 504s
import { readFile } from 'fs/promises';

const DEFAULT_CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const DEFAULT_MAX_REPORTERS = Number(process.env.MAX_REPORTERS || 60);
const TIME_BUDGET_MS = 8000; // stop work ~8s to return something
const PER_AUTHOR_LIMIT = 50; // posts per author feed
const REQ_TIMEOUT_MS = 1500; // abort slow upstream calls

export default async (req, context) => {
  const started = Date.now();
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('ping') === '1') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    const q = (url.searchParams.get('q') || '')
      .split('|').map(s => s.trim()).filter(Boolean);
    const tz = url.searchParams.get('tz') || (process.env.TIMEZONE || 'America/New_York');

    // Load reporters (remote first, fallback local)
    const reportersCsv = await loadReportersCsv();
    const reportersAll = parseCsv(reportersCsv);
    // Optional: allow per-request override ?limitReporters=40
    const maxReporters = Number(url.searchParams.get('limitReporters') || DEFAULT_MAX_REPORTERS);
    const reporters = reportersAll.slice(0, Math.max(1, maxReporters));

    // Resolve DIDs (in parallel, small pool)
    await pool(reporters.map(r => async () => {
      if (!r.did && r.handle) r.did = await resolveDid(r.handle);
    }), DEFAULT_CONCURRENCY);

    // Filter invalid
    const ready = reporters.filter(r => r.did);

    // Fetch author feeds in parallel with time budget
    const items = [];
    const tasks = ready.map(r => async () => {
      if (Date.now() - started > TIME_BUDGET_MS) return; // respect budget
      const feed = await fetchJSON(
        `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(r.did)}&limit=${PER_AUTHOR_LIMIT}`,
        REQ_TIMEOUT_MS
      );
      for (const item of (feed.feed || [])) {
        const post = item.post;
        if (!post || post.author?.did !== r.did) continue;

        // Only originals
        if (post.reason) continue;                  // reposts
        if (post.record?.reply) continue;           // replies
        if (post.embed?.$type === 'app.bsky.embed.record' || post.embed?.record) continue; // quotes

        const created = Date.parse(post.record?.createdAt || post.indexedAt || '');
        if (!created || created < Date.now() - 7*24*60*60*1000) continue; // last 7 days

        const text = post.record?.text || '';
        if (q.length && !containsAny(text, q)) continue;

        const postId = (post.uri || '').split('/').pop();
        const link = `https://bsky.app/profile/${post.author?.did}/post/${postId}`;

        items.push({
          ts: created,
          tsLocal: new Intl.DateTimeFormat('en-US', {
            timeStyle: 'short', dateStyle: 'medium', timeZone: tz
          }).format(new Date(created)),
          authorDisplay: post.author?.displayName || post.author?.handle || 'Reporter',
          authorHandle: post.author?.handle || '',
          authorAvatar: post.author?.avatar || '',
          html: escapeHtml(text).replace(/\n/g, '<br>'),
          mediaUrl: extractFirstImage(post),
          url: addUtm(link, 'hoopshype')
        });
      }
    });

    await pool(tasks, DEFAULT_CONCURRENCY);

    items.sort((a,b) => b.ts - a.ts);
    return json({ items, scanned: ready.length, took_ms: Date.now() - started });

  } catch (e) {
    console.error('[stream] error', e && (e.stack || e.message || e));
    return new Response(JSON.stringify({ error: e.message || 'error' }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
};

// ---------------- helpers ----------------
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' }
  });
}
async function fetchJSON(u, timeoutMs) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs || 0);
  try {
    const r = await fetch(u, { signal: ctl.signal });
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
function extractFirstImage(p) {
  return p?.embed?.images?.[0]?.fullsize || p?.record?.embed?.images?.[0]?.fullsize || null;
}
function addUtm(u, source) {
  const url = new URL(u);
  url.searchParams.set('utm_source', source);
  return url.toString();
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i=1;i<lines.length;i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [handle = '', did = ''] = line.split(',');
    if (!handle) continue;
    out.push({ handle: handle.trim(), did: did.trim() });
  }
  return out;
}
function containsAny(text, tokens) {
  const lower = text.toLowerCase();
  return tokens.some(k => lower.includes(String(k).toLowerCase()));
}
async function loadReportersCsv() {
  const remote = process.env.REPORTERS_CSV_URL;
  if (remote) {
    const r = await fetch(remote, { headers: { 'cache-control': 'no-cache' } });
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
