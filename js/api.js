// ─── api.js ───────────────────────────────────────────────────────────────────
// All network calls. db() for Supabase actions via claude.js.
// callClaude() for AI vision with OpenAI fallback on overload.

async function db(action, payload = {}) {
  const jwt = lsGet('ffm_streamer_jwt');
  const headers = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
  const r = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, payload }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function callClaude(messages, maxTokens = 1200) {
  const MAX_RETRIES = 2;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
    try {
      const res = await fetch('/.netlify/functions/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, max_tokens: maxTokens }),
      });
      const data = await res.json();
      if (data.error) {
        const msg = (data.error.message || JSON.stringify(data.error)).toLowerCase();
        const isOverload = /overload|unavailable|capacity|529|503/.test(msg);
        if (isOverload && attempt < MAX_RETRIES) { lastErr = new Error('PROVIDER_OVERLOADED'); continue; }
        if (isOverload) throw new Error('PROVIDER_OVERLOADED');
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      // Extract text from Anthropic format
      const text = (data.content || []).map(c => c.text || '').join('');
      if (!text) throw new Error('Empty response');
      return text;
    } catch(e) {
      lastErr = e;
      if (e.message === 'PROVIDER_OVERLOADED' && attempt < MAX_RETRIES) continue;
      if (attempt === MAX_RETRIES) break;
    }
  }
  throw lastErr || new Error('AI call failed');
}

window.db = db;
window.callClaude = callClaude;
