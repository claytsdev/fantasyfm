// ─── state.js ─────────────────────────────────────────────────────────────────
// Two completely separate state contexts: S (streamer) and V (viewer).
// S is NEVER touched by the viewer join flow.
// V is NEVER used by streamer tabs.

// ── Streamer State ──────────────────────────────────────────────────────────
window.S = {
  sessionCode: null,    // Only set when streamer creates/rejoins their OWN session
  roster: [],
  events: [],
  viewers: {},
  transferLog: {},
  isLive: false,
  type: 'oneoff',
  seasonEnd: null,
  allowNewJoiners: true,
  transfersPerViewer: 3,
};

// ── Viewer State ─────────────────────────────────────────────────────────────
window.V = {
  viewerSessionCode: null,
  roster: [],
  events: [],
  viewers: {},
  type: 'oneoff',
  transfersPerViewer: 3,
  allowNewJoiners: true,
};

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v !== null ? v : fallback; }
  catch(e) { return fallback; }
}
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch(e) {} }
function lsRemove(key) { try { localStorage.removeItem(key); } catch(e) {} }
function lsGetJson(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e) { return fallback; }
}
function lsSetJson(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {} }

// ── Streamer persistence ──────────────────────────────────────────────────────

function saveStreamerState() {
  lsSetJson('ffm_streamer_state', {
    sessionCode: S.sessionCode,
    isLive: S.isLive,
    type: S.type,
    seasonEnd: S.seasonEnd,
    allowNewJoiners: S.allowNewJoiners,
    transfersPerViewer: S.transfersPerViewer,
  });
}

function loadStreamerState() {
  const saved = lsGetJson('ffm_streamer_state');
  if (saved && saved.sessionCode) {
    S.sessionCode = saved.sessionCode;
    S.isLive = saved.isLive || false;
    S.type = saved.type || 'oneoff';
    S.seasonEnd = saved.seasonEnd || null;
    S.allowNewJoiners = saved.allowNewJoiners !== undefined ? saved.allowNewJoiners : true;
    S.transfersPerViewer = saved.transfersPerViewer || 3;
    return true;
  }
  return false;
}

function clearStreamerState() {
  S.sessionCode = null;
  S.roster = [];
  S.events = [];
  S.viewers = {};
  S.transferLog = {};
  S.isLive = false;
  S.type = 'oneoff';
  S.seasonEnd = null;
  S.allowNewJoiners = true;
  S.transfersPerViewer = 3;
  lsRemove('ffm_streamer_state');
  lsRemove('ffm_streamer_session');
}

// ── Avatar helpers ────────────────────────────────────────────────────────────
function saveAvatar(name, dataUrl) { lsSet('ffm_av_' + name, dataUrl); }
function loadAvatar(name) { return lsGet('ffm_av_' + name, null); }
function clearAvatars() {
  try { Object.keys(localStorage).filter(k => k.startsWith('ffm_av_')).forEach(k => localStorage.removeItem(k)); }
  catch(e) {}
}

// ── Sanitise ──────────────────────────────────────────────────────────────────
function sanitise(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

window.lsGet = lsGet;
window.lsSet = lsSet;
window.lsRemove = lsRemove;
window.lsGetJson = lsGetJson;
window.lsSetJson = lsSetJson;
window.saveStreamerState = saveStreamerState;
window.loadStreamerState = loadStreamerState;
window.clearStreamerState = clearStreamerState;
window.saveAvatar = saveAvatar;
window.loadAvatar = loadAvatar;
window.clearAvatars = clearAvatars;
window.sanitise = sanitise;
