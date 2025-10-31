// netlify/functions/reactions.mjs
// Node 18+ (global fetch). No node-fetch needed.

export const config = { path: "/api/reactions" };

/* -----------------------------
   Helpers
----------------------------- */
const BLUESKY_API = "https://bsky.social";
const BSKY_APP_HANDLE = process.env.BSKY_HANDLE;       // e.g. "hoopshypeofficial.bsky.social"
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD;

/** Small sleep to be gentle with XRPC */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Convert a post record to our lean JSON for the UI/embed */
function mapPost(p, tz = "UTC") {
  const { author, uri, cid, likeCount = 0, repostCount = 0, record, embed, indexedAt } = p;

  // author bits
  const authorDisplay = author?.displayName || author?.handle || "";
  const authorHandle = author?.handle || "";
  const authorAvatar = author?.avatar || "";

  // post URL: bsky.app/profile/<did>/post/<rkey>
  const did = author?.did || "";
  const rkey = uri?.split("/").pop() || "";
  const url = did && rkey ? `https://bsky.app/profile/${did}/post/${rkey}` : "";

  // media (first image if any)
  let mediaUrl = "";
  if (embed?.images?.length) {
    mediaUrl = embed.images[0]?.fullsize || embed.images[0]?.thumb || "";
  }

  const text = record?.text || "";
  const ts = indexedAt ? new Date(indexedAt).toISOString() : new Date().toISOString();

  // very light HTML: linkify http(s) and www. domains, preserve line breaks
  const linkified = linkify(text);

  // reply / quote flags
  const isReply = !!record?.reply;
  const isQuote = !!embed?.record;

  // pretty local time string
  const tsLocal = toLocal(ts, tz);

  return {
    ts,
    tsLocal,
    authorDisplay,
    authorHandle,
    authorAvatar,
    text,
    html: linkified,
    mediaUrl,
    url,
    likeCount,
    repostCount,
    isReply,
    isQuote
  };
}

function linkify(s = "") {
  if (!s) return "";
  let out = s.replace(/(https?:\/\/[^\s]+)/gim, m => `<a href="${m}" target="_blank" rel="noopener nofollow">${m}</a>`);
  out = out.replace(/\b((?:www\.)?(?:[a-z0-9-]+\.)+(?:com|co|io|net|org|news|tv|fm|gg|ai|link|app|be|ly|to|media|social|dev|us|uk|ca|de|fr|es|it|nl|se|no|dk|pl|cz|sk|pt|ie))(\/[^\s]*)?/gim,
    (m, host, path = "") => `<a href="https://${host}${path}" target="_blank" rel="noopener nofollow">${m}</a>`
  );
  out = out.replace(/\n/g, "<br>");
  return out;
}

function toLocal(iso, tz = "UTC") {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { timeZone: tz, hour12: true });
  } catch {
    return iso;
  }
}

/** read reporters.csv from the site root and return a Set of priority handles (lowercased) */
async function getPriorityHandles(siteUrl) {
  try {
    const url = `${siteUrl.replace(/\/$/, "")}/reporters.csv`;
    const r = await fetch(url, { headers: { "accept": "text/plain" } });
    if (!r.ok) return new Set();
    const csv = await r.text();
    const lines = csv.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // accept handles with or without leading @
    return new Set(lines.map(x => x.replace(/^@/, "").toLowerCase()));
  } catch {
    return new Set();
  }
}

/* -----------------------------
   Bluesky session & calls
----------------------------- */
async function createSession() {
  if (!BSKY_APP_HANDLE || !BSKY_APP_PASSWORD) {
    throw new Error("Missing BSKY_HANDLE or BSKY_APP_PASSWORD env.");
  }
  const r = await fetch(`${BLUESKY_API}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: BSKY_APP_HANDLE, password: BSKY_APP_PASSWORD })
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`createSession failed: ${r.status} ${e}`);
  }
  const j = await r.json();
  return j.accessJwt; // use access token for subsequent calls
}

async function searchPosts({ token, q, limit = 50, cursor }) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const r = await fetch(`${BLUESKY_API}/xrpc/app.bsky.feed.searchPosts?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`searchPosts failed: ${r.status} ${e}`);
  }
  return r.json(); // { posts, cursor }
}

/* -----------------------------
   Netlify Function handler
----------------------------- */
export async function handler(event) {
  try {
    const url = new URL(event.rawUrl);
    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      `${url.protocol}//${url.host}`;

    // Query params
    const q = (url.searchParams.get("q") || "").trim() || "NBA";
    const hours = Number(url.searchParams.get("hours") || 6);
    const minReposts = Number(url.searchParams.get("minReposts") || 0);
    const minLikes = Number(url.searchParams.get("minLikes") || 0);
    const limit = Math.min(Number(url.searchParams.get("limit") || 40), 100);
    const includeReplies = url.searchParams.get("includeReplies") === "1";
    const includeQuotes = url.searchParams.get("includeQuotes") === "1";
    const sort = (url.searchParams.get("sort") || "reposts").toLowerCase(); // "reposts" | "likes" | "time"
    const tz = url.searchParams.get("tz") || "UTC";
    const noCache = url.searchParams.get("nocache") === "1";

    const since = Date.now() - hours * 60 * 60 * 1000;

    // Priority handles (from reporters.csv at repo root)
    const priority = await getPriorityHandles(siteUrl);

    // Bluesky session
    const token = await createSession();

    // Gather posts
    let items = [];
    let cursor = undefined;
    const pageLimit = 50; // per request to XRPC
    // Fetch until either we collected at least 3×limit raw (to allow filtering), or we fall out of time window, or cursor ends
    for (let page = 0; page < 12; page++) {
      const data = await searchPosts({ token, q, limit: pageLimit, cursor });
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      if (!posts.length) break;

      // Map and filter
      for (const p of posts) {
        const ts = Date.parse(p.indexedAt || p.createdAt || Date.now());
        if (Number.isFinite(ts) && ts < since) {
          // This post is outside time window; we won't break immediately because search results can be mixed,
          // but we won't keep it.
        }
        const mapped = mapPost(p, tz);

        // basic filters
        if (!includeReplies && mapped.isReply) continue;
        if (!includeQuotes && mapped.isQuote) continue;
        if (mapped.repostCount < minReposts) continue;
        if (mapped.likeCount < minLikes) continue;
        if (Date.parse(mapped.ts) < since) continue;

        items.push(mapped);
      }

      cursor = data?.cursor;
      if (!cursor) break;
      if (items.length >= limit * 3) break; // enough to sort & trim
      await sleep(120); // be nice
    }

    // Sort
    items.sort((a, b) => {
      if (sort === "likes") return b.likeCount - a.likeCount || Date.parse(b.ts) - Date.parse(a.ts);
      if (sort === "time") return Date.parse(b.ts) - Date.parse(a.ts);
      // default: reposts
      return b.repostCount - a.repostCount || b.likeCount - a.likeCount || Date.parse(b.ts) - Date.parse(a.ts);
    });

    // Priority bump (stable): move items whose authorHandle is in reporters.csv to the front
    if (priority.size) {
      const pri = [];
      const rest = [];
      for (const it of items) {
        const h = it.authorHandle?.toLowerCase() || "";
        (priority.has(h) ? pri : rest).push(it);
      }
      items = pri.concat(rest);
    }

    // Trim
    items = items.slice(0, limit);

    // Response (cache unless nocache=1)
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": noCache
        ? "no-store"
        : "public, s-maxage=180, max-age=60, stale-while-revalidate=60"
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ items })
    };
  } catch (err) {
    // Return a JSON error (and mark no-cache so the UI can retry quickly)
    return {
      statusCode: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      },
      body: JSON.stringify({ error: String(err?.message || err) })
    };
  }
}
