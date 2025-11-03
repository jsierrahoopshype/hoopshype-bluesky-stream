// netlify/functions/watchlist-accounts.mjs
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'watchlist-accounts';
const KEY = 'accounts.json';

// CORS helpers
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...cors },
    body: JSON.stringify(body)
  };
}

function text(status, body = '') {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/plain', ...cors },
    body
  };
}

// Try automatic Blobs config first; if not present fall back to manual mode
function getBlobsStore() {
  try {
    // Works when Netlify auto-configures the function for Blobs
    return getStore(STORE_NAME);
  } catch (_) {
    const siteID =
      process.env.NETLIFY_SITE_ID ||
      process.env.SITE_ID; // allow either name

    const token =
      process.env.NETLIFY_API_TOKEN ||
      process.env.NETLIFY_TOKEN; // allow either name

    if (!siteID || !token) {
      throw new Error(
        'Netlify Blobs is not configured. Set env vars NETLIFY_SITE_ID and NETLIFY_API_TOKEN.'
      );
    }
    // Manual mode using siteID + token
    return getStore({ name: STORE_NAME, siteID, token });
  }
}

export async function handler(event) {
  // Preflight for CORS
  if (event.httpMethod === 'OPTIONS') return text(204);

  let store;
  try {
    store = getBlobsStore();
  } catch (err) {
    return json(500, { error: err.message });
  }

  try {
    if (event.httpMethod === 'GET') {
      // Shape: { enabled: ["@user1.bsky.social", ...], updatedAt: ISO }
      const raw = await store.get(KEY);
      if (!raw) return json(200, { enabled: [], updatedAt: null });
      try {
        return json(200, JSON.parse(raw));
      } catch {
        // If somehow plain text was stored, wrap it
        return json(200, { enabled: String(raw).split(/\r?\n/).filter(Boolean), updatedAt: null });
      }
    }

    if (event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const enabled = Array.isArray(payload.enabled) ? payload.enabled : [];

      const record = {
        enabled,
        updatedAt: new Date().toISOString()
      };

      await store.set(KEY, JSON.stringify(record), {
        metadata: { kind: 'watchlist-accounts' }
      });

      return json(200, record);
    }

    return text(405, 'Method Not Allowed');
  } catch (err) {
    return json(500, { error: err.message });
  }
}
