// ─── auth.js ──────────────────────────────────────────────────────────────────
// Streamer login/logout, OAuth return, UI mode management.

let streamerAuthed = false;
let uiMode = 'viewer'; // 'viewer' | 'streamer' | 'mod'
let oauthUser = null;   // { username, platform, oauthId, avatar }

// ── UI Mode ───────────────────────────────────────────────────────────────────
function setUIMode(mode) {
  uiMode = mode;
  lsSet('ffm_ui_mode', mode);
  const isStreamer = mode === 'streamer';
  const isMod = mode === 'mod';
  // Show/hide streamer-only nav items
  ['nb-setup', 'nb-live'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (isStreamer || isMod) ? '' : 'none';
  });
  const adminTab = document.getElementById('nb-admin');
  if (adminTab) {
    const isAdmin = lsGet('ffm_access_type') === 'admin';
    adminTab.style.display = isStreamer && isAdmin ? '' : 'none';
  }
  lsSet('ffm_ui_mode', mode);
}

function clearUIMode() {
  uiMode = 'viewer';
  lsRemove('ffm_ui_mode');
  ['nb-setup', 'nb-live', 'nb-admin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function checkStreamerAuth() {
  return lsGet('ffm_streamer_authed') === 'true' && !!lsGet('ffm_streamer_jwt');
}

// ── Tab routing ───────────────────────────────────────────────────────────────
function goTab(id, btnEl) {
  // Protect streamer-only tabs
  if ((id === 'setup' || id === 'live') && uiMode !== 'streamer' && uiMode !== 'mod') {
    goTab('home'); return;
  }
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const sec = document.getElementById('sec-' + id);
  if (sec) sec.classList.add('active');
  // Activate the matching nav button
  const nb = btnEl || document.getElementById('nb-' + id);
  if (nb) nb.classList.add('active');
  // Trigger renders when switching to these tabs
  if (id === 'league') { if (typeof renderLeague === 'function') renderLeague(); }
  if (id === 'live' && S.isLive) {
    if (typeof renderScoring === 'function') { renderScoring(); refreshLog(); refreshStats(); renderInsights(); renderViewerList(); }
  }
  if (id === 'admin' && checkStreamerAuth() && lsGet('ffm_access_type') === 'admin') {
    if (typeof renderAdminTab === 'function') renderAdminTab();
  }
  if (id === 'streamer') { if (typeof renderStreamerTab === 'function') renderStreamerTab(); }
  if (id === 'setup') { if (typeof updateSetupTabLabel === 'function') updateSetupTabLabel(); }
}

// ── Streamer login ────────────────────────────────────────────────────────────
async function streamerLogin() {
  const email = document.getElementById('str-email').value.trim();
  const pass = document.getElementById('str-pass').value;
  const err = document.getElementById('str-err');
  if (!email || !pass) { err.style.display = 'block'; err.textContent = 'Please enter your email and password.'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('#str-login .btn-accent');
  if (btn) { btn.textContent = 'Signing in...'; btn.disabled = true; }
  try {
    const data = await db('auth_login', { email, password: pass });
    if (data.error) {
      err.style.display = 'block';
      if (data.error === 'NEEDS_PAYMENT') {
        err.innerHTML = 'A subscription is required. <a href="#" onclick="document.getElementById(\'checkout-section\').scrollIntoView({behavior:\'smooth\'});return false;" style="color:var(--accent);text-decoration:underline">Subscribe below →</a>';
      } else if (data.error === 'SUBSCRIPTION_EXPIRED') {
        err.innerHTML = 'Subscription expired. <a href="#" onclick="document.getElementById(\'checkout-section\').scrollIntoView({behavior:\'smooth\'});return false;" style="color:var(--accent);text-decoration:underline">Renew below →</a>';
      } else {
        err.textContent = data.error;
      }
    } else {
      lsSet('ffm_streamer_authed', 'true');
      lsSet('ffm_streamer_email', data.email);
      lsSet('ffm_access_type', data.access_type || 'beta');
      lsSet('ffm_channel_name', data.channel_name || '');
      if (data.access_token) lsSet('ffm_streamer_jwt', data.access_token);
      if (data.user_id) lsSet('ffm_streamer_uid', data.user_id);
      streamerAuthed = true;
      setUIMode('streamer');
      renderStreamerTab();
    }
  } catch(e) {
    err.style.display = 'block';
    err.textContent = 'Connection error. Please try again.';
  } finally {
    if (btn) { btn.textContent = 'Sign in →'; btn.disabled = false; }
  }
}

function streamerLogout() {
  ['ffm_streamer_authed','ffm_streamer_email','ffm_access_type','ffm_channel_name',
   'ffm_streamer_jwt','ffm_streamer_uid','ffm_streamer_session'].forEach(k => lsRemove(k));
  streamerAuthed = false;
  clearUIMode();
  goTab('home', document.getElementById('nb-home'));
  renderStreamerTab();
}

// ── Stripe ────────────────────────────────────────────────────────────────────
async function startCheckout() {
  const email = document.getElementById('checkout-email').value.trim();
  const err = document.getElementById('checkout-err');
  if (!email || !email.includes('@')) { err.style.display='block'; err.textContent='Please enter a valid email.'; return; }
  err.style.display = 'none';
  const btn = document.getElementById('checkout-btn');
  if (btn) { btn.textContent = 'Redirecting...'; btn.disabled = true; }
  try {
    const result = await db('create_checkout', { email });
    if (result.error) { err.style.display='block'; err.textContent=result.error; }
    else if (result.url) window.location.href = result.url;
  } catch(e) {
    err.style.display='block'; err.textContent='Error. Please try again.';
  } finally {
    if (btn) { btn.textContent = 'Get access — £5/month →'; btn.disabled = false; }
  }
}

function checkCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    goTab('streamer', document.getElementById('nb-streamer'));
    const el = document.getElementById('checkout-success');
    if (el) el.style.display = 'block';
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('checkout') === 'cancelled') {
    goTab('streamer', document.getElementById('nb-streamer'));
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// ── OAuth viewer login ────────────────────────────────────────────────────────
function loginTwitch() {
  const code = document.getElementById('vcode').value.trim().toUpperCase();
  window.location.href = '/.netlify/functions/auth-twitch' + (code ? '?session=' + code : '');
}

function loginYouTube() {
  const code = document.getElementById('vcode').value.trim().toUpperCase();
  window.location.href = '/.netlify/functions/auth-google' + (code ? '?session=' + code : '');
}

function setOAuthUser(username, platform, avatar, oauthId) {
  oauthUser = { username, platform, oauthId, avatar };
  lsSetJson('ffm_oauth', oauthUser);
  renderOAuthUser();
}

function renderOAuthUser() {
  if (!oauthUser) return;
  const userEl = document.getElementById('oauth-user');
  const btnsEl = document.getElementById('oauth-btns');
  const nameEl = document.getElementById('oauth-name');
  const platEl = document.getElementById('oauth-platform');
  const avatarEl = document.getElementById('oauth-avatar');
  const joinBtn = document.getElementById('join-btn');
  if (userEl) userEl.style.display = 'flex';
  if (btnsEl) btnsEl.style.display = 'none';
  if (nameEl) nameEl.textContent = oauthUser.username;
  if (platEl) platEl.textContent = oauthUser.platform === 'twitch' ? 'Twitch' : 'YouTube';
  if (avatarEl && oauthUser.avatar) { avatarEl.src = oauthUser.avatar; avatarEl.style.display = 'block'; }
  if (joinBtn) { joinBtn.disabled = false; joinBtn.style.opacity = '1'; }
}

function clearOAuth() {
  oauthUser = null;
  lsRemove('ffm_oauth');
  const userEl = document.getElementById('oauth-user');
  const btnsEl = document.getElementById('oauth-btns');
  if (userEl) userEl.style.display = 'none';
  if (btnsEl) btnsEl.style.display = 'flex';
  clearUIMode();
  goTab('home', document.getElementById('nb-home'));
}

function checkOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const oauth = params.get('oauth');
  if (oauth === 'twitch' || oauth === 'youtube') {
    const username = params.get('username');
    const id = params.get('id');
    const avatar = params.get('avatar') || '';
    const session = params.get('session') || '';
    setOAuthUser(username, oauth, avatar, id);
    if (session) {
      const el = document.getElementById('vcode');
      if (el) el.value = session;
    }
    goTab('viewer', document.getElementById('nb-viewer'));
    window.history.replaceState({}, '', window.location.pathname);
  } else if (oauth === 'error') {
    goTab('viewer', document.getElementById('nb-viewer'));
    const err = document.getElementById('vjoin-err');
    if (err) { err.style.display = 'block'; err.textContent = 'Sign in failed. Please try again.'; }
    window.history.replaceState({}, '', window.location.pathname);
  }
  // Restore from localStorage
  const saved = lsGetJson('ffm_oauth');
  if (saved && !oauthUser) {
    oauthUser = saved;
    renderOAuthUser();
  }
}

// ── Streamer tab renderer ─────────────────────────────────────────────────────
function renderStreamerTab() {
  if (checkStreamerAuth()) {
    document.getElementById('str-login').style.display = 'none';
    document.getElementById('str-dash').style.display = 'block';
    const email = lsGet('ffm_streamer_email', '');
    const welcome = document.getElementById('str-welcome');
    if (welcome) welcome.textContent = email || 'Welcome back';
    const channelName = lsGet('ffm_channel_name', '');
    const cnInput = document.getElementById('channel-name-input');
    if (cnInput) cnInput.value = channelName;
    const banner = document.getElementById('profile-banner');
    if (banner) banner.style.display = channelName ? 'none' : 'block';
    if (lsGet('ffm_access_type') === 'admin') {
      const adminPanel = document.getElementById('admin-panel');
      if (adminPanel) adminPanel.style.display = 'block';
      loadStreamers();
      const adminTab = document.getElementById('nb-admin');
      if (adminTab) adminTab.style.display = '';
    }
    loadTwitchChannel();
  } else {
    document.getElementById('str-login').style.display = 'block';
    document.getElementById('str-dash').style.display = 'none';
  }
}

async function saveChannelName() {
  const input = document.getElementById('channel-name-input');
  const status = document.getElementById('channel-name-status');
  const jwt = lsGet('ffm_streamer_jwt');
  if (!input || !jwt) return;
  const val = input.value.trim();
  if (!val) { if (status) { status.textContent='Please enter a channel name.'; status.style.color='var(--att)'; } return; }
  if (status) { status.textContent='Saving...'; status.style.color='var(--txt3)'; }
  const res = await db('update_channel_name', { channel_name: val, user_jwt: jwt });
  if (res && res.ok) {
    lsSet('ffm_channel_name', val);
    if (status) { status.textContent='✓ Saved'; status.style.color='#4aff91'; }
    const banner = document.getElementById('profile-banner');
    if (banner) banner.style.display = 'none';
    setTimeout(() => { if (status) status.textContent = ''; }, 2500);
  } else {
    if (status) { status.textContent='Error saving.'; status.style.color='var(--att)'; }
  }
}

window.streamerAuthed = streamerAuthed;
window.uiMode = uiMode;
window.oauthUser = oauthUser;
window.setUIMode = setUIMode;
window.clearUIMode = clearUIMode;
window.checkStreamerAuth = checkStreamerAuth;
window.goTab = goTab;
window.streamerLogin = streamerLogin;
window.streamerLogout = streamerLogout;
window.startCheckout = startCheckout;
window.checkCheckoutReturn = checkCheckoutReturn;
window.loginTwitch = loginTwitch;
window.loginYouTube = loginYouTube;
window.setOAuthUser = setOAuthUser;
window.renderOAuthUser = renderOAuthUser;
window.clearOAuth = clearOAuth;
window.checkOAuthReturn = checkOAuthReturn;
window.renderStreamerTab = renderStreamerTab;
window.saveChannelName = saveChannelName;
