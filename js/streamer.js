// ─── streamer.js ──────────────────────────────────────────────────────────────
// Streamer session lifecycle: go live, reload, squad upload, scoring controls.

let entriesLocked = false;
let pendingMatch = [];
let pendingMatchResult = null;
let statsScreenB64 = null, statsScreenMime = null;

// ── DB reload ─────────────────────────────────────────────────────────────────
async function reloadFromDB() {
  if (!S.sessionCode) return;
  const [session, roster, events, viewers, transferLog] = await Promise.all([
    db('get_session', { session_id: S.sessionCode }),
    db('get_roster', { session_id: S.sessionCode }),
    db('get_events', { session_id: S.sessionCode }),
    db('get_viewers', { session_id: S.sessionCode }),
    db('get_transfer_log', { session_id: S.sessionCode }),
  ]);
  if (session) {
    S.isLive = session.is_live;
    S.type = session.type || 'oneoff';
    S.seasonEnd = session.season_end || null;
    S.allowNewJoiners = session.allow_new_joiners !== undefined ? session.allow_new_joiners : true;
    S.transfersPerViewer = session.transfers_per_viewer || 3;
    if (session.is_entries_locked !== undefined) {
      entriesLocked = !!session.is_entries_locked;
      _applyEntriesToggleUI();
      lsSet('ffm_entries_locked', entriesLocked ? '1' : '0');
    }
  }
  if (Array.isArray(roster)) {
    S.roster = roster.map(p => ({ name: p.name, pos: p.pos, avatar: loadAvatar(p.name) }));
  }
  if (Array.isArray(events)) {
    S.events = events.map(e => ({
      player: e.player_name, pos: e.pos, eventType: e.event_type,
      points: Number(e.points),
      time: new Date(e.created_at).toLocaleTimeString(),
      // BUG FIX: always ms from DB created_at
      ts: new Date(e.created_at).getTime(),
    }));
  }
  // Build viewers
  const prevViewers = S.viewers || {};
  S.viewers = {};
  if (Array.isArray(viewers)) {
    viewers.forEach(v => {
      S.viewers[v.viewer_name] = {
        picks: { DEF: v.pick_def || null, MID: v.pick_mid || null, ATT: v.pick_att || null, CAP: v.pick_cap || null },
        locked: v.locked,
        platform: v.platform || 'manual',
        oauthId: v.oauth_id || null,
        // BUG FIX: always ms
        lockedAtTs: typeof v.events_at_lock === 'string'
          ? new Date(v.events_at_lock).getTime()
          : (v.events_at_lock || 0),
        transfersUsed: v.transfers_used || 0,
        isMod: v.is_mod || false,
        bankedPoints: v.banked_points || 0,
      };
    });
  }
  // Preserve optimistic local state
  Object.keys(prevViewers).forEach(name => {
    const prev = prevViewers[name];
    if (!S.viewers[name]) S.viewers[name] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: prev.locked || false };
    Object.keys(prev.picks || {}).forEach(pos => {
      if (prev.picks[pos] && !S.viewers[name].picks[pos]) S.viewers[name].picks[pos] = prev.picks[pos];
    });
    if (prev.locked) S.viewers[name].locked = true;
    if (prev.lockedAtTs && (!S.viewers[name].lockedAtTs || prev.lockedAtTs > S.viewers[name].lockedAtTs)) {
      S.viewers[name].lockedAtTs = prev.lockedAtTs;
    }
  });
  // Transfer log
  S.transferLog = {};
  if (Array.isArray(transferLog)) {
    transferLog.forEach(t => {
      if (!S.transferLog[t.oauth_id]) S.transferLog[t.oauth_id] = {};
      const ts = new Date(t.transferred_at).getTime();
      const posKey = t.pos.replace('pick_', '').toUpperCase();
      if (!S.transferLog[t.oauth_id][posKey]) S.transferLog[t.oauth_id][posKey] = [];
      S.transferLog[t.oauth_id][posKey].push({ player: t.player_name, ts, isOutgoing: !!t.is_outgoing });
    });
    Object.values(S.transferLog).forEach(pm => Object.keys(pm).forEach(p => pm[p].sort((a, b) => a.ts - b.ts)));
  }
}

// ── Restore UI after reload ───────────────────────────────────────────────────
function restoreUI() {
  document.getElementById('sp-upload').style.display = 'none';
  document.getElementById('sp-roster').style.display = 'none';
  document.getElementById('sp-done').style.display = 'block';
  document.getElementById('code-val').textContent = S.sessionCode;
  document.getElementById('session-pill').textContent = S.sessionCode;
  document.getElementById('live-pill').style.display = 'inline-flex';
  document.getElementById('live-locked').style.display = 'none';
  document.getElementById('live-panel').style.display = 'block';
  document.getElementById('lg-empty').style.display = 'none';
  document.getElementById('lg-panel').style.display = 'block';
  const seasonBadge = document.getElementById('season-badge');
  const seasonSettingsBtn = document.getElementById('season-settings-btn');
  const endResetBtn = document.getElementById('end-reset-btn');
  if (seasonBadge) seasonBadge.style.display = S.type === 'season' ? 'inline-flex' : 'none';
  if (seasonSettingsBtn) seasonSettingsBtn.style.display = S.type === 'season' ? 'inline-flex' : 'none';
  if (endResetBtn) endResetBtn.textContent = S.type === 'season' ? 'End Season' : 'Reset session';
  updateSetupTabLabel();
  renderScoring();
  refreshLog();
  refreshStats();
  renderLeague();
  renderInsights();
  renderViewerList();
  renderSquadManage();
  startPolling();
  updateOverlayUrl();
  loadLastMatch();
  setUIMode('streamer');
  // Restore entries lock state
  const saved = lsGet('ffm_entries_locked');
  if (saved !== null) { entriesLocked = saved === '1'; _applyEntriesToggleUI(); }
}

function updateSetupTabLabel() {
  const lbl = document.getElementById('nb-setup');
  if (!lbl) return;
}

// ── Rejoin ────────────────────────────────────────────────────────────────────
async function rejoinSession() {
  const input = document.getElementById('rejoin-code-input');
  const status = document.getElementById('rejoin-status');
  if (!input || !status) return;
  const code = input.value.trim().toUpperCase();
  if (!code) { status.style.color = 'var(--att)'; status.textContent = 'Please enter a session code.'; return; }
  status.style.color = 'var(--txt3)'; status.textContent = 'Looking up session…';
  try {
    const jwt = lsGet('ffm_streamer_jwt');
    if (!jwt) { status.style.color = 'var(--att)'; status.textContent = 'You must be logged in as a streamer.'; return; }
    const session = await db('rejoin_session', { session_id: code, user_jwt: jwt });
    if (!session || !session.id) { status.style.color = 'var(--att)'; status.textContent = 'Session not found.'; return; }
    S.sessionCode = session.id;
    S.isLive = true;
    S.type = session.type || 'oneoff';
    S.seasonEnd = session.season_end || null;
    S.allowNewJoiners = session.allow_new_joiners !== undefined ? session.allow_new_joiners : true;
    S.transfersPerViewer = session.transfers_per_viewer || 3;
    await reloadFromDB();
    saveStreamerState();
    lsSet('ffm_streamer_session', session.id);
    document.getElementById('sp-rejoin').style.display = 'none';
    restoreUI();
  } catch(e) {
    status.style.color = 'var(--att)'; status.textContent = 'Error: ' + e.message;
  }
}

// ── Squad upload ──────────────────────────────────────────────────────────────
function showManual() {
  S.roster = []; addBlank();
  document.getElementById('sp-upload').style.display = 'none';
  document.getElementById('sp-roster').style.display = 'block';
}

function renderRoster() {
  const tbody = document.getElementById('roster-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  S.roster.forEach((p, i) => {
    const tr = document.createElement('tr');
    const av = posAvatar(p.pos, 28);
    tr.innerHTML = `<td class="roster-name-cell">${av}<input class="roster-name-input" value="${p.name}" oninput="S.roster[${i}].name=this.value" placeholder="Player name"></td>
      <td><div class="pos-toggle">${['DEF','MID','ATT'].map(pos => `<button class="pos-btn ${p.pos===pos ? 'p-' + pos : ''}" onclick="setPos(${i},'${pos}')">${pos}</button>`).join('')}</div></td>
      <td><button class="remove-btn" onclick="rmPlayer(${i})">✕</button></td>`;
    tbody.appendChild(tr);
  });
}
function setPos(i, pos) { S.roster[i].pos = pos; renderRoster(); }
function rmPlayer(i) { S.roster.splice(i, 1); renderRoster(); }
function addBlank() { S.roster.push({ name: '', pos: 'MID' }); renderRoster(); }

function showSecondScreenshot() {
  const el = document.getElementById('second-screenshot');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function cropFacesByBoundingBox(b64, mime, players) {
  return new Promise(resolve => {
    const imgEl = new Image();
    imgEl.onload = () => {
      try {
        const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
        if (!W || !H) { resolve(); return; }
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.getContext('2d').drawImage(imgEl, 0, 0, W, H);
        const faceSize = 44;
        let cropped = 0;
        players.forEach(p => {
          if (p.fx == null || p.fy == null || p.fw == null || p.fh == null) return;
          const x = Math.round(p.fx / 100 * W), y = Math.round(p.fy / 100 * H);
          const w = Math.round(p.fw / 100 * W), h = Math.round(p.fh / 100 * H);
          if (w < 4 || h < 4) return;
          const fc = document.createElement('canvas');
          fc.width = faceSize; fc.height = faceSize;
          fc.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, faceSize, faceSize);
          p.avatar = fc.toDataURL('image/jpeg', 0.85);
          cropped++;
        });
        resolve();
      } catch(e) { resolve(); }
    };
    imgEl.onerror = () => resolve();
    imgEl.src = `data:${mime};base64,${b64}`;
  });
}

async function runSquadRead(b64, mime) {
  const loading = document.getElementById('squad-loading');
  if (loading) loading.style.display = 'block';
  try {
    const txt = await callClaude([{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
      { type: 'text', text: 'This is a Football Manager squad screen. List every visible OUTFIELD player only (exclude GK). Preserve ALL diacritical/special characters exactly. Also return face bounding boxes as percentages of image width/height. Respond ONLY with JSON array: [{"name":"Player Name","pos":"DEF","fx":12.5,"fy":8.2,"fw":4.1,"fh":5.8}]. Positions: DEF, MID, ATT only. GK positions: skip entirely.' },
    ]}], 1400);
    const players = JSON.parse(txt);
    if (Array.isArray(players) && players.length) {
      await cropFacesByBoundingBox(b64, mime, players);
      S.roster = players.map(p => ({ name: p.name, pos: p.pos || 'MID', avatar: p.avatar || null }));
      players.forEach(p => { if (p.avatar) saveAvatar(p.name, p.avatar); });
    }
    if (loading) loading.style.display = 'none';
    document.getElementById('sp-upload').style.display = 'none';
    document.getElementById('sp-roster').style.display = 'block';
    renderRoster();
  } catch(e) {
    if (loading) loading.style.display = 'none';
    alert('Could not read squad: ' + e.message + '. Try uploading again or enter manually.');
  }
}

async function runSquadRead2(b64, mime) {
  const loading = document.getElementById('squad2-loading');
  if (loading) loading.style.display = 'block';
  try {
    const txt = await callClaude([{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
      { type: 'text', text: 'This is a Football Manager squad screen. List every visible OUTFIELD player only. Do NOT include goalkeepers. Preserve ALL diacritical and special characters exactly. Respond ONLY with JSON array: [{"name":"Player Name","pos":"DEF"}]. Positions: DEF, MID, ATT only.' },
    ]}], 800);
    const newPlayers = JSON.parse(txt);
    const existingNames = S.roster.map(p => p.name.toLowerCase());
    S.roster = [...S.roster, ...newPlayers.filter(p => !existingNames.includes(p.name.toLowerCase()))];
    if (loading) loading.style.display = 'none';
    document.getElementById('second-screenshot').style.display = 'none';
    renderRoster();
  } catch(e) {
    if (loading) loading.style.display = 'none';
  }
}

// ── Go Live ───────────────────────────────────────────────────────────────────
function goLive() {
  const valid = S.roster.filter(p => p.name.trim());
  if (!valid.some(p => p.pos === 'DEF') || !valid.some(p => p.pos === 'MID') || !valid.some(p => p.pos === 'ATT')) {
    alert('You need at least one DEF, one MID, and one ATT.'); return;
  }
  S.roster = valid;
  showSessionTypeModal();
}

function showSessionTypeModal() { const m = document.getElementById('session-type-modal'); if (m) m.style.display = 'flex'; }
function hideSessionTypeModal() { const m = document.getElementById('session-type-modal'); if (m) m.style.display = 'none'; }
function showSeasonSetupModal() { hideSessionTypeModal(); const m = document.getElementById('season-setup-modal'); if (m) m.style.display = 'flex'; }
function hideSeasonSetupModal() { const m = document.getElementById('season-setup-modal'); if (m) m.style.display = 'none'; }

async function startOneOff() { hideSessionTypeModal(); await _goLive('oneoff'); }

async function startSeason() {
  const allowNewJoiners = document.getElementById('allow-new-joiners').checked;
  const transfersPerViewer = parseInt(document.getElementById('transfers-per-viewer').value, 10);
  if (isNaN(transfersPerViewer) || transfersPerViewer < 1) { alert('Transfers must be at least 1.'); return; }
  hideSeasonSetupModal();
  S.allowNewJoiners = allowNewJoiners;
  S.transfersPerViewer = transfersPerViewer;
  S.seasonEnd = null;
  await _goLive('season');
}

async function _goLive(type) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let sessionCode = 'FM-';
  for (let i = 0; i < 6; i++) sessionCode += chars[Math.floor(Math.random() * chars.length)];
  const jwt = lsGet('ffm_streamer_jwt');
  const sessionPayload = { id: sessionCode, user_jwt: jwt, type };
  if (type === 'season') {
    sessionPayload.season_end = S.seasonEnd;
    sessionPayload.allow_new_joiners = S.allowNewJoiners;
    sessionPayload.transfers_per_viewer = S.transfersPerViewer;
  }
  let sessionResult;
  try { sessionResult = await db('create_session', sessionPayload); } catch(e) { sessionResult = null; }
  if (sessionResult && sessionResult.message === 'JWT expired') { alert('Your session expired. Please log in again.'); streamerLogout(); return; }
  const sessionRow = Array.isArray(sessionResult) ? sessionResult[0] : sessionResult;
  if (!sessionRow || sessionRow.error || !sessionRow.id) {
    alert('Failed to create session. Please check your connection and try again.'); return;
  }
  S.sessionCode = sessionCode;
  S.isLive = true; S.type = type; S.events = []; S.viewers = {};
  lsSet('ffm_streamer_session', sessionCode);
  await db('save_roster', { session_id: S.sessionCode, players: S.roster });
  saveStreamerState();
  // Update UI
  document.getElementById('code-val').textContent = S.sessionCode;
  document.getElementById('session-pill').textContent = S.sessionCode;
  document.getElementById('live-pill').style.display = 'inline-flex';
  document.getElementById('sp-roster').style.display = 'none';
  document.getElementById('sp-done').style.display = 'block';
  document.getElementById('live-locked').style.display = 'none';
  document.getElementById('live-panel').style.display = 'block';
  document.getElementById('lg-empty').style.display = 'none';
  document.getElementById('lg-panel').style.display = 'block';
  const seasonBadge = document.getElementById('season-badge');
  const seasonSettingsBtn = document.getElementById('season-settings-btn');
  const endResetBtn = document.getElementById('end-reset-btn');
  if (seasonBadge) seasonBadge.style.display = type === 'season' ? 'inline-flex' : 'none';
  if (seasonSettingsBtn) seasonSettingsBtn.style.display = type === 'season' ? 'inline-flex' : 'none';
  if (endResetBtn) endResetBtn.textContent = type === 'season' ? 'End Season' : 'Reset session';
  renderScoring(); startPolling(); updateOverlayUrl(); loadLastMatch(); renderSquadManage();
  showChatCopyModal(S.sessionCode);
}

function showChatCopyModal(code) {
  const text = `Join my FantasyFM game at fantasyfm.io using my code: ${code}`;
  const el = document.getElementById('chat-copy-modal');
  const ta = document.getElementById('chat-copy-text');
  if (!el || !ta) return;
  ta.value = text;
  el.style.display = 'flex';
}
function closeChatCopyModal() { const el = document.getElementById('chat-copy-modal'); if (el) el.style.display = 'none'; }
function copyChatText() {
  const ta = document.getElementById('chat-copy-text');
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    const btn = document.getElementById('chat-copy-btn');
    if (btn) { btn.textContent = 'Copied! ✓'; setTimeout(() => btn.textContent = 'Copy to clipboard', 2000); }
  });
}

// ── Session reset / end ───────────────────────────────────────────────────────
async function handleEndOrReset() { await resetAll(); }

async function resetAll() {
  const msg = S.type === 'season' ? 'End this season? This will clear all scores, picks and viewers permanently.' : 'Reset session? All scores and viewers will be cleared.';
  if (!confirm(msg)) return;
  if (S.sessionCode) await db('reset_session', { session_id: S.sessionCode });
  stopAbly();
  clearStreamerState();
  document.getElementById('sp-upload').style.display = 'block';
  document.getElementById('sp-roster').style.display = 'none';
  document.getElementById('sp-done').style.display = 'none';
  document.getElementById('live-pill').style.display = 'none';
  document.getElementById('session-pill').textContent = '';
  document.getElementById('live-locked').style.display = 'block';
  document.getElementById('live-panel').style.display = 'none';
  document.getElementById('lg-empty').style.display = 'block';
  document.getElementById('lg-panel').style.display = 'none';
  document.getElementById('squad-preview').style.display = 'none';
  const seasonBadge = document.getElementById('season-badge');
  const seasonSettingsBtn = document.getElementById('season-settings-btn');
  if (seasonBadge) seasonBadge.style.display = 'none';
  if (seasonSettingsBtn) seasonSettingsBtn.style.display = 'none';
  const rp = document.getElementById('sp-rejoin');
  if (rp) rp.style.display = 'block';
}

// ── Scoring controls ──────────────────────────────────────────────────────────
function renderScoring() {
  const panel = document.getElementById('scoring-panel');
  if (!panel) return;
  panel.innerHTML = '';
  const cols = window.innerWidth >= 600 ? 3 : window.innerWidth >= 400 ? 2 : 1;
  panel.style.cssText = `display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:14px;`;
  const byPos = { DEF: [], MID: [], ATT: [] };
  S.roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  ['DEF', 'MID', 'ATT'].forEach(pos => {
    if (!byPos[pos].length) return;
    const sec = document.createElement('div');
    sec.className = 'pos-section';
    sec.innerHTML = `<div class="pos-heading">${PL[pos]}</div>`;
    byPos[pos].forEach(player => {
      const pts = getScore(player.name);
      const row = document.createElement('div');
      row.className = 'player-row';
      const btns = Object.entries(SC[pos]).map(([evt, p]) =>
        `<button class="evt-btn" onclick="logEvt('${player.name.replace(/'/g,"\\'")}','${pos}','${evt}',this)">${EL[evt]} <span class="evt-pts-hint">+${p}</span></button>`
      ).join('');
      const negBtns = `<button class="evt-btn evt-neg" onclick="logNeg('${player.name.replace(/'/g,"\\'")}','${pos}','yellow_card',-2,this)" title="Yellow card">🟨 <span class="evt-pts-hint">-2</span></button><button class="evt-btn evt-neg" onclick="logNeg('${player.name.replace(/'/g,"\\'")}','${pos}','red_card',-5,this)" title="Red card">🟥 <span class="evt-pts-hint">-5</span></button>`;
      const ratingBtn = `<button class="evt-btn rating-btn" onclick="logEvt('${player.name.replace(/'/g,"\\'")}','${pos}','rating',this)" title="Rating bonus">⭐ Rat</button>`;
      const editBtn = `<button class="evt-btn edit-btn" onclick="editScore('${player.name.replace(/'/g,"\\'")}','${pos}')" title="Edit score">✏️</button>`;
      row.innerHTML = `${posAvatar(pos, 28)}<span class="player-name-t">${player.name}</span>${btns}${negBtns}${ratingBtn}${editBtn}<span class="score-num${pts !== 0 ? ' has-pts' : ''}" id="sc-${sid(player.name)}" style="${pts < 0 ? 'color:var(--att)' : pts > 0 ? 'color:var(--accent)' : ''}">${pts}</span>`;
      sec.appendChild(row);
    });
    panel.appendChild(sec);
  });
}

const _logEvtInFlight = new Set();

async function logEvt(name, pos, evt, btnEl) {
  const key = name + '|' + evt;
  if (_logEvtInFlight.has(key)) return;
  _logEvtInFlight.add(key);
  if (btnEl) btnEl.disabled = true;
  const safeName = sanitise(name, 60);
  const safePos = ['DEF','MID','ATT'].includes(pos) ? pos : 'DEF';
  if (!SC[safePos] || !SC[safePos][evt]) { _logEvtInFlight.delete(key); if (btnEl) btnEl.disabled = false; return; }
  try {
    const result = await db('add_event', { session_id: S.sessionCode, player_name: safeName, pos: safePos, event_type: evt, points: SC[safePos][evt] });
    if (result && result.error) throw new Error(result.error);
    // BUG FIX: use DB timestamp, not Date.now()
    const eventRow = Array.isArray(result) ? result[0] : result;
    const evTs = eventRow && eventRow.created_at ? new Date(eventRow.created_at).getTime() : Date.now();
    S.events.push({ player: name, pos, eventType: evt, points: SC[safePos][evt], time: new Date(evTs).toLocaleTimeString(), ts: evTs });
    const el = document.getElementById('sc-' + sid(name));
    if (el) { const s = getScore(name); el.textContent = s; el.className = 'score-num' + (s !== 0 ? ' has-pts' : ''); }
    refreshLog(); refreshStats(); renderLeague();
    announceEvent(name, evt, SC[safePos][evt]);
  } catch(e) { alert('Failed to log event: ' + e.message); }
  finally { _logEvtInFlight.delete(key); if (btnEl) btnEl.disabled = false; }
}

async function logNeg(name, pos, evt, pts, btnEl) {
  const key = name + '|' + evt + '|neg';
  if (_logEvtInFlight.has(key)) return;
  _logEvtInFlight.add(key);
  if (btnEl) btnEl.disabled = true;
  const safeName = sanitise(name, 60);
  const safePos = ['DEF','MID','ATT'].includes(pos) ? pos : 'DEF';
  const safePts = Number(pts);
  if (!isFinite(safePts) || safePts > 0) { _logEvtInFlight.delete(key); if (btnEl) btnEl.disabled = false; return; }
  try {
    const result = await db('add_event', { session_id: S.sessionCode, player_name: safeName, pos: safePos, event_type: evt, points: safePts });
    if (result && result.error) throw new Error(result.error);
    const eventRow = Array.isArray(result) ? result[0] : result;
    const negTs = eventRow && eventRow.created_at ? new Date(eventRow.created_at).getTime() : Date.now();
    S.events.push({ player: name, pos, eventType: evt, points: safePts, time: new Date(negTs).toLocaleTimeString(), ts: negTs });
    const el = document.getElementById('sc-' + sid(name));
    if (el) { const s = getScore(name); el.textContent = s; el.className = 'score-num' + (s !== 0 ? ' has-pts' : ''); }
    refreshLog(); refreshStats(); renderLeague();
  } catch(e) { alert('Failed to log event: ' + e.message); }
  finally { _logEvtInFlight.delete(key); if (btnEl) btnEl.disabled = false; }
}

async function editScore(name, pos) {
  const current = getScore(name);
  const input = prompt(`Set total points for ${name} (current: ${current}):`, current);
  if (input === null) return;
  const target = parseInt(input);
  if (isNaN(target)) { alert('Please enter a number.'); return; }
  const diff = target - current;
  if (diff === 0) return;
  const safeName = sanitise(name, 60);
  const safePos = ['DEF','MID','ATT'].includes(pos) ? pos : 'DEF';
  const result = await db('add_event', { session_id: S.sessionCode, player_name: safeName, pos: safePos, event_type: 'manual_adjust', points: diff });
  const eventRow = Array.isArray(result) ? result[0] : result;
  const adjTs = eventRow && eventRow.created_at ? new Date(eventRow.created_at).getTime() : Date.now();
  S.events.push({ player: name, pos, eventType: 'manual_adjust', points: diff, time: new Date(adjTs).toLocaleTimeString(), ts: adjTs });
  renderScoring(); refreshLog(); refreshStats(); renderLeague(); renderInsights();
}

async function undoLast() {
  if (!S.events.length) return;
  await db('delete_last_event', { session_id: S.sessionCode });
  const last = S.events.pop();
  const el = document.getElementById('sc-' + sid(last.player));
  if (el) { const s = getScore(last.player); el.textContent = s; el.className = 'score-num' + (s !== 0 ? ' has-pts' : ''); }
  refreshLog(); refreshStats(); renderLeague();
}

// ── Entries lock ──────────────────────────────────────────────────────────────
async function toggleEntries() {
  const jwt = lsGet('ffm_streamer_jwt');
  if (!jwt || !S.sessionCode) return;
  const newLocked = !entriesLocked;
  await db('set_entries_locked', { session_id: S.sessionCode, is_entries_locked: newLocked, user_jwt: jwt });
  entriesLocked = newLocked;
  _applyEntriesToggleUI();
  lsSet('ffm_entries_locked', entriesLocked ? '1' : '0');
}

function _applyEntriesToggleUI() {
  const btn = document.getElementById('entries-toggle-btn');
  if (!btn) return;
  btn.textContent = entriesLocked ? t('entries_locked') : t('entries_open');
  btn.className = 'btn ' + (entriesLocked ? 'btn-locked' : 'btn-open');
}

// ── Match stats upload ────────────────────────────────────────────────────────
function doStatsUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  const allowed = ['image/png','image/jpeg','image/jpg','image/webp'];
  if (!allowed.includes(file.type)) { alert('Please upload a PNG, JPEG or WebP image.'); return; }
  if (file.size > 10*1024*1024) { alert('Image too large. Please use a screenshot under 10MB.'); return; }
  const reader = new FileReader();
  reader.onload = function(ev) {
    statsScreenB64 = ev.target.result.split(',')[1];
    statsScreenMime = file.type || 'image/png';
    document.getElementById('stats-img').src = ev.target.result;
    document.getElementById('stats-preview').style.display = 'block';
    updateReadBtn();
  };
  reader.readAsDataURL(file);
}

function updateReadBtn() {
  const btn = document.getElementById('read-stats-btn');
  if (!btn) return;
  const ready = !!statsScreenB64;
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '0.4';
}

let csToggle = false, motmToggle = false;

function toggleCS() {
  csToggle = !csToggle;
  const btn = document.getElementById('cs-toggle');
  if (btn) { btn.textContent = csToggle ? t('cs_on') : t('cs_off'); btn.className = 'btn ' + (csToggle ? 'btn-accent' : ''); }
}
function toggleMOTM() {
  motmToggle = !motmToggle;
  const btn = document.getElementById('motm-toggle');
  if (btn) { btn.className = 'btn ' + (motmToggle ? 'btn-accent' : ''); }
}

async function runBothReads() {
  if (!statsScreenB64) return;
  const btn = document.getElementById('read-stats-btn');
  if (btn) { btn.textContent = t('reading_stats'); btn.disabled = true; }
  try {
    const txt = await callClaude([{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: statsScreenMime, data: statsScreenB64 } },
      { type: 'text', text: `This is a Football Manager Player Stats screen. For each player visible extract: name, goals, assists, rating (decimal), time_played (minutes, 90 if played full match), motm (true/false if player of match icon). Preserve ALL special characters. Respond ONLY with JSON array: [{"name":"Player","goals":0,"assists":0,"rating":7.2,"time_played":90,"motm":false}]` },
    ]}], 1400);
    const rawPlayers = JSON.parse(txt);
    pendingMatch = buildMatchPreview(rawPlayers, S.roster, csToggle, motmToggle);
    pendingMatchResult = null;
    showMatchPreview();
    saveLastSubmission(statsScreenB64, statsScreenMime);
  } catch(e) {
    alert('Could not read stats: ' + e.message);
  } finally {
    if (btn) { btn.textContent = t('read_stats'); btn.disabled = false; updateReadBtn(); }
  }
}

function showMatchPreview() {
  const list = document.getElementById('match-events-list');
  const results = document.getElementById('match-results');
  if (!list || !results) return;
  if (!pendingMatch.length) { list.innerHTML = '<div class="empty-msg">No scoring events detected.</div>'; results.style.display = 'block'; return; }
  list.innerHTML = pendingMatch.map((ev, i) => {
    const pts = Number(ev.points);
    return `<div class="preview-event">
      <span class="badge b-${ev.pos}">${ev.pos}</span>
      <span class="preview-name">${ev.player}</span>
      <span class="preview-type">${EL[ev.eventType]}</span>
      <span class="preview-pts">${pts >= 0 ? '+' : ''}${pts}pts</span>
      <button class="remove-btn" onclick="removePendingEvent(${i})">✕</button>
    </div>`;
  }).join('');
  results.style.display = 'block';
}

function removePendingEvent(i) {
  pendingMatch.splice(i, 1);
  showMatchPreview();
}

async function applyMatch() {
  if (!S.sessionCode) { alert(t('err_no_session')); return; }
  if (!pendingMatch.length) { document.getElementById('match-results').style.display = 'none'; return; }
  const btn = document.querySelector('[onclick="applyMatch()"]');
  if (btn) { btn.textContent = 'Applying...'; btn.disabled = true; }
  try {
    const results = await Promise.all(pendingMatch.map(ev =>
      db('add_event', { session_id: S.sessionCode, player_name: ev.player, pos: ev.pos, event_type: ev.eventType, points: ev.points })
    ));
    // BUG FIX: use DB timestamps for all events
    results.forEach((res, i) => {
      const ev = pendingMatch[i];
      const eventRow = Array.isArray(res) ? res[0] : res;
      const evTs = eventRow && eventRow.created_at ? new Date(eventRow.created_at).getTime() : Date.now();
      S.events.push({ player: ev.player, pos: ev.pos, eventType: ev.eventType, points: Number(ev.points), time: new Date(evTs).toLocaleTimeString(), ts: evTs });
    });
    pendingMatch = []; pendingMatchResult = null;
    document.getElementById('match-results').style.display = 'none';
    renderScoring(); refreshLog(); refreshStats(); renderLeague(); renderInsights();
    announceMatchEnd();
    reloadFromDB().then(() => { renderScoring(); refreshLog(); refreshStats(); renderLeague(); renderInsights(); });
  } catch(e) {
    alert('Error applying points: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'Apply points'; btn.disabled = false; }
  }
}

function discardMatch() {
  pendingMatch = [];
  const results = document.getElementById('match-results');
  if (results) results.style.display = 'none';
}

// ── Season settings ───────────────────────────────────────────────────────────
function showSeasonSettingsModal() {
  const m = document.getElementById('season-settings-modal'); if (!m) return;
  document.getElementById('edit-season-end').value = S.seasonEnd ? S.seasonEnd.slice(0,16) : '';
  document.getElementById('edit-allow-new-joiners').checked = S.allowNewJoiners;
  document.getElementById('edit-transfers-per-viewer').value = S.transfersPerViewer;
  m.style.display = 'flex';
}
function hideSeasonSettingsModal() { const m = document.getElementById('season-settings-modal'); if (m) m.style.display = 'none'; }
async function saveSeasonSettings() {
  const allowNewJoiners = document.getElementById('edit-allow-new-joiners').checked;
  const transfersPerViewer = parseInt(document.getElementById('edit-transfers-per-viewer').value, 10);
  if (isNaN(transfersPerViewer) || transfersPerViewer < 1) { alert('Transfers must be at least 1.'); return; }
  await db('update_season_settings', { session_id: S.sessionCode, season_end: null, allow_new_joiners: allowNewJoiners, transfers_per_viewer: transfersPerViewer });
  S.allowNewJoiners = allowNewJoiners; S.transfersPerViewer = transfersPerViewer;
  hideSeasonSettingsModal();
}

// ── Add player to season ──────────────────────────────────────────────────────
function showAddPlayerPanel() {
  const existing = document.getElementById('season-add-player');
  if (existing) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'season-add-player'; panel.className = 'card';
  panel.innerHTML = `<div class="card-title">Add player to season squad</div>
    <div class="input-row">
      <input id="new-player-name" class="input-field" placeholder="Player name" style="flex:2">
      <select id="new-player-pos" class="input-field" style="flex:1">
        <option value="DEF">DEF</option><option value="MID">MID</option><option value="ATT">ATT</option>
      </select>
    </div>
    <div class="btn-row">
      <button class="btn btn-accent" onclick="addSeasonPlayer()">Add player</button>
      <button class="btn" onclick="document.getElementById('season-add-player').remove()">Cancel</button>
    </div>`;
  const scoringCard = document.getElementById('scoring-collapse');
  if (scoringCard && scoringCard.parentElement) scoringCard.parentElement.insertBefore(panel, scoringCard);
  else document.getElementById('live-panel').prepend(panel);
}

async function addSeasonPlayer() {
  const name = sanitise(document.getElementById('new-player-name').value.trim(), 60);
  const pos = document.getElementById('new-player-pos').value;
  if (!name) { alert('Please enter a player name.'); return; }
  if (S.roster.find(p => p.name.toLowerCase() === name.toLowerCase())) { alert('Player already in squad.'); return; }
  S.roster.push({ name, pos });
  await db('save_roster', { session_id: S.sessionCode, players: S.roster });
  document.getElementById('season-add-player')?.remove();
  renderScoring();
}

// ── Mod management ────────────────────────────────────────────────────────────
async function promoteMod(viewerName) {
  const jwt = lsGet('ffm_streamer_jwt');
  if (!jwt) { alert('Must be logged in as a streamer.'); return; }
  const res = await db('promote_mod', { session_id: S.sessionCode, viewer_name: sanitise(viewerName, 60), user_jwt: jwt });
  if (res && res.error) { alert('Could not promote: ' + res.error); return; }
  if (S.viewers[viewerName]) S.viewers[viewerName].isMod = true;
  renderViewerList();
}

async function demoteMod(viewerName) {
  const jwt = lsGet('ffm_streamer_jwt');
  if (!jwt) { alert('Must be logged in as a streamer.'); return; }
  const res = await db('demote_mod', { session_id: S.sessionCode, viewer_name: sanitise(viewerName, 60), user_jwt: jwt });
  if (res && res.error) { alert('Could not demote: ' + res.error); return; }
  if (S.viewers[viewerName]) S.viewers[viewerName].isMod = false;
  renderViewerList();
}

// ── Twitch chat ───────────────────────────────────────────────────────────────
function saveTwitchChannel() {
  const ch = document.getElementById('twitch-channel');
  if (ch) lsSet('ffm_twitch_channel', ch.value.trim().toLowerCase());
}
function loadTwitchChannel() {
  const saved = lsGet('ffm_twitch_channel', '');
  const el = document.getElementById('twitch-channel');
  if (saved && el) el.value = saved;
  return saved;
}
async function sendChatMessage(message) {
  const channel = loadTwitchChannel();
  if (!channel) return;
  try {
    await fetch('/.netlify/functions/twitch-chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ channel, message }) });
  } catch(e) {}
}
async function testChatBot() {
  const channel = loadTwitchChannel();
  const status = document.getElementById('chat-status');
  if (!channel) { if (status) status.textContent = 'Enter your channel name first.'; return; }
  if (status) status.textContent = 'Sending test message...';
  try {
    const r = await fetch('/.netlify/functions/twitch-chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ channel, message: '👋 FantasyFM bot is connected! Type !leaderboard to see the live standings.' }) });
    const data = await r.json();
    if (status) { status.textContent = data.ok ? '✓ Message sent!' : '✗ ' + (data.error || 'Failed'); status.style.color = data.ok ? 'var(--accent)' : 'var(--att)'; }
  } catch(e) {
    if (status) { status.textContent = '✗ Connection error'; status.style.color = 'var(--att)'; }
  }
}
async function announcePicks(vname, picks) {
  const cap = picks.CAP ? ` ⭐ Captain: ${picks.CAP}` : '';
  await sendChatMessage(`🎮 ${vname} locked in! DEF: ${picks.DEF||'—'} · MID: ${picks.MID||'—'} · ATT: ${picks.ATT||'—'}${cap}`);
}
async function announceEvent(playerName, eventType, points) {
  const labels = { goal: 'scores', assist: 'gets an assist', clean_sheet: 'keeps a clean sheet', motm: 'is Player of the Match', rating: 'earns a rating bonus' };
  const icons = { goal: '⚽', assist: '🅰️', clean_sheet: '🧤', motm: '⭐', rating: '📊' };
  const msg = `${icons[eventType]||'📌'} ${playerName} ${labels[eventType]||eventType}! (+${points}pts)`;
  await sendChatMessage(msg);
}
async function announceLeaderboard() {
  const lb = getLeaderboard().slice(0, 3);
  if (!lb.length) { await sendChatMessage('📊 No managers locked in yet! Join at fantasyfm.io'); return; }
  const top = lb.map((v, i) => `${['🥇','🥈','🥉'][i]} ${v.name} ${v.pts}pts`).join(' · ');
  await sendChatMessage(`📊 TOP 3: ${top} | fantasyfm.io`);
}
async function announceMatchEnd() {
  const lb = getLeaderboard();
  if (!lb.length) return;
  await sendChatMessage(`🏆 Match over! Top manager: ${lb[0].name} with ${lb[0].pts} points! Full leaderboard at fantasyfm.io`);
}

// ── Collapsible scoring ───────────────────────────────────────────────────────
function toggleScoring() {
  const col = document.getElementById('scoring-collapse');
  const chev = document.getElementById('scoring-chevron');
  const badge = document.getElementById('scoring-badge');
  const open = col.style.display === 'none';
  col.style.display = open ? 'block' : 'none';
  if (chev) chev.style.transform = open ? 'rotate(180deg)' : '';
  if (badge) badge.textContent = open ? 'Open' : 'Click to open';
}
function toggleAccessMgmt() {
  const body = document.getElementById('access-mgmt-body');
  const chevron = document.getElementById('access-mgmt-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
}

// ── File reading (image paste/upload) ────────────────────────────────────────
function readFileAs(file, type) {
  const reader = new FileReader();
  reader.onload = function(ev) {
    const b64 = ev.target.result.split(',')[1];
    const mime = file.type || 'image/png';
    if (type === 'squad') {
      document.getElementById('squad-img').src = ev.target.result;
      document.getElementById('squad-preview').style.display = 'block';
      runSquadRead(b64, mime);
    } else if (type === 'squad2') {
      runSquadRead2(b64, mime);
    } else if (type === 'stats' || type === 'match') {
      statsScreenB64 = b64; statsScreenMime = mime;
      document.getElementById('stats-img').src = ev.target.result;
      document.getElementById('stats-preview').style.display = 'block';
      updateReadBtn();
    }
  };
  reader.readAsDataURL(file);
}

function handleImagePaste(f, forceType) {
  if (!f) return;
  if (document.activeElement) document.activeElement.blur();
  if (forceType) { readFileAs(f, forceType); return; }
  const activeNav = document.querySelector('.nav-btn.active');
  const navId = activeNav ? activeNav.id : '';
  if (navId === 'nb-setup') {
    document.getElementById('sp-upload').style.display = 'block';
    document.getElementById('sp-roster').style.display = 'none';
    document.getElementById('sp-done').style.display = 'none';
    readFileAs(f, 'squad');
  } else if (navId === 'nb-live' && S.isLive) {
    readFileAs(f, 'stats');
  }
}

async function pasteFromClipboard(type) {
  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const file = new File([blob], 'screenshot.png', { type: imageType });
        handleImagePaste(file, type);
        return;
      }
    }
    alert('No image found in clipboard. Take a screenshot first, then click Paste.');
  } catch(err) {
    alert('Click here then press Ctrl+V / Cmd+V to paste your screenshot.');
  }
}

function doSquadUpload(e) {
  const file = e.target.files[0]; if (!file) return;
  readFileAs(file, 'squad');
}
function doSquadUpload2(e) {
  const file = e.target.files[0]; if (!file) return;
  readFileAs(file, 'squad2');
}

// Global paste listener
document.addEventListener('paste', function(e) {
  const items = Array.from((e.clipboardData || e.originalEvent.clipboardData).items);
  const imageItem = items.find(item => item.type.startsWith('image/'));
  if (!imageItem) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const isTextInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  const hasText = items.some(item => item.type === 'text/plain');
  if (isTextInput && hasText) return;
  const f = imageItem.getAsFile();
  if (!f) return;
  e.preventDefault();
  handleImagePaste(f, null);
});

document.addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    const tag = (e.target.tagName || '').toLowerCase();
    const isTextInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (isTextInput) return;
    const activeNav = document.querySelector('.nav-btn.active');
    const navId = activeNav ? activeNav.id : '';
    if (navId === 'nb-setup') { e.preventDefault(); pasteFromClipboard('squad'); }
    else if (navId === 'nb-live' && S.isLive) { e.preventDefault(); pasteFromClipboard('stats'); }
  }
});

window.entriesLocked = entriesLocked;
window.reloadFromDB = reloadFromDB;
window.restoreUI = restoreUI;
window.rejoinSession = rejoinSession;
window.showManual = showManual;
window.renderRoster = renderRoster;
window.setPos = setPos;
window.rmPlayer = rmPlayer;
window.addBlank = addBlank;
window.showSecondScreenshot = showSecondScreenshot;
window.goLive = goLive;
window.showSessionTypeModal = showSessionTypeModal;
window.hideSessionTypeModal = hideSessionTypeModal;
window.showSeasonSetupModal = showSeasonSetupModal;
window.hideSeasonSetupModal = hideSeasonSetupModal;
window.startOneOff = startOneOff;
window.startSeason = startSeason;
window.showChatCopyModal = showChatCopyModal;
window.closeChatCopyModal = closeChatCopyModal;
window.copyChatText = copyChatText;
window.handleEndOrReset = handleEndOrReset;
window.renderScoring = renderScoring;
window.logEvt = logEvt;
window.logNeg = logNeg;
window.editScore = editScore;
window.undoLast = undoLast;
window.toggleEntries = toggleEntries;
window._applyEntriesToggleUI = _applyEntriesToggleUI;
window.doStatsUpload = doStatsUpload;
window.updateReadBtn = updateReadBtn;
window.csToggle = csToggle;
window.motmToggle = motmToggle;
window.toggleCS = toggleCS;
window.toggleMOTM = toggleMOTM;
window.runBothReads = runBothReads;
window.showMatchPreview = showMatchPreview;
window.removePendingEvent = removePendingEvent;
window.applyMatch = applyMatch;
window.discardMatch = discardMatch;
window.showSeasonSettingsModal = showSeasonSettingsModal;
window.hideSeasonSettingsModal = hideSeasonSettingsModal;
window.saveSeasonSettings = saveSeasonSettings;
window.showAddPlayerPanel = showAddPlayerPanel;
window.addSeasonPlayer = addSeasonPlayer;
window.promoteMod = promoteMod;
window.demoteMod = demoteMod;
window.saveTwitchChannel = saveTwitchChannel;
window.loadTwitchChannel = loadTwitchChannel;
window.testChatBot = testChatBot;
window.announceLeaderboard = announceLeaderboard;
window.toggleScoring = toggleScoring;
window.toggleAccessMgmt = toggleAccessMgmt;
window.readFileAs = readFileAs;
window.handleImagePaste = handleImagePaste;
window.pasteFromClipboard = pasteFromClipboard;
window.doSquadUpload = doSquadUpload;
window.doSquadUpload2 = doSquadUpload2;

// ── HTML compatibility aliases ─────────────────────────────────────────────────
// These match the onclick="..." attribute names used in index.html

// readStats() → runBothReads()
window.readStats = runBothReads;

// toggleEntriesLock() → toggleEntries()
window.toggleEntriesLock = toggleEntries;

// sendTestMessage() → testChatBot()
window.sendTestMessage = testChatBot;

// applyPendingMatch() → applyMatch()
window.applyPendingMatch = applyMatch;

// discardPending() → discardMatch()
window.discardPending = discardMatch;

// setCS(bool) - set clean sheet to specific value
window.setCS = function(val) {
  csToggle = !!val;
  const yesBtn = document.getElementById('cs-yes-btn');
  const noBtn = document.getElementById('cs-no-btn');
  if (yesBtn) yesBtn.className = 'btn btn-sm' + (val ? ' btn-accent' : '');
  if (noBtn) noBtn.className = 'btn btn-sm' + (!val ? ' btn-accent' : '');
};

// setMOTM(bool) - set MOTM to specific value
window.setMOTM = function(val) {
  motmToggle = !!val;
  const yesBtn = document.getElementById('motm-yes-btn');
  const noBtn = document.getElementById('motm-no-btn');
  if (yesBtn) yesBtn.className = 'btn btn-sm' + (val ? ' btn-accent' : '');
  if (noBtn) noBtn.className = 'btn btn-sm' + (!val ? ' btn-accent' : '');
};

// updateSquadTab - show/hide season-specific controls
window.updateSquadTab = function() {
  const addBtn = document.getElementById('season-add-btn');
  const squadSection = document.getElementById('season-squad-section');
  if (addBtn) addBtn.style.display = S.isLive && S.type === 'season' ? 'inline-flex' : 'none';
  if (squadSection) squadSection.style.display = S.isLive && S.type === 'season' ? 'block' : 'none';
  if (S.isLive && S.type === 'season') renderSquadManage();
};

// switchOAuthAccount() is viewerSwitchAccount() from viewer.js
window.switchOAuthAccount = function() { if (typeof viewerSwitchAccount === 'function') viewerSwitchAccount(); };

// viewerChangeSession
window.viewerChangeSession = function() {
  lsRemove('ffm_last_viewer_code');
  const vcodeEl = document.getElementById('vcode');
  if (vcodeEl) vcodeEl.value = '';
  const changeRow = document.getElementById('change-session-row');
  if (changeRow) changeRow.style.display = 'none';
};
