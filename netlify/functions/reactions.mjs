// netlify/functions/reactions.mjs
import fetch from "node-fetch";

const NO_CACHE = 180; // seconds
const AGENT = "HoopsHype-Reactions-Tool/1.0 (+https://www.hoopshype.com)";

// --- helpers ---------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadReportersCSV() {
  // Try env first, otherwise fall back to static file in repo root
  const url =
    process.env.REPORTERS_CSV_URL ||
    `${process.env.URL || "https://unique-twilight-d4fa41.netlify.app"}/reporters.csv`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": AGENT } });
    if (!r.ok) throw new Error("reporters csv not ok");
    const txt = await r.text();
    const lines = txt.trim().split(/\r?\n/);
    // Accept handle with or without leading @; we store normalized handle.
    const set = new Set(
      lines
        .map(l => l.trim())
        .filter(Boolean)
        .map(h => h.replace(/^@/, "").toLowerCase())
    );
    return set;
  } catch {
    return new Set();
  }
}

function firstImage(p) {
  const imgs =
    p?.embed?.images?.[0]?.fullsize ||
    p?.embed?.images?.[0]?.thumb ||
    p?.embed?.image?.fullsize ||
    p?.embed?.image?.thumb ||
    "";
  return imgs || "";
}

function escapeHTML(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function engagementScore(x) {
  return (x.likeCount || 0) + (x.repostCount || 0);
}

function json(body, { status = 200, noCache = false } = {}) {
  const ttl = noCache ? 0 : NO_CACHE;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
      "access-control-allow-origin": "*"
    }
  });
}

// --- main ------------------------------------------------------------
export default async (req) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") || "";
    const hours = Math.max(1, Math.min(48, Number(url.searchParams.get("hours") || 6)));
    const minReposts = Math.max(0, Number(url.searchParams.get("minReposts") || 0));
    const minLikes = Math.max(0, Number(url.searchParams.get("minLikes") || 0));
    const includeReplies = url.searchParams.get("includeReplies") === "1";
    const includeQuotes = url.searchParams.get("includeQuotes") === "1";
    const sort = url.searchParams.get("sort") || "reposts";
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 40)));
    const preferReporters = url.searchParams.get("preferReporters") !== "0"; // default on

    const reportersSet = preferReporters ? await loadReportersCSV() : new Set();

    // Bluesky search
    const endpoint = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts";
    const since = Date.now() - hours * 3600 * 1000;
    let cursor = "";
    let out = [];

    while (out.length < limit) {
      const u = new URL(endpoint);
      u.searchParams.set("q", q || "nba");
      u.searchParams.set("sort", "latest");
      u.searchParams.set("limit", "50");
      if (cursor) u.searchParams.set("cursor", cursor);

      const r = await fetch(u, {
        headers: { "User-Agent": AGENT, accept: "application/json" },
      });
      if (!r.ok) break;

      const data = await r.json();
      const feed = data?.posts || data?.feed || [];
      for (const p of feed) {
        const rec = p?.record || {};
        const ts = new Date(rec?.createdAt || p?.indexedAt || p?.createdAt || 0).getTime();
        if (!ts || ts < since) continue;

        const isReply = !!p?.reply;
        const isQuote = !!p?.embedding?.detached || !!p?.embed?.quotedPost || p?.reason?.type === "app.bsky.feed.defs#reasonQuote";
        if (!includeReplies && isReply) continue;
        if (!includeQuotes && isQuote) continue;

        const authorHandle = (p?.author?.handle || "").toLowerCase();
        const item = {
          ts,
          tsLocal: new Date(ts).toLocaleString("en-US", { hour12: false }),
          authorDisplay: p?.author?.displayName || p?.author?.handle || "",
          authorHandle,
          authorAvatar: p?.author?.avatar || "",
          text: rec?.text || p?.text || "",
          html: escapeHTML(rec?.text || p?.text || "").replace(/\n/g, "<br>"),
          mediaUrl: firstImage(p),
          url:
            p?.uri
              ? `https://bsky.app/profile/${p.author?.did || ""}/post/${p.uri.split("/").pop()}`
              : "",
          likeCount: p?.likeCount || 0,
          repostCount: p?.repostCount || 0,
          isReply: isReply ? 1 : 0,
          isQuote: isQuote ? 1 : 0,
        };

        // priority?
        item.priority = reportersSet.has(authorHandle) ? 1 : 0;

        // filters: NOTE reshares = reposts + quotes (so quotes count as a kind of reshare)
        const reshares = (item.repostCount || 0) + (item.isQuote ? 1 : 0);
        if (minReposts && reshares < minReposts) continue;
        if (minLikes && item.likeCount < minLikes) continue;

        out.push(item);
        if (out.length >= limit) break;
      }

      cursor = data?.cursor || "";
      if (!cursor) break;
      // polite
      await sleep(80);
    }

    // sort: priority first, then selected mode
    out.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (sort === "likes") return (b.likeCount || 0) - (a.likeCount || 0) || b.ts - a.ts;
      if (sort === "engagement")
        return (engagementScore(b) - engagementScore(a)) || b.ts - a.ts;
      // default: reposts
      return (b.repostCount || 0) - (a.repostCount || 0) || b.ts - a.ts;
    });

    // trim
    const items = out.slice(0, limit);
    return json({ items }, { noCache: url.searchParams.get("nocache") === "1" });

  } catch (e) {
    return json({ error: e?.message || String(e) }, { status: 500, noCache: true });
  }
}
