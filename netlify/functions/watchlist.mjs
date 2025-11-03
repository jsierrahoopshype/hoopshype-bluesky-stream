// netlify/functions/watchlist.mjs
// Bluesky Watchlist API: /api/watchlist?handles=a,b,c&hours=6&minReposts=0&minLikes=0&limit=40&includeReplies=0&sort=recent
// Env required: BSKY_HANDLE, BSKY_APP_PASSWORD
// Node 18+ has global fetch; no node-fetch needed.

export default async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const params = Object.fromEntries(url.searchParams.entries());

    const handles = (params.handles || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!handles.length) {
      return json(res, { error: 'No handles provided' }, { status: 400 });
    }

    const hours = Math.max(0, Number(params.hours || 6));
    const minReposts = Math.max(0, Number(params.minReposts || 0));
    const minLikes = Math.max(0, Number(params.minLikes || 0));
    const limit = Math.max(1, Math.min(200, Number(params.limit || 40))); // total items
    const includeReplies = String(params.includeReplies || '0') === '1';
    const sort = (params.sort || 'recent'); // 'recent' | 'reposts' | 'likes' | 'total'

    // login (session)
    const session = await loginBSKY();

    // cutoff time
    const cutoffMs = Date.now() - hours * 60 * 60 * 1000;

    // fetch feeds per handle until we hit cutoff or have enough results overall
    const all = [];
    for (const h of handles) {
      const items = await getAuthorFeed(session, h, { includeReplies, cutoffMs, want: Math.ceil(limit * 1.5) });
      all.push(...items);
      if (all.length >= limit * 2) break; // soft ceiling to control work
    }

    // filter thresholds
    let out = all.filter(p => {
      if (p.ts < cutoffMs) return false;
      if (p.repostCount < minReposts) return false;
      if (p.likeCount < minLikes) return false;
      return true;
    });

    // sort
    out.sort((a, b) => {
      if (sort === 'reposts') return b.repostCount - a.repostCount || b.ts - a.ts;
      if (sort === 'likes')   return b.likeCount - a.likeCount || b.ts - a.ts;
      if (sort === 'total')   return (b.likeCount + b.repostCount) - (a.likeCount + a.repostCount) || b.ts - a.ts;
      return b.ts - a.ts; // recent
    });

    // final limit
    out = out.slice(0, limit);

    return json(res, { items: out, count: out.length }, { noCache: true });
  } catch (e) {
    console.error('watchlist error', e);
    return json(res, { error: e.message || String(e) }, { status: 500, noCache: true });
  }
};

// ---------- Bluesky helpers ----------

const PDS = 'https://bsky.social';

async function loginBSKY() {
  const identifier = process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD;
  if (!identifier || !password) throw new Error('Missing BSKY_HANDLE / BSKY_APP_PASSWORD');

  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!r.ok) throw new Error('Bluesky login failed');
  return await r.json(); // { did, accessJwt, ... }
}

/**
 * Fetch recent posts for an author handle.
 * @param {*} session
 * @param {string} handle
 * @param {{includeReplies:boolean, cutoffMs:number, want:number}} opts
 */
async function getAuthorFeed(session, handle, opts) {
  const { includeReplies, cutoffMs, want } = opts;
  const out = [];
  let cursor = '';
  const auth = { Authorization: `Bearer ${session.accessJwt}` };

  for (let page = 0; page < 6; page++) {
    const u = new URL(`${PDS}/xrpc/app.bsky.feed.getAuthorFeed`);
    u.searchParams.set('actor', handle);
    u.searchParams.set('limit', '50');
    // 'posts_with_replies' | 'posts_no_replies' | 'posts_with_media'
    u.searchParams.set('filter', includeReplies ? 'posts_with_replies' : 'posts_no_replies');
    if (cursor) u.searchParams.set('cursor', cursor);

    const r = await fetch(u, { headers: auth });
    if (!r.ok) break;

    const j = await r.json();
    const feed = Array.isArray(j.feed) ? j.feed : [];
    for (const it of feed) {
      const post = it.post || it; // shape varies
      const rec = post.record || {};
      const createdAt = rec.createdAt || post.indexedAt || post.createdAt;
      const ts = createdAt ? Date.parse(createdAt) : Date.now();
      // stop early if post is older than cutoff and we already have some
      if (ts < cutoffMs && out.length >= 10) {
        cursor = ''; // force exit
        break;
      }

      // derive url from URI: at://did/app.bsky.feed.post/rkey
      const [did, rkey] = parseUri(post.uri);
      const url = (did && rkey) ? `https://bsky.app/profile/${did}/post/${rkey}` :
                  `https://bsky.app/profile/${handle}`;

      const authorHandle = (post.author && (post.author.handle || post.author.did)) || handle;
      const authorDisplay = (post.author && post.author.displayName) || authorHandle;

      const text = String((rec.text || '').toString());
      const html = escapeHtml(text).replace(/\n/g, '<br>');
      const mediaUrl = firstImage(post);

      out.push({
        url,
        ts,
        tsLocal: new Date(ts).toLocaleString('en-US', { hour12: false }),
        authorHandle,
        authorDisplay,
        text,
        html,
        mediaUrl,
        likeCount: Number(post.likeCount || 0),
        repostCount: Number(post.repostCount || 0),
        isReply: Number(rec.reply ? 1 : 0),
        isQuote: Number(rec.embed && rec.embed.record ? 1 : 0),
      });
      if (out.length >= want) break;
    }

    if (!j.cursor || out.length >= want || !cursorAdvanceAllowed(cursor, j.cursor)) break;
    cursor = j.cursor;
  }

  return out;
}

function cursorAdvanceAllowed(prev, next) {
  // simple guard to avoid infinite loops on weird cursors
  return next && next !== prev;
}

function parseUri(uri = '') {
  // at://did/app.bsky.feed.post/rkey
  try {
    const parts = uri.split('/');
    const did = parts[2];
    const rkey = parts[parts.length - 1];
    return [did, rkey];
  } catch {
    return [null, null];
  }
}

function firstImage(post) {
  try {
    const embed = post.embed || {};
    if (embed?.images?.[0]?.fullsize) return String(embed.images[0].fullsize);
    if (embed?.media?.images?.[0]?.fullsize) return String(embed.media.images[0].fullsize);
  } catch {}
  return '';
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// small JSON helper
function json(res, data, opts = {}) {
  const status = opts.status || 200;
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (opts.noCache) {
    headers['cache-control'] = 'no-store, max-age=0';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}
