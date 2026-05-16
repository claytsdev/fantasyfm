// ─── app.js ───────────────────────────────────────────────────────────────────
// Entry point: i18n, admin, startup wiring.

// ── i18n ──────────────────────────────────────────────────────────────────────
let currentLang = lsGet('ffm_lang', 'en');

const LANG = {
  en: {
    home: 'Home', setup: 'Setup', controls: 'Controls', viewer: 'Viewer', table: 'Table', streamer: 'Streamer',
    for_streamers: 'For streamers', for_viewers: 'For viewers',
    scoring: 'Scoring', defender: 'Defender', midfielder: 'Midfielder', attacker: 'Attacker',
    clean_sheet: 'Clean sheet', goal: 'Goal', assist: 'Assist', rating: 'Rating',
    rating_scale: '7+/8+/9+', all_bonuses: 'All bonuses are cumulative',
    cs_note: '🧤 Clean sheet points awarded to all players who played the full match',
    potm: 'Player of the Match', captain_bonus: 'Captain Bonus',
    step1_title: 'Step 1 — squad screenshot',
    step1_sub: 'Upload your FM squad screen. FantasyFM will read player names and positions automatically.',
    upload_file: 'Upload file', upload_file_sub: 'Click to browse',
    paste_screenshot: 'Paste screenshot', paste_screenshot_sub: 'Click after copying',
    reading_squad: 'Reading squad…', enter_manually: 'Enter manually instead',
    step2_title: 'Step 2 — confirm positions',
    step2_sub: 'Check and adjust positions, then click Go Live.',
    step2_hint: 'Click DEF / MID / ATT to reassign any player. Check wingers and wing-backs especially.',
    add_player: '+ Add player', add_second: 'Add from 2nd screenshot',
    go_live: 'Go live', re_upload: 'Re-upload',
    session_live: 'Session is live. Share the code with your viewers.',
    viewers_enter: 'Viewers enter this on the Viewer tab',
    goto_live: 'Go to live controls', reset_session: 'Reset session',
    no_session_setup: 'No active session. Complete setup first.',
    match_upload: 'Match stats', match_upload_sub: 'Upload the Player Stats screen from FM.',
    match_upload_hint: 'Full-Time Report → click your team name → Player Stats tab → screenshot the full table.',
    read_stats: 'Read stats', reading_stats: 'Reading stats…',
    detected: 'Detected — confirm to apply', apply_points: 'Apply points', discard: 'Discard',
    clean_sheet_toggle: 'Clean sheet?', cs_on: 'YES', cs_off: 'NO',
    motm_toggle: 'Player of the Match +5pts',
    new_entries: 'New entries', entries_open: 'OPEN', entries_locked: 'LOCKED',
    last_submission: 'Last submission', no_submission: 'No stats submitted yet.',
    player_insights: 'Player insights', insights_empty: 'Lock-ins will show player selection data here.',
    event_log: 'Event log', no_events: 'No events yet.',
    manual_scoring: 'Manual scoring', undo_last: 'Undo last',
    join_title: 'Join a game',
    join_sub: 'Sign in with your Twitch or YouTube account to join.',
    session_code_label: 'Session code',
    no_session_viewer: 'No active session.',
    enter_code: 'Session code (e.g. FM-AB3XY7)',
    join_btn: 'Join game', pick_title: 'Build your squad',
    pick_sub: 'Pick one per position, then choose your captain for 2x points.',
    lock_btn: 'Lock in picks', lock_wait: 'Select all 4 picks to continue',
    viewers_lbl: 'Viewers', events_lbl: 'Events', top_manager: 'Top manager', leading_pts: 'Leading pts',
    pts: 'pts', switch_btn: 'Switch',
    manager_table: 'Manager Table', refresh: 'Refresh',
    top_players: 'Top Players', top_scorers: 'Top Goalscorers',
    most_picked: 'Most Picked', most_captained: 'Most Captained',
    no_goals: 'No goals yet.', no_picks: 'No picks yet.', no_captains: 'No captains yet.',
    streamer_access: 'Streamer Access', sign_in: 'Sign in',
    streamer_sub: 'Access your streamer dashboard to set up sessions and control scoring.',
    email_lbl: 'Email', password_lbl: 'Password', sign_in_btn: 'Sign in',
    private_beta: 'Private Beta',
    beta_msg: 'FantasyFM is currently in private beta. Streamer access is invite-only.',
    streamer_dash: 'Streamer Dashboard', welcome_back: 'Welcome back', sign_out: 'Sign out',
    access_mgmt: 'Access management', add_streamer: '+ Add streamer',
    temp_password: 'Temporary password', access_type: 'Access type',
    expires_lbl: 'Expires (leave blank = never)', cancel: 'Cancel', loading: 'Loading…',
    twitch_bot: 'Twitch chat bot', twitch_channel: 'Your Twitch channel name', test_message: 'Test message',
    obs_overlay: 'OBS Overlay', browser_source: 'Browser Source', copy_url: 'Copy URL',
    err_no_session: 'No active session. Start a session in the Setup tab first.',
    err_signin: 'Please sign in with Twitch or YouTube first.',
    err_code: 'Please enter the session code.',
    err_not_found: 'Session code not found. Check the stream.',
    err_entries_locked: 'New entries are currently closed. Wait for the streamer to open entries.',
    session_type_title: 'Start a new competition',
    oneoff_label: 'One-off Session', oneoff_desc: 'Single stream. No transfers.',
    season_label: 'New Season', season_desc: 'Runs across multiple streams. Viewers keep their picks.',
    allow_new_joiners_label: 'Allow new viewers to join mid-season',
    transfers_per_viewer_label: 'Transfers per viewer',
    end_stream_btn: 'End Stream', season_settings_btn: 'Season Settings',
    season_badge: 'SEASON',
  },
  fr: {
    home: 'Accueil', setup: 'Équipe', controls: 'Contrôles', viewer: 'Spectateur', table: 'Classement', streamer: 'Streamer',
    for_streamers: 'Pour les streamers', for_viewers: 'Pour les spectateurs',
    scoring: 'Points', defender: 'Défenseur', midfielder: 'Milieu', attacker: 'Attaquant',
    clean_sheet: 'Clean sheet', goal: 'But', assist: 'Passe décisive', rating: 'Note',
    rating_scale: '7+/8+/9+', all_bonuses: 'Tous les bonus sont cumulables',
    cs_note: '🧤 CS pour tous les joueurs ayant joué 90min',
    potm: 'Joueur du match', captain_bonus: 'Bonus capitaine',
    step1_title: 'Étape 1 — capture d\'équipe',
    step1_sub: 'Importez votre écran d\'équipe FM. FantasyFM lira les noms et positions automatiquement.',
    upload_file: 'Importer', upload_file_sub: 'Cliquer pour parcourir',
    paste_screenshot: 'Coller', paste_screenshot_sub: 'Cliquer après avoir copié',
    reading_squad: 'Lecture en cours…', enter_manually: 'Saisir manuellement',
    step2_title: 'Étape 2 — confirmer les positions',
    step2_sub: 'Vérifiez les positions puis cliquez sur Démarrer.',
    step2_hint: 'Cliquez DEF / MIL / ATT pour réassigner.',
    add_player: '+ Ajouter', add_second: 'Ajouter 2ème capture',
    go_live: 'Démarrer', re_upload: 'Re-importer',
    session_live: 'Session en direct. Partagez le code avec vos spectateurs.',
    viewers_enter: 'Les spectateurs entrent ce code dans l\'onglet Spectateur',
    goto_live: 'Contrôles live', reset_session: 'Réinitialiser',
    no_session_setup: 'Aucune session active.',
    match_upload: 'Stats du match', match_upload_sub: 'Importez l\'écran Stats Joueurs de FM.',
    read_stats: 'Lire stats', reading_stats: 'Lecture…',
    detected: 'Détecté — confirmer pour appliquer', apply_points: 'Appliquer', discard: 'Annuler',
    clean_sheet_toggle: 'Clean sheet?', cs_on: 'OUI', cs_off: 'NON',
    motm_toggle: 'Joueur du match +5pts',
    new_entries: 'Nouvelles entrées', entries_open: 'OUVERT', entries_locked: 'FERMÉ',
    last_submission: 'Dernier envoi', no_submission: 'Aucun envoi.',
    player_insights: 'Insights joueurs', insights_empty: 'Les sélections apparaîtront ici.',
    event_log: 'Journal', no_events: 'Aucun événement.',
    manual_scoring: 'Points manuels', undo_last: 'Annuler',
    join_title: 'Rejoindre une partie',
    join_sub: 'Connectez-vous avec Twitch ou YouTube.',
    session_code_label: 'Code de session',
    no_session_viewer: 'Aucune session active.',
    enter_code: 'Code session (ex. FM-AB3XY7)',
    join_btn: 'Rejoindre', pick_title: 'Composez votre équipe',
    pick_sub: 'Choisissez un joueur par poste, puis votre capitaine.',
    lock_btn: 'Valider', lock_wait: 'Choisissez les 4 joueurs',
    viewers_lbl: 'Spectateurs', events_lbl: 'Événements', top_manager: 'Meilleur manager', leading_pts: 'Points',
    pts: 'pts',
    manager_table: 'Classement', refresh: 'Actualiser',
    top_players: 'Meilleurs joueurs', top_scorers: 'Meilleurs buteurs',
    most_picked: 'Plus sélectionnés', most_captained: 'Plus capitaines',
    no_goals: 'Aucun but.', no_picks: 'Aucune sélection.', no_captains: 'Aucun capitaine.',
    streamer_access: 'Accès Streamer', sign_in: 'Se connecter',
    streamer_sub: 'Accédez au dashboard streamer.',
    email_lbl: 'Email', password_lbl: 'Mot de passe', sign_in_btn: 'Se connecter',
    private_beta: 'Bêta privée',
    beta_msg: 'FantasyFM est en bêta privée. L\'accès streamer est sur invitation.',
    streamer_dash: 'Dashboard Streamer', welcome_back: 'Bienvenue', sign_out: 'Déconnexion',
    access_mgmt: 'Gestion des accès', add_streamer: '+ Ajouter',
    expires_lbl: 'Expiration (vide = jamais)', cancel: 'Annuler', loading: 'Chargement…',
    twitch_bot: 'Bot Twitch', twitch_channel: 'Votre chaîne Twitch', test_message: 'Message test',
    obs_overlay: 'Overlay OBS', browser_source: 'Source navigateur', copy_url: 'Copier URL',
    err_no_session: 'Aucune session. Commencez dans l\'onglet Équipe.',
    err_signin: 'Connectez-vous avec Twitch ou YouTube.',
    err_code: 'Entrez le code de session.',
    err_not_found: 'Code non trouvé.',
    err_entries_locked: 'Nouvelles entrées fermées.',
    session_type_title: 'Nouvelle compétition',
    oneoff_label: 'Session unique', oneoff_desc: 'Un seul stream. Pas de transferts.',
    season_label: 'Nouvelle saison', season_desc: 'Plusieurs streams. Les joueurs gardent leurs sélections.',
    allow_new_joiners_label: 'Autoriser nouveaux joueurs en cours de saison',
    transfers_per_viewer_label: 'Transferts par spectateur',
    end_stream_btn: 'Fin de stream', season_settings_btn: 'Paramètres saison',
    season_badge: 'SAISON',
  },
  de: {
    home: 'Start', setup: 'Kader', controls: 'Kontrollen', viewer: 'Zuschauer', table: 'Tabelle', streamer: 'Streamer',
    for_streamers: 'Für Streamer', for_viewers: 'Für Zuschauer',
    scoring: 'Punkte', defender: 'Verteidiger', midfielder: 'Mittelfeld', attacker: 'Angreifer',
    clean_sheet: 'Clean sheet', goal: 'Tor', assist: 'Vorlage', rating: 'Note',
    rating_scale: '7+/8+/9+', all_bonuses: 'Alle Boni sind kumulativ',
    cs_note: '🧤 CS für alle Spieler die 90min gespielt haben',
    potm: 'Spieler des Spiels', captain_bonus: 'Kapitänbonus',
    step1_title: 'Schritt 1 — Kader-Screenshot',
    step1_sub: 'Lade deinen FM-Kader-Screenshot hoch.',
    upload_file: 'Datei hochladen', upload_file_sub: 'Klicken zum Durchsuchen',
    paste_screenshot: 'Einfügen', paste_screenshot_sub: 'Nach dem Kopieren klicken',
    reading_squad: 'Kader wird gelesen…', enter_manually: 'Manuell eingeben',
    step2_title: 'Schritt 2 — Positionen bestätigen',
    step2_sub: 'Prüfe Positionen und klicke auf Live gehen.',
    step2_hint: 'Klicke DEF / MID / ATT zum Zuweisen.',
    add_player: '+ Spieler hinzufügen', add_second: 'Zweiten Screenshot hinzufügen',
    go_live: 'Live gehen', re_upload: 'Neu hochladen',
    session_live: 'Session ist live. Teile den Code mit deinen Zuschauern.',
    viewers_enter: 'Zuschauer geben dies im Zuschauer-Tab ein',
    goto_live: 'Zu Live-Kontrollen', reset_session: 'Session zurücksetzen',
    no_session_setup: 'Keine aktive Session.',
    match_upload: 'Match-Stats', match_upload_sub: 'Lade den FM Spieler-Stats-Screenshot hoch.',
    read_stats: 'Stats lesen', reading_stats: 'Lese Stats…',
    detected: 'Erkannt — bestätigen zum Anwenden', apply_points: 'Punkte vergeben', discard: 'Verwerfen',
    clean_sheet_toggle: 'Clean sheet?', cs_on: 'JA', cs_off: 'NEIN',
    motm_toggle: 'Spieler des Spiels +5Pkt',
    new_entries: 'Neue Einträge', entries_open: 'OFFEN', entries_locked: 'GESPERRT',
    last_submission: 'Letzter Upload', no_submission: 'Noch kein Upload.',
    player_insights: 'Spieler-Insights', insights_empty: 'Auswahlstatistiken erscheinen hier.',
    event_log: 'Ereignisprotokoll', no_events: 'Noch keine Ereignisse.',
    manual_scoring: 'Manuelle Punkte', undo_last: 'Rückgängig',
    join_title: 'Spiel beitreten',
    join_sub: 'Melde dich mit Twitch oder YouTube an.',
    session_code_label: 'Session-Code',
    no_session_viewer: 'Keine aktive Session.',
    enter_code: 'Session-Code (z.B. FM-AB3XY7)',
    join_btn: 'Beitreten', pick_title: 'Stell dein Team auf',
    pick_sub: 'Wähle einen Spieler pro Position, dann deinen Kapitän.',
    lock_btn: 'Auswahl bestätigen', lock_wait: 'Wähle alle 4 Spieler',
    viewers_lbl: 'Zuschauer', events_lbl: 'Ereignisse', top_manager: 'Bester Manager', leading_pts: 'Führende Pkt',
    pts: 'Pkt',
    manager_table: 'Manager-Tabelle', refresh: 'Aktualisieren',
    top_players: 'Top Spieler', top_scorers: 'Top Torjäger',
    most_picked: 'Häufig gewählt', most_captained: 'Häufig Kapitän',
    no_goals: 'Noch keine Tore.', no_picks: 'Noch keine Auswahl.', no_captains: 'Noch kein Kapitän.',
    streamer_access: 'Streamer-Zugang', sign_in: 'Anmelden',
    streamer_sub: 'Zugriff auf dein Streamer-Dashboard.',
    email_lbl: 'E-Mail', password_lbl: 'Passwort', sign_in_btn: 'Anmelden',
    private_beta: 'Private Beta',
    beta_msg: 'FantasyFM ist in der privaten Beta.',
    streamer_dash: 'Streamer-Dashboard', welcome_back: 'Willkommen zurück', sign_out: 'Abmelden',
    access_mgmt: 'Zugriffsverwaltung', add_streamer: '+ Streamer hinzufügen',
    expires_lbl: 'Ablauf (leer = nie)', cancel: 'Abbrechen', loading: 'Laden…',
    twitch_bot: 'Twitch-Bot', twitch_channel: 'Dein Twitch-Kanal', test_message: 'Testnachricht',
    obs_overlay: 'OBS-Einblendung', browser_source: 'Browserquelle', copy_url: 'URL kopieren',
    err_no_session: 'Keine aktive Session.',
    err_signin: 'Bitte melde dich mit Twitch oder YouTube an.',
    err_code: 'Bitte gib den Session-Code ein.',
    err_not_found: 'Session-Code nicht gefunden.',
    err_entries_locked: 'Neue Einträge sind gesperrt.',
    session_type_title: 'Neuen Wettbewerb starten',
    oneoff_label: 'Einzelsession', oneoff_desc: 'Nur ein Stream. Keine Transfers.',
    season_label: 'Neue Saison', season_desc: 'Mehrere Streams. Zuschauer behalten ihre Auswahl.',
    allow_new_joiners_label: 'Neue Zuschauer mid-Saison erlauben',
    transfers_per_viewer_label: 'Transfers pro Zuschauer',
    end_stream_btn: 'Stream beenden', season_settings_btn: 'Saisoneinstellungen',
    season_badge: 'SAISON',
  },
};

function t(key) { return (LANG[currentLang] || LANG.en)[key] || LANG.en[key] || key; }
function setLang(code) {
  currentLang = code;
  lsSet('ffm_lang', code);
  applyLang();
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.style.opacity = b.dataset.lang === code ? '1' : '0.4';
    b.style.borderColor = b.dataset.lang === code ? 'var(--accent)' : 'var(--border)';
  });
}
function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

window.t = t;
window.setLang = setLang;
window.applyLang = applyLang;

// ── Admin ─────────────────────────────────────────────────────────────────────
let adminRefreshInterval = null;

async function renderAdminTab() {
  const el = document.getElementById('admin-sessions-list');
  if (!el) return;
  el.innerHTML = '<div class="empty-msg">Loading…</div>';
  const jwt = lsGet('ffm_streamer_jwt');
  if (!jwt) { el.innerHTML = '<div class="empty-msg att">Not authenticated.</div>'; return; }
  const data = await db('admin_get_sessions', { user_jwt: jwt });
  if (!Array.isArray(data)) {
    el.innerHTML = '<div class="empty-msg att">' + (data && data.error ? data.error : 'Failed to load.') + '</div>'; return;
  }
  if (!data.length) { el.innerHTML = '<div class="empty-msg">No sessions found.</div>'; return; }
  const live = data.filter(s => s.is_live);
  const notLive = data.filter(s => !s.is_live);
  const renderRow = (s) => {
    const created = new Date(s.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const liveBadge = s.is_live ? '<span class="status-badge live">LIVE</span>' : '<span class="status-badge ended">ENDED</span>';
    const typeBadge = s.type === 'season' ? '<span class="status-badge season">SEASON</span>' : '';
    const channelDisplay = s.streamer_channel
      ? `<span class="accent-text">${s.streamer_channel}</span> <span class="txt3">(${s.streamer_email})</span>`
      : `<span class="txt2">${s.streamer_email}</span>`;
    const endBtn = s.is_live ? `<button class="evt-btn danger" onclick="adminEndSession('${s.id}')">End session</button>` : '';
    const inspectBtn = `<button class="evt-btn accent" onclick="adminInspectSession('${s.id}')">Inspect</button>`;
    return `<div class="admin-row">
      <div class="admin-row-info">
        <div class="admin-row-title">${s.id} ${liveBadge}${typeBadge}</div>
        <div class="admin-row-channel">${channelDisplay}</div>
        <div class="admin-row-meta">${created} · ${s.viewer_count} viewer${s.viewer_count !== 1 ? 's' : ''}</div>
      </div>
      <div class="admin-row-btns">${inspectBtn}${endBtn}</div>
    </div>`;
  };
  let html = '';
  if (live.length) {
    html += `<div class="admin-group-label live">Live (${live.length})</div>`;
    html += live.map(renderRow).join('');
  }
  if (notLive.length) {
    html += `<div class="admin-group-label">Recent (${notLive.length})</div>`;
    html += notLive.map(renderRow).join('');
  }
  el.innerHTML = html;
  const ts = document.getElementById('admin-last-refresh');
  if (ts) ts.textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

async function adminEndSession(sessionId) {
  if (!confirm(`Force-end session ${sessionId}?`)) return;
  const jwt = lsGet('ffm_streamer_jwt');
  const res = await db('end_stream', { session_id: sessionId, user_jwt: jwt });
  if (res && res.error) { alert('Error: ' + res.error); return; }
  renderAdminTab();
}

async function adminInspectSession(sessionId) {
  const modal = document.getElementById('inspect-modal');
  const content = document.getElementById('inspect-content');
  if (!modal || !content) return;
  content.innerHTML = '<div class="empty-msg">Loading…</div>';
  modal.style.display = 'flex';
  const jwt = lsGet('ffm_streamer_jwt');
  const data = await db('admin_inspect_session', { session_id: sessionId, user_jwt: jwt });
  if (!data || data.error) { content.innerHTML = `<div class="empty-msg att">${data?.error || 'Failed.'}</div>`; return; }
  const { session, streamer_email, streamer_channel, roster, events, viewers } = data;
  const created = new Date(session.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const liveBadge = session.is_live ? '<span class="status-badge live">LIVE</span>' : '<span class="status-badge ended">ENDED</span>';
  const typeBadge = session.type === 'season' ? '<span class="status-badge season ml">SEASON</span>' : '';
  const evtPts = {};
  events.forEach(e => { evtPts[e.player_name] = (evtPts[e.player_name] || 0) + Number(e.points); });
  const byPos = { DEF: [], MID: [], ATT: [] };
  roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  content.innerHTML = `
    <div class="inspect-header">
      <div class="inspect-title">${session.id} ${liveBadge}${typeBadge}</div>
      <div class="inspect-meta">${streamer_channel ? `<span class="accent-text">${streamer_channel}</span> ` : ''}${streamer_email}</div>
      <div class="inspect-sub">${created} · ${viewers.length} viewer${viewers.length!==1?'s':''} · ${events.length} event${events.length!==1?'s':''}</div>
    </div>
    <div class="inspect-grid">
      <div>
        <div class="inspect-group-label">Squad (${roster.length})</div>
        ${['DEF','MID','ATT'].map(pos => {
          const players = byPos[pos];
          if (!players.length) return '';
          return `<div class="inspect-pos-group">
            <div class="inspect-pos-label b-${pos}">${pos}</div>
            ${players.map(p => {
              const pts = evtPts[p.name] || 0;
              return `<div class="inspect-player-row">
                <span>${p.name}</span>
                ${pts ? `<span class="accent-text">+${pts}</span>` : '<span class="txt3">0</span>'}
              </div>`;
            }).join('')}
          </div>`;
        }).join('')}
        <div class="inspect-group-label mt">Events (${events.length})</div>
        ${events.length ? [...events].reverse().slice(0,15).map(e =>
          `<div class="inspect-event-row"><span class="b-${e.pos}">${e.player_name}</span> · ${e.event_type.replace(/_/g,' ')} <span class="accent-text">${Number(e.points)>0?'+':''}${e.points}</span></div>`
        ).join('') + (events.length>15?`<div class="txt3 small">+${events.length-15} more</div>`:'')
        : '<div class="txt3">No events yet.</div>'}
      </div>
      <div>
        <div class="inspect-group-label">Managers (${viewers.length})</div>
        ${viewers.map(v => {
          const pts = [v.pick_def,v.pick_mid,v.pick_att,v.pick_cap].filter(Boolean).reduce((s,p)=>s+(evtPts[p]||0),0);
          const picks = [v.pick_def,v.pick_mid,v.pick_att].filter(Boolean).join(' · ') || '—';
          return `<div class="inspect-viewer-row">
            <div class="inspect-viewer-name">${v.locked?'🔒':'⏳'} ${v.viewer_name}</div>
            <div class="inspect-viewer-picks txt3">${picks}${v.pick_cap?` · ★${v.pick_cap}`:''}</div>
            ${v.locked?`<div class="accent-text">${pts}pts</div>`:'<div class="txt3">not locked</div>'}
          </div>`;
        }).join('') || '<div class="txt3">No viewers.</div>'}
      </div>
    </div>`;
}

function closeInspectModal() {
  const modal = document.getElementById('inspect-modal');
  if (modal) modal.style.display = 'none';
}

// Waitlist & Streamers admin
async function loadWaitlist() {
  const list = document.getElementById('waitlist-items') || document.getElementById('waitlist-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-msg">Loading…</div>';
  const data = await db('get_waitlist', {});
  if (!Array.isArray(data) || !data.length) { list.innerHTML = '<div class="empty-msg">No waitlist entries.</div>'; return; }
  list.innerHTML = data.map(w => {
    const date = new Date(w.created_at).toLocaleDateString('en-GB');
    const grantBtn = `<button class="evt-btn success" onclick="grantFromWaitlist('${w.email}','${w.name.replace(/'/g,"\\'")}',${w.id})">Grant access</button>`;
    const removeBtn = `<button class="evt-btn danger" onclick="removeWaitlist(${w.id})">Remove</button>`;
    return `<div class="admin-row">
      <div class="admin-row-info">
        <div class="admin-row-title">${w.name} <span class="txt3">&lt;${w.email}&gt;</span>${w.channel?` · ${w.channel}`:''}</div>
        <div class="admin-row-meta">Joined ${date}</div>
      </div>
      <div class="admin-row-btns">${grantBtn}${removeBtn}</div>
    </div>`;
  }).join('');
}

async function grantFromWaitlist(email, name, waitlistId) {
  if (!confirm(`Grant access to ${name} (${email})? This will create their account and send a welcome email.`)) return;
  const btn = event.target;
  const origText = btn.textContent;
  btn.textContent = 'Sending…'; btn.disabled = true;
  const result = await db('grant_and_email', { email, name, waitlist_id: waitlistId });
  btn.textContent = origText; btn.disabled = false;
  if (result && result.error) { alert('Error: ' + result.error); return; }
  const msg = document.createElement('div');
  msg.className = 'toast-success';
  msg.textContent = `✓ Access granted & welcome email sent to ${email}`;
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 4000);
  loadWaitlist(); loadStreamers();
}

async function removeWaitlist(id) {
  if (!confirm('Remove this entry?')) return;
  await db('remove_waitlist', { id });
  loadWaitlist();
}

async function loadStreamers() {
  const list = document.getElementById('streamer-list-items') || document.getElementById('streamers-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-msg">Loading…</div>';
  const data = await db('get_streamers', {});
  if (!Array.isArray(data) || !data.length) { list.innerHTML = '<div class="empty-msg">No streamers yet.</div>'; return; }
  list.innerHTML = data.map(s => {
    const expired = s.expires_at && new Date(s.expires_at) < new Date();
    const expLabel = s.expires_at ? new Date(s.expires_at).toLocaleDateString('en-GB') : 'Never';
    const typeCls = s.access_type === 'admin' ? 'accent-text' : s.access_type === 'paid' ? 'success-text' : 'warn-text';
    const actionBtns = s.access_type !== 'admin'
      ? `<button class="evt-btn" onclick="extendAccess(${s.id},'${s.access_type}')">Extend</button><button class="evt-btn danger" onclick="revokeAccess(${s.id})">Revoke</button>`
      : '';
    return `<div class="admin-row">
      <div class="admin-row-info">
        <div class="admin-row-title">${s.email}</div>
        <div class="admin-row-meta"><span class="${typeCls}">${s.access_type.toUpperCase()}</span> · Expires: ${expLabel}${expired?' <span class="att-text">⚠ EXPIRED</span>':''}</div>
      </div>
      <div class="admin-row-btns">${actionBtns}</div>
    </div>`;
  }).join('');
}

function showAddStreamer() {
  document.getElementById('add-streamer-form').style.display = 'block';
  const d = new Date(); d.setMonth(d.getMonth() + 3);
  document.getElementById('new-expiry').value = d.toISOString().split('T')[0];
}

async function addStreamer() {
  const email = document.getElementById('new-email').value.trim();
  const pass = document.getElementById('new-pass').value.trim();
  const type = document.getElementById('new-type').value;
  const expiry = document.getElementById('new-expiry').value;
  const err = document.getElementById('add-err');
  if (!email || !pass) { err.style.display='block'; err.textContent='Email and password required.'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('#add-streamer-form .btn-accent');
  if (btn) { btn.textContent='Adding…'; btn.disabled=true; }
  const result = await db('add_streamer', { email, password: pass, access_type: type, expires_at: expiry ? new Date(expiry).toISOString() : null });
  if (btn) { btn.textContent='Add streamer'; btn.disabled=false; }
  if (result && result.error) { err.style.display='block'; err.textContent=result.error; return; }
  document.getElementById('add-streamer-form').style.display = 'none';
  document.getElementById('new-email').value = '';
  document.getElementById('new-pass').value = '';
  loadStreamers();
}

async function extendAccess(id, type) {
  const months = prompt('Extend by how many months?', '3');
  if (!months || isNaN(months)) return;
  const d = new Date(); d.setMonth(d.getMonth() + parseInt(months));
  await db('update_streamer', { id, access_type: type, expires_at: d.toISOString() });
  loadStreamers();
}

async function revokeAccess(id) {
  if (!confirm('Revoke this streamer access?')) return;
  await db('remove_streamer', { id });
  loadStreamers();
}

function switchAdminTab(tab) {
  ['streamers-list','waitlist-list','bugs-list','add-streamer-form'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  ['btn-tab-streamers','btn-tab-waitlist','btn-tab-bugs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.borderColor='var(--border)'; el.style.color='var(--txt3)'; }
  });
  if (tab === 'waitlist') {
    document.getElementById('waitlist-list').style.display = 'block';
    const btn = document.getElementById('btn-tab-waitlist');
    if (btn) { btn.style.borderColor='var(--mid)'; btn.style.color='var(--mid)'; }
    loadWaitlist();
  } else if (tab === 'bugs') {
    document.getElementById('bugs-list').style.display = 'block';
    const btn = document.getElementById('btn-tab-bugs');
    if (btn) { btn.style.borderColor='var(--att)'; btn.style.color='var(--att)'; }
    loadBugReports();
  } else {
    document.getElementById('streamers-list').style.display = 'block';
    const btn = document.getElementById('btn-tab-streamers');
    if (btn) { btn.style.borderColor='var(--accent)'; btn.style.color='var(--accent)'; }
  }
}

// Bug reports
function toggleBugForm() {
  const form = document.getElementById('bug-form');
  const btn = document.getElementById('bug-toggle-btn');
  const isOpen = form.style.display !== 'none';
  form.style.display = isOpen ? 'none' : 'block';
  btn.textContent = isOpen ? 'Report →' : 'Cancel';
  document.getElementById('bug-err').style.display = 'none';
  document.getElementById('bug-success').style.display = 'none';
}

async function submitBug() {
  const category = document.getElementById('bug-category').value;
  const description = document.getElementById('bug-description').value.trim();
  const steps = document.getElementById('bug-steps').value.trim();
  const err = document.getElementById('bug-err');
  const success = document.getElementById('bug-success');
  if (!description) { err.style.display='block'; err.textContent='Please describe the bug.'; return; }
  err.style.display = 'none';
  const streamerEmail = lsGet('ffm_streamer_email', 'anonymous');
  await db('submit_bug', { streamer_email: streamerEmail, category, description, steps });
  form.style.display = 'none';
  success.style.display = 'block';
}

async function loadBugReports() {
  const list = document.getElementById('bugs-items') || document.getElementById('bugs-list');
  if (!list) return;
  list.innerHTML = '<div class="empty-msg">Loading…</div>';
  const data = await db('get_bugs', {});
  if (!Array.isArray(data) || !data.length) { list.innerHTML = '<div class="empty-msg">No bug reports yet.</div>'; return; }
  const catLabels = { scoring: 'Scoring', picks: 'Picks', ui: 'UI', ai: 'AI/OCR', other: 'Other' };
  const open = data.filter(b => !b.resolved);
  const closed = data.filter(b => b.resolved);
  const renderBug = b => {
    const date = new Date(b.created_at).toLocaleDateString('en-GB');
    const cat = catLabels[b.category] || b.category;
    const statusTxt = b.resolved ? '✓ Resolved' : '● Open';
    const toggleLabel = b.resolved ? 'Re-open' : 'Resolve';
    return `<div class="bug-row">
      <div class="bug-row-header">
        <span class="bug-cat">${cat}</span>
        <span class="${b.resolved ? 'txt3' : 'att-text'}">${statusTxt}</span>
        <span class="txt3 small">${date} · ${b.streamer_email}</span>
        <button class="evt-btn ${b.resolved?'':'success'}" onclick="resolveBug(${b.id},${!b.resolved})">${toggleLabel}</button>
      </div>
      <div class="bug-desc">${b.description}</div>
      ${b.steps ? `<div class="bug-steps">${b.steps}</div>` : ''}
    </div>`;
  };
  let html = '';
  if (open.length) { html += `<div class="admin-group-label att">Open (${open.length})</div>${open.map(renderBug).join('')}`; }
  if (closed.length) { html += `<div class="admin-group-label">Resolved (${closed.length})</div>${closed.map(renderBug).join('')}`; }
  list.innerHTML = html;
}

async function resolveBug(id, resolved) {
  await db('resolve_bug', { id, resolved });
  loadBugReports();
}

window.renderAdminTab = renderAdminTab;
window.adminEndSession = adminEndSession;
window.adminInspectSession = adminInspectSession;
window.closeInspectModal = closeInspectModal;
window.loadWaitlist = loadWaitlist;
window.grantFromWaitlist = grantFromWaitlist;
window.removeWaitlist = removeWaitlist;
window.loadStreamers = loadStreamers;
window.showAddStreamer = showAddStreamer;
window.addStreamer = addStreamer;
window.extendAccess = extendAccess;
window.revokeAccess = revokeAccess;
window.switchAdminTab = switchAdminTab;
window.toggleBugForm = toggleBugForm;
window.submitBug = submitBug;
window.loadBugReports = loadBugReports;
window.resolveBug = resolveBug;

// ── Startup ───────────────────────────────────────────────────────────────────
async function init() {
  setLang(currentLang);
  loadLastSubmission();

  // Restore streamer auth
  if (lsGet('ffm_streamer_authed') === 'true') {
    streamerAuthed = true;
  }

  // Restore streamer session
  const hadSession = loadStreamerState();
  if (hadSession) {
    await reloadFromDB();
    if (S.isLive) restoreUI();
    else {
      const rp = document.getElementById('sp-rejoin');
      if (rp) rp.style.display = 'block';
    }
  } else {
    const rp = document.getElementById('sp-rejoin');
    if (rp) rp.style.display = 'block';
  }

  // Restore UI mode
  const savedMode = lsGet('ffm_ui_mode');
  if (savedMode === 'streamer' && checkStreamerAuth()) setUIMode('streamer');
  else clearUIMode();

  // Handle OAuth return
  checkOAuthReturn();
  checkCheckoutReturn();

  // Auto-rejoin viewer session
  await autoRejoinViewer();

  // If streamer is logged in but viewer auto-join went to wrong session, show rejoin panel
  const myStreamerSession = lsGet('ffm_streamer_session');
  if (checkStreamerAuth() && myStreamerSession && S.sessionCode !== myStreamerSession) {
    const rp = document.getElementById('sp-rejoin');
    if (rp) {
      rp.style.display = 'block';
      const inp = document.getElementById('rejoin-code-input');
      if (inp) inp.value = myStreamerSession;
    }
  }

  renderStreamerTab();
}

document.addEventListener('DOMContentLoaded', init);
