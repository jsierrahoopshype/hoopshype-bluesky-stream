// netlify/functions/reactions.mjs
// Bluesky Reactions API (no auth; uses public search endpoint)
// Query: q, hours, minReposts, minLikes, limit, includeReplies, includeQuotes, sort
// Example: /api/reactions?q=NBA&hours=6&minReposts=5&limit=40

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const hours = Math.max(1, Number(url.searchParams.get('hours') || 6));
    const minReposts = Math.max(0, Number(url.searchParams.get('minReposts') || 0));
    const minLikes = Math.max(0, Number(url.searchParams.get('minLikes') || 0));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const includeReplies = url.searchParams.get('includeReplies') === 'true';
    const includeQuotes = url.searchParams.get('includeQuotes') === 'true';
    const sort = (url.searchParams.get('sort') || 'reposts').toLowerCase(); // 'reposts' | 'likes' | 'latest' | 'total'

    if (!q.trim()) return json({ items: [], scanned: 0 }, { status: 200 });

    const UA = 'HoopsHype-Reactions/1.0 (+https://hoopshype.com)';
    // Public read endpoint
    const SEARCH = 'https://api.bsky.app/xrpc/app.bsky.feed.searchPosts';

    // time window
    const now = Date.now();
    const cutoff = now - hours * 3600 * 1000;

    let cursor = '';
    let collected = [];
    let scanned = 0;

    // We’ll pull pages until:
    // - we have more than we need (we’ll trim later) OR
    // - posts are all older than the cutoff OR
    // - the API stops giving cursors
    while (true) {
      const params = new URLSearchParams({
        q,
        limit: '100',
        sort: 'latest', // get freshest first; we sort after
      });
      if (cursor) params.set('cursor', cursor);

      const r = await fetch(`${SEARCH}?${params}`, {
        headers: { 'User-Agent': UA },
      });

      if (!r.ok) {
        // Return the server’s error body to help debug
        let errText = '';
        try { errText = await r.text(); } catch {}
        return json(
          { error: `search ${r.status}`, details: errText.slice(0, 500) },
          { status: 502, noCache: true }
        );
      }

      const page = await r.json();
      const posts = Array.isArray(page.posts) ? page.posts : [];
      scanned += posts.length;

      // Map/filter to our shape
      for (const p of posts) {
        const rec = p.record || {};
        const text = typeof rec.text === 'string' ? rec.text : '';
        const createdAt = rec.createdAt ? Date.parse(rec.createdAt) : 0;
        if (!createdAt || createdAt < cutoff) continue; // outside window

        const isReply = !!rec.reply;
        const isQuote = !!rec.embed?.record;
        if (!includeReplies && isReply) continue;
        if (!includeQuotes && isQuote) continue;

        const likeCount = p.likeCount || 0;
        const repostCount = p.repostCount || 0;
        if (likeCount < minLikes) continue;
        if (repostCount < minReposts) continue;

        const author = p.author || {};
        const authorHandle = author.handle || '';
        const authorDisplay = author.displayName || authorHandle || '';
        const authorAvatar = author.avatar || '';

        // Try to pull first embedded image (if any)
        const mediaUrl = firstImage(p);

        // Build a public post URL
        const postUrl = author.handle
          ? `https://bsky.app/profile/${author.handle}/post/${p.uri?.split('/').pop() || ''}`
          : `https://bsky.app/`;

        collected.push({
          ts: createdAt,
          tsISO: new Date(createdAt).toISOString(),
          authorDisplay,
          authorHandle,
          authorAvatar,
          text,
          likeCount,
          repostCount,
          isReply,
          isQuote,
          url: postUrl,
          mediaUrl,
        });
      }

      // stop conditions
      if (collected.length >= limit * 2) break; // collected enough to sort/trim
      cursor = page.cursor || '';
      if (!cursor) break;
    }

    // sort
    collected.sort((a, b) => {
      if (sort === 'likes') return b.likeCount - a.likeCount || b.ts - a.ts;
      if (sort === 'latest') return b.ts - a.ts;
      if (sort === 'total') return (b.likeCount + b.repostCount) - (a.likeCount + a.repostCount) || b.ts - a.ts;
      // default: reposts
      return b.repostCount - a.repostCount || b.ts - a.ts;
    });

    // trim
    collected = collected.slice(0, limit);

    return json(
      { items: collected, scanned, windowHours: hours, q, sort },
      { status: 200, noCache: false }
    );
  } catch (e) {
    return json({ error: e?.message || String(e) }, { status: 500, noCache: true });
  }
};

// ---------- helpers ----------
function firstImage(post) {
  const emb = post?.embed;
  if (!emb) return null;
  // app.bsky.embed.images
  const imgs = emb?.images;
  if (Array.isArray(imgs) && imgs[0]?.thumb) return imgs[0].thumb;
  // quote embeds may have images under embed.record.embed.images
  const recImg = emb?.record?.embed?.images;
  if (Array.isArray(recImg) && recImg[0]?.thumb) return recImg[0].thumb;
  return null;
}

function json(obj, opts = {}) {
  const status = opts.status || 200;
  const browserTTL = opts.noCache ? 0 : 300; // 5m
  const cdnTTL = opts.noCache ? 0 : 120;     // 2m
  const swr = opts.noCache ? 0 : 120;        // 2m
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${browserTTL}, s-maxage=${cdnTTL}, stale-while-revalidate=${swr}`,
    },
  });
}
