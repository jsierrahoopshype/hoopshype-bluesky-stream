<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Bluesky Watchlist</title>
  <style>
    :root{
      --bg:#fafafa;--panel:#fff;--text:#111;--muted:#666;--stroke:#e6e6e6;
      --accent:#0a66ff;--accent-2:#0e5bd3;--chip:#f1f5ff;--good:#12a150;
    }
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);
      font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial}
    .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
    h1{margin:0 0 16px;font-size:22px}
    .grid{display:grid;grid-template-columns:1fr 360px;gap:16px}
    .panel{background:var(--panel);border:1px solid var(--stroke);border-radius:10px;padding:16px}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    label{font-size:12px;color:var(--muted)}
    input[type="text"],select{width:100%;padding:10px;border:1px solid var(--stroke);
      border-radius:8px;background:#fff}
    input[type="number"]{width:84px;padding:8px;border:1px solid var(--stroke);border-radius:8px}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:10px;
      border:1px solid var(--stroke);background:#f7f7f7;cursor:pointer;user-select:none}
    .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
    .btn.primary:hover{background:var(--accent-2)}
    .btn.ghost{background:#fff}
    .btn.green{background:var(--good);color:#fff;border-color:var(--good)}
    .btn:disabled{opacity:.6;cursor:not-allowed}
    .pills{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--stroke);
      border-radius:999px;background:#fff;white-space:nowrap}
    .pill.added{background:var(--chip)}
    .pill .x{display:inline-block;width:16px;height:16px;line-height:15px;border-radius:50%;
      text-align:center;cursor:pointer;background:#eee;font-size:11px}
    .hint{font-size:12px;color:var(--muted)}
    .cards{display:flex;flex-direction:column;gap:12px;margin-top:12px}
    .card{border:1px solid var(--stroke);border-radius:10px;background:#fff;padding:12px;display:grid;gap:8px}
    .cardSel{border-color:var(--accent)}
    .meta{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px}
    .meta img{width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid var(--stroke)}
    .selBox{min-height:260px;white-space:pre-wrap;border:1px solid var(--stroke);border-radius:10px;background:#fff;padding:10px}
    .rightHead{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .rightHead .count{font-weight:600}
    .controls{display:flex;gap:8px;flex-wrap:wrap}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Bluesky Watchlist</h1>
    <div class="grid">
      <!-- LEFT -->
      <div class="panel">
        <div class="row">
          <div style="flex:1">
            <label>Search topic (optional)</label>
            <input id="q" type="text" placeholder="(optional filter in post text)" />
          </div>
          <div>
            <label>Lookback (hours)</label>
            <input id="hours" type="number" value="6" min="1" />
          </div>
          <div>
            <label>Min reposts</label>
            <input id="minReposts" type="number" value="0" min="0" />
          </div>
          <div>
            <label>Min likes</label>
            <input id="minLikes" type="number" value="0" min="0" />
          </div>
          <div>
            <label>Limit (total)</label>
            <input id="limit" type="number" value="60" min="1" />
          </div>
          <div style="min-width:180px">
            <label>Sort by</label>
            <select id="sort">
              <option value="recent">Recent (desc)</option>
              <option value="reposts">Reposts (desc)</option>
              <option value="likes">Likes (desc)</option>
              <option value="total">Total (reposts+likes)</option>
            </select>
          </div>
        </div>

        <div class="row" style="margin-top:10px">
          <label><input id="inclReplies" type="checkbox"> Include replies</label>
          <label><input id="nocache" type="checkbox"> nocache</label>
          <button id="searchBtn" class="btn primary" style="margin-left:auto">Search</button>
          <button id="allBtn" class="btn">All</button>
          <button id="noneBtn" class="btn">None</button>
        </div>

        <div style="margin-top:14px">
          <div class="row">
            <div style="flex:1">
              <label>Accounts (base = reporters.csv, plus your saved changes)</label>
            </div>
            <div class="row" style="margin-left:auto">
              <input id="newHandle" type="text" placeholder="add handle (e.g. @hoopshypeofficial.bsky.social)"
                     style="width:360px" />
              <button id="addBtn" class="btn ghost">Add & save</button>
            </div>
          </div>
          <div id="accounts" class="pills" style="border:1px solid var(--stroke);border-radius:10px;padding:10px;max-height:180px;overflow:auto;margin-top:6px"></div>
          <div class="hint">Use the × on a chip to remove it permanently. “Added” chips were saved by you (not from reporters.csv).</div>
        </div>

        <div id="results" class="cards"></div>
      </div>

      <!-- RIGHT -->
      <div class="panel">
        <div class="rightHead">
          <div class="count">Selected <span id="selCount">0</span></div>
          <label><input id="priority" type="checkbox" checked> Priority first</label>
        </div>
        <div class="controls">
          <button id="copyText" class="btn green">Copy plain text</button>
          <button id="copyCsv" class="btn">Copy CSV</button>
          <button id="copyHtml" class="btn">Copy publisher-safe HTML</button>
        </div>
        <div style="margin-top:10px" class="hint">Preview of copied output…</div>
        <textarea id="preview" class="selBox" readonly></textarea>
      </div>
    </div>
  </div>

  <script>
  // --- helpers
  const $ = s => document.querySelector(s);
  const el = {
    q: $('#q'), hours: $('#hours'), minReposts: $('#minReposts'), minLikes: $('#minLikes'),
    limit: $('#limit'), sort: $('#sort'), inclReplies: $('#inclReplies'), nocache: $('#nocache'),
    accounts: $('#accounts'), results: $('#results'), searchBtn: $('#searchBtn'),
    allBtn: $('#allBtn'), noneBtn: $('#noneBtn'), newHandle: $('#newHandle'), addBtn: $('#addBtn'),
    priority: $('#priority'), copyText: $('#copyText'), copyCsv: $('#copyCsv'), copyHtml: $('#copyHtml'),
    preview: $('#preview'), selCount: $('#selCount')
  };

  let BASE = [];           // from reporters.csv  -> [{handle, display}]
  let SAVED = { extras: [], removals: [] }; // from /api/watchlist-accounts
  let ACCOUNT_LIST = [];   // merged + selected flags for UI
  let SEARCH_ITEMS = [];
  let SELECTED_KEYS = new Set();

  // --- persistence API
  async function apiGet() {
    const r = await fetch('/api/watchlist-accounts'); return r.json();
  }
  async function apiAdd(handle, display) {
    const r = await fetch('/api/watchlist-accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ handle, display })});
    return r.json();
  }
  async function apiRemove(handle) {
    const r = await fetch('/api/watchlist-accounts', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ handle })});
    return r.json();
  }

  // --- csv
  async function loadReportersCsv(){
    try{
      const txt = await fetch('/reporters.csv?'+Date.now()).then(r=>r.ok?r.text():'');
      const rows = txt.split(/\r?\n/).map(r=>r.trim()).filter(Boolean);
      const out = [];
      if(!rows.length) return out;
      const hasHeader = /handle/i.test(rows[0]) || rows[0].includes(',');
      for(const [i,row] of rows.entries()){
        if(i===0 && hasHeader && /handle|display/i.test(row)) continue;
        const [h, d=''] = row.split(','); const handle = (h||'').trim().replace(/^@/,'');
        if(handle) out.push({ handle, display: (d||'').trim() || '@'+handle });
      }
      return out;
    }catch{ return []; }
  }

  // merge: (BASE + extras) - removals
  function computeAccounts(){
    const rm = new Set(SAVED.removals.map(h=>h.toLowerCase()));
    const baseKept = BASE.filter(a=>!rm.has(a.handle.toLowerCase()));
    const extras = SAVED.extras.map(a=>({ handle: a.handle, display: a.display || '@'+a.handle, added:true }));
    const merged = [...baseKept, ...extras];

    // default: all selected
    ACCOUNT_LIST = merged.map(a=>({ ...a, selected: true }));
    renderAccounts();
  }

  function chipTemplate(a){
    const id = 'acc_' + a.handle.replace(/[^\w]/g,'_');
    return `
      <label class="pill ${a.added ? 'added':''}" data-h="${a.handle}">
        <input type="checkbox" id="${id}" ${a.selected ? 'checked':''}>
        ${a.display || '@'+a.handle}
        <span title="remove permanently" class="x" data-remove>&times;</span>
      </label>`;
  }
  function renderAccounts(){
    el.accounts.innerHTML = ACCOUNT_LIST.map(chipTemplate).join('') || '<span class="hint">No accounts</span>';
    // select toggle
    el.accounts.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      cb.addEventListener('change', e=>{
        const h = e.target.closest('.pill').dataset.h;
        const acc = ACCOUNT_LIST.find(x=>x.handle===h);
        if(acc){ acc.selected = e.target.checked; }
      });
    });
    // permanent remove
    el.accounts.querySelectorAll('[data-remove]').forEach(btn=>{
      btn.addEventListener('click', async e=>{
        const h = e.target.closest('.pill').dataset.h;
        SAVED = await apiRemove(h);
        computeAccounts();
      });
    });
  }

  function selectedHandles(){ return ACCOUNT_LIST.filter(a=>a.selected).map(a=>a.handle); }

  async function runSearch(){
    const params = new URLSearchParams({
      q: el.q.value.trim(),
      hours: Number(el.hours.value||6),
      minReposts: Number(el.minReposts.value||0),
      minLikes: Number(el.minLikes.value||0),
      limit: Number(el.limit.value||60),
      sort: el.sort.value,
      includeReplies: el.inclReplies.checked ? 1 : 0,
      priorityFirst: el.priority.checked ? 1 : 0,
      handles: selectedHandles().join(','),
      fromWatchlist: 1,
      nocache: el.nocache.checked ? 1 : 0
    });
    el.searchBtn.disabled = true;
    el.results.innerHTML = '<div class="hint">Loading…</div>';
    try{
      const res = await fetch('/api/reactions?'+params.toString());
      const json = await res.json();
      SEARCH_ITEMS = Array.isArray(json.items) ? json.items : [];
      renderResults();
    }catch(e){
      el.results.innerHTML = '<div class="hint">Error loading results.</div>';
      console.error(e);
    }finally{
      el.searchBtn.disabled = false;
    }
  }

  function cardTemplate(p){
    const key = p.uri || p.url || p.ts;
    const isSel = SELECTED_KEYS.has(key);
    const media = p.mediaUrl ? `<img src="${p.mediaUrl}" alt="" style="max-width:100%;border-radius:8px;border:1px solid var(--stroke)">` : '';
    return `<div class="card ${isSel?'cardSel':''}" data-k="${key}">
      <div class="meta">
        ${p.authorAvatar?`<img src="${p.authorAvatar}" alt="">`:''}
        <div>
          <div><strong>${p.authorDisplay||''}</strong> <span class="hint">@${p.authorHandle||''}</span></div>
          <div class="hint">${new Date(p.tsLocal||p.ts||Date.now()).toLocaleString()}</div>
        </div>
        <div style="margin-left:auto" class="hint">❤ ${p.likeCount||0} · ↻ ${p.repostCount||0}</div>
      </div>
      <div>${p.html || (p.text||'').replace(/\n/g,'<br>')}</div>
      ${media}
      <div class="row"><a class="btn ghost" href="${p.url||'#'}" target="_blank" rel="noopener">Open on Bluesky</a></div>
    </div>`;
  }
  function renderResults(){
    if(!SEARCH_ITEMS.length){ el.results.innerHTML = '<div class="hint">No results for those filters.</div>'; return; }
    el.results.innerHTML = SEARCH_ITEMS.map(cardTemplate).join('');
    el.results.querySelectorAll('.card').forEach(c=>{
      c.addEventListener('click', ()=>{
        const k = c.dataset.k;
        if(SELECTED_KEYS.has(k)) SELECTED_KEYS.delete(k); else SELECTED_KEYS.add(k);
        c.classList.toggle('cardSel');
        updatePreview();
      });
    });
  }

  function buildSelected(){
    const set = new Set(SELECTED_KEYS);
    return SEARCH_ITEMS.filter(p=> set.has(p.uri || p.url || p.ts));
  }
  function updatePreview(){
    const items = buildSelected();
    el.selCount.textContent = items.length;
    const lines = items.map(p=>{
      const h = `@${p.authorHandle||''}`.replace(/^@@/,'@');
      const when = new Date(p.tsLocal||p.ts||Date.now()).toLocaleString();
      const t = (p.text||'').replace(/\s+\n/g,'\n').trim();
      return `${p.authorDisplay||h} — ${when}\n${t}\n${p.url||''}`;
    });
    el.preview.value = lines.join('\n\n');
  }
  function toCsv(items){
    const esc = s => `"${String(s||'').replace(/"/g,'""')}"`;
    const rows = [
      ['author','handle','time','likes','reposts','url','text'].map(esc).join(',')
    ];
    for(const p of items){
      rows.push([
        p.authorDisplay||'',
        '@'+(p.authorHandle||''),
        new Date(p.tsLocal||p.ts||Date.now()).toISOString(),
        p.likeCount||0,
        p.repostCount||0,
        p.url||'',
        (p.text||'').replace(/\r?\n/g,' \\n ')
      ].map(esc).join(','));
    }
    return rows.join('\n');
  }
  function toPublisherHtml(items){
    const safe = s => String(s||'').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const blocks = items.map(p=>{
      const a = `${safe(p.authorDisplay||'')} <span style="color:#666">@${safe(p.authorHandle||'')}</span>`;
      const t = safe(p.text||'').replace(/\n/g,'<br>');
      const ts = new Date(p.tsLocal||p.ts||Date.now()).toLocaleString();
      const img = p.mediaUrl ? `<div style="margin-top:8px"><img src="${safe(p.mediaUrl)}" style="max-width:100%;border:1px solid #eee;border-radius:8px"></div>` : '';
      return `<div style="border:1px solid #eee;border-radius:10px;padding:12px;margin:10px 0">
        <div style="font-weight:600">${a}</div>
        <div style="color:#666;font-size:12px">${ts}</div>
        <div style="margin-top:6px">${t}</div>
        ${img}
        <div style="margin-top:6px"><a href="${safe(p.url||'#')}" target="_blank" rel="noopener">Open on Bluesky</a></div>
      </div>`;
    });
    return blocks.join('\n');
  }

  // actions
  el.searchBtn.addEventListener('click', runSearch);
  el.allBtn.addEventListener('click', ()=>{ ACCOUNT_LIST.forEach(a=>a.selected=true); renderAccounts(); });
  el.noneBtn.addEventListener('click', ()=>{ ACCOUNT_LIST.forEach(a=>a.selected=false); renderAccounts(); });
  el.addBtn.addEventListener('click', async ()=>{
    const raw = el.newHandle.value.trim();
    if(!raw) return;
    const h = raw.replace(/^@/,'');
    SAVED = await apiAdd(h, '@'+h);
    el.newHandle.value = '';
    computeAccounts();
  });
  el.copyText.addEventListener('click', ()=>{ const txt = el.preview.value; navigator.clipboard.writeText(txt); });
  el.copyCsv.addEventListener('click', ()=>{ const csv = toCsv(buildSelected()); navigator.clipboard.writeText(csv); el.preview.value = csv; });
  el.copyHtml.addEventListener('click', ()=>{ const html = toPublisherHtml(buildSelected()); navigator.clipboard.writeText(html); el.preview.value = html; });

  // boot: load base CSV + saved changes, merge, auto-search
  (async function init(){
    BASE = await loadReportersCsv();
    SAVED = await apiGet();          // {extras, removals}
    computeAccounts();               // merge & render, default-selected
    runSearch();                     // auto-run on first load
  })();
  </script>
</body>
</html>
