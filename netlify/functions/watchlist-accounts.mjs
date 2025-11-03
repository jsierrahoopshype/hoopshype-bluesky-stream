// netlify/functions/watchlist-accounts.mjs
import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const KEY = 'accounts_v1';

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) };
}
function err(statusCode, message) {
  return json(statusCode, { error: message });
}
function uniquePush(arr, item, key = 'handle') {
  if (!arr.some(x => (x[key] || '').toLowerCase() === (item[key] || '').toLowerCase())) arr.push(item);
}

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const store = getStore('watchlist'); // a named blob store
  let state = await store.get(KEY, { type: 'json' });
  if (!state || typeof state !== 'object') state = { extras: [], removals: [] };

  try {
    if (event.httpMethod === 'GET') {
      return json(200, state);
    }

    if (event.httpMethod === 'POST') {
      const { handle, display } = JSON.parse(event.body || '{}');
      const h = String(handle || '').trim().replace(/^@/, '');
      if (!h) return err(400, 'handle required');

      // If it was in removals, un-remove it
      state.removals = state.removals.filter(x => x.toLowerCase() !== h.toLowerCase());
      uniquePush(state.extras, { handle: h, display: display || '@' + h }, 'handle');

      await store.set(KEY, JSON.stringify(state));
      return json(200, state);
    }

    if (event.httpMethod === 'DELETE') {
      const { handle } = JSON.parse(event.body || '{}');
      const h = String(handle || '').trim().replace(/^@/, '');
      if (!h) return err(400, 'handle required');

      // Remove from extras if present
      state.extras = state.extras.filter(x => x.handle.toLowerCase() !== h.toLowerCase());
      // Add to removals
      if (!state.removals.some(r => r.toLowerCase() === h.toLowerCase())) state.removals.push(h);

      await store.set(KEY, JSON.stringify(state));
      return json(200, state);
    }

    if (event.httpMethod === 'PUT') {
      const { extras, removals } = JSON.parse(event.body || '{}');
      state = {
        extras: Array.isArray(extras) ? extras.map(x => ({ handle: String(x.handle).trim().replace(/^@/, ''), display: x.display || '@' + x.handle })) : [],
        removals: Array.isArray(removals) ? removals.map(h => String(h).trim().replace(/^@/, '')) : [],
      };
      await store.set(KEY, JSON.stringify(state));
      return json(200, state);
    }

    return err(405, 'Method not allowed');
  } catch (e) {
    return err(500, e.message || 'Server error');
  }
}
