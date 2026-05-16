// ─── ui.js ────────────────────────────────────────────────────────────────────
// DOM rendering helpers: leaderboard, event log, scoring cards, insights, etc.

// ── Position avatar ──────────────────────────────────────────────────────────
function posAvatar(pos, size = 28) {
  const colours = { DEF: '#4a9eff', MID: '#f5a623', ATT: '#ff5a5a' };
  const bg = colours[pos] || '#3a3e52';
  const s = Math.round(size * 0.55);
  return `<span class="pos-avatar" style="width:${size}px;height:${size}px;background:${bg}"><svg width="${s}" height="${s}" viewBox="0 0 20 20" fill="rgba(255,255,255,0.9)" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="6" r="4"/><path d="M2 18c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg></span>`;
}

function platBadge(platform) {
  if (platform === 'twitch') return '<span class="plat-badge tw">TW</span>';
  if (platform === 'youtube') return '<span class="plat-badge yt">YT</span>';
  return '';
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderLeague() {
  const lgEmpty = document.getElementById('lg-empty');
  const lgPanel = document.getElementById('lg-panel');
  const useViewerCtx = !S.isLive && V.viewerSessionCode;
  const viewers = useViewerCtx ? V.viewers : S.viewers;
  const events = useViewerCtx ? V.events : S.events;
  const roster = useViewerCtx ? V.roster : S.roster;

  if (!S.sessionCode && !V.viewerSessionCode) {
    if (lgEmpty) lgEmpty.style.display = 'block';
    if (lgPanel) lgPanel.style.display = 'none';
    return;
  }
  if (lgEmpty) lgEmpty.style.display = 'none';
  if (lgPanel) lgPanel.style.display = 'block';

  const lb = getLeaderboard(viewers, events);

  // Manager Table
  const list = document.getElementById('lg-list');
  if (list) {
    if (!lb.length) {
      list.innerHTML = '<div class="empty-msg">No managers have locked picks yet.</div>';
    } else {
      list.innerHTML = lb.map((v) => {
        const rank = lb.filter(x => x.pts > v.pts).length + 1;
        const rCls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
        const picks = [v.picks.DEF, v.picks.MID, v.picks.ATT].filter(Boolean).join(' · ');
        const capDisplay = v.picks.CAP ? ` · <span class="cap-star">★${v.picks.CAP}</span>` : '';
        return `<div class="league-row ${rank <= 3 ? 'top-' + rank : ''}">
          <span class="rank-num ${rCls}">#${rank}</span>
          <span class="lg-name">${v.name}${platBadge(v.platform)}</span>
          <span class="lg-picks">${picks}${capDisplay}</span>
          <span class="lg-pts ${rank <= 3 ? 'top' : ''}">${v.pts}</span>
        </div>`;
      }).join('');
    }
  }

  // Shared pick/cap data
  const locked = Object.entries(viewers).filter(([, v]) => v.locked);
  const total = locked.length;
  const pickCounts = {}, capCounts = {};
  locked.forEach(([, v]) => {
    [v.picks.DEF, v.picks.MID, v.picks.ATT].filter(Boolean).forEach(p => { pickCounts[p] = (pickCounts[p] || 0) + 1; });
    if (v.picks.CAP) capCounts[v.picks.CAP] = (capCounts[v.picks.CAP] || 0) + 1;
  });

  function statRow(name, count, outOf, extra = '') {
    const pos = roster.find(r => r.name === name)?.pos || '?';
    const pct = outOf ? Math.round(count / outOf * 100) : 0;
    const pts = getScore(name, 0, events);
    return `<div class="stat-row">
      <div class="stat-row-top">
        <span class="badge b-${pos}">${pos}</span>
        <span class="stat-name">${name}</span>
        <span class="stat-val">${extra || count}</span>
      </div>
      <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%"></div></div>
    </div>`;
  }

  // Top Players
  const topPlayers = document.getElementById('lg-top-players');
  if (topPlayers) {
    const scored = roster.map(p => ({ name: p.name, pos: p.pos, pts: getScore(p.name, 0, events) }))
      .filter(p => p.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 6);
    const maxPts = scored[0]?.pts || 1;
    topPlayers.innerHTML = scored.length
      ? scored.map(p => {
          const pct = Math.round(p.pts / maxPts * 100);
          return `<div class="stat-row">
            <div class="stat-row-top">
              <span class="badge b-${p.pos}">${p.pos}</span>
              <span class="stat-name">${p.name}</span>
              <span class="stat-val accent">+${p.pts}</span>
            </div>
            <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')
      : '<div class="empty-msg">No scores yet.</div>';
  }

  // Top Goalscorers
  const topScorers = document.getElementById('lg-top-scorers');
  if (topScorers) {
    const goals = {};
    events.filter(e => (e.event_type || e.eventType) === 'goal').forEach(e => { goals[e.player] = (goals[e.player] || 0) + 1; });
    const sorted = Object.entries(goals).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxG = sorted[0]?.[1] || 1;
    topScorers.innerHTML = sorted.length
      ? sorted.map(([name, g]) => {
          const pos = roster.find(r => r.name === name)?.pos || '?';
          const pct = Math.round(g / maxG * 100);
          return `<div class="stat-row">
            <div class="stat-row-top">
              <span class="badge b-${pos}">${pos}</span>
              <span class="stat-name">${name}</span>
              <span class="stat-val" style="color:var(--mid)">${g} ⚽</span>
            </div>
            <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%;background:var(--mid)"></div></div>
          </div>`;
        }).join('')
      : '<div class="empty-msg" data-i18n="no_goals">No goals yet.</div>';
  }

  // Most Picked
  const mostPicked = document.getElementById('lg-most-picked');
  if (mostPicked) {
    const sorted = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    mostPicked.innerHTML = sorted.length && total
      ? sorted.map(([name, count]) => statRow(name, count, total)).join('')
      : '<div class="empty-msg">No picks yet.</div>';
  }

  // Most Captained
  const mostCaptained = document.getElementById('lg-most-captained');
  if (mostCaptained) {
    const sorted = Object.entries(capCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    mostCaptained.innerHTML = sorted.length && total
      ? sorted.map(([name, count]) => statRow(name, count, total, `★${count}`)).join('')
      : '<div class="empty-msg">No captains yet.</div>';
  }
}

async function refreshLeague() {
  const btn = document.querySelector('[onclick="refreshLeague()"]');
  if (btn) { btn.textContent = 'Refreshing...'; btn.disabled = true; }
  if (S.sessionCode) await reloadFromDB();
  renderLeague();
  if (btn) { btn.textContent = t('refresh'); btn.disabled = false; }
}

// ── Event Log ─────────────────────────────────────────────────────────────────
function refreshLog() {
  const log = document.getElementById('event-log');
  if (!log) return;
  if (!S.events.length) {
    log.innerHTML = `<div class="evt-item empty" data-i18n="no_events">${t('no_events')}</div>`;
    return;
  }
  log.innerHTML = [...S.events].reverse().map(e =>
    `<div class="evt-item">
      <span class="evt-time">${e.time}</span>
      <span class="evt-player">${e.player}</span>
      <span class="evt-type">${EL[e.eventType] || e.eventType}</span>
      <span class="evt-pts">${Number(e.points) >= 0 ? '+' : ''}${e.points}pts</span>
    </div>`
  ).join('');
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function refreshStats() {
  const sv = document.getElementById('sv');
  const se = document.getElementById('se');
  const sl = document.getElementById('sl');
  const sp2 = document.getElementById('sp2');
  if (sv) sv.textContent = Object.values(S.viewers).filter(v => v.locked).length;
  if (se) se.textContent = S.events.length;
  const lb = getLeaderboard();
  if (lb.length && sl && sp2) {
    sl.textContent = lb[0].name.split(' ')[0];
    sp2.textContent = lb[0].pts + 'pts';
  }
}

// ── Player Insights ───────────────────────────────────────────────────────────
function renderInsights() {
  const el = document.getElementById('player-insights');
  if (!el) return;
  const locked = Object.entries(S.viewers).filter(([, v]) => v.locked);
  if (!locked.length) { el.innerHTML = `<div class="empty-msg" data-i18n="insights_empty">${t('insights_empty')}</div>`; return; }
  const picks = {}, capPicks = {};
  locked.forEach(([, v]) => {
    [v.picks.DEF, v.picks.MID, v.picks.ATT].filter(Boolean).forEach(p => { picks[p] = (picks[p] || 0) + 1; });
    if (v.picks.CAP) capPicks[v.picks.CAP] = (capPicks[v.picks.CAP] || 0) + 1;
  });
  const sorted = Object.entries(picks).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const total = locked.length;
  el.innerHTML = sorted.map(([name, count]) => {
    const pct = Math.round(count / total * 100);
    const caps = capPicks[name] || 0;
    const pts = getScore(name);
    const pos = S.roster.find(r => r.name === name)?.pos || '?';
    return `<div class="insight-row">
      <div class="insight-top">
        <span class="badge b-${pos}">${pos}</span>
        <span class="insight-name">${name}</span>
        <span class="insight-pct">${count}/${total} (${pct}%)${caps ? ` · ★${caps}cap` : ''}${pts ? ` <span class="accent-text">${pts}pts</span>` : ''}</span>
      </div>
      <div class="stat-bar-wrap"><div class="stat-bar" style="width:${pct}%;transition:width 0.4s"></div></div>
    </div>`;
  }).join('');
}

// ── Viewer list (Controls tab) ────────────────────────────────────────────────
function renderViewerList() {
  const el = document.getElementById('viewer-list');
  if (!el) return;
  const viewers = Object.entries(S.viewers);
  if (!viewers.length) { el.innerHTML = '<div class="empty-msg">No viewers have joined yet.</div>'; return; }
  el.innerHTML = viewers.map(([name, v]) => {
    const locked = v.locked ? '🔒' : '⏳';
    const modBadge = v.isMod ? '<span class="mod-badge">MOD</span>' : '';
    const safeName = name.replace(/'/g, "\\'");
    const modBtn = v.isMod
      ? `<button class="evt-btn danger" onclick="demoteMod('${safeName}')">Demote</button>`
      : `<button class="evt-btn warn" onclick="promoteMod('${safeName}')">Make Mod</button>`;
    return `<div class="viewer-row">
      <span class="viewer-row-name">${locked} ${name}${platBadge(v.platform)}${modBadge}</span>
      ${modBtn}
    </div>`;
  }).join('');
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById('modal-' + id);
  const overlay = document.getElementById('modal-overlay');
  if (el) el.style.display = 'block';
  if (overlay) overlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  ['privacy', 'terms', 'pricing', 'changelog'].forEach(id => {
    const el = document.getElementById('modal-' + id);
    if (el) el.style.display = 'none';
  });
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Last match card ───────────────────────────────────────────────────────────
function setLastMatch(home, homeScore, away, awayScore, scorers) {
  const el = id => document.getElementById(id);
  if (el('lm-home')) el('lm-home').textContent = home || '—';
  if (el('lm-away')) el('lm-away').textContent = away || '—';
  if (el('lm-score')) el('lm-score').textContent = `${homeScore} : ${awayScore}`;
  if (el('last-match-date')) el('last-match-date').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const gl = el('lm-goals');
  if (gl) {
    gl.innerHTML = scorers && scorers.length
      ? scorers.map(s => `<div class="goal-row"><span class="goal-icon">⚽</span>${s.name}${s.team ? ` <span class="goal-team">(${s.team})</span>` : ''}</div>`).join('')
      : '<div class="empty-msg">No goals recorded</div>';
  }
  const emptyEl = el('lm-empty-state'), contentEl = el('lm-content'), clearBtn = el('lm-clear-btn');
  if (emptyEl) emptyEl.style.display = 'none';
  if (contentEl) contentEl.style.display = 'block';
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  if (S.sessionCode) lsSetJson('ffm_last_match_' + S.sessionCode, { home, homeScore, away, awayScore, scorers, ts: Date.now() });
}

function clearLastMatch() {
  ['lm-empty-state', 'lm-content'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.style.display = i === 0 ? 'block' : 'none';
  });
  const clearBtn = document.getElementById('lm-clear-btn');
  const dateEl = document.getElementById('last-match-date');
  if (clearBtn) clearBtn.style.display = 'none';
  if (dateEl) dateEl.textContent = '';
  if (S.sessionCode) lsRemove('ffm_last_match_' + S.sessionCode);
}

function loadLastMatch() {
  if (!S.sessionCode) return;
  const saved = lsGetJson('ffm_last_match_' + S.sessionCode);
  if (saved) setLastMatch(saved.home, saved.homeScore, saved.away, saved.awayScore, saved.scorers);
}

function showLastMatchForm() {
  const existing = document.getElementById('lm-form');
  if (existing) { existing.remove(); return; }
  const card = document.getElementById('last-match-card');
  if (!card) return;
  const form = document.createElement('div');
  form.id = 'lm-form';
  form.className = 'last-match-form';
  form.innerHTML = `
    <input class="input-field" id="lm-home-in" placeholder="Home team">
    <div class="score-inputs">
      <input class="input-field score-in" id="lm-hs-in" placeholder="0">
      <span class="score-sep">:</span>
      <input class="input-field score-in" id="lm-as-in" placeholder="0">
    </div>
    <input class="input-field" id="lm-away-in" placeholder="Away team">
    <input class="input-field scorers-in" id="lm-scorers-in" placeholder="Scorers e.g. Mané (H), Salah (H), Kane (A)">
    <div class="form-btns">
      <button class="btn btn-accent" onclick="submitLastMatch()">Save</button>
      <button class="btn" onclick="document.getElementById('lm-form').remove()">Cancel</button>
    </div>`;
  card.appendChild(form);
  card.style.display = 'block';
}

function submitLastMatch() {
  const home = document.getElementById('lm-home-in')?.value.trim() || '';
  const away = document.getElementById('lm-away-in')?.value.trim() || '';
  const hs = document.getElementById('lm-hs-in')?.value.trim() || '0';
  const as_ = document.getElementById('lm-as-in')?.value.trim() || '0';
  const raw = document.getElementById('lm-scorers-in')?.value.trim() || '';
  const scorers = raw ? raw.split(',').map(s => {
    const m = s.trim().match(/^(.+?)\s*\(([HA])\)\s*$/i);
    if (m) return { name: m[1].trim(), team: m[2].toUpperCase() === 'H' ? home : away };
    return { name: s.trim(), team: '' };
  }).filter(s => s.name) : [];
  document.getElementById('lm-form')?.remove();
  setLastMatch(home, hs, away, as_, scorers);
}

// ── Last submission image ─────────────────────────────────────────────────────
function saveLastSubmission(b64, mime) {
  try {
    const dataUrl = `data:${mime};base64,${b64}`;
    localStorage.setItem('ffm_last_submission', dataUrl);
    const el = document.getElementById('last-submission-img');
    if (el) { el.src = dataUrl; el.style.display = 'block'; }
    const emptyEl = document.getElementById('last-submission-empty');
    if (emptyEl) emptyEl.style.display = 'none';
  } catch(e) {}
}

function loadLastSubmission() {
  try {
    const saved = localStorage.getItem('ffm_last_submission');
    const el = document.getElementById('last-submission-img');
    const emptyEl = document.getElementById('last-submission-empty');
    if (saved && el) {
      el.src = saved;
      el.style.display = 'block';
      if (emptyEl) emptyEl.style.display = 'none';
    }
  } catch(e) {}
}

function enlargeStatsImg() {
  const img = document.getElementById('stats-img');
  if (!img || !img.src) return;
  const lb = document.getElementById('match-lightbox');
  const lg = document.getElementById('match-img-large');
  if (lb && lg) { lg.src = img.src; lb.style.display = 'flex'; }
}

// ── OBS overlay URL ───────────────────────────────────────────────────────────
function updateOverlayUrl() {
  if (!S.sessionCode) return;
  const url = `${window.location.origin}/overlay.html?session=${S.sessionCode}`;
  const el = document.getElementById('overlay-url');
  if (el) el.textContent = url;
}

function copyOverlayUrl() {
  const el = document.getElementById('overlay-url');
  if (!el || !el.textContent || el.textContent === '—') return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = document.querySelector('[onclick="copyOverlayUrl()"]');
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 2000); }
  });
}

// ── Waitlist form ─────────────────────────────────────────────────────────────
async function submitWaitlist() {
  const name = document.getElementById('wl-name').value.trim();
  const email = document.getElementById('wl-email').value.trim();
  const channel = document.getElementById('wl-twitch').value.trim();
  const err = document.getElementById('wl-err');
  if (!name || !email || !channel) { err.style.display='block'; err.textContent='Name, email and channel are required.'; return; }
  if (!email.includes('@')) { err.style.display='block'; err.textContent='Please enter a valid email.'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('#waitlist-form .btn-accent');
  if (btn) { btn.textContent = 'Joining...'; btn.disabled = true; }
  const result = await db('add_waitlist', { name, email, channel: channel || null });
  if (btn) { btn.textContent = 'Join waitlist →'; btn.disabled = false; }
  if (result && result.error) {
    err.style.display = 'block';
    err.textContent = result.error.includes('duplicate') ? 'This email is already on the waitlist!' : result.error;
    return;
  }
  const formEl = document.getElementById('waitlist-form');
  const successEl = document.getElementById('waitlist-success');
  if (formEl) formEl.style.display = 'none';
  if (successEl) successEl.style.display = 'block';
}

// ── Squad manage (season) ────────────────────────────────────────────────────
function renderSquadManage() {
  const list = document.getElementById('squad-manage-list');
  if (!list) return;
  if (!S.roster.length) { list.innerHTML = '<div class="empty-msg">No players in squad.</div>'; return; }
  const byPos = { DEF: [], MID: [], ATT: [] };
  S.roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  list.innerHTML = ['DEF', 'MID', 'ATT'].map(pos => {
    if (!byPos[pos].length) return '';
    return `<div class="squad-manage-pos">
      <div class="squad-manage-pos-label">${PL[pos]}</div>
      ${byPos[pos].map(p => `<div class="squad-manage-row">
        <span class="badge b-${pos}">${pos}</span>
        <span class="squad-manage-name">${p.name}</span>
      </div>`).join('')}
    </div>`;
  }).join('');
}

window.posAvatar = posAvatar;
window.platBadge = platBadge;
window.renderLeague = renderLeague;
window.refreshLeague = refreshLeague;
window.refreshLog = refreshLog;
window.refreshStats = refreshStats;
window.renderInsights = renderInsights;
window.renderViewerList = renderViewerList;
window.openModal = openModal;
window.closeModal = closeModal;
window.setLastMatch = setLastMatch;
window.clearLastMatch = clearLastMatch;
window.loadLastMatch = loadLastMatch;
window.showLastMatchForm = showLastMatchForm;
window.submitLastMatch = submitLastMatch;
window.saveLastSubmission = saveLastSubmission;
window.loadLastSubmission = loadLastSubmission;
window.enlargeStatsImg = enlargeStatsImg;
window.updateOverlayUrl = updateOverlayUrl;
window.copyOverlayUrl = copyOverlayUrl;
window.submitWaitlist = submitWaitlist;
window.renderSquadManage = renderSquadManage;
