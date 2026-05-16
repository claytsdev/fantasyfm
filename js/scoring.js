// ─── scoring.js ───────────────────────────────────────────────────────────────
// Scoring constants and pure scoring functions.
// getViewerScore implements captain correctly with all v1 bugs fixed.

const SC = {
  DEF: { goal: 3, assist: 3, clean_sheet: 5 },
  MID: { goal: 3, assist: 5, clean_sheet: 3 },
  ATT: { goal: 5, assist: 3, clean_sheet: 1 },
};
const EL = {
  goal: 'Goal', assist: 'Assist', clean_sheet: 'Clean sheet',
  motm: 'Player of the Match', rating: 'Rating bonus',
  yellow_card: 'Yellow card', red_card: 'Red card', manual_adjust: 'Manual adjustment',
};
const PL = { DEF: 'Defenders', MID: 'Midfielders', ATT: 'Attackers' };
const CAP_MULTIPLIER = 2;

function sid(n) { return n.replace(/[^a-zA-Z0-9]/g, '_'); }

// Get total score for a single player from an events array, after a given timestamp.
// eventsArr defaults to S.events (streamer context) but can be V.events (viewer context).
function getScore(name, fromTs = 0, eventsArr = null) {
  const events = eventsArr || S.events;
  return events
    .filter(e => e.player === name && (e.ts || 0) > fromTs)
    .reduce((s, e) => s + Number(e.points), 0);
}

// BUG FIX: Captain correctly handled.
// - If CAP === DEF/MID/ATT → multiply that position's score × 2
// - If CAP is a 4th player → add their score × 2 separately (NOT added inside loop again)
// - Add bankedPoints
function getViewerScore(vname, viewersObj = null, eventsArr = null) {
  const viewers = viewersObj || S.viewers;
  const events = eventsArr || S.events;
  const v = viewers[vname];
  if (!v) return 0;
  const picks = v.picks || {};
  // BUG FIX: lockedAtTs must always be ms. DB may return ISO or ms number.
  const lockedTs = typeof v.lockedAtTs === 'string'
    ? new Date(v.lockedAtTs).getTime()
    : (v.lockedAtTs || 0);
  const banked = v.bankedPoints || 0;
  let current = 0;
  // DEF
  if (picks.DEF) {
    const pts = getScore(picks.DEF, lockedTs, events);
    current += picks.CAP === picks.DEF ? pts * CAP_MULTIPLIER : pts;
  }
  // MID
  if (picks.MID) {
    const pts = getScore(picks.MID, lockedTs, events);
    current += picks.CAP === picks.MID ? pts * CAP_MULTIPLIER : pts;
  }
  // ATT
  if (picks.ATT) {
    const pts = getScore(picks.ATT, lockedTs, events);
    current += picks.CAP === picks.ATT ? pts * CAP_MULTIPLIER : pts;
  }
  // Captain is a 4th player — score them at 2x (NOT double-counted)
  if (picks.CAP && picks.CAP !== picks.DEF && picks.CAP !== picks.MID && picks.CAP !== picks.ATT) {
    current += getScore(picks.CAP, lockedTs, events) * CAP_MULTIPLIER;
  }
  return banked + current;
}

function getLeaderboard(viewersObj = null, eventsArr = null) {
  const viewers = viewersObj || S.viewers;
  return Object.entries(viewers)
    .filter(([, v]) => v.locked)
    .map(([name, v]) => ({
      name,
      picks: v.picks,
      pts: getViewerScore(name, viewers, eventsArr),
      platform: v.platform || 'manual',
    }))
    .sort((a, b) => b.pts - a.pts);
}

// Build points from a detected match read (for preview before applying).
function buildMatchPreview(rawPlayers, rosterArr, csToggle, motmToggle) {
  const events = [];
  rosterArr.forEach(rp => {
    const found = rawPlayers.find(p => p.name.toLowerCase() === rp.name.toLowerCase());
    if (!found) return;
    const pos = rp.pos;
    if (found.goals > 0) {
      for (let i = 0; i < found.goals; i++) events.push({ player: rp.name, pos, eventType: 'goal', points: SC[pos].goal });
    }
    if (found.assists > 0) {
      for (let i = 0; i < found.assists; i++) events.push({ player: rp.name, pos, eventType: 'assist', points: SC[pos].assist });
    }
    if (csToggle && found.time_played >= 90) events.push({ player: rp.name, pos, eventType: 'clean_sheet', points: SC[pos].clean_sheet });
    if (found.rating >= 9) events.push({ player: rp.name, pos, eventType: 'rating', points: 3 });
    else if (found.rating >= 8) events.push({ player: rp.name, pos, eventType: 'rating', points: 2 });
    else if (found.rating >= 7) events.push({ player: rp.name, pos, eventType: 'rating', points: 1 });
    if (motmToggle && found.motm) events.push({ player: rp.name, pos, eventType: 'motm', points: 5 });
  });
  // Auto-detect MOTM if toggle on but no explicit flag — highest rated squad player
  if (motmToggle && !rawPlayers.some(p => p.motm)) {
    const best = rawPlayers
      .filter(p => rosterArr.some(r => r.name.toLowerCase() === p.name.toLowerCase()) && p.rating > 0)
      .sort((a, b) => b.rating - a.rating)[0];
    if (best && !events.some(e => e.eventType === 'motm' && e.player.toLowerCase() === best.name.toLowerCase())) {
      const rp = rosterArr.find(r => r.name.toLowerCase() === best.name.toLowerCase());
      if (rp) events.push({ player: rp.name, pos: rp.pos, eventType: 'motm', points: 5 });
    }
  }
  return events;
}

window.SC = SC;
window.EL = EL;
window.PL = PL;
window.CAP_MULTIPLIER = CAP_MULTIPLIER;
window.sid = sid;
window.getScore = getScore;
window.getViewerScore = getViewerScore;
window.getLeaderboard = getLeaderboard;
window.buildMatchPreview = buildMatchPreview;
