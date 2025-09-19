export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').split('|').map(s => s.trim()).filter(Boolean);
    const tz = url.searchParams.get('tz') || (process.env.TIMEZONE || 'America/New_York');

    const csvURL = new URL('../../reporters.csv', import.meta.url);
    const csv = await fetch(csvURL).then(r => r.text());
    const reporters = parseCsv(csv);

    for (const r of reporters) {
      if (!r.did && r.handle) r.did = await resolveDid(r.handle);
    }

    const sinceUtcMs = Date.now() - 7*24*60*60*1000;
    const results = [];
    for (const r of reporters) {
      if (!r.did) continue;
      const feed = await fetchJSON(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(r.did)}&limit=100`);
      for (const item of (feed.feed || [])) {
        const post = item.post;
        if (!post || post.author?.did !== r.did) continue;
        if (post.reason) continue;                 // reposts
        if (post.record?.reply) continue;          // replies
        if (post.embed?.$type === 'app.bsky.embed.record' || post.embed?.record) continue; // quotes

        const created = Date.parse(post.record?.createdAt || post.indexedAt || '');
        if (!created || created < sinceUtcMs) continue;

        const text = (post.record?.text || '');
        if (q.length && !containsAny(text, q)) continue;

        const tsLocal = new Intl.DateTimeFormat('en-US', { timeStyle:'short', dateStyle:'medium', timeZone: tz }).format(new Date(created));
        const url = appendUTM(`https://bsky.app/profile/${post.author?.did}/post/${post.uri?.split('/').pop()}`, 'hoopshype');
        const media = extractFirstImage(post);

        results.push({
          ts: created,
          tsLocal,
          authorDisplay: post.author?.displayName || post.author?.handle || 'Reporter',
          authorHandle: post.author?.handle || '',
          authorAvatar: post.author?.avatar || '',
          html: escapeHtml(text).replace(/\n/g,'<br>'),
          mediaUrl: media,
          url
        });
      }
    }
    results.sort((a,b) => b.ts - a.ts);
    return json({ items: results });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  function json(obj) {
    return new Response(JSON.stringify(obj), { headers: { 'content-type':'application/json', 'cache-control':'max-age=60' } });
  }
  async function fetchJSON(u) { const r = await fetch(u); if (!r.ok) return {}; return r.json(); }
  async function resolveDid(handle) {
    try {
      const r = await fetchJSON(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
      return r.did || null;
    } catch { return null; }
  }
  function extractFirstImage(p){
    const img = p?.embed?.images?.[0]?.fullsize || p?.record?.embed?.images?.[0]?.fullsize;
    return img || null;
  }
  function appendUTM(u, source) {
    const url = new URL(u);
    url.searchParams.set('utm_source', source);
    return url.toString();
  }
  function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function parseCsv(text){
    const lines = text.trim().split(/\r?\n/);
    const rows = [];
    for (let i=1;i<lines.length;i++){
      const [handle='',did=''] = lines[i].split(',');
      rows.push({ handle: handle.trim(), did: did.trim() });
    }
    return rows;
  }
  function containsAny(text, arr){
    const lower = text.toLowerCase();
    return arr.some(k => lower.includes(String(k).toLowerCase()));
  }
};
