// ─── viewer.js ────────────────────────────────────────────────────────────────
// Viewer join flow, player picker, dashboard, and transfer UI.
// ALL v1 bugs fixed:
//   - V (viewer state) is completely separate from S (streamer state)
//   - joinGame() never touches S.sessionCode
//   - lockedAtTs always in ms
//   - Captain scoring is correct

let _joinAttempts = 0, _joinBlock = 0;

// ── Join ──────────────────────────────────────────────────────────────────────
async function joinGame() {
  const err = document.getElementById('vjoin-err');
  if (Date.now() < _joinBlock) {
    const secs = Math.ceil((_joinBlock - Date.now()) / 1000);
    err.style.display = 'block'; err.textContent = `Too many attempts. Wait ${secs}s.`; return;
  }
  if (!oauthUser) { err.style.display = 'block'; err.textContent = t('err_signin'); return; }
  const name = sanitise(oauthUser.username, 40);
  const code = sanitise(document.getElementById('vcode').value.trim().toUpperCase(), 12);
  if (!code) { err.style.display = 'block'; err.textContent = t('err_code'); return; }

  err.style.display = 'none';

  let session;
  try { session = await db('get_session', { session_id: code }); }
  catch(e) { err.style.display='block'; err.textContent='Connection error. Try again.'; return; }

  // BUG FIX: allow season sessions even when not live
  const sessionValid = session && (session.is_live || session.type === 'season');
  if (!sessionValid) {
    _joinAttempts++;
    if (_joinAttempts >= 5) { _joinBlock = Date.now() + 60000; _joinAttempts = 0; }
    err.style.display = 'block'; err.textContent = t('err_not_found'); return;
  }
  _joinAttempts = 0;

  // BUG FIX: store in V, NEVER in S
  V.viewerSessionCode = code;
  V.type = session.type || 'oneoff';
  V.allowNewJoiners = session.allow_new_joiners !== undefined ? session.allow_new_joiners : true;
  V.transfersPerViewer = session.transfers_per_viewer || 3;

  lsSet('ffm_last_viewer_code', code);

  let roster, events, viewers;
  try {
    [roster, events, viewers] = await Promise.all([
      db('get_roster', { session_id: code }),
      db('get_events', { session_id: code }),
      db('get_viewers', { session_id: code }),
    ]);
  } catch(e) {
    // BUG FIX: on failure only clear viewer code, never touch S
    V.viewerSessionCode = null;
    err.style.display = 'block'; err.textContent = 'Failed to load session data.'; return;
  }

  V.roster = Array.isArray(roster) ? roster.map(p => ({ name: p.name, pos: p.pos })) : [];
  V.events = Array.isArray(events) ? events.map(e => ({
    player: e.player_name, pos: e.pos, eventType: e.event_type, points: Number(e.points),
    time: new Date(e.created_at).toLocaleTimeString(),
    ts: new Date(e.created_at).getTime(), // always ms
  })) : [];
  V.viewers = {};
  if (Array.isArray(viewers)) {
    viewers.forEach(v => {
      V.viewers[v.viewer_name] = {
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

  // Check entries lock for new viewers
  if (session.is_entries_locked && !V.viewers[name]) {
    // BUG FIX: only clear viewer code, don't touch S
    V.viewerSessionCode = null;
    err.style.display = 'block'; err.textContent = t('err_entries_locked'); return;
  }
  // Check season new joiners
  if (V.type === 'season' && !V.allowNewJoiners && !V.viewers[name]?.locked) {
    V.viewerSessionCode = null;
    err.style.display = 'block'; err.textContent = 'This season is not accepting new players.'; return;
  }

  // Create viewer entry if new
  if (!V.viewers[name]) V.viewers[name] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: false, transfersUsed: 0, bankedPoints: 0, lockedAtTs: 0 };

  // Restore locally saved picks
  try {
    const savedPicks = lsGetJson('ffm_viewer_picks_' + name);
    if (savedPicks && !V.viewers[name].locked) Object.assign(V.viewers[name].picks, savedPicks);
  } catch(e) {}

  // Also update S.viewers for streamer context (if same streamer is also a viewer)
  // But NEVER overwrite S.sessionCode
  if (!checkStreamerAuth() || !lsGet('ffm_streamer_session')) {
    // Pure viewer mode - safe to sync S for leaderboard tab
    S.viewers = V.viewers;
    S.roster = V.roster;
    S.events = V.events;
  }

  const myData = V.viewers[name];
  setUIMode(myData && myData.isMod ? 'mod' : 'viewer');

  if (V.viewers[name].locked) showDash(name);
  else showPicker(name);

  startViewerPolling(code);
}

// ── Viewer Ably/Polling (separate from streamer) ──────────────────────────────
let viewerPollInterval = null;

function startViewerPolling(code) {
  if (viewerPollInterval) clearInterval(viewerPollInterval);
  viewerPollInterval = setInterval(async () => {
    if (!V.viewerSessionCode) { clearInterval(viewerPollInterval); return; }
    try {
      const [events, viewers] = await Promise.all([
        db('get_events', { session_id: V.viewerSessionCode }),
        db('get_viewers', { session_id: V.viewerSessionCode }),
      ]);
      if (Array.isArray(events)) {
        V.events = events.map(e => ({
          player: e.player_name, pos: e.pos, eventType: e.event_type, points: Number(e.points),
          time: new Date(e.created_at).toLocaleTimeString(), ts: new Date(e.created_at).getTime(),
        }));
      }
      if (Array.isArray(viewers)) {
        viewers.forEach(v => {
          V.viewers[v.viewer_name] = {
            picks: { DEF: v.pick_def||null, MID: v.pick_mid||null, ATT: v.pick_att||null, CAP: v.pick_cap||null },
            locked: v.locked, platform: v.platform||'manual', oauthId: v.oauth_id||null,
            lockedAtTs: typeof v.events_at_lock === 'string' ? new Date(v.events_at_lock).getTime() : (v.events_at_lock||0),
            transfersUsed: v.transfers_used||0, isMod: v.is_mod||false, bankedPoints: v.banked_points||0,
          };
        });
      }
      // Refresh dash if showing
      const vdash = document.getElementById('vp-dash');
      if (vdash && vdash.style.display !== 'none') {
        const vname = vdash.dataset.viewer;
        if (vname) showDash(vname, false);
      }
      // Refresh leaderboard
      renderLeague();
    } catch(e) {}
  }, 15000);
}

// ── Picker ────────────────────────────────────────────────────────────────────
function showPicker(vname) {
  document.getElementById('vp-join').style.display = 'none';
  document.getElementById('vp-dash').style.display = 'none';
  const panel = document.getElementById('vp-picker');
  panel.style.display = 'block';

  if (!V.viewers[vname]) V.viewers[vname] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: false };
  const viewer = V.viewers[vname];
  if (!viewer.picks) viewer.picks = { DEF: null, MID: null, ATT: null, CAP: null };

  // Restore picks from localStorage
  try {
    const saved = lsGetJson('ffm_viewer_picks_' + vname);
    if (saved) Object.assign(viewer.picks, saved);
  } catch(e) {}

  const byPos = { DEF: [], MID: [], ATT: [] };
  V.roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  const posQ = { DEF: 'Pick your defender', MID: 'Pick your midfielder', ATT: 'Pick your attacker' };
  let html = `<div class="picker-title">${t('pick_title')}, ${vname}</div>
    <div class="picker-sub">${t('pick_sub')}</div>`;

  ['DEF', 'MID', 'ATT'].forEach(pos => {
    html += `<div class="pos-section"><div class="pos-heading">${posQ[pos]}</div>`;
    byPos[pos].forEach(p => {
      const sel = viewer.picks[pos] === p.name;
      const safeName = p.name.replace(/'/g, "\\'");
      html += `<div class="pick-row ${sel ? 'sel' : ''}" onclick="pickPlayer('${vname}','${pos}','${safeName}')">
        <span class="badge b-${pos}">${pos}</span>
        <span class="pick-name">${p.name}</span>
        ${sel ? '<span class="pick-check">✓</span>' : ''}
      </div>`;
    });
    html += '</div>';
  });

  // Captain — must be different to DEF/MID/ATT picks
  html += `<div class="pos-section cap-section">
    <div class="pos-heading cap-heading">⭐ Pick your captain (2× points)</div>
    <div class="cap-sub">Must be a different player to your DEF, MID and ATT picks</div>`;
  V.roster.forEach(p => {
    const sel = viewer.picks.CAP === p.name;
    const safeName = p.name.replace(/'/g, "\\'");
    html += `<div class="pick-row cap-row ${sel ? 'sel-cap' : ''}" onclick="pickPlayer('${vname}','CAP','${safeName}')">
      <span class="badge b-${p.pos}">${p.pos}</span>
      <span class="pick-name">${p.name}</span>
      ${sel ? '<span class="cap-star-check">★</span>' : ''}
    </div>`;
  });
  html += '</div>';

  const picks = viewer.picks;
  const capIsUnique = picks.CAP && picks.CAP !== picks.DEF && picks.CAP !== picks.MID && picks.CAP !== picks.ATT;
  const allPicked = picks.DEF && picks.MID && picks.ATT && capIsUnique;
  html += `<button class="btn ${allPicked ? 'btn-accent' : ''}" onclick="lockPicks('${vname}')" ${allPicked ? '' : 'disabled'} style="${allPicked ? '' : 'opacity:0.35;cursor:not-allowed'}">${allPicked ? t('lock_btn') : t('lock_wait')}</button>`;
  panel.innerHTML = html;
}

function pickPlayer(vname, pos, pname) {
  if (!V.viewers[vname]) V.viewers[vname] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: false };
  const picks = V.viewers[vname].picks;
  if (pos === 'CAP') {
    picks.CAP = pname;
  } else {
    if (picks[pos] && picks.CAP === picks[pos]) picks.CAP = null;
    picks[pos] = pname;
  }
  try { lsSetJson('ffm_viewer_picks_' + vname, picks); } catch(e) {}
  showPicker(vname);
}

async function lockPicks(vname) {
  if (!V.viewers[vname]) V.viewers[vname] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: false };
  V.viewers[vname].locked = true;
  // Use max DB-sourced event ts (never Date.now()) to stay in DB clock space
  const lastEventTs = V.events.length ? Math.max(...V.events.map(e => e.ts || 0)) : 0;
  V.viewers[vname].lockedAtTs = lastEventTs;
  const v = V.viewers[vname];
  showDash(vname);
  // Save to DB in background
  const sessionCode = V.viewerSessionCode;
  db('upsert_viewer', {
    session_id: sessionCode,
    viewer_name: vname,
    pick_def: v.picks.DEF,
    pick_mid: v.picks.MID,
    pick_att: v.picks.ATT,
    pick_cap: v.picks.CAP || null,
    events_at_lock: lastEventTs,
    locked: true,
    platform: oauthUser ? oauthUser.platform : 'manual',
    oauth_id: oauthUser ? oauthUser.oauthId : null,
    avatar_url: oauthUser ? oauthUser.avatar : null,
  }).then(() => {
    try { lsRemove('ffm_viewer_picks_' + vname); } catch(e) {}
    announcePicks(vname, v.picks);
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function showDash(vname, updateDataset = true) {
  document.getElementById('vp-join').style.display = 'none';
  document.getElementById('vp-picker').style.display = 'none';
  const panel = document.getElementById('vp-dash');
  panel.style.display = 'block';
  if (updateDataset) panel.dataset.viewer = vname;

  if (!V.viewers[vname]) V.viewers[vname] = { picks: { DEF: null, MID: null, ATT: null, CAP: null }, locked: true };
  const v = V.viewers[vname];

  // Restore picks from localStorage if missing
  if (!v.picks || (!v.picks.DEF && !v.picks.MID && !v.picks.ATT)) {
    try { const saved = lsGetJson('ffm_viewer_picks_' + vname); if (saved) v.picks = saved; } catch(e) {}
  }
  const picks = v.picks || { DEF: null, MID: null, ATT: null, CAP: null };
  const total = getViewerScore(vname, V.viewers, V.events);
  const lb = getLeaderboard(V.viewers, V.events);
  const rank = lb.findIndex(x => x.name === vname) + 1;
  const posN = { DEF: 'Defender', MID: 'Midfielder', ATT: 'Attacker' };
  const fromTs = v.lockedAtTs || 0;

  let html = `<div class="dash-header">
    <div>
      <div class="dash-title">${vname}'s squad</div>
      <div class="dash-rank">${rank > 0 ? 'Rank #' + rank + ' of ' + lb.length : '—'}</div>
    </div>
    <div class="dash-score-wrap">
      <div class="viewer-dash-total">${total}</div>
      <div class="dash-pts-lbl">pts</div>
    </div>
  </div>`;

  ['DEF', 'MID', 'ATT'].forEach(pos => {
    const pname = picks[pos];
    const pts = pname ? getScore(pname, fromTs, V.events) : 0;
    const isCap = pname && picks.CAP === pname;
    html += `<div class="player-row">
      <span class="badge b-${pos}">${posN[pos]}</span>
      <span class="player-name-t">${pname || '—'}${isCap ? '<span class="cap-star-inline">★ CAP</span>' : ''}</span>
      <span class="score-num${pts > 0 ? ' has-pts' : ''}">${isCap ? pts * 2 : pts}</span>
      ${isCap ? '<span class="cap-mult">×2</span>' : ''}
    </div>`;
  });

  // 4th captain (not one of the positional picks)
  if (picks.CAP && picks.CAP !== picks.DEF && picks.CAP !== picks.MID && picks.CAP !== picks.ATT) {
    const capPts = getScore(picks.CAP, fromTs, V.events);
    html += `<div class="player-row cap4-row">
      <span class="badge cap-badge">CAP</span>
      <span class="player-name-t">${picks.CAP} <span class="cap-star-inline">★</span></span>
      <span class="score-num${capPts > 0 ? ' has-pts' : ''}">${capPts * 2}</span>
    </div>`;
  }

  if (v.bankedPoints > 0) {
    html += `<div class="banked-row"><span class="banked-label">Banked from previous picks</span><span class="banked-pts">+${v.bankedPoints}</span></div>`;
  }

  html += `<button class="btn switch-btn" onclick="viewerSwitchAccount()">Switch account</button>`;

  // Transfers (season mode)
  if (V.type === 'season' && v.locked) {
    html += renderTransferUI(vname);
  }

  panel.innerHTML = html;
}

function renderTransferUI(vname) {
  const v = V.viewers[vname];
  if (!v) return '';
  const used = v.transfersUsed || 0;
  const remaining = V.transfersPerViewer - used;
  if (remaining <= 0) return `<div class="transfer-section"><div class="transfer-title">Transfers</div><div class="transfer-empty">No transfers remaining.</div></div>`;
  const byPos = { DEF: [], MID: [], ATT: [] };
  V.roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  const posKeys = ['DEF', 'MID', 'ATT', 'CAP'];
  let html = `<div class="transfer-section">
    <div class="transfer-title">Transfers <span class="transfer-remaining">${remaining} remaining</span></div>
    <div class="transfer-fields">`;
  posKeys.forEach(pos => {
    const current = v.picks[pos] || '—';
    const roster = pos === 'CAP' ? V.roster : (byPos[pos] || []);
    html += `<div class="transfer-field">
      <label class="transfer-label">${pos}</label>
      <select id="transfer-${pos}" class="input-field">
        <option value="${current}">${current} (current)</option>
        ${roster.filter(p => p.name !== current).map(p => `<option value="${p.name}">${p.name}</option>`).join('')}
      </select>
    </div>`;
  });
  html += `</div>
    <button class="btn btn-accent" onclick="submitTransfers('${vname}')">Save transfers</button>
  </div>`;
  return html;
}

// BUG FIX: Full transfer implementation with correct scoring
async function submitTransfers(vname) {
  const v = V.viewers[vname];
  if (!v) return;
  if (!oauthUser) { alert('Please sign in with Twitch or YouTube.'); return; }

  const newPicks = {
    DEF: document.getElementById('transfer-DEF')?.value || v.picks.DEF,
    MID: document.getElementById('transfer-MID')?.value || v.picks.MID,
    ATT: document.getElementById('transfer-ATT')?.value || v.picks.ATT,
    CAP: document.getElementById('transfer-CAP')?.value || v.picks.CAP,
  };

  // Validate: CAP must not match positional picks
  if ([newPicks.DEF, newPicks.MID, newPicks.ATT].includes(newPicks.CAP)) {
    alert('Your captain must be a different player to your Defender, Midfielder and Attacker.'); return;
  }

  const posKeys = ['DEF', 'MID', 'ATT', 'CAP'];
  const changes = [];
  for (const pos of posKeys) {
    const el = document.getElementById('transfer-' + pos);
    if (el && el.value && el.value !== v.picks[pos]) {
      changes.push({ pos: 'pick_' + pos.toLowerCase(), newPlayer: el.value, displayPos: pos });
    }
  }
  if (!changes.length) { alert('No changes detected.'); return; }

  const used = v.transfersUsed || 0;
  const remaining = V.transfersPerViewer - used;
  if (changes.length > remaining) {
    alert(`You only have ${remaining} transfer(s) remaining but made ${changes.length} change(s).`); return;
  }

  for (const { pos, newPlayer, displayPos } of changes) {
    // BUG FIX: score calculated BEFORE changing picks, using current lockedAtTs
    const scoreNow = getViewerScore(vname, V.viewers, V.events);
    const res = await db('use_transfer', {
      session_id: V.viewerSessionCode,
      oauth_id: oauthUser.oauthId,
      pos,
      new_player: newPlayer,
      current_score: scoreNow,
    });
    if (res && res.error) { alert('Transfer failed: ' + res.error); return; }
    // BUG FIX: update local state correctly
    v.picks[displayPos] = newPlayer;
    v.transfersUsed = (v.transfersUsed || 0) + 1;
    v.bankedPoints = scoreNow;
    // BUG FIX: always convert events_at_lock to ms
    if (res && res.events_at_lock !== undefined) {
      v.lockedAtTs = typeof res.events_at_lock === 'string'
        ? new Date(res.events_at_lock).getTime()
        : res.events_at_lock;
    } else {
      // Fallback: use current latest event ts from V.events
      v.lockedAtTs = V.events.length ? Math.max(...V.events.map(e => e.ts || 0)) : Date.now();
    }
  }
  showDash(vname);
}

function viewerSwitchAccount() {
  lsRemove('ffm_last_viewer_code');
  V.viewerSessionCode = null;
  V.viewers = {};
  V.events = [];
  V.roster = [];
  if (viewerPollInterval) { clearInterval(viewerPollInterval); viewerPollInterval = null; }
  document.getElementById('vp-join').style.display = 'block';
  document.getElementById('vp-picker').style.display = 'none';
  document.getElementById('vp-picker').innerHTML = '';
  document.getElementById('vp-dash').style.display = 'none';
  document.getElementById('vp-dash').innerHTML = '';
  const vcodeEl = document.getElementById('vcode');
  if (vcodeEl) { vcodeEl.value = ''; vcodeEl.focus(); }
  const err = document.getElementById('vjoin-err');
  if (err) err.style.display = 'none';
  setUIMode('viewer');
  goTab('viewer', document.getElementById('nb-viewer'));
}

// ── Auto-rejoin ───────────────────────────────────────────────────────────────
async function autoRejoinViewer() {
  try {
    const savedOAuth = lsGetJson('ffm_oauth');
    if (!savedOAuth) return;
    const savedCode = lsGet('ffm_last_viewer_code');
    if (!savedCode) return;
    const vcodeEl = document.getElementById('vcode');
    if (vcodeEl) vcodeEl.value = savedCode;
    if (!oauthUser) { oauthUser = savedOAuth; renderOAuthUser(); }
    await joinGame();
  } catch(e) {}
}

window.joinGame = joinGame;
window.showPicker = showPicker;
window.pickPlayer = pickPlayer;
window.lockPicks = lockPicks;
window.showDash = showDash;
window.renderTransferUI = renderTransferUI;
window.submitTransfers = submitTransfers;
window.viewerSwitchAccount = viewerSwitchAccount;
window.autoRejoinViewer = autoRejoinViewer;
