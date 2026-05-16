// ─── netlify/functions/claude.js ─────────────────────────────────────────────
// Main backend: DB actions, AI calls (Anthropic + OpenAI fallback), Ably.
// Bug fixes vs v1:
//   - add_event returns created_at via 'Prefer: return=representation'
//   - use_transfer stores events_at_lock as ms timestamp from Date.now()
//   - clean action routing (no ambiguous branching)

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sbHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY}`,
  'Prefer': 'return=representation',
});
const sbBase = () => `${process.env.SUPABASE_URL}/rest/v1`;

// ── Ably helpers ──────────────────────────────────────────────────────────────
async function ablyPublish(sessionCode, eventName, data) {
  const key = process.env.ABLY_API_KEY;
  if (!key) return;
  try {
    await fetch(`https://rest.ably.io/channels/${encodeURIComponent('ffm-' + sessionCode)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(key).toString('base64'),
      },
      body: JSON.stringify({ name: eventName, data }),
    });
  } catch(e) { console.error('Ably publish failed:', e.message); }
}

async function ablyToken(payload) {
  const key = process.env.ABLY_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'Ably not configured' }) };
  const sessionId = payload && payload.session_id ? payload.session_id : '*';
  const capability = JSON.stringify({ ['ffm-' + sessionId]: ['subscribe'] });
  const r = await fetch(`https://rest.ably.io/keys/${key.split(':')[0]}/requestToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(key).toString('base64'),
    },
    body: JSON.stringify({ keyName: key.split(':')[0], capability, ttl: 3600000, timestamp: Date.now() }),
  });
  const token = await r.json();
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token) };
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function handleLogin(payload) {
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: payload.email, password: payload.password }),
  });
  const data = await r.json();
  if (data.error || !data.access_token) {
    return json({ error: 'Invalid email or password' });
  }
  const sr = await fetch(`${sbBase()}/streamers?email=eq.${encodeURIComponent(data.user.email)}&select=email,access_type,expires_at,channel_name`, { headers: sbHeaders() });
  const streamers = await sr.json();
  if (!streamers.length) return json({ error: 'This account does not have streamer access.' });
  const streamer = streamers[0];
  if (streamer.access_type === 'beta' || streamer.access_type === 'expired') return json({ error: 'NEEDS_PAYMENT' });
  if (streamer.access_type === 'paid' && streamer.expires_at && new Date(streamer.expires_at) < new Date()) return json({ error: 'SUBSCRIPTION_EXPIRED' });
  return json({ success: true, email: streamer.email, access_type: streamer.access_type, expires_at: streamer.expires_at, channel_name: streamer.channel_name || '', access_token: data.access_token, user_id: data.user.id });
}

// ── Stripe checkout ───────────────────────────────────────────────────────────
async function createCheckout(payload) {
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const PRICE_ID = process.env.STRIPE_PRICE_ID;
  const APP_URL = process.env.APP_URL || 'https://fantasyfm.io';
  const params = new URLSearchParams({
    'mode': 'subscription',
    'line_items[0][price]': PRICE_ID,
    'line_items[0][quantity]': '1',
    'success_url': `${APP_URL}?checkout=success&email={CHECKOUT_SESSION_ID}`,
    'cancel_url': `${APP_URL}?checkout=cancelled`,
    'customer_email': payload.email || '',
    'subscription_data[metadata][email]': payload.email || '',
    'allow_promotion_codes': 'true',
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const session = await r.json();
  if (session.error) return json({ error: session.error.message });
  return json({ url: session.url });
}

// ── Streamer management ───────────────────────────────────────────────────────
async function getStreamers() {
  const r = await fetch(`${sbBase()}/streamers?select=id,email,access_type,expires_at,channel_name,created_at&order=created_at.desc`, { headers: sbHeaders() });
  return json(await r.json());
}

async function addStreamer(payload) {
  const authR = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
    body: JSON.stringify({ email: payload.email, password: payload.password, email_confirm: true }),
  });
  const authData = await authR.json();
  if (authData.error && !authData.error.message.includes('already')) return json({ error: authData.error.message });
  const r = await fetch(`${sbBase()}/streamers`, {
    method: 'POST', headers: sbHeaders(),
    body: JSON.stringify({ email: payload.email, access_type: payload.access_type || 'beta', expires_at: payload.expires_at || null }),
  });
  return json(await r.json());
}

async function updateStreamer(payload) {
  const r = await fetch(`${sbBase()}/streamers?email=eq.${encodeURIComponent(payload.email)}`, {
    method: 'PATCH', headers: sbHeaders(),
    body: JSON.stringify({ access_type: payload.access_type, expires_at: payload.expires_at || null }),
  });
  return json(await r.json());
}

async function removeStreamer(payload) {
  await fetch(`${sbBase()}/streamers?email=eq.${encodeURIComponent(payload.email)}`, { method: 'DELETE', headers: sbHeaders() });
  return json({ ok: true });
}

// ── Email helpers ─────────────────────────────────────────────────────────────
function generatePassword() {
  const words = ['Tactic','Strike','Squad','Press','Derby','Pitch','Scout','Draft','League','Assist'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  const sym = ['!','@','#','$','%'][Math.floor(Math.random() * 5)];
  return `${word}${num}${sym}`;
}

function welcomeEmailHtml(name, email, password) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0e0f13;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0e0f13;padding:40px 20px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<tr><td style="background:#161820;border-radius:12px 12px 0 0;padding:36px 40px;text-align:center;border-bottom:2px solid #9b4dff;">
<div style="font-family:Arial Black,sans-serif;font-size:26px;font-weight:900;color:#e8eaf0;text-transform:uppercase;letter-spacing:2px">Fantasy<span style="color:#9b4dff">FM</span></div>
<div style="font-size:14px;color:#8b90a8;margin-top:6px;letter-spacing:0.5px">You're in</div>
</td></tr>
<tr><td style="background:#161820;padding:36px 40px;">
<h2 style="color:#e8eaf0;font-size:18px;margin:0 0 16px">Welcome, ${name}! 🎉</h2>
<p style="color:#8b90a8;font-size:14px;line-height:1.6;margin:0 0 20px">Your FantasyFM streamer account is ready. Here are your login details:</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2028;border-radius:8px;margin-bottom:24px;">
<tr><td style="padding:16px 20px">
<div style="font-size:12px;color:#555b72;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Email</div>
<div style="font-size:15px;color:#e8eaf0;font-weight:600">${email}</div>
</td></tr>
<tr><td style="padding:0 20px 16px">
<div style="font-size:12px;color:#555b72;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">Password</div>
<div style="font-size:18px;color:#9b4dff;font-weight:700;letter-spacing:1px;font-family:monospace">${password}</div>
</td></tr>
</table>
<a href="https://fantasyfm.io" style="display:block;background:#9b4dff;color:#fff;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.5px">Sign in to FantasyFM →</a>
</td></tr>
<tr><td style="background:#0e0f13;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
<div style="font-size:12px;color:#555b72">Change your password after your first login.</div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function grantAndEmail(payload) {
  const password = payload.password || generatePassword();
  // Create auth user
  const authR = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
    body: JSON.stringify({ email: payload.email, password, email_confirm: true }),
  });
  const authData = await authR.json();
  const alreadyExists = authData.error && authData.error.message && authData.error.message.includes('already');
  if (authData.error && !alreadyExists) return json({ error: authData.error.message });

  // Upsert streamer record
  const existing = await fetch(`${sbBase()}/streamers?email=eq.${encodeURIComponent(payload.email)}&select=id`, { headers: sbHeaders() });
  const existingData = await existing.json();
  if (existingData.length) {
    await fetch(`${sbBase()}/streamers?email=eq.${encodeURIComponent(payload.email)}`, {
      method: 'PATCH', headers: sbHeaders(), body: JSON.stringify({ access_type: 'paid', expires_at: null }),
    });
  } else {
    await fetch(`${sbBase()}/streamers`, {
      method: 'POST', headers: sbHeaders(), body: JSON.stringify({ email: payload.email, access_type: 'paid', expires_at: null }),
    });
  }

  // Send welcome email via Resend
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (RESEND_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'FantasyFM <noreply@fantasyfm.io>',
          to: [payload.email],
          subject: 'Welcome to FantasyFM — your login details',
          html: welcomeEmailHtml(payload.name || payload.email, payload.email, password),
        }),
      });
    } catch(e) { console.error('Email send failed:', e.message); }
  }
  return json({ ok: true, password });
}

// ── AI proxy (Anthropic + OpenAI fallback) ────────────────────────────────────
async function handleAI(body) {
  // Primary: Anthropic Claude
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: body.max_tokens || 1200, messages: body.messages }),
    });
    const data = await r.json();
    const isOverloaded = r.status === 529 || r.status === 503 || r.status === 500 || r.status === 401 ||
      (data.error && /overload|unavailable|capacity|authentication|invalid/i.test(JSON.stringify(data.error)));
    if (!isOverloaded) return json(data);
    console.log('Anthropic overloaded, falling back to OpenAI');
  } catch(e) { console.error('Anthropic request failed:', e.message); }

  // Fallback: OpenAI GPT-4o
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return json({ error: { message: 'AI provider unavailable. Please try again.' } });

  try {
    const openaiMessages = (body.messages || []).map(msg => ({
      role: msg.role,
      content: Array.isArray(msg.content)
        ? msg.content.map(part => {
            if (part.type === 'image') {
              return { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}`, detail: 'high' } };
            }
            return part;
          })
        : msg.content,
    }));
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: body.max_tokens || 1200, messages: openaiMessages }),
    });
    const data = await r.json();
    if (data.choices && data.choices[0]) {
      const text = data.choices[0].message?.content || '';
      return json({ content: [{ type: 'text', text }] });
    }
  } catch(e) { console.error('OpenAI fallback failed:', e.message); }

  return json({ error: { message: 'Both AI providers are currently unavailable. Please try again shortly.' } });
}

// ── oauth-config helper ───────────────────────────────────────────────────────
function handleOAuthConfig() {
  return json({
    twitch_client_id: process.env.TWITCH_CLIENT_ID || '',
    youtube_client_id: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  });
}

// ── JSON response helper ──────────────────────────────────────────────────────
function json(data) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

// ── Main Supabase action handler ──────────────────────────────────────────────
async function handleSupabase(body) {
  const { action, payload = {} } = body;
  const base = sbBase();
  const headers = sbHeaders();
  let result;

  switch (action) {
    case 'create_session': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const sessionData = {
        id: payload.id,
        user_id: jwtPayload.sub,
        is_live: true,
        type: payload.type || 'oneoff',
        season_end: payload.season_end || null,
        allow_new_joiners: payload.allow_new_joiners !== undefined ? payload.allow_new_joiners : true,
        transfers_per_viewer: payload.transfers_per_viewer || 3,
        is_entries_locked: false,
      };
      const r = await fetch(`${base}/sessions`, { method: 'POST', headers, body: JSON.stringify(sessionData) });
      result = await r.json();
      break;
    }

    case 'save_roster': {
      // Delete existing roster entries, then insert fresh
      await fetch(`${base}/roster?session_id=eq.${payload.session_id}`, { method: 'DELETE', headers });
      const rows = (payload.players || []).filter(p => p.name && p.name.trim()).map(p => ({
        session_id: payload.session_id,
        name: String(p.name).replace(/[<>"'`]/g, '').slice(0, 60),
        pos: ['DEF','MID','ATT'].includes(p.pos) ? p.pos : 'MID',
      }));
      if (rows.length) {
        const r = await fetch(`${base}/roster`, { method: 'POST', headers, body: JSON.stringify(rows) });
        result = await r.json();
      } else { result = []; }
      break;
    }

    case 'get_roster': {
      const r = await fetch(`${base}/roster?session_id=eq.${payload.session_id}&select=name,pos&order=pos.asc`, { headers });
      result = await r.json();
      break;
    }

    case 'get_session': {
      const r = await fetch(`${base}/sessions?id=eq.${payload.session_id}&select=id,is_live,type,season_end,allow_new_joiners,transfers_per_viewer,is_entries_locked`, { headers });
      const sessions = await r.json();
      result = sessions[0] || null;
      break;
    }

    case 'rejoin_session': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const r = await fetch(`${base}/sessions?id=eq.${payload.session_id}&select=id,is_live,type,season_end,allow_new_joiners,transfers_per_viewer,is_entries_locked,user_id`, { headers });
      const sessions = await r.json();
      if (!sessions[0]) { result = null; break; }
      if (sessions[0].user_id !== jwtPayload.sub) throw new Error('You do not own this session.');
      const { user_id, ...sessionData } = sessions[0];
      result = sessionData;
      break;
    }

    case 'get_viewers': {
      const r = await fetch(`${base}/viewers?session_id=eq.${payload.session_id}&select=viewer_name,pick_def,pick_mid,pick_att,pick_cap,locked,platform,oauth_id,avatar_url,events_at_lock,transfers_used,is_mod,banked_points`, { headers });
      result = await r.json();
      break;
    }

    case 'upsert_viewer': {
      const safeFields = {};
      const allowedPos = ['pick_def','pick_mid','pick_att','pick_cap'];
      allowedPos.forEach(pos => { if (payload[pos] !== undefined) safeFields[pos] = payload[pos] ? String(payload[pos]).replace(/[<>"'`]/g,'').slice(0,60) : null; });
      if (payload.locked !== undefined) safeFields.locked = !!payload.locked;
      if (payload.events_at_lock !== undefined) safeFields.events_at_lock = Number(payload.events_at_lock);
      if (payload.platform) safeFields.platform = payload.platform;
      if (payload.oauth_id) safeFields.oauth_id = String(payload.oauth_id).slice(0, 100);
      if (payload.avatar_url) safeFields.avatar_url = String(payload.avatar_url).slice(0, 512);
      if (payload.viewer_name) safeFields.viewer_name = String(payload.viewer_name).replace(/[<>"'`]/g,'').slice(0, 60);
      safeFields.session_id = payload.session_id;

      const r = await fetch(`${base}/viewers`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify(safeFields),
      });
      const viewerResult = await r.json();
      const viewer = Array.isArray(viewerResult) ? viewerResult[0] : viewerResult;
      result = viewer;
      await ablyPublish(payload.session_id, 'state_changed', { type: 'viewer', viewer });
      break;
    }

    case 'add_event': {
      const allowedPos = ['DEF','MID','ATT'];
      const allowedEvents = ['goal','assist','clean_sheet','motm','rating','yellow_card','red_card','manual_adjust'];
      const pts = Number(payload.points);
      if (!allowedPos.includes(payload.pos)) throw new Error('Invalid pos');
      if (!allowedEvents.includes(payload.event_type)) throw new Error('Invalid event_type');
      if (!isFinite(pts) || Math.abs(pts) > 100) throw new Error('Invalid points value');
      if (!payload.session_id || !payload.player_name) throw new Error('Missing required fields');
      const safeName = String(payload.player_name).replace(/[<>"'`]/g,'').slice(0, 60);
      // CRITICAL FIX: 'Prefer: return=representation' so we get created_at back
      const r = await fetch(`${base}/events`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ session_id: payload.session_id, player_name: safeName, pos: payload.pos, event_type: payload.event_type, points: pts }),
      });
      const evResult = await r.json();
      const eventRow = Array.isArray(evResult) ? evResult[0] : evResult;
      result = eventRow; // includes created_at
      await ablyPublish(payload.session_id, 'state_changed', {
        type: 'event',
        event: eventRow ? { player_name: eventRow.player_name, pos: eventRow.pos, event_type: eventRow.event_type, points: eventRow.points, created_at: eventRow.created_at } : null,
      });
      break;
    }

    case 'delete_last_event': {
      const r = await fetch(`${base}/events?session_id=eq.${payload.session_id}&order=id.desc&limit=1`, { headers });
      const events = await r.json();
      if (events.length > 0) {
        await fetch(`${base}/events?id=eq.${events[0].id}`, { method: 'DELETE', headers });
        result = events[0];
        await ablyPublish(payload.session_id, 'state_changed', { type: 'event_deleted', event_id: events[0].id });
      } else { result = null; }
      break;
    }

    case 'get_events': {
      const r = await fetch(`${base}/events?session_id=eq.${payload.session_id}&select=id,player_name,pos,event_type,points,created_at&order=id.asc`, { headers });
      result = await r.json();
      break;
    }

    case 'get_transfer_log': {
      const r = await fetch(`${base}/transfer_log?session_id=eq.${payload.session_id}&select=oauth_id,pos,player_name,transferred_at,is_outgoing&order=id.asc`, { headers });
      result = await r.json();
      break;
    }

    case 'use_transfer': {
      const allowedPos = ['pick_def','pick_mid','pick_att','pick_cap'];
      if (!allowedPos.includes(payload.pos)) throw new Error('Invalid pos');
      const safeName = String(payload.new_player).replace(/[<>"'`]/g,'').slice(0, 60);
      const sessionR = await fetch(`${base}/sessions?id=eq.${payload.session_id}&select=type,transfers_per_viewer`, { headers });
      const sessions = await sessionR.json();
      if (!sessions[0] || sessions[0].type !== 'season') throw new Error('Transfers only available in season mode');
      const viewerR = await fetch(`${base}/viewers?session_id=eq.${payload.session_id}&oauth_id=eq.${encodeURIComponent(payload.oauth_id)}&select=transfers_used,banked_points`, { headers });
      const viewers = await viewerR.json();
      const viewer = viewers[0];
      if (!viewer) throw new Error('Viewer not found');
      if (viewer.transfers_used >= sessions[0].transfers_per_viewer) throw new Error('No transfers remaining');
      const newBanked = Number(payload.current_score) || 0;
      const now = new Date().toISOString();
      // CRITICAL FIX: store events_at_lock as ms timestamp (Date.now()), not ISO string
      await fetch(`${base}/viewers?session_id=eq.${payload.session_id}&oauth_id=eq.${encodeURIComponent(payload.oauth_id)}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ [payload.pos]: safeName, transfers_used: viewer.transfers_used + 1, banked_points: newBanked, events_at_lock: Date.now() }),
      });
      // Log transfer
      await fetch(`${base}/transfer_log`, { method: 'POST', headers, body: JSON.stringify({ session_id: payload.session_id, oauth_id: payload.oauth_id, pos: payload.pos, player_name: safeName }) });
      const updated = await fetch(`${base}/viewers?session_id=eq.${payload.session_id}&oauth_id=eq.${encodeURIComponent(payload.oauth_id)}&select=viewer_name,pick_def,pick_mid,pick_att,pick_cap,locked,platform,oauth_id,avatar_url,events_at_lock,transfers_used,is_mod,banked_points`, { headers });
      const updatedViewer = (await updated.json())[0] || null;
      result = updatedViewer;
      await ablyPublish(payload.session_id, 'state_changed', { type: 'transfer', viewer: updatedViewer, transfer: { oauth_id: payload.oauth_id, pos: payload.pos, player_name: safeName, transferred_at: now } });
      break;
    }

    case 'promote_mod':
    case 'demote_mod': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const sessionR = await fetch(`${base}/sessions?id=eq.${payload.session_id}&select=user_id`, { headers });
      const sessions = await sessionR.json();
      if (!sessions.length) throw new Error('Session not found');
      if (sessions[0].user_id !== jwtPayload.sub) throw new Error('Not authorised to manage this session');
      const isMod = action === 'promote_mod';
      await fetch(`${base}/viewers?session_id=eq.${payload.session_id}&viewer_name=eq.${encodeURIComponent(payload.viewer_name)}`, {
        method: 'PATCH', headers, body: JSON.stringify({ is_mod: isMod }),
      });
      await ablyPublish(payload.session_id, 'state_changed', { type: isMod ? 'mod_promoted' : 'mod_demoted', viewer_name: payload.viewer_name });
      result = { ok: true };
      break;
    }

    case 'set_entries_locked': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const sessionCheck = await fetch(`${base}/sessions?id=eq.${payload.session_id}&select=user_id`, { headers });
      const sessions = await sessionCheck.json();
      if (!sessions.length) throw new Error('Session not found');
      if (sessions[0].user_id !== jwtPayload.sub) throw new Error('Not authorised');
      await fetch(`${base}/sessions?id=eq.${payload.session_id}`, { method: 'PATCH', headers, body: JSON.stringify({ is_entries_locked: payload.is_entries_locked }) });
      await ablyPublish(payload.session_id, 'state_changed', { type: 'entries_lock', locked: payload.is_entries_locked });
      result = { ok: true };
      break;
    }

    case 'update_season_settings': {
      await fetch(`${base}/sessions?id=eq.${payload.session_id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ season_end: payload.season_end, allow_new_joiners: payload.allow_new_joiners, transfers_per_viewer: payload.transfers_per_viewer }),
      });
      await ablyPublish(payload.session_id, 'state_changed', { type: 'season_settings', season_end: payload.season_end, allow_new_joiners: payload.allow_new_joiners, transfers_per_viewer: payload.transfers_per_viewer });
      result = { ok: true };
      break;
    }

    case 'update_channel_name': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const safeName = String(payload.channel_name || '').replace(/[<>"'`]/g,'').trim().slice(0, 60);
      await fetch(`${base}/streamers?email=eq.${encodeURIComponent(jwtPayload.email)}`, { method: 'PATCH', headers, body: JSON.stringify({ channel_name: safeName }) });
      result = { ok: true, channel_name: safeName };
      break;
    }

    case 'end_stream': {
      await fetch(`${base}/sessions?id=eq.${payload.session_id}`, { method: 'PATCH', headers, body: JSON.stringify({ is_live: false }) });
      await ablyPublish(payload.session_id, 'state_changed', { type: 'stream_ended' });
      result = { ok: true };
      break;
    }

    case 'reset_session': {
      await fetch(`${base}/events?session_id=eq.${payload.session_id}`, { method: 'DELETE', headers });
      await fetch(`${base}/viewers?session_id=eq.${payload.session_id}`, { method: 'DELETE', headers });
      await fetch(`${base}/roster?session_id=eq.${payload.session_id}`, { method: 'DELETE', headers });
      await fetch(`${base}/sessions?id=eq.${payload.session_id}`, { method: 'DELETE', headers });
      await ablyPublish(payload.session_id, 'state_changed', { type: 'reset' });
      result = { ok: true };
      break;
    }

    case 'add_waitlist': {
      const check = await fetch(`${base}/waitlist?email=eq.${encodeURIComponent(payload.email)}&select=id`, { headers });
      const existing = await check.json();
      if (existing.length > 0) { result = { error: 'duplicate' }; break; }
      const r = await fetch(`${base}/waitlist`, { method: 'POST', headers, body: JSON.stringify({ name: payload.name, email: payload.email, channel: payload.channel || null }) });
      result = await r.json();
      break;
    }

    case 'get_waitlist': {
      const r = await fetch(`${base}/waitlist?order=created_at.asc&select=id,name,email,channel,created_at`, { headers });
      result = await r.json();
      break;
    }

    case 'remove_waitlist': {
      await fetch(`${base}/waitlist?id=eq.${payload.id}`, { method: 'DELETE', headers });
      result = { ok: true };
      break;
    }

    case 'submit_bug': {
      const r = await fetch(`${base}/bug_reports`, { method: 'POST', headers, body: JSON.stringify({ streamer_email: payload.streamer_email, category: payload.category, description: payload.description, steps: payload.steps || null, resolved: false }) });
      result = await r.json();
      break;
    }

    case 'get_bugs': {
      const r = await fetch(`${base}/bug_reports?order=created_at.desc&select=id,streamer_email,category,description,steps,resolved,created_at`, { headers });
      result = await r.json();
      break;
    }

    case 'resolve_bug': {
      await fetch(`${base}/bug_reports?id=eq.${payload.id}`, { method: 'PATCH', headers, body: JSON.stringify({ resolved: payload.resolved }) });
      result = { ok: true };
      break;
    }

    case 'admin_get_sessions': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const adminCheck = await fetch(`${base}/streamers?email=eq.${encodeURIComponent(jwtPayload.email)}&select=access_type`, { headers });
      const admins = await adminCheck.json();
      if (!admins.length || admins[0].access_type !== 'admin') throw new Error('Admin access required');
      const sessionsR = await fetch(`${base}/sessions?select=id,is_live,type,season_end,created_at,user_id&order=created_at.desc`, { headers });
      const sessions = await sessionsR.json();
      const enriched = await Promise.all(sessions.map(async (s) => {
        const [viewersR, authUserR] = await Promise.all([
          fetch(`${base}/viewers?session_id=eq.${s.id}&select=viewer_name`, { headers }),
          fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${s.user_id}`, {
            headers: { 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
          }),
        ]);
        const viewers = await viewersR.json();
        const authUser = await authUserR.json();
        const streamerEmail = authUser?.email || '';
        let streamerChannel = '';
        if (streamerEmail) {
          const streamerR = await fetch(`${base}/streamers?email=eq.${encodeURIComponent(streamerEmail)}&select=channel_name`, { headers });
          const streamers = await streamerR.json();
          streamerChannel = streamers[0]?.channel_name || '';
        }
        return { ...s, viewer_count: viewers.length, streamer_email: streamerEmail || 'Unknown', streamer_channel: streamerChannel };
      }));
      result = enriched;
      break;
    }

    case 'admin_inspect_session': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const adminCheck = await fetch(`${base}/streamers?email=eq.${encodeURIComponent(jwtPayload.email)}&select=access_type`, { headers });
      const admins = await adminCheck.json();
      if (!admins.length || admins[0].access_type !== 'admin') throw new Error('Admin access required');
      const sessionId = payload.session_id;
      const [sessionR, rosterR, eventsR, viewersR] = await Promise.all([
        fetch(`${base}/sessions?id=eq.${sessionId}&select=id,is_live,type,season_end,allow_new_joiners,transfers_per_viewer,created_at,user_id`, { headers }),
        fetch(`${base}/roster?session_id=eq.${sessionId}&select=name,pos&order=pos.asc`, { headers }),
        fetch(`${base}/events?session_id=eq.${sessionId}&select=player_name,pos,event_type,points,created_at&order=id.asc`, { headers }),
        fetch(`${base}/viewers?session_id=eq.${sessionId}&select=viewer_name,pick_def,pick_mid,pick_att,pick_cap,locked,platform,oauth_id,is_mod,transfers_used,events_at_lock,banked_points`, { headers }),
      ]);
      const sessions = await sessionR.json();
      if (!sessions.length) throw new Error('Session not found');
      const session = sessions[0];
      const streamerR = await fetch(`${base}/streamers?id=eq.${session.user_id}&select=email,channel_name`, { headers });
      const streamers = await streamerR.json();
      result = {
        session,
        streamer_email: streamers[0]?.email || 'Unknown',
        streamer_channel: streamers[0]?.channel_name || '',
        roster: await rosterR.json(),
        events: await eventsR.json(),
        viewers: await viewersR.json(),
      };
      break;
    }

    case 'admin_end_session': {
      if (!payload.user_jwt) throw new Error('Authentication required');
      const jwtPayload = JSON.parse(Buffer.from(payload.user_jwt.split('.')[1], 'base64').toString());
      const adminCheck = await fetch(`${base}/streamers?email=eq.${encodeURIComponent(jwtPayload.email)}&select=access_type`, { headers });
      const admins = await adminCheck.json();
      if (!admins.length || admins[0].access_type !== 'admin') throw new Error('Admin access required');
      await fetch(`${base}/sessions?id=eq.${payload.session_id}`, { method: 'PATCH', headers, body: JSON.stringify({ is_live: false }) });
      result = { ok: true };
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }

  return json(result);
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    // Action routing
    if (body.action === 'auth_login') return await handleLogin(body.payload || {});
    if (body.action === 'ably_token') return await ablyToken(body.payload || {});
    if (body.action === 'create_checkout') return await createCheckout(body.payload || {});
    if (body.action === 'get_streamers') return await getStreamers();
    if (body.action === 'add_streamer') return await addStreamer(body.payload || {});
    if (body.action === 'update_streamer') return await updateStreamer(body.payload || {});
    if (body.action === 'remove_streamer') return await removeStreamer(body.payload || {});
    if (body.action === 'grant_and_email') return await grantAndEmail(body.payload || {});
    if (body.action === 'oauth_config') return handleOAuthConfig();
    if (body.action) return await handleSupabase(body);

    // No action = AI proxy call
    return await handleAI(body);

  } catch(err) {
    console.error('claude.js error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
