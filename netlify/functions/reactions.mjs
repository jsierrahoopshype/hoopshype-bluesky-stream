// netlify/functions/reactions.mjs
export default async (req) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const hours = Number(url.searchParams.get('hours') || '6');
    const minReposts = Number(url.searchParams.get('minReposts') || '0');
    const minLikes = Number(url.searchParams.get('minLikes') || '0');
    const limit = Math.min(Number(url.searchParams.get('limit') || '40'), 100);
    const sort = (url.searchParams.get('sort') || 'reposts').toLowerCase();
    const includeReplies = url.searchParams.get('includeReplies') === 'true';
    const includeQuotes = url.searchParams.get('includeQuotes') === 'true';

    if (!q.trim()) return json({ items: [] });

    // Headers that make Bluesky happier
    const UA = [
      'HoopsHype-Reactions/1.1',
      `(https://www.hoopshype.com; contact:@${process.env.BSKY_HANDLE || 'unknown'})`,
    ].join(' ');

    const COMMON_HEADERS = {
      'Accept': 'application/json',
      'User-Agent': UA,
      // These two aren’t always required, but reduce false positives on some WAFs:
      'Origin': 'https://www.hoopshype.com',
      'Referer': 'https://www.hoopshype.com/',
    };

    // Try to authenticate (preferred path to avoid public edge 403s)
    let accessJwt = '';
    if (process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD) {
      try {
        const r = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
          method: 'POST',
          headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: process.env.BSKY_HANDLE,
            password: process.env.BSKY_APP_PASSWORD,
          }),
        });
        if (r.ok) {
          const s = await r.json();
          accessJwt = s.accessJwt || '';
        }
      } catch { /* fall through unauthenticated if needed */ }
    }

    // Preferred: first-party xrpc on bsky.social with auth (if we have it)
    const primary = await searchOnBskyXrpc({
      q, limit,
      headers: COMMON_HEADERS,
      accessJwt,
    });

    if (primary.ok) {
      return filterAndRespond(primary.posts, { hours, minReposts, minLikes, limit, sort, includeReplies, includeQuotes });
    }

    // If we got a hard 403 (your screenshot), retry with the legacy search host
    if (primary.status === 403) {
      const legacy = await searchLegacyHost({ q, limit, headers: COMMON_HEADERS });
      if (legacy.ok) {
        return filterAndRespond(legacy.posts, { hours, minReposts, minLikes, limit, sort, includeReplies, includeQuotes });
      }
      // If legacy also failed, surface the upstream 403
      return json({ error: 'upstream 403', detail: legacy.detail || primary.detail || '' }, { status: 502, noCache: true });
    }

    // Other non-403 errors from xrpc
    return json({ error: primary.detail || 'search error' }, { status: 502, noCache: true });

  } catch (e) {
    return json({ error: e?.message || 'unknown' }, { status: 500, noCache: true });
  }
};


/* ----------------------- helpers ----------------------- */

// Use first-party host (bsky.social/xrpc) – best path when authenticated
async function searchOnBskyXrpc({ q, limit, headers, accessJwt }) {
  try {
    const u = new URL('https://bsky.social/xrpc/app.bsky.feed.searchPosts');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));

    const h = { ...headers };
    if (accessJwt) h['Authorization'] = `Bearer ${accessJwt}`;

    const r = await fetch(u, { headers: h });
    if (!r.ok) {
      const detail = await safeText(r);
      return { ok: false, status: r.status, detail };
    }
    const data = await r.json();
    const posts = Array.isArray(data.posts) ? data.posts : [];
    return { ok: true, posts };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err) };
  }
}

// Legacy search host (search.bsky.social) – returns a slightly different shape
async function searchLegacyHost({ q, limit, headers }) {
  try {
    const u = new URL('https://search.bsky.social/search/posts');
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));

    const r = await fetch(u, { headers });
    if (!r.ok) {
      const detail = await safeText(r);
      return { ok: false, status: r.status, detail };
    }
    const data = await r.json();
    // Legacy returns { posts: [{ post, reason? }...] }
    const items = Array.isArray(data.posts) ? data.posts.map(x => x.post || x) : [];
    return { ok: true, posts: items };
  } catch (err) {
    return { ok: false, status: 0, detail: String(err) };
  }
}

async function safeText(r) {
  try { return await r.text(); } catch { return ''; }
}

function filterAndRespond(rawPosts, opts) {
  const { hours, minReposts, minLikes, limit, sort, includeReplies, includeQuotes } = opts;
  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;

  function isQuote(p) {
    return !!(p?.embed?.record?.uri);
  }
  function isReply(p) {
    return !!p?.reply;
  }
  function textFromRecord(rec) {
    return (rec && typeof rec.text === 'string') ? rec.text : '';
  }
  function firstImageUrl(p) {
    const imgs = p?.embed?.images || p?.embed?.media?.images || [];
    return imgs[0]?.fullsize || imgs[0]?.thumb || '';
  }
  function escapeHTML(s='') {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  const filtered = rawPosts
    .filter(p => {
      const t = p?.indexedAt ? Date.parse(p.indexedAt) : 0;
      if (!t || now - t > windowMs) return false;
      if (!includeReplies && isReply(p)) return false;
      if (!includeQuotes && isQuote(p)) return false;
      if ((p?.repostCount || 0) < minReposts) return false;
      if ((p?.likeCount   || 0) < minLikes)   return false;
      return true;
    })
    .map(p => ({
      ts: Date.parse(p.indexedAt || p.createdAt || 0) || 0,
      tsLocal: p.indexedAt || '',
      authorDisplay: p?.author?.displayName || '',
      authorHandle: p?.author?.handle || '',
      authorAvatar: p?.author?.avatar || '',
      text: textFromRecord(p?.record),
      html: escapeHTML(textFromRecord(p?.record)).replace(/\n/g, '<br>'),
      url: 'https://bsky.app/profile/' + (p?.author?.did || p?.author?.handle || '') + '/post/' + (p?.uri?.split('/').pop() || ''),
      mediaUrl: firstImageUrl(p),
      likeCount: Number(p?.likeCount || 0),
      repostCount: Number(p?.repostCount || 0),
      isReply: isReply(p) ? 1 : 0,
      isQuote: isQuote(p) ? 1 : 0
    }));

  const sorted = filtered.sort((a, b) => {
    if (sort.startsWith('like')) return b.likeCount - a.likeCount || b.ts - a.ts;
    if (sort.startsWith('time')) return b.ts - a.ts;
    return b.repostCount - a.repostCount || b.ts - a.ts; // default: reposts
  });

  return json(
    { items: sorted.slice(0, limit) },
    { status: 200, browserTTL: 0, cdnTTL: 180 }
  );
}

function json(obj, opts={}) {
  const status = opts.status || 200;
  const headers = { 'Content-Type': 'application/json' };
  if (opts.noCache) {
    headers['Cache-Control'] = 'no-store';
  } else {
    const cdnTTL = Number(opts.cdnTTL ?? 180);
    headers['Cache-Control'] = `public, s-maxage=${cdnTTL}, stale-while-revalidate=120`;
  }
  return new Response(JSON.stringify(obj), { status, headers });
}
