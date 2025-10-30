// netlify/functions/reactions.mjs
// Bluesky Reactions API (public search-only, no auth required)

const UA = 'HoopsHype-Reactions/1.0 (+https://www.hoopshype.com)';
const BASE = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';

export default async (req) => {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const hours = Math.max(1, Number(url.searchParams.get('hours') || 6));
    const minReposts = Math.max(0, Number(url.searchParams.get('minReposts') || 0));
    const minLikes = Math.max(0, Number(url.searchParams.get('minLikes') || 0));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const includeReplies = url.searchParams.get('includeReplies') === '1';
    const includeQuotes = url.searchParams.get('includeQuotes') === '1';
    const sort = (url.searchParams.get('sort') || 'reposts').toLowerCase(); // 'reposts'|'likes'|'total'

    if (!q) {
      return json({ items: [], meta: { q, reason: 'empty query' } }, { status: 200, noCache: true });
    }

    const sinceTs = Date.now() - hours * 3600 * 1000;

    let cursor = '';
    const out = [];
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json'
    };

    // paginate searchPosts
    while (out.length < limit) {
      const u = new URL(BASE);
      u.searchParams.set('q', q);
      u.searchParams.set('limit', '25'); // small pages; we stop early
      if (cursor) u.searchParams.set('cursor', cursor);

      const r = await fetch(u.toString(), { headers });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return json({ error: `upstream ${r.status}`, detail: txt.slice(0, 500) }, { status: 502, noCache: true });
      }
      const data = await r.json();

      const posts = Array.isArray(data?.posts) ? data.posts : [];
      for (const p of posts) {
        // time filter (indexedAt is ISO)
        const ts = Date.parse(p.indexedAt || p.createdAt || 0);
        if (Number.isFinite(ts) && ts < sinceTs) continue;

        // filter replies/quotes if requested
        const isReply = !!p.reply;
        const isQuote = !!p.embed?.record; // quote posts carry a record embed
        if (!includeReplies && isReply) continue;
        if (!includeQuotes && isQuote) continue;

        const likeCount = p.likeCount || 0;
        const repostCount = p.repostCount || 0;
        if (repostCount < minReposts) continue;
        if (likeCount < minLikes) continue;

        // extract first image if present
        const mediaUrl = firstImage(p) || null;

        out.push({
          ts,                                     // unix ms
          tsLocal: new Date(ts).toLocaleString('en-US', { hour12: true }),
          authorDisplay: p.author?.displayName || p.author?.handle || '',
          authorHandle: p.author?.handle || '',
          authorAvatar: avatarUrl(p),
          text: extractText(p),
          html: escapeHTML(extractText(p)),
          url: postUrl(p),
          mediaUrl,
          likeCount,
          repostCount,
          replyCount: p.replyCount || 0,
          isReply: isReply ? 1 : 0,
          isQuote: isQuote ? 1 : 0
        });

        if (out.length >= limit) break;
      }

      cursor = data?.cursor || '';
      if (!cursor) break;
    }

    // sort
    out.sort((a, b) => {
      if (sort === 'likes') return b.likeCount - a.likeCount || b.ts - a.ts;
      if (sort === 'total') return (b.likeCount + b.repostCount) - (a.likeCount + a.repostCount) || b.ts - a.ts;
      // default: reposts
      return b.repostCount - a.repostCount || b.ts - a.ts;
    });

    // respond
    return json({ items: out.slice(0, limit), meta: { q, hours, minReposts, minLikes, includeReplies, includeQuotes, sort } });

  } catch (e) {
    return json({ error: String(e?.message || e) }, { status: 500, noCache: true });
  }
};

/* ---------------- helpers ---------------- */

function extractText(p) {
  // p.record?.text for app.bsky.feed.post
  const rec = p?.record;
  if (!rec) return '';
  return String(rec?.text || '').trim();
}

function avatarUrl(p) {
  const did = p?.author?.did;
  // use Bluesky CDN avatar if provided
  if (p?.author?.avatar) return p.author.avatar;
  return did ? `https://cdn.bsky.app/img/avatar/plain/${did}@jpeg` : '';
}

function postUrl(p) {
  const handle = p?.author?.handle;
  const rkey = p?.uri?.split('/').pop();
  return (handle && rkey) ? `https://bsky.app/profile/${handle}/post/${rkey}` : '';
}

function firstImage(p) {
  const emb = p?.embed;
  // image embeds
  if (emb?.$type === 'app.bsky.embed.images#view' && Array.isArray(emb.images) && emb.images[0]?.fullsize) {
    return emb.images[0].fullsize;
  }
  // recordWithMedia (quote with image)
  if (emb?.$type === 'app.bsky.embed.recordWithMedia#view' && emb.media?.$type === 'app.bsky.embed.images#view') {
    const imgs = emb.media.images;
    if (Array.isArray(imgs) && imgs[0]?.fullsize) return imgs[0].fullsize;
  }
  return null;
}

function escapeHTML(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function json(obj, opts = {}) {
  const status = opts.status || 200;
  const noCache = !!opts.noCache;
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (noCache) {
    headers.set('cache-control', 'no-store');
  } else {
    // small shared cache (3 minutes) to be nice to Bluesky
    headers.set('cache-control', 'public, max-age=0, s-maxage=180');
  }
  return new Response(JSON.stringify(obj), { status, headers });
}
