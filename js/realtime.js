// ─── realtime.js ──────────────────────────────────────────────────────────────
// Ably real-time subscription with 15s polling fallback.

let ablyClient = null;
let ablyChannel = null;
let pollInterval = null;
let bgSyncInterval = null;
let _ablySessionCode = null; // track which session Ably is connected to

function applyViewerFromAbly(v) {
  if (!v || !v.viewer_name) return;
  S.viewers[v.viewer_name] = {
    picks: { DEF: v.pick_def || null, MID: v.pick_mid || null, ATT: v.pick_att || null, CAP: v.pick_cap || null },
    locked: v.locked,
    platform: v.platform || 'manual',
    oauthId: v.oauth_id || null,
    // BUG FIX: always convert to ms
    lockedAtTs: typeof v.events_at_lock === 'string'
      ? new Date(v.events_at_lock).getTime()
      : (v.events_at_lock || 0),
    transfersUsed: v.transfers_used || 0,
    isMod: v.is_mod || false,
    bankedPoints: v.banked_points || 0,
  };
}

function rerender() {
  renderScoring();
  refreshLog();
  refreshStats();
  renderLeague();
  renderInsights();
  renderViewerList();
  // Refresh viewer dash if visible
  const vdash = document.getElementById('vp-dash');
  if (vdash && vdash.style.display !== 'none') {
    const vname = vdash.dataset.viewer;
    if (vname) showDash(vname, false);
  }
}

function startAbly() {
  if (!S.sessionCode) return;
  if (_ablySessionCode === S.sessionCode && ablyClient) return; // already connected
  stopAbly();
  _ablySessionCode = S.sessionCode;

  if (typeof Ably === 'undefined') {
    console.warn('Ably SDK not loaded — polling fallback');
    startPollingFallback();
    return;
  }

  try {
    ablyClient = new Ably.Realtime({
      authCallback: async (tokenParams, callback) => {
        try {
          const jwt = lsGet('ffm_streamer_jwt');
          const headers = { 'Content-Type': 'application/json' };
          if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
          const r = await fetch('/.netlify/functions/claude', {
            method: 'POST', headers,
            body: JSON.stringify({ action: 'ably_token', payload: { session_id: S.sessionCode } }),
          });
          const token = await r.json();
          if (token.error) { callback(token.error, null); return; }
          callback(null, token);
        } catch(e) { callback(e.message, null); }
      },
    });

    ablyClient.connection.on('failed', () => {
      console.warn('Ably failed — polling fallback');
      stopAbly();
      startPollingFallback();
    });

    const channelName = 'ffm-' + S.sessionCode;
    ablyChannel = ablyClient.channels.get(channelName);

    // Background sync every 60s to catch anything missed
    bgSyncInterval = setInterval(async () => {
      if (!S.sessionCode) { clearInterval(bgSyncInterval); return; }
      await reloadFromDB();
      rerender();
    }, 60000);

    ablyChannel.subscribe('state_changed', async (msg) => {
      if (!S.sessionCode) return;
      const d = msg.data || {};
      if (d.type === 'viewer') {
        if (d.viewer) applyViewerFromAbly(d.viewer);
        rerender();
      } else if (d.type === 'event') {
        if (d.event) {
          const evTs = new Date(d.event.created_at).getTime();
          const alreadyHave = S.events.some(e =>
            e.player === d.event.player_name &&
            e.eventType === d.event.event_type &&
            Math.abs(e.ts - evTs) < 5000
          );
          if (!alreadyHave) {
            S.events.push({
              player: d.event.player_name, pos: d.event.pos,
              eventType: d.event.event_type, points: Number(d.event.points),
              time: new Date(d.event.created_at).toLocaleTimeString(),
              ts: evTs,
            });
          }
        }
        rerender();
      } else if (d.type === 'event_deleted') {
        if (S.events.length > 0) S.events.pop();
        rerender();
      } else if (d.type === 'transfer') {
        if (d.viewer) applyViewerFromAbly(d.viewer);
        if (d.transfer) {
          const { oauth_id, pos, player_name, transferred_at } = d.transfer;
          if (!S.transferLog[oauth_id]) S.transferLog[oauth_id] = {};
          const posKey = pos.replace('pick_', '').toUpperCase();
          const ts = new Date(transferred_at).getTime();
          if (!S.transferLog[oauth_id][posKey]) S.transferLog[oauth_id][posKey] = [];
          S.transferLog[oauth_id][posKey].push({ player: player_name, ts, isOutgoing: false });
          S.transferLog[oauth_id][posKey].sort((a, b) => a.ts - b.ts);
        }
        rerender();
      } else if (d.type === 'entries_lock') {
        entriesLocked = !!d.locked;
        _applyEntriesToggleUI();
        lsSet('ffm_entries_locked', entriesLocked ? '1' : '0');
      } else if (d.type === 'season_settings') {
        if (d.season_end !== undefined) S.seasonEnd = d.season_end;
        if (d.allow_new_joiners !== undefined) S.allowNewJoiners = d.allow_new_joiners;
        if (d.transfers_per_viewer !== undefined) S.transfersPerViewer = d.transfers_per_viewer;
      } else if (d.type === 'mod_promoted' || d.type === 'mod_demoted') {
        if (d.viewer_name && S.viewers[d.viewer_name]) {
          S.viewers[d.viewer_name].isMod = (d.type === 'mod_promoted');
        }
        if (oauthUser && d.viewer_name === oauthUser.username) {
          const shouldBeMod = d.type === 'mod_promoted';
          if (shouldBeMod && uiMode !== 'mod') setUIMode('mod');
          else if (!shouldBeMod && uiMode === 'mod') setUIMode('viewer');
        }
        rerender();
      } else {
        await reloadFromDB();
        rerender();
      }
    });

  } catch(e) {
    console.warn('Ably init error — polling fallback', e);
    startPollingFallback();
  }
}

function stopAbly() {
  if (bgSyncInterval) { clearInterval(bgSyncInterval); bgSyncInterval = null; }
  if (ablyChannel) { try { ablyChannel.unsubscribe(); } catch(e) {} ablyChannel = null; }
  if (ablyClient) { try { ablyClient.close(); } catch(e) {} ablyClient = null; }
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  _ablySessionCode = null;
}

function startPollingFallback() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    if (!S.sessionCode) return;
    await reloadFromDB();
    rerender();
  }, 15000);
}

// Legacy alias
function startPolling() { startAbly(); }

window.startAbly = startAbly;
window.stopAbly = stopAbly;
window.startPollingFallback = startPollingFallback;
window.startPolling = startPolling;
window.applyViewerFromAbly = applyViewerFromAbly;
window.rerender = rerender;
