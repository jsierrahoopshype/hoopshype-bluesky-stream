// netlify/functions/reactions.mjs
// Bluesky "Reactions" — search public posts in last X hours, filter by reposts/likes, return sorted list.
// No auth, uses the public Bluesky API. Adds CORS + UA + edge cache.
//
// Query params:
// q=(string)|hours=6|minReposts=5|minLikes=0|limit=40|sort=reposts|includeReplies=0|includeQuotes=0
// tz=America/New_York  (for local timestamps)
// nocache=1 to bypass cache once
//
// Example:
// /api/reactions?q=LeBron%20James&hours=12&minReposts=10&limit=50&sort=reposts

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

const OUTBOUND_HEADERS = {
  'User-Agent': 'HoopsHype-Reactions/1.0 (+https://hoopshype.com)'
};

const REQ_TIMEOUT_MS = 1500;
const PAGE_LIMIT = 50; // per API page

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const hours = Math.max(1, Number(url.searchParams.get('hours') || 6));
    const minReposts = Math.max(0, Number(url.searchParams.get('minReposts') || 5));
    const minLikes = Math.max(0, Number(url.searchParams.get('minLikes') || 0));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 40)));
    const sort = (url.searchParams.get('sort') || 'reposts').toLowerCase(); // 'reposts'|'likes'|'total'
    const tz = url.searchParams.get('tz') || 'America/New_York';
    const includeReplies = url.searchParams.get('includeReplies') === '1';
    const includeQuotes  = url.searchParams.get('includeQuotes')  === '1';
    const NO_CACHE = url.searchParams.get('nocache') === '1';

    if (!q) {
      return json({ error: 'missing q' }, { status: 400, noCache: true });
    }

    const sinceMs = Date.now() - hours * 3600 * 1000;
    const out = [];

    // We page through search results until we go past the time window or hit limit*2
    let cursor = '';
    let safety = 0;

    while (safety++ < 20 && out.length < limit * 2) {
      const endpoint = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
      endpoint.searchParams.set('q', q);
      endpoint.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor) endpoint.searchParams.set('cursor', cursor);

      const page = await fetchJSON(endpoint.toString(), REQ_TIMEOUT_MS);
      const posts = page?.posts || [];
      if (!posts.length) break;

      for (const p of posts) {
        const created =
          Date.parse(p.record?.createdAt || p.indexedAt || '') ||
          Date.parse(p.indexedAt || '');
        if (!created) continue;

        // stop if results are older than window (API is roughly newest-first)
        if (created < sinceMs) { safety = 99; break; }

        const isReply = !!p.record?.reply;
        const isQuote = !!(p.embed?.record || p.embed?.$type === 'app.bsky.embed.record');
        if (isReply && !includeReplies) continue;
        if (isQuote && !includeQuotes) continue;

        const reposts = Number(p.repostCount || 0);
        const likes   = Number(p.likeCount || 0);
        if (reposts < minReposts) continue;
        if (likes   < minLikes) continue;

        const id = (p.uri || '').split('/').pop();
        const urlPost = `https://bsky.app/profile/${p.author?.did}/post/${id}`;
        out.push({
          ts: created,
          tsLocal: new Intl.DateTimeFormat('en-US', {
            timeStyle: 'short', dateStyle: 'medium', timeZone: tz
          }).format(new Date(created)),
          authorDisplay: p.author?.displayName || p.author?.handle || 'User',
          authorHandle:  p.author?.handle || '',
          authorAvatar:  p.author?.avatar || '',
          textHtml: escapeHtml(p.record?.text || '').replace(/\n/g,'<br>'),
          mediaUrl: firstImage(p),
          url: urlPost,
          repostCount: reposts,
          likeCount: likes,
          replyCount: Number(p.replyCount || 0),
          quote: isQuote ? 1 : 0,
          reply: isReply ? 1 : 0
        });
      }

      cursor = page?.cursor || '';
      if (!cursor) break;
    }

    // sort
    out.sort((a, b) => {
      if (sort === 'likes')  return b.likeCount - a.likeCount || b.ts - a.ts;
      if (sort === 'total')  return (b.likeCount + b.repostCount) - (a.likeCount + a.repostCount) || b.ts - a.ts;
      return b.repostCount - a.repostCount || b.ts - a.ts;
    });

    const items = out.slice(0, limit);
    return json({ items, q, hours, minReposts, minLikes, sort }, { noCache: NO_CACHE });

  } catch (e) {
    console.error('[reactions] err', e);
    return json({ error: e.message || 'error' }, { status: 500, noCache: true });
  }
};

// ---------- helpers ----------
function firstImage(p) {
  return p?.embed?.images?.[0]?.fullsize ||
         p?.record?.embed?.images?.[0]?.fullsize || null;
}
function escapeHtml(s){return String(s||'').replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function json(obj, opts={}) {
  const status = opts.status || 200;
  const browserTTL = opts.noCache ? 0 : 60;
  const cdnTTL     = opts.noCache ? 0 : 180; // 3 min
  const swr        = opts.noCache ? 0 : 120;
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...CORS,
      'content-type': 'application/json',
      'cache-control': browserTTL ? `public, max-age=${browserTTL}, s-maxage=${cdnTTL}, stale-while-revalidate=${swr}` : 'no-store',
      'Netlify-CDN-Cache-Control': cdnTTL ? `public, s-maxage=${cdnTTL}` : 'no-store'
    }
  });
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
