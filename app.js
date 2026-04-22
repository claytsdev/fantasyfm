let S={sessionCode:null,roster:[],events:[],viewers:{},isLive:false,type:'oneoff',seasonEnd:null,allowNewJoiners:true,transfersPerViewer:3};
let pendingMatch=[];
let pendingMatchResult=null;
function sanitise(str,maxLen=100){
  if(typeof str!=='string')return '';
  return str.replace(/[<>"'`]/g,'').trim().slice(0,maxLen);
}

const SC={DEF:{goal:3,assist:3,clean_sheet:5},MID:{goal:3,assist:5,clean_sheet:3},ATT:{goal:5,assist:3,clean_sheet:1}};
const BONUS={motm:5,rating:1};
const EL={goal:'Goal',assist:'Assist',clean_sheet:'Clean sheet',motm:'Player of the Match',rating:'Rating bonus',yellow_card:'Yellow card',red_card:'Red card',manual_adjust:'Manual adjustment'};
const PL={DEF:'Defenders',MID:'Midfielders',ATT:'Attackers'};
const CAP_MULTIPLIER=2; // Captain gets 2x points

// ── DB helpers ──────────────────────────────────────────────────────────────
async function db(action,payload){
  const r=await fetch('/.netlify/functions/claude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});
  return r.json();
}

// ── Local state helpers ──────────────────────────────────────────────────────
function save(){try{localStorage.setItem('ffm_state',JSON.stringify({sessionCode:S.sessionCode,isLive:S.isLive,type:S.type,seasonEnd:S.seasonEnd,allowNewJoiners:S.allowNewJoiners,transfersPerViewer:S.transfersPerViewer,viewerName:oauthUser?oauthUser.username:null}));}catch(e){}}
function saveAvatar(name,dataUrl){try{localStorage.setItem('ffm_av_'+name,dataUrl);}catch(e){}}
function loadAvatar(name){try{return localStorage.getItem('ffm_av_'+name)||null;}catch(e){return null;}}
function clearAvatars(){try{Object.keys(localStorage).filter(k=>k.startsWith('ffm_av_')).forEach(k=>localStorage.removeItem(k));}catch(e){}}

async function load(){
  try{
    const r=localStorage.getItem('ffm_state');
    if(r){
      const saved=JSON.parse(r);
      if(saved.sessionCode){
        S.sessionCode=saved.sessionCode;
        S.isLive=saved.isLive||false;
        S.type=saved.type||'oneoff';
        S.seasonEnd=saved.seasonEnd||null;
        S.allowNewJoiners=saved.allowNewJoiners!==undefined?saved.allowNewJoiners:true;
        S.transfersPerViewer=saved.transfersPerViewer||3;
        // Reload from DB
        await reloadFromDB();
        if(saved.isLive)restoreUI();
      }
    }
  }catch(e){}
}

async function reloadFromDB(){
  if(!S.sessionCode)return;
  const [session,roster,events,viewers]=await Promise.all([
    db('get_session',{session_id:S.sessionCode}),
    db('get_roster',{session_id:S.sessionCode}),
    db('get_events',{session_id:S.sessionCode}),
    db('get_viewers',{session_id:S.sessionCode})
  ]);
  if(session){
    S.isLive=session.is_live;
    S.type=session.type||'oneoff';
    S.seasonEnd=session.season_end||null;
    S.allowNewJoiners=session.allow_new_joiners!==undefined?session.allow_new_joiners:true;
    S.transfersPerViewer=session.transfers_per_viewer||3;
    // Sync entries lock state from DB (source of truth)
    if(session.is_entries_locked !== undefined){
      entriesLocked = !!session.is_entries_locked;
      _applyEntriesToggleUI();
      try{ localStorage.setItem('ffm_entries_locked', entriesLocked ? '1' : '0'); }catch(e){}
    }
  }
  // Only overwrite roster if DB returned a valid array — never wipe on error/non-array response
  if(Array.isArray(roster)){S.roster=roster.map(p=>({name:p.name,pos:p.pos,avatar:loadAvatar(p.name)}));}
  // ── CRITICAL: update events so getScore() reflects latest DB state ──
  if(Array.isArray(events)){
    S.events=events.map(e=>({player:e.player_name,pos:e.pos,eventType:e.event_type,points:Number(e.points),time:new Date(e.created_at).toLocaleTimeString(),ts:new Date(e.created_at).getTime()}));
  }
  const prevViewers=S.viewers||{};
  S.viewers={};
  if(Array.isArray(viewers)){
    viewers.forEach(v=>{
      S.viewers[v.viewer_name]={
        picks:{DEF:v.pick_def||null,MID:v.pick_mid||null,ATT:v.pick_att||null,CAP:v.pick_cap||null},
        locked:v.locked,
        platform:v.platform||'manual',
        oauthId:v.oauth_id||null,
        lockedAtTs:v.events_at_lock||0,
        transfersUsed:v.transfers_used||0,
        isMod:v.is_mod||false
      };
    });
  }
  // Restore any in-progress OR recently-locked picks that weren't yet saved to DB
  Object.keys(prevViewers).forEach(name=>{
    const prev=prevViewers[name];
    const localPicks=prev.picks||{};
    if(!S.viewers[name])S.viewers[name]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:prev.locked||false};
    // For both locked and unlocked viewers: restore any non-null local picks not yet in DB
    Object.keys(localPicks).forEach(pos=>{
      if(localPicks[pos]&&!S.viewers[name].picks[pos]){
        S.viewers[name].picks[pos]=localPicks[pos];
      }
    });
    // Preserve locked state from local if DB hasn't caught up yet
    if(prev.locked)S.viewers[name].locked=true;
    // Preserve lockedAtTs — never let it decrease (DB returning 0 on a race would grant retroactive points)
    if(prev.lockedAtTs && (!S.viewers[name].lockedAtTs || prev.lockedAtTs > S.viewers[name].lockedAtTs)){
      S.viewers[name].lockedAtTs=prev.lockedAtTs;
    }
  });
  // Also restore from localStorage for current oauth user (covers brief window between lock and DB write)
  if(oauthUser){
    const name=oauthUser.username;
    try{
      const saved=localStorage.getItem('ffm_viewer_picks_'+name);
      if(saved&&S.viewers[name]){
        const p=JSON.parse(saved);
        Object.keys(p).forEach(pos=>{if(p[pos])S.viewers[name].picks[pos]=p[pos];});
      }
    }catch(e){}
  }
}

function restoreUI(){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('sec-setup').classList.add('active');
  document.getElementById('nb-setup').classList.add('active');
  document.getElementById('sp-upload').style.display='none';
  document.getElementById('sp-roster').style.display='none';
  document.getElementById('sp-done').style.display='block';
  document.getElementById('code-val').textContent=S.sessionCode;
  document.getElementById('session-pill').textContent=S.sessionCode;
  document.getElementById('live-pill').style.display='inline-block';
  document.getElementById('live-locked').style.display='none';
  document.getElementById('live-panel').style.display='block';
  document.getElementById('lg-empty').style.display='none';
  document.getElementById('lg-panel').style.display='block';
  renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();renderViewerList();
  startPolling();
  updateOverlayUrl();
  loadLastMatch();
  if(checkStreamerAuth()){
    document.getElementById('nb-streamer').style.color='var(--accent)';
  }
  setUIMode('streamer');
  // Restore entries lock state
  try{
    const saved = localStorage.getItem('ffm_entries_locked');
    if(saved !== null){ entriesLocked = saved === '1'; _applyEntriesToggleUI(); }
  }catch(e){}
  // Restore season UI elements
  const seasonBadge=document.getElementById('season-badge');
  const seasonSettingsBtn=document.getElementById('season-settings-btn');
  const endResetBtn=document.getElementById('end-reset-btn');
  if(seasonBadge)seasonBadge.style.display=S.type==='season'?'inline-block':'none';
  if(seasonSettingsBtn)seasonSettingsBtn.style.display=S.type==='season'?'inline-block':'none';
  if(endResetBtn)endResetBtn.textContent=S.type==='season'?'End Season':'Reset session';
  updateSquadTab();
  updateSetupTabLabel();
  renderSquadManage();
}

let pollInterval=null; // kept for fallback only
let ablyClient=null;
let ablyChannel=null;

function startAbly(){
  if(!S.sessionCode)return;
  // Clean up any existing connection
  stopAbly();

  // If Ably SDK not loaded, fall back to polling
  if(typeof Ably==='undefined'){
    console.warn('Ably SDK not loaded — falling back to polling');
    startPollingFallback();
    return;
  }

  try{
    ablyClient=new Ably.Realtime({
      authCallback: async (tokenParams, callback) => {
        try {
          const r = await fetch('/.netlify/functions/claude', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: 'ably_token', payload: {session_id: S.sessionCode}})
          });
          const token = await r.json();
          if (token.error) { callback(token.error, null); return; }
          callback(null, token);
        } catch(e) { callback(e.message, null); }
      }
    });

    ablyClient.connection.on('failed',()=>{
      console.warn('Ably connection failed — falling back to polling');
      stopAbly();
      startPollingFallback();
    });

    const channelName=`ffm-${S.sessionCode}`;
    ablyChannel=ablyClient.channels.get(channelName);
    ablyChannel.subscribe('state_changed',async(msg)=>{
      if(!S.sessionCode)return;
      await reloadFromDB();
      renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();
      renderViewerList();
      const vdash=document.getElementById('vp-dash');
      if(vdash&&vdash.style.display!=='none'){
        const vname=vdash.dataset.viewer;
        if(vname)showDash(vname,false);
      }
      // If current viewer was just promoted/demoted, update their UI mode
      if(oauthUser&&(msg.data.type==='mod_promoted'||msg.data.type==='mod_demoted')){
        const vdata=S.viewers[oauthUser.username];
        if(vdata){
          const shouldBeMod=vdata.isMod;
          if(shouldBeMod&&uiMode!=='mod')setUIMode('mod');
          else if(!shouldBeMod&&uiMode==='mod')setUIMode('viewer');
        }
      }
    });
  }catch(e){
    console.warn('Ably init error — falling back to polling',e);
    startPollingFallback();
  }
}

function stopAbly(){
  if(ablyChannel){try{ablyChannel.unsubscribe();}catch(e){}ablyChannel=null;}
  if(ablyClient){try{ablyClient.close();}catch(e){}ablyClient=null;}
  if(pollInterval){clearInterval(pollInterval);pollInterval=null;}
}

function startPollingFallback(){
  if(pollInterval)clearInterval(pollInterval);
  pollInterval=setInterval(async()=>{
    if(!S.sessionCode)return;
    await reloadFromDB();
    renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();
    const vdash=document.getElementById('vp-dash');
    if(vdash&&vdash.style.display!=='none'){
      const vname=vdash.dataset.viewer;
      if(vname)showDash(vname,false);
    }
  },5000);
}

// Legacy alias so any remaining callsites keep working
function startPolling(){ startAbly(); }

// goTab defined in auth section below

function showManual(){S.roster=[];addBlank();document.getElementById('sp-upload').style.display='none';document.getElementById('sp-roster').style.display='block';}

async function callClaude(messages,maxTokens=1200){
  const res=await fetch('/.netlify/functions/claude',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({messages,max_tokens:maxTokens})
  });
  const data=await res.json();
  if(data.error) throw new Error(data.error.message||JSON.stringify(data.error));
  if(!data.content) throw new Error('No response from AI: '+JSON.stringify(data));
  return data.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim();
}

async function doSquadUpload(e){
  const file=e.target.files[0];if(!file)return;
  const allowed=['image/png','image/jpeg','image/jpg','image/webp'];
  if(!allowed.includes(file.type)){alert('Please upload a PNG, JPEG or WebP image.');return;}
  if(file.size>10*1024*1024){alert('Image too large. Please use a screenshot under 10MB.');return;}
  const reader=new FileReader();
  reader.onload=async function(ev){
    const b64=ev.target.result.split(',')[1];
    document.getElementById('squad-img').src=ev.target.result;
    document.getElementById('squad-preview').style.display='block';
    runSquadRead(b64,file.type||'image/png');
  };
  reader.readAsDataURL(file);
}

async function runSquadRead(b64,mime){
  document.getElementById('squad-loading').style.display='block';
  document.getElementById('squad-err').style.display='none';
  try{
    const txt=await callClaude([{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:mime,data:b64}},
      {type:'text',text:`This is a Football Manager squad screen. List ALL visible players including goalkeepers in strict top-to-bottom order. For each player also identify the bounding box of their face/photo thumbnail — the small player portrait image in the row. Express the bounding box as percentages of total image dimensions: fx=left edge %, fy=top edge %, fw=width %, fh=height %.

POSITION MAPPING: ${t('squad_prompt_positions')} Output must use only: GK, DEF, MID, ATT.

CRITICAL: Preserve ALL diacritical and special characters exactly — Polish (ł,ą,ę,ó,ś,ź,ż,ć,ń), French (é,à,ç,è,ê), German (ü,ö,ä,ß), Spanish (ñ,á,é,í,ó,ú). Do NOT substitute with ASCII.

Respond ONLY with JSON array, no markdown: [{"name":"Player Name","pos":"DEF","fx":2.1,"fy":6.8,"fw":3.5,"fh":5.2}]`}
    ]}],1800);
    const allPlayers=JSON.parse(txt);
    // Filter to outfield only
    S.roster=allPlayers.filter(p=>p.pos!=='GK');
    document.getElementById('squad-loading').style.display='none';
    document.getElementById('sp-upload').style.display='none';
    document.getElementById('sp-roster').style.display='block';
    renderRoster();
  }catch(err){
    document.getElementById('squad-loading').style.display='none';
    const el=document.getElementById('squad-err');
    el.style.display='block';
    el.textContent='Could not read screenshot automatically. Try a clearer image, or enter your squad manually.';
    S.roster=[];
    document.getElementById('sp-upload').style.display='none';
    document.getElementById('sp-roster').style.display='block';
    renderRoster();
  }
}

// Crop player faces using exact bounding boxes returned by Claude.
// Works across all FM screenshot layouts regardless of column order or screen size.
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
          // Convert % to pixels
          const x = Math.round(p.fx / 100 * W);
          const y = Math.round(p.fy / 100 * H);
          const w = Math.round(p.fw / 100 * W);
          const h = Math.round(p.fh / 100 * H);
          if (w < 4 || h < 4) return;

          const fc = document.createElement('canvas');
          fc.width = faceSize; fc.height = faceSize;
          fc.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, faceSize, faceSize);
          p.avatar = fc.toDataURL('image/jpeg', 0.85);
          cropped++;
        });
        console.log(`Cropped ${cropped}/${players.length} faces via bounding boxes`);
        resolve();
      } catch(e) { console.warn('cropFacesByBoundingBox error', e); resolve(); }
    };
    imgEl.onerror = () => resolve();
    imgEl.src = `data:${mime};base64,${b64}`;
  });
}


function posAvatar(pos, size) {
  size = size || 28;
  const colours = {DEF:'#4a9eff', MID:'#f5a623', ATT:'#ff5a5a'};
  const bg = colours[pos] || '#3a3e52';
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:4px;background:${bg};flex-shrink:0;margin-right:6px"><svg width="${Math.round(size*0.55)}" height="${Math.round(size*0.55)}" viewBox="0 0 20 20" fill="rgba(255,255,255,0.9)" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="6" r="4"/><path d="M2 18c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg></span>`;
}

function renderRoster(){
  const tbody=document.getElementById('roster-body');tbody.innerHTML='';
  S.roster.forEach((p,i)=>{
    const tr=document.createElement('tr');
    const av = posAvatar(p.pos, 28);
    tr.innerHTML=`<td style="display:flex;align-items:center">${av}<input class="roster-name-input" value="${p.name}" oninput="S.roster[${i}].name=this.value" placeholder="Player name" style="flex:1"></td><td><div class="pos-toggle">${['DEF','MID','ATT'].map(pos=>`<button class="pos-btn ${p.pos===pos?'p-'+pos:''}" onclick="setPos(${i},'${pos}')">${pos}</button>`).join('')}</div></td><td><button class="remove-btn" onclick="rmPlayer(${i})">&#x2715;</button></td>`;
    tbody.appendChild(tr);
  });
}
function setPos(i,pos){S.roster[i].pos=pos;renderRoster();}
function rmPlayer(i){S.roster.splice(i,1);renderRoster();}
function addBlank(){S.roster.push({name:'',pos:'MID'});renderRoster();}

function showSecondScreenshot(){
  const el=document.getElementById('second-screenshot');
  if(el)el.style.display=el.style.display==='none'?'block':'none';
}

async function doSquadUpload2(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async function(ev){
    runSquadRead2(ev.target.result.split(',')[1],file.type||'image/png');
  };
  reader.readAsDataURL(file);
}

async function runSquadRead2(b64,mime){
  document.getElementById('squad2-loading').style.display='block';
  try{
    const txt=await callClaude([{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:mime,data:b64}},
      {type:'text',text:'This is a Football Manager squad screen. List every visible OUTFIELD player only. Do NOT include goalkeepers (GK). CRITICAL: Preserve ALL diacritical and special characters exactly as shown — Polish (ł, ą, ę, ó, ś, ź, ż, ć, ń), French (é, à, ç), German (ü, ö, ä), Spanish (ñ), and any other non-ASCII letters. Do NOT substitute with ASCII equivalents. Respond ONLY with JSON array: [{"name":"Player Name","pos":"DEF"}]. Positions: DEF, MID, ATT only.'}
    ]}],800);
    const newPlayers=JSON.parse(txt);
    // Merge with existing roster, avoid duplicates
    const existingNames=S.roster.map(p=>p.name.toLowerCase());
    const toAdd=newPlayers.filter(p=>!existingNames.includes(p.name.toLowerCase()));
    S.roster=[...S.roster,...toAdd];
    document.getElementById('squad2-loading').style.display='none';
    document.getElementById('second-screenshot').style.display='none';
    renderRoster();
  }catch(err){
    document.getElementById('squad2-loading').style.display='none';
  }
}

async function goLive(){
  const valid=S.roster.filter(p=>p.name.trim());
  if(!valid.some(p=>p.pos==='DEF')||!valid.some(p=>p.pos==='MID')||!valid.some(p=>p.pos==='ATT')){alert('You need at least one DEF, one MID, and one ATT.');return;}
  S.roster=valid;
  // Show session type picker instead of going live immediately
  showSessionTypeModal();
}

function showSessionTypeModal(){
  const m=document.getElementById('session-type-modal');
  if(m)m.style.display='flex';
}
function hideSessionTypeModal(){
  const m=document.getElementById('session-type-modal');
  if(m)m.style.display='none';
}
function showSeasonSetupModal(){
  hideSessionTypeModal();
  const m=document.getElementById('season-setup-modal');
  if(m)m.style.display='flex';
}
function hideSeasonSetupModal(){
  const m=document.getElementById('season-setup-modal');
  if(m)m.style.display='none';
}

async function startOneOff(){
  hideSessionTypeModal();
  await _goLive('oneoff');
}

async function startSeason(){
  const seasonName=document.getElementById('season-name-input').value.trim();
  const allowNewJoiners=document.getElementById('allow-new-joiners').checked;
  const transfersPerViewer=parseInt(document.getElementById('transfers-per-viewer').value,10);
  if(isNaN(transfersPerViewer)||transfersPerViewer<1){alert('Transfers must be at least 1.');return;}
  hideSeasonSetupModal();
  S.seasonEnd=null;
  S.seasonName=seasonName||null;
  S.allowNewJoiners=allowNewJoiners;
  S.transfersPerViewer=transfersPerViewer;
  await _goLive('season');
}

async function _goLive(type){
  S.sessionCode=(()=>{const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='FM-';for(let i=0;i<6;i++)s+=chars[Math.floor(Math.random()*chars.length)];return s;})();
  S.isLive=true;S.type=type;S.events=[];S.viewers={};
  const _sjwt=localStorage.getItem('ffm_streamer_jwt')||null;
  const sessionPayload={id:S.sessionCode,user_jwt:_sjwt,type};
  if(type==='season'){
    sessionPayload.season_end=S.seasonEnd;
    sessionPayload.allow_new_joiners=S.allowNewJoiners;
    sessionPayload.transfers_per_viewer=S.transfersPerViewer;
  }
  const sessionResult = await db('create_session',sessionPayload);
  if(sessionResult && sessionResult.message === 'JWT expired'){
    alert('Your session has expired. Please log in again.');
    streamerLogout();
    return;
  }
  await db('save_roster',{session_id:S.sessionCode,players:S.roster});
  save();
  document.getElementById('code-val').textContent=S.sessionCode;
  document.getElementById('session-pill').textContent=S.sessionCode;
  document.getElementById('live-pill').style.display='inline-block';
  document.getElementById('sp-roster').style.display='none';
  document.getElementById('sp-done').style.display='block';
  document.getElementById('live-locked').style.display='none';
  document.getElementById('live-panel').style.display='block';
  document.getElementById('lg-empty').style.display='none';
  document.getElementById('lg-panel').style.display='block';
  // Show/hide season badge and settings button
  const seasonBadge=document.getElementById('season-badge');
  const seasonSettingsBtn=document.getElementById('season-settings-btn');
  const endResetBtn=document.getElementById('end-reset-btn');
  if(seasonBadge)seasonBadge.style.display=type==='season'?'inline-block':'none';
  if(seasonSettingsBtn)seasonSettingsBtn.style.display=type==='season'?'inline-block':'none';
  if(endResetBtn)endResetBtn.textContent=type==='season'?'End Season':'Reset session';
  updateSquadTab();
  updateSetupTabLabel();
  renderScoring();startPolling();updateOverlayUrl();loadLastMatch();
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

function closeChatCopyModal() {
  const el = document.getElementById('chat-copy-modal');
  if (el) el.style.display = 'none';
}

function copyChatText() {
  const ta = document.getElementById('chat-copy-text');
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    const btn = document.getElementById('chat-copy-btn');
    if (btn) { btn.textContent = 'Copied! ✓'; btn.style.background = '#22c55e'; setTimeout(() => { btn.textContent = 'Copy to clipboard'; btn.style.background = ''; }, 2000); }
  });
}

async function doMatchUpload(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=function(ev){
    matchReportB64=ev.target.result.split(',')[1];
    matchReportMime=file.type||'image/png';
    document.getElementById('match-img').src=ev.target.result;
    document.getElementById('match-preview').style.display='block';
    updateReadBtn();
  };
  reader.readAsDataURL(file);
}


function saveReferenceMatch(b64, mime, correctJson) {
  try {
    localStorage.setItem('ffm_ref_match', JSON.stringify({b64, mime, json: correctJson}));
    return true;
  } catch(e) { return false; }
}

function loadReferenceMatch() {
  try {
    const s = localStorage.getItem('ffm_ref_match');
    return s ? JSON.parse(s) : null;
  } catch(e) { return null; }
}

function saveCurrentAsReference() {
  // Grab the current match image b64 and the accepted JSON output
  const imgEl = document.getElementById('match-img');
  if (!imgEl || !imgEl.src || !pendingMatchResult) {
    alert('No match result to save. Upload a screenshot and confirm the result first.');
    return;
  }
  // Get b64 from the img src
  const src = imgEl.src;
  const b64 = src.includes('base64,') ? src.split('base64,')[1] : null;
  const mime = src.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  if (!b64) { alert('Could not read image data.'); return; }
  // Build the correct JSON from pendingMatch events and pendingMatchResult
  const playersJson = S.roster.filter(p => {
    return pendingMatch.some(e => e.player === p.name);
  }).map(p => {
    const evts = pendingMatch.filter(e => e.player === p.name);
    return {
      name: p.name,
      goals: evts.filter(e => e.eventType === 'goal').length,
      assists: evts.filter(e => e.eventType === 'assist').length,
      clean_sheet: evts.some(e => e.eventType === 'clean_sheet'),
      rating: (() => { const r = evts.find(e => e.eventType === 'rating'); if (!r) return 0; if (r.points === 3) return 9.0; if (r.points === 2) return 8.0; return 7.0; })(),
      motm: evts.some(e => e.eventType === 'motm')
    };
  });
  const mr = pendingMatchResult || {};
  const correctJson = JSON.stringify({
    match: { home: mr.home||'', homeScore: mr.homeScore||0, away: mr.away||'', awayScore: mr.awayScore||0, scorers: mr.scorers||[] },
    players: playersJson
  });
  if (saveReferenceMatch(b64, mime, correctJson)) {
    const btn = document.getElementById('ref-match-btn');
    const info = document.getElementById('ref-match-info');
    if (btn) { btn.textContent = '✓ Saved as reference'; btn.style.background = 'var(--accent-dark)'; }
    if (info) info.textContent = '✓ Reference saved — all future match reads will use this as an example';
  } else {
    alert('Could not save reference (storage full?).');
  }
}

// State for two-box uploads
let matchReportB64 = null, matchReportMime = null;
let statsScreenB64 = null, statsScreenMime = null;

function doStatsUpload(e){
  const file = e.target.files[0]; if(!file) return;
  const allowed = ['image/png','image/jpeg','image/jpg','image/webp'];
  if(!allowed.includes(file.type)){alert('Please upload a PNG, JPEG or WebP image.');return;}
  if(file.size > 10*1024*1024){alert('Image too large. Please use a screenshot under 10MB.');return;}
  const reader = new FileReader();
  reader.onload = function(ev){
    statsScreenB64 = ev.target.result.split(',')[1];
    statsScreenMime = file.type||'image/png';
    document.getElementById('stats-img').src = ev.target.result;
    document.getElementById('stats-preview').style.display = 'block';
    updateReadBtn();
  };
  reader.readAsDataURL(file);
}

function enlargeStatsImg(){
  const img = document.getElementById('stats-img');
  if(!img||!img.src) return;
  const lb = document.getElementById('match-lightbox');
  const lg = document.getElementById('match-img-large');
  if(lb&&lg){lg.src=img.src;lb.style.display='flex';}
}

function updateReadBtn(){
  const btn = document.getElementById('read-match-btn');
  if(!btn) return;
  const ready = !!statsScreenB64;
  btn.disabled = !ready;
  btn.style.opacity = ready ? '1' : '0.4';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
}

async function runBothReads(){
  if(!statsScreenB64) return;
  document.getElementById('match-loading').style.display='block';
  document.getElementById('match-err').style.display='none';
  document.getElementById('match-results').style.display='none';
  const names = S.roster.map(p=>sanitise(p.name,40)).join(', ');
  try{
    const prompt = `This is a Football Manager Player Stats screen. My squad players are: ${names}.

Read the table. For EVERY player whose name appears in my squad list above, extract their row data:
- name: exactly as shown in the Player column
- goals: the number in the "${t('stats_goals_col')}" column. 0 if dash or empty.
- assists: the number in the "${t('stats_assists_col')}" column. 0 if dash or empty.
- rating: the decimal number in the "${t('stats_rating_col')}" column (far right coloured pill). 0 if dash (-).
- time_played: look at the "Time" column (second column). Rules: (1) If blank/empty, the player played the full match — use 90. (2) If the player's rating is a dash (-) AND their Run distance is 0.0km, they did not play — use 0. (3) If there is a number in the Time column: if that number is greater than 45, the player was subbed OFF at that minute — use that number directly as minutes played (e.g. "72" = 72 mins played, "88" = 88 mins played). If that number is 45 or less, the player was subbed ON at that minute — calculate as 90 minus that number (e.g. came on at 30 = 60 mins played, came on at 45 = 45 mins played).
- run_km: the numeric value from the Run column (e.g. "7.6km" → 7.6, "0.0km" → 0.0).

Include ALL matching squad players even if they have 0 in every column.

Return ONLY valid JSON, no markdown:
{"players":[{"name":"Full Name","goals":0,"assists":1,"rating":7.5,"time_played":90,"run_km":7.6}]}`;

    const txt = await callClaude([{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:statsScreenMime,data:statsScreenB64}},
      {type:'text',text:prompt}
    ]}], 1500);
    const parsed = JSON.parse(txt);
    lastParsedPlayers = parsed.players||[];
    cleanSheetActive = false;
    motmActive = false;
    const csBtn = document.getElementById('cs-toggle');
    if(csBtn){csBtn.textContent=t('cs_off');csBtn.style.background='var(--bg4)';csBtn.style.color='var(--txt3)';csBtn.style.borderColor='var(--border)';}
    const motmBtn = document.getElementById('motm-toggle');
    if(motmBtn){motmBtn.textContent='OFF';motmBtn.style.background='var(--bg4)';motmBtn.style.color='var(--txt3)';motmBtn.style.borderColor='var(--border)';}
    const motmName = document.getElementById('motm-player-name');
    if(motmName) motmName.textContent = 'Awarded to highest-rated squad player';
    buildMatchPreview(lastParsedPlayers, {scorers:lastParsedPlayers.filter(p=>p.goals>0).map(p=>p.name)});
    saveLastSubmission(statsScreenB64, statsScreenMime);
    document.getElementById('match-loading').style.display='none';
  }catch(err){
    document.getElementById('match-loading').style.display='none';
    const el = document.getElementById('match-err');
    el.style.display='block';
    el.textContent='Could not read stats: '+err.message;
    console.error(err);
  }
}

function saveLastSubmission(b64, mime){
  try{
    const img = document.getElementById('last-sub-img');
    const content = document.getElementById('last-sub-content');
    const empty = document.getElementById('last-sub-empty');
    const date = document.getElementById('last-sub-date');
    if(img) img.src = 'data:'+mime+';base64,'+b64;
    if(content) content.style.display='block';
    if(empty) empty.style.display='none';
    if(date) date.textContent = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    try{ localStorage.setItem('ffm_last_sub_mime', mime); localStorage.setItem('ffm_last_sub_b64', b64); }catch(e){}
  }catch(e){}
}

function saveLastSubTitle(){
  try{ localStorage.setItem('ffm_last_sub_title', document.getElementById('last-sub-title').value); }catch(e){}
}

function enlargeLastSub(){
  const img = document.getElementById('last-sub-img');
  if(!img||!img.src) return;
  const lb = document.getElementById('match-lightbox');
  const lg = document.getElementById('match-img-large');
  if(lb&&lg){lg.src=img.src;lb.style.display='flex';}
}

function loadLastSubmission(){
  try{
    const b64 = localStorage.getItem('ffm_last_sub_b64');
    const mime = localStorage.getItem('ffm_last_sub_mime');
    const title = localStorage.getItem('ffm_last_sub_title');
    if(b64&&mime){
      const img = document.getElementById('last-sub-img');
      const content = document.getElementById('last-sub-content');
      const empty = document.getElementById('last-sub-empty');
      if(img) img.src = 'data:'+mime+';base64,'+b64;
      if(content) content.style.display='block';
      if(empty) empty.style.display='none';
    }
    if(title){ const el=document.getElementById('last-sub-title'); if(el)el.value=title; }
  }catch(e){}
}


let cleanSheetActive = false;
let lastParsedPlayers = [];
let motmActive = false;
let entriesLocked = false;

function toggleEntries(){
  entriesLocked = !entriesLocked;
  _applyEntriesToggleUI();
  try{ localStorage.setItem('ffm_entries_locked', entriesLocked ? '1' : '0'); }catch(e){}
  // Persist to DB so server enforces it on new join attempts
  if(S.sessionCode) db('set_entries_locked', { session_id: S.sessionCode, is_entries_locked: entriesLocked, user_jwt: localStorage.getItem('ffm_streamer_jwt') });
}

function _applyEntriesToggleUI(){
  const toggle = document.getElementById('entries-toggle');
  const knob = document.getElementById('entries-toggle-knob');
  const text = document.getElementById('entries-toggle-text');
  const label = document.getElementById('entries-label');
  if(entriesLocked){
    if(toggle){ toggle.style.borderColor='#ff5a5a'; toggle.style.background='#200a0a'; }
    if(knob) knob.style.background='#ff5a5a';
    if(text){ text.textContent='LOCKED'; text.style.color='#ff5a5a'; }
    if(label) label.textContent='🔴 New entries: Locked';
  } else {
    if(toggle){ toggle.style.borderColor='#4aff91'; toggle.style.background='#0a2010'; }
    if(knob) knob.style.background='#4aff91';
    if(text){ text.textContent='OPEN'; text.style.color='#4aff91'; }
    if(label) label.textContent='🟢 New entries: Open';
  }
}

function toggleMOTM(){
  motmActive = !motmActive;
  const btn = document.getElementById('motm-toggle');
  if(btn){
    btn.textContent = motmActive ? 'ON' : 'OFF';
    btn.style.background = motmActive ? 'var(--accent)' : 'var(--bg4)';
    btn.style.color = motmActive ? '#fff' : 'var(--txt3)';
    btn.style.borderColor = motmActive ? 'var(--accent)' : 'var(--border)';
  }
  if(motmActive && lastParsedPlayers && lastParsedPlayers.length){
    const best = [...lastParsedPlayers].filter(p=>p.rating>0).sort((a,b)=>b.rating-a.rating)[0];
    const nameEl = document.getElementById('motm-player-name');
    if(best && nameEl) nameEl.textContent = best.name + ' (Rating ' + best.rating.toFixed(1) + ')';
  } else {
    const nameEl = document.getElementById('motm-player-name');
    if(nameEl) nameEl.textContent = 'Awarded to highest-rated squad player';
  }
  buildMatchPreview(lastParsedPlayers||[], null);
}

function toggleCleanSheet(){
  cleanSheetActive = !cleanSheetActive;
  const btn = document.getElementById('cs-toggle');
  if(btn){
    btn.textContent = cleanSheetActive ? t('cs_on') : t('cs_off');
    btn.style.background = cleanSheetActive ? 'var(--accent)' : 'var(--bg4)';
    btn.style.color = cleanSheetActive ? '#fff' : 'var(--txt3)';
    btn.style.borderColor = cleanSheetActive ? 'var(--accent)' : 'var(--border)';
  }
  // Rebuild the preview with or without CS
  if(pendingMatch.length || document.getElementById('match-results').style.display !== 'none'){
    rebuildWithCS();
  }
}

function rebuildWithCS(){
  // buildMatchPreview will handle CS based on cleanSheetActive flag
  buildMatchPreview(lastParsedPlayers||[], null);
}


async function runMatchRead(b64,mime){
  // Legacy single-image path (paste handler fallback)
  matchReportB64 = b64; matchReportMime = mime;
  updateReadBtn();
}


function buildMatchPreview(parsed, matchResult){
  pendingMatch=[];
  pendingMatchResult=matchResult||null;
  const list=document.getElementById('match-list');list.innerHTML='';
  parsed.forEach(entry=>{
    const player=S.roster.find(p=>p.name.toLowerCase().includes(entry.name.toLowerCase())||entry.name.toLowerCase().includes(p.name.toLowerCase().split(' ').pop()));
    if(!player)return;
    const pos=player.pos;let pts=0;const bd=[];
    if(entry.goals>0){const g=SC[pos].goal*entry.goals;pts+=g;bd.push(`${entry.goals}G +${g}pts`);for(let i=0;i<entry.goals;i++)pendingMatch.push({player:player.name,pos,eventType:'goal',points:SC[pos].goal});}
    if(entry.assists>0){const a=SC[pos].assist*entry.assists;pts+=a;bd.push(`${entry.assists}A +${a}pts`);for(let i=0;i<entry.assists;i++)pendingMatch.push({player:player.name,pos,eventType:'assist',points:SC[pos].assist});}
    // CS: player must have played the full match (90 mins, no sub on or off)
    // run_km=0 + rating=0 means unused sub / did not play
    const timePlayed = entry.time_played != null ? entry.time_played : (entry.rating > 0 ? 90 : 0);
    const runKm = entry.run_km != null ? entry.run_km : (entry.rating > 0 ? 1 : 0);
    const didPlay = runKm > 0 && entry.rating > 0;
    const csEligible = didPlay && timePlayed === 90;
    if(cleanSheetActive && csEligible){const cs=SC[pos].clean_sheet;pts+=cs;bd.push(`CS +${cs}pts (${timePlayed}')`);pendingMatch.push({player:player.name,pos,eventType:'clean_sheet',points:cs});}
    else if(!cleanSheetActive && entry.clean_sheet && csEligible){const cs=SC[pos].clean_sheet;pts+=cs;bd.push(`CS +${cs}pts`);pendingMatch.push({player:player.name,pos,eventType:'clean_sheet',points:cs});}
    // MOTM: from toggle (highest rated) or explicit entry.motm flag
    const isMotm = entry.motm || (motmActive && lastParsedPlayers && lastParsedPlayers.length &&
      [...lastParsedPlayers].filter(p=>p.rating>0).sort((a,b)=>b.rating-a.rating)[0]?.name === entry.name);
    if(isMotm){pts+=BONUS.motm;bd.push(`MOTM +${BONUS.motm}pts`);pendingMatch.push({player:player.name,pos,eventType:'motm',points:BONUS.motm});}
    if(entry.rating&&entry.rating>0){
      let ratingPts=0;
      if(entry.rating>=9)ratingPts=3;
      else if(entry.rating>=8)ratingPts=2;
      else if(entry.rating>=7)ratingPts=1;
      if(ratingPts>0){pts+=ratingPts;bd.push(`Rating ${entry.rating.toFixed(1)} +${ratingPts}pt`);pendingMatch.push({player:player.name,pos,eventType:'rating',points:ratingPts});}
    }

    if(pts===0)return;
    const row=document.createElement('div');row.className='match-result-row';
    row.innerHTML=`<div style="display:flex;align-items:center;gap:8px;flex:1">${posAvatar(pos, 26)}<span style="font-size:13px;font-weight:600;color:var(--txt)">${player.name}</span></div><div style="text-align:right;min-width:80px"><div class="match-pts">${pts>=0?"+":""}${pts} pts</div><div class="match-breakdown" style="font-size:10px">${bd.join(' · ')}</div></div>`;
    list.appendChild(row);
  });
  if(!list.children.length){list.innerHTML=`<div style="font-size:13px;color:var(--txt3)">No scoring events found. Try the player stats screen.</div>`;pendingMatch=[];}
  document.getElementById('match-results').style.display='block';
}

async function applyMatch(){
  const applyBtn=document.querySelector('button[onclick="applyMatch()"]');
  if(!S.sessionCode){
    alert(t('err_no_session'));
    return;
  }
  if(!pendingMatch.length){
    document.getElementById('match-results').style.display='none';
    return;
  }
  if(applyBtn){applyBtn.textContent='Applying...';applyBtn.disabled=true;}
  try{
    const now = new Date().toLocaleTimeString();
    // Write to DB and immediately update local S.events (same as manual scoring)
    await Promise.all(pendingMatch.map(ev=>
      db('add_event',{session_id:S.sessionCode,player_name:ev.player,pos:ev.pos,event_type:ev.eventType,points:ev.points})
    ));
    // Push to local state immediately so UI updates even if reloadFromDB is slow
    pendingMatch.forEach(ev=>{
      S.events.push({player:ev.player,pos:ev.pos,eventType:ev.eventType,points:Number(ev.points),time:now,ts:Date.now()});
    });
    pendingMatch=[];
    pendingMatchResult=null;
    document.getElementById('match-results').style.display='none';
    renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();
    announceMatchEnd();
    // Then reload from DB in background to confirm
    reloadFromDB().then(()=>{
      renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();
    });
  }catch(err){
    console.error('Apply error:', err);
    alert('Error applying points: '+err.message);
  }finally{
    if(applyBtn){applyBtn.textContent='Apply points';applyBtn.disabled=false;}
  }
}

// ─────────────────────────────────────────────────────────────────
// LANGUAGE SYSTEM
// ─────────────────────────────────────────────────────────────────
let currentLang = localStorage.getItem('ffm_lang') || 'en';

const LANG = {
  en: {
    home: 'Home', setup: 'Setup', controls: 'Controls', viewer: 'Viewer', table: 'Table', streamer: 'Streamer',
    for_streamers: 'For streamers', for_viewers: 'For viewers',
    scoring: 'Scoring', defender: 'Defender', midfielder: 'Midfielder', attacker: 'Attacker',
    clean_sheet: 'Clean sheet', goal: 'Goal', assist: 'Assist', rating: 'Rating',
    rating_scale: '7+/8+/9+', all_bonuses: 'All bonuses are cumulative', cs_note: '🧤 Clean sheet points awarded to all players who played the full match',
    potm: 'Player of the Match', captain_bonus: 'Captain Bonus',
    step1_title: 'Step 1 — squad screenshot',
    step1_sub: 'Upload your FM squad screen. FantasyFM will read player names and positions automatically.',
    upload_file: 'Upload file', upload_file_sub: 'Click to browse',
    paste_screenshot: 'Paste screenshot', paste_screenshot_sub: 'Click after copying',
    reading_squad: 'Reading squad from screenshot...', enter_manually: 'Enter manually instead',
    step2_title: 'Step 2 — confirm positions',
    step2_sub: 'Check and adjust positions, then click Go Live.',
    step2_hint: 'Click DEF / MID / ATT to reassign any player. Check wingers and wing-backs especially.',
    add_player: '+ Add player', add_second: 'Add from 2nd screenshot',
    confirm_live: 'Confirm & go live',
    second_upload_sub: 'Upload or paste a second squad screenshot to add more players:',
    go_live: 'Go live', re_upload: 'Re-upload',
    session_live: 'Session is live. Share the code with your viewers.',
    viewers_enter: 'Viewers enter this on the Viewer tab',
    goto_live: 'Go to live controls', reset_session: 'Reset session',
    no_session_setup: 'No active session. Complete setup first.',
    match_upload: 'Match upload', match_upload_sub: 'Upload the Player Stats screen from FM.',
    match_upload_hint: 'Full-Time Report → click your team name → Player Stats tab → screenshot the full table.',
    read_stats: 'Read stats', reading_stats: 'Reading stats...',
    detected: 'Detected — confirm to apply', apply_points: 'Apply points', discard: 'Discard',
    clean_sheet_toggle: 'Clean sheet?', clean_sheet_hint: 'Awards CS points to all players who played the full match',
    cs_on: 'ON', cs_off: 'OFF',
    motm_toggle: 'Player of the Match +5pts', motm_hint: 'Awarded to highest-rated squad player',
    new_entries: 'New entries', new_entries_hint: 'Lock to stop viewers joining mid-game',
    entries_open: 'OPEN', entries_locked: 'LOCKED',
    last_submission: 'Last submission', no_submission: 'No stats submitted yet.',
    enlarge_hint: 'Click image to enlarge and verify stats',
    player_insights: 'Player insights', insights_empty: 'Lock-ins will show player selection data here.',
    event_log: 'Event log', no_events: 'No events yet.',
    manual_scoring: 'Manual scoring', manual_open: 'Click to open', undo_last: 'Undo last',
    join_title: 'Join a game',
    join_sub: 'Sign in with your Twitch or YouTube account to join. Your stream username will appear on the leaderboard.',
    session_code_label: 'Session code', sign_in_above: 'Sign in above to join',
    no_session_viewer: 'No active session.',
    enter_name: 'Your name', enter_code: 'Session code (e.g. FM-AB3XY7)',
    join_btn: 'Join game', pick_title: 'Build your squad',
    pick_sub: 'Pick one per position, then choose your captain for 2x points.',
    lock_btn: 'Lock in picks', lock_wait: 'Select all 4 picks to continue',
    viewers_lbl: 'Viewers', events_lbl: 'Events', top_manager: 'Top manager', leading_pts: 'Leading pts',
    pts: 'pts', switch_btn: 'Switch', sign_in_play: 'Sign in to play',
    manager_table: 'Manager Table', refresh: 'Refresh',
    top_players: 'Top Players', top_scorers: 'Top Goalscorers',
    most_picked: 'Most Picked', most_captained: 'Most Captained',
    no_goals: 'No goals yet.', no_picks: 'No picks yet.', no_captains: 'No captains yet.',
    streamer_access: 'Streamer Access', sign_in: 'Sign in',
    streamer_sub: 'Access your streamer dashboard to set up sessions and control scoring.',
    email_lbl: 'Email', password_lbl: 'Password', sign_in_btn: 'Sign in',
    private_beta: 'Private Beta',
    beta_msg: 'FantasyFM is currently in private beta. Streamer access is invite-only. If you have been given access, sign in above.',
    streamer_dash: 'Streamer Dashboard', welcome_back: 'Welcome back', sign_out: 'Sign out',
    setup_session: 'Setup session', live_controls: 'Live controls',
    access_mgmt: 'Access management', add_streamer: '+ Add streamer',
    temp_password: 'Temporary password', access_type: 'Access type',
    expires_lbl: 'Expires (leave blank = never)', cancel: 'Cancel', loading: 'Loading...',
    twitch_bot: 'Twitch chat bot',
    twitch_bot_sub: 'Enter your Twitch channel name to enable automatic chat announcements.',
    twitch_channel: 'Your Twitch channel name', test_message: 'Test message',
    obs_overlay: 'OBS Overlay', browser_source: 'Browser Source', copy_url: 'Copy URL',
    quick_tips: 'Quick tips',
    err_no_session: 'No active session. Start a session in the Setup tab first.',
    err_signin: 'Please sign in with Twitch or YouTube first.',
    err_code: 'Please enter the session code.',
    err_not_found: 'Session code not found. Check the stream.',
    err_entries_locked: 'New entries are currently closed. Wait for the streamer to open entries.',
    squad_prompt_positions: 'GK stays GK, DEF (defenders/CBs/fullbacks/wing-backs), MID (all midfielders including DM/AM), ATT (strikers/forwards/wingers).',
    stats_goals_col: 'Goals', stats_assists_col: 'Assists', stats_rating_col: 'Rating',
    session_type_title: 'Start a new competition',
    oneoff_label: 'One-off Session', oneoff_desc: 'Single stream. No transfers.',
    season_label: 'New Season', season_desc: 'Runs across multiple streams. Viewers keep their picks.',
    season_end_label: 'Season end date & time',
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
    potm: 'Joueur du match', captain_bonus: 'Bonus capitaine',
    step1_title: 'Étape 1 — capture d’équipe',
    step1_sub: 'Importez votre écran d’équipe FM. FantasyFM lira les noms et positions automatiquement.',
    upload_file: 'Importer fichier', upload_file_sub: 'Cliquer pour parcourir',
    paste_screenshot: 'Coller capture', paste_screenshot_sub: 'Cliquer après avoir copié',
    reading_squad: 'Lecture de l’équipe en cours...', enter_manually: 'Saisir manuellement',
    step2_title: 'Étape 2 — confirmer les positions',
    step2_sub: 'Vérifiez les positions puis cliquez sur Démarrer.',
    step2_hint: 'Cliquez sur DEF / MIL / ATT pour réassigner. Vérifiez surtout les ailiers.',
    add_player: '+ Ajouter joueur', add_second: 'Ajouter depuis 2ème capture',
    confirm_live: 'Confirmer et démarrer',
    second_upload_sub: 'Importez une deuxième capture pour ajouter des joueurs :',
    go_live: 'Démarrer', re_upload: 'Reimporter',
    session_live: 'Session en direct. Partagez le code avec vos spectateurs.',
    viewers_enter: 'Les spectateurs entrent ce code dans l’onglet Spectateur',
    goto_live: 'Aller aux contrôles', reset_session: 'Réinitialiser',
    no_session_setup: 'Aucune session. Completez la configuration d’abord.',
    match_upload: 'Import match', match_upload_sub: 'Importez l’écran Stats joueurs de FM.',
    match_upload_hint: 'Rapport fin de match → cliquez sur votre équipe → onglet Stats joueurs → capturez le tableau.',
    read_stats: 'Lire les stats', reading_stats: 'Lecture des stats...',
    detected: 'Détecté — confirmer pour appliquer', apply_points: 'Appliquer', discard: 'Annuler',
    clean_sheet_toggle: 'Clean sheet ?', clean_sheet_hint: 'Attribue des points CS à tous les joueurs ayant joué le match complet',
    cs_on: 'OUI', cs_off: 'NON',
    motm_toggle: 'Joueur du match +5pts', motm_hint: 'Attribué au joueur le mieux noté',
    new_entries: 'Nouvelles entrées', new_entries_hint: 'Verrouiller pour stopper les nouveaux',
    entries_open: 'OUVERT', entries_locked: 'FERMÉ',
    last_submission: 'Dernier envoi', no_submission: 'Aucun envoi pour l’instant.',
    enlarge_hint: 'Cliquer pour agrandir et vérifier les stats',
    player_insights: 'Stats joueurs', insights_empty: 'Les données de sélection apparaitront ici.',
    event_log: 'Événements', no_events: 'Aucun événement.',
    manual_scoring: 'Points manuels', manual_open: 'Cliquer pour ouvrir', undo_last: 'Annuler dernier',
    join_title: 'Rejoindre une partie',
    join_sub: 'Connectez-vous avec Twitch ou YouTube. Votre pseudo apparaîtra au classement.',
    session_code_label: 'Code de session', sign_in_above: 'Connectez-vous ci-dessus',
    no_session_viewer: 'Aucune session active.',
    enter_name: 'Votre pseudo', enter_code: 'Code de session (ex. FM-AB3XY7)',
    join_btn: 'Rejoindre', pick_title: 'Composez votre équipe',
    pick_sub: 'Choisissez un joueur par poste, puis votre capitaine pour 2x de points.',
    lock_btn: 'Valider mes choix', lock_wait: 'Sélectionnez les 4 joueurs pour continuer',
    viewers_lbl: 'Spectateurs', events_lbl: 'Événements', top_manager: 'Meilleur manager', leading_pts: 'Points en tête',
    pts: 'pts', switch_btn: 'Changer', sign_in_play: 'Connectez-vous pour jouer',
    manager_table: 'Classement managers', refresh: 'Actualiser',
    top_players: 'Meilleurs joueurs', top_scorers: 'Meilleurs buteurs',
    most_picked: 'Plus choisis', most_captained: 'Plus capitaines',
    no_goals: 'Aucun but.', no_picks: 'Aucun choix.', no_captains: 'Aucun capitaine.',
    streamer_access: 'Accès Streamer', sign_in: 'Connexion',
    streamer_sub: 'Accédez à votre tableau de bord pour gérer vos sessions.',
    email_lbl: 'Email', password_lbl: 'Mot de passe', sign_in_btn: 'Se connecter',
    private_beta: 'Accès privé',
    beta_msg: 'FantasyFM est en accès privé. Seuls les streamers invités peuvent se connecter.',
    streamer_dash: 'Tableau de bord', welcome_back: 'Bon retour', sign_out: 'Déconnexion',
    setup_session: 'Configurer', live_controls: 'Contrôles live',
    access_mgmt: 'Gestion accès', add_streamer: '+ Ajouter streamer',
    temp_password: 'Mot de passe temp.', access_type: 'Type d’accès',
    expires_lbl: 'Expire (vide = jamais)', cancel: 'Annuler', loading: 'Chargement...',
    twitch_bot: 'Bot Twitch',
    twitch_bot_sub: 'Entrez votre nom de chaîne Twitch pour les annonces automatiques.',
    twitch_channel: 'Votre chaîne Twitch', test_message: 'Message test',
    obs_overlay: 'Incrustation OBS', browser_source: 'Source navigateur', copy_url: 'Copier l’URL',
    quick_tips: 'Conseils rapides',
    err_no_session: 'Aucune session active. Lancez une session dans l’onglet Équipe.',
    err_signin: 'Veuillez vous connecter avec Twitch ou YouTube.',
    err_code: 'Veuillez entrer le code de session.',
    err_not_found: 'Code introuvable. Vérifiez le stream.',
    err_entries_locked: 'Les nouvelles entrées sont fermées. Attendez le streamer.',
    squad_prompt_positions: 'GB=GK, D/DC/DL/DR/DLC/DRC=DEF, MD/MDC/MDG/MDD/M/MC/MG/MO/MOC/MOG/MOD/MCA=MID, BT/BTL/BTR/BTD=ATT. Output only: GK, DEF, MID, ATT.',
    stats_goals_col: 'Buts', stats_assists_col: 'Passes décisi...', stats_rating_col: 'Note',
    session_type_title: 'Démarrer une compétition',
    oneoff_label: 'Session unique', oneoff_desc: 'Un seul stream. Pas de transferts.',
    season_label: 'Nouvelle saison', season_desc: 'Sur plusieurs streams. Les spectateurs gardent leurs choix.',
    season_end_label: 'Date et heure de fin de saison',
    allow_new_joiners_label: 'Autoriser de nouveaux joueurs en cours de saison',
    transfers_per_viewer_label: 'Transferts par spectateur',
    end_stream_btn: 'Terminer le stream', season_settings_btn: 'Paramètres saison',
    season_badge: 'SAISON',
  },
  de: {
    home: 'Start', setup: 'Kader', controls: 'Steuerung', viewer: 'Zuschauer', table: 'Tabelle', streamer: 'Streamer',
    for_streamers: 'Für Streamer', for_viewers: 'Für Zuschauer',
    scoring: 'Punkte', defender: 'Verteidiger', midfielder: 'Mittelfeld', attacker: 'Stürmer',
    clean_sheet: 'Zu-Null', goal: 'Tor', assist: 'Vorlage', rating: 'Bewertung',
    rating_scale: '7+/8+/9+', all_bonuses: 'Alle Boni sind kumulativ',
    potm: 'Spieler des Spiels', captain_bonus: 'Kapitänsbonus',
    step1_title: 'Schritt 1 — Kader-Screenshot',
    step1_sub: 'Lade deinen FM-Kader hoch. FantasyFM liest Namen und Positionen automatisch.',
    upload_file: 'Datei hochladen', upload_file_sub: 'Klicken zum Durchsuchen',
    paste_screenshot: 'Screenshot einfügen', paste_screenshot_sub: 'Nach dem Kopieren klicken',
    reading_squad: 'Kader wird gelesen...', enter_manually: 'Manuell eingeben',
    step2_title: 'Schritt 2 — Positionen bestätigen',
    step2_sub: 'Überprüfe die Positionen und klicke auf Live gehen.',
    step2_hint: 'Klicke auf VER / MIT / STÜ um Positionen zu ändern. Außenbahnspieler prüfen.',
    add_player: '+ Spieler hinzufügen', add_second: 'Aus 2. Screenshot hinzufügen',
    confirm_live: 'Bestätigen & live gehen',
    second_upload_sub: 'Lade einen zweiten Screenshot hoch um mehr Spieler hinzuzufügen:',
    go_live: 'Live gehen', re_upload: 'Neu hochladen',
    session_live: 'Session ist live. Teile den Code mit deinen Zuschauern.',
    viewers_enter: 'Zuschauer geben dies im Zuschauer-Tab ein',
    goto_live: 'Zu den Live-Kontrollen', reset_session: 'Session zurücksetzen',
    no_session_setup: 'Keine aktive Session. Zuerst Setup abschließen.',
    match_upload: 'Spiel-Upload', match_upload_sub: 'Lade den Spieler-Stats-Bildschirm aus FM hoch.',
    match_upload_hint: 'Spielbericht → klicke auf deinen Vereinsnamen → Spielerstatistiken → Screenshot der Tabelle.',
    read_stats: 'Stats einlesen', reading_stats: 'Stats werden gelesen...',
    detected: 'Erkannt — bestätigen zum Anwenden', apply_points: 'Punkte vergeben', discard: 'Verwerfen',
    clean_sheet_toggle: 'Zu-Null?', clean_sheet_hint: 'Vergibt Zu-Null-Punkte an alle Spieler die die vollen 90 Min gespielt haben',
    cs_on: 'JA', cs_off: 'NEIN',
    motm_toggle: 'Spieler des Spiels +5Pkt', motm_hint: 'Vergeben an den bestbewerteten Spieler',
    new_entries: 'Neue Einträge', new_entries_hint: 'Sperren um neue Teilnehmer zu blockieren',
    entries_open: 'OFFEN', entries_locked: 'GESPERRT',
    last_submission: 'Letzter Upload', no_submission: 'Noch keine Stats eingereicht.',
    enlarge_hint: 'Klicken zum Vergrößern und Stats prüfen',
    player_insights: 'Spieler-Insights', insights_empty: 'Auswahlstatistiken erscheinen hier.',
    event_log: 'Ereignisprotokoll', no_events: 'Noch keine Ereignisse.',
    manual_scoring: 'Manuelle Punkte', manual_open: 'Klicken zum Öffnen', undo_last: 'Rückgängig',
    join_title: 'Spiel beitreten',
    join_sub: 'Melde dich mit Twitch oder YouTube an. Dein Name erscheint in der Tabelle.',
    session_code_label: 'Session-Code', sign_in_above: 'Oben anmelden',
    no_session_viewer: 'Keine aktive Session.',
    enter_name: 'Dein Name', enter_code: 'Session-Code (z.B. FM-AB3XY7)',
    join_btn: 'Beitreten', pick_title: 'Stell dein Team auf',
    pick_sub: 'Wähle einen Spieler pro Position, dann deinen Kapitän für 2x Punkte.',
    lock_btn: 'Auswahl bestätigen', lock_wait: 'Wähle alle 4 Spieler aus um fortzufahren',
    viewers_lbl: 'Zuschauer', events_lbl: 'Ereignisse', top_manager: 'Bester Manager', leading_pts: 'Führende Pkt',
    pts: 'Pkt', switch_btn: 'Wechseln', sign_in_play: 'Anmelden zum Spielen',
    manager_table: 'Manager-Tabelle', refresh: 'Aktualisieren',
    top_players: 'Top Spieler', top_scorers: 'Torp Torjäger',
    most_picked: 'Häufig gewählt', most_captained: 'Häufig Kapitän',
    no_goals: 'Noch keine Tore.', no_picks: 'Noch keine Auswahl.', no_captains: 'Noch kein Kapitän.',
    streamer_access: 'Streamer-Zugang', sign_in: 'Anmelden',
    streamer_sub: 'Zugriff auf dein Streamer-Dashboard für Sessions und Punkte.',
    email_lbl: 'E-Mail', password_lbl: 'Passwort', sign_in_btn: 'Anmelden',
    private_beta: 'Private Beta',
    beta_msg: 'FantasyFM ist in der privaten Beta. Streamer-Zugang nur auf Einladung.',
    streamer_dash: 'Streamer-Dashboard', welcome_back: 'Willkommen zurück', sign_out: 'Abmelden',
    setup_session: 'Session einrichten', live_controls: 'Live-Kontrollen',
    access_mgmt: 'Zugriffsverwaltung', add_streamer: '+ Streamer hinzufügen',
    temp_password: 'Temporäres Passwort', access_type: 'Zugriffstyp',
    expires_lbl: 'Ablauf (leer = nie)', cancel: 'Abbrechen', loading: 'Laden...',
    twitch_bot: 'Twitch-Bot',
    twitch_bot_sub: 'Gib deinen Twitch-Kanalnamen ein für automatische Ansagen.',
    twitch_channel: 'Dein Twitch-Kanal', test_message: 'Testnachricht',
    obs_overlay: 'OBS-Einblendung', browser_source: 'Browserquelle', copy_url: 'URL kopieren',
    quick_tips: 'Schnelltipps',
    err_no_session: 'Keine aktive Session. Starte eine Session im Kader-Tab.',
    err_signin: 'Bitte melde dich mit Twitch oder YouTube an.',
    err_code: 'Bitte gib den Session-Code ein.',
    err_not_found: 'Session-Code nicht gefunden. Prüfe den Stream.',
    err_entries_locked: 'Neue Einträge sind gesperrt. Warte auf den Streamer.',
    squad_prompt_positions: 'TW=GK, IV/LA/RA/LV/RV/LMV/RMV=DEF, ZM/DM/OM/LM/RM/ZOM/ZDM/LAM/RAM=MID, ST/LS/RS=ATT. Output only: GK, DEF, MID, ATT.',
    stats_goals_col: 'Tore', stats_assists_col: 'Vorlagen', stats_rating_col: 'Note',
    session_type_title: 'Neue Wettbewerb starten',
    oneoff_label: 'Einzelsession', oneoff_desc: 'Nur ein Stream. Keine Transfers.',
    season_label: 'Neue Saison', season_desc: 'Über mehrere Streams. Zuschauer behalten ihre Auswahl.',
    season_end_label: 'Saisonende (Datum & Uhrzeit)',
    allow_new_joiners_label: 'Neue Zuschauer mid-Saison erlauben',
    transfers_per_viewer_label: 'Transfers pro Zuschauer',
    end_stream_btn: 'Stream beenden', season_settings_btn: 'Saisoneinstellungen',
    season_badge: 'SAISON',
  }
};

function t(key){ return (LANG[currentLang]||LANG.en)[key]||LANG.en[key]||key; }

function setLang(code){
  currentLang=code;
  localStorage.setItem('ffm_lang',code);
  applyLang();
  document.querySelectorAll('.lang-btn').forEach(b=>{
    b.style.opacity=b.dataset.lang===code?'1':'0.4';
    b.style.borderColor=b.dataset.lang===code?'var(--accent)':'var(--border)';
  });
}

function applyLang(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n);});
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.i18nPlaceholder);});
}


function sid(n){return n.replace(/[^a-zA-Z0-9]/g,'_');}
function getScore(name,fromTs=0){return S.events.filter(e=>e.player===name&&(e.ts||0)>fromTs).reduce((s,e)=>s+Number(e.points),0);}
function getViewerScore(vname){
  const v=S.viewers[vname];if(!v)return 0;
  const picks=v.picks;
  const from=v.lockedAtTs||0; // only count events after they locked in
  let total=0;
  // Base scores for DEF, MID, ATT
  if(picks.DEF)total+=getScore(picks.DEF,from);
  if(picks.MID)total+=getScore(picks.MID,from);
  if(picks.ATT)total+=getScore(picks.ATT,from);
  // Captain always scores 2x their points.
  // Add captain score TWICE. If captain is also DEF/MID/ATT, subtract once
  // (since their base was already counted above) so net = 2x not 3x.
  if(picks.CAP){
    const capScore=getScore(picks.CAP,from);
    const capIsAlsoPick=[picks.DEF,picks.MID,picks.ATT].includes(picks.CAP);    if(capIsAlsoPick){
      // base already counted once above, add once more = 2x total
      total+=capScore;
    } else {
      // captain is a separate 4th player — add twice for 2x
      total+=capScore*2;
    }
  }
  return total;
}

// ── Season mid-roster management ─────────────────────────────────────────────
function showAddPlayerPanel(){
  const existing=document.getElementById('season-add-player');
  if(existing){existing.remove();return;}
  const panel=document.createElement('div');
  panel.id='season-add-player';
  panel.style.cssText='background:var(--bg3);border:1px solid var(--accent);border-radius:var(--r);padding:14px;margin-bottom:14px';
  panel.innerHTML=`
    <div style="font-size:13px;font-weight:600;color:var(--txt);margin-bottom:10px">Add player to season squad</div>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input id="new-player-name" class="input-field" placeholder="Player name" style="flex:2;margin-bottom:0">
      <select id="new-player-pos" class="input-field" style="flex:1;margin-bottom:0">
        <option value="DEF">DEF</option>
        <option value="MID">MID</option>
        <option value="ATT">ATT</option>
      </select>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-accent" onclick="addSeasonPlayer()" style="font-size:12px">Add player</button>
      <button class="btn" onclick="document.getElementById('season-add-player').remove()" style="font-size:12px">Cancel</button>
    </div>`;
  const scoringCard=document.getElementById('scoring-collapse');
  if(scoringCard&&scoringCard.parentElement)scoringCard.parentElement.insertBefore(panel,scoringCard);
}

async function addSeasonPlayer(){
  const name=sanitise(document.getElementById('new-player-name').value.trim(),60);
  const pos=document.getElementById('new-player-pos').value;
  if(!name){alert('Please enter a player name.');return;}
  if(S.roster.find(p=>p.name.toLowerCase()===name.toLowerCase())){alert('Player already in squad.');return;}
  S.roster.push({name,pos});
  await db('save_roster',{session_id:S.sessionCode,players:S.roster});
  document.getElementById('season-add-player')?.remove();
  renderScoring();
}

function renderScoring(){
  const panel=document.getElementById('scoring-panel');panel.innerHTML='';
  const cols=window.innerWidth>=600?3:window.innerWidth>=400?2:1;
  panel.style.cssText='display:grid;grid-template-columns:repeat('+cols+',minmax(0,1fr));gap:14px;';
  const byPos={DEF:[],MID:[],ATT:[]};
  S.roster.forEach(p=>{if(byPos[p.pos])byPos[p.pos].push(p);});
  ['DEF','MID','ATT'].forEach(pos=>{
    if(!byPos[pos].length)return;
    const sec=document.createElement('div');sec.className='pos-section';
    sec.innerHTML=`<div class="pos-heading">${PL[pos]}</div>`;
    byPos[pos].forEach(player=>{
      const pts=getScore(player.name);
      const row=document.createElement('div');row.className='player-row';
      const btns=Object.entries(SC[pos]).map(([evt,p])=>`<button class="evt-btn" onclick="logEvt('${player.name}','${pos}','${evt}')">${EL[evt]} <span style="opacity:0.7">+${p}</span></button>`).join('');
      const negBtns=`<button class="evt-btn evt-neg" onclick="logNeg('${player.name}','${pos}','yellow_card',-2)" title="Yellow card">🟨 <span style="opacity:0.7">-2</span></button><button class="evt-btn evt-neg" onclick="logNeg('${player.name}','${pos}','red_card',-5)" title="Red card">🟥 <span style="opacity:0.7">-5</span></button>`;
      const ratingBtns=`<button class="evt-btn" onclick="logEvt('${player.name}','${pos}','rating')" style="border-color:var(--accent);color:var(--accent)" title="Rating bonus (+1/2/3 pts)">⭐ Rat</button>`;
      const editBtn=`<button class="evt-btn" onclick="editScore('${player.name}','${pos}')" style="border-color:var(--txt3);color:var(--txt3)" title="Edit total score">✏️</button>`;
      row.innerHTML=`${posAvatar(pos,28)}<span class="player-name-t">${player.name}</span>${btns}${negBtns}${ratingBtns}${editBtn}<span class="score-num ${pts!==0?'has-pts':''}" id="sc-${sid(player.name)}" style="${pts<0?'color:var(--att)':pts>0?'color:var(--accent)':''}">${pts}</span>`;
      sec.appendChild(row);
    });
    panel.appendChild(sec);
  });
}

async function logEvt(name,pos,evt){
  const safeName=sanitise(name,60);const safePos=(['DEF','MID','ATT'].includes(pos)?pos:'DEF');
  if(!SC[safePos]||!SC[safePos][evt])return;
  await db('add_event',{session_id:S.sessionCode,player_name:safeName,pos:safePos,event_type:evt,points:SC[safePos][evt]});
  S.events.push({player:name,pos,eventType:evt,points:SC[pos][evt],time:new Date().toLocaleTimeString(),ts:Date.now()});
  const el=document.getElementById('sc-'+sid(name));
  if(el){el.textContent=getScore(name);el.className='score-num has-pts';}
  refreshLog();refreshStats();renderLeague();
  announceEvent(name, evt, SC[pos][evt]);
}

async function editScore(name, pos){
  const current = getScore(name);
  const input = prompt(`Set total points for ${name} (current: ${current}):`, current);
  if(input === null) return;
  const target = parseInt(input);
  if(isNaN(target)){ alert('Please enter a number.'); return; }
  const diff = target - current;
  if(diff === 0) return;
  // Add a single adjustment event
  const safeName = sanitise(name, 60);
  const safePos = (['DEF','MID','ATT'].includes(pos) ? pos : 'DEF');
  await db('add_event',{session_id:S.sessionCode,player_name:safeName,pos:safePos,event_type:'manual_adjust',points:diff});
  S.events.push({player:name,pos,eventType:'manual_adjust',points:diff,time:new Date().toLocaleTimeString(),ts:Date.now()});
  renderScoring();refreshLog();refreshStats();renderLeague();renderInsights();
}

async function logNeg(name,pos,evt,pts){
  const safeName=sanitise(name,60);const safePos=(['DEF','MID','ATT'].includes(pos)?pos:'DEF');
  const safePts=Number(pts);if(!isFinite(safePts)||safePts>0)return;
  await db('add_event',{session_id:S.sessionCode,player_name:safeName,pos:safePos,event_type:evt,points:safePts});
  S.events.push({player:name,pos,eventType:evt,points:pts,time:new Date().toLocaleTimeString(),ts:Date.now()});
  const el=document.getElementById('sc-'+sid(name));
  if(el){const s=getScore(name);el.textContent=s;el.className='score-num'+(s>0?' has-pts':s<0?' has-pts':' ');}
  refreshLog();refreshStats();renderLeague();
  announceEvent(name,evt,pts);
}

async function undoLast(){
  if(!S.events.length)return;
  await db('delete_last_event',{session_id:S.sessionCode});
  const last=S.events.pop();
  const el=document.getElementById('sc-'+sid(last.player));
  if(el){const s=getScore(last.player);el.textContent=s;el.className='score-num'+(s>0?' has-pts':'');}
  refreshLog();refreshStats();renderLeague();
}

function refreshLog(){
  const log=document.getElementById('event-log');
  if(!S.events.length){log.innerHTML='<div class="evt-item" style="color:var(--txt3)">No events yet.</div>';return;}
  log.innerHTML=[...S.events].reverse().map(e=>`<div class="evt-item">${e.time} &mdash; <strong style="color:#c8b8ff">${e.player}</strong> &middot; ${EL[e.eventType]} &middot; <span class="evt-pts">+${e.points}pts</span></div>`).join('');
}

function refreshStats(){
  document.getElementById('sv').textContent=Object.keys(S.viewers).filter(v=>S.viewers[v].locked).length;
  document.getElementById('se').textContent=S.events.length;
  const lb=getLeaderboard();
  const topEl=document.getElementById('sl');
  const ptsEl=document.getElementById('sp2');
  if(lb.length&&topEl&&ptsEl){
    topEl.textContent=lb[0].name.split(' ')[0];
    ptsEl.textContent=lb[0].pts+'pts';
    topEl.style.fontSize='13px';
  }
}

// ── OAuth viewer login ──────────────────────────────────────────────────────
let oauthUser = null;

function loginTwitch() {
  const session = document.getElementById('vcode').value.trim().toUpperCase();
  window.location.href = '/.netlify/functions/auth-twitch?session=' + session;
}

function loginYouTube() {
  const session = document.getElementById('vcode').value.trim().toUpperCase();
  window.location.href = '/.netlify/functions/auth-google?session=' + session;
}

function setOAuthUser(username, platform, avatar, oauthId) {
  oauthUser = { username, platform, oauthId, avatar };
  localStorage.setItem('ffm_oauth', JSON.stringify(oauthUser));
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
  if (userEl) { userEl.style.display = 'flex'; }
  if (btnsEl) btnsEl.style.display = 'none';
  if (nameEl) nameEl.textContent = oauthUser.username;
  if (platEl) platEl.textContent = oauthUser.platform === 'twitch' ? 'Twitch' : 'YouTube';
  if (avatarEl && oauthUser.avatar) { avatarEl.src = oauthUser.avatar; avatarEl.style.display = 'block'; }
  if (joinBtn) { joinBtn.disabled = false; joinBtn.style.opacity = '1'; joinBtn.style.cursor = 'pointer'; joinBtn.textContent = 'Join →'; }
  // Show "change session" link if they have a previously saved session
  const changeRow = document.getElementById('change-session-row');
  if (changeRow) {
    const hasSavedCode = !!localStorage.getItem('ffm_last_viewer_code');
    changeRow.style.display = hasSavedCode ? 'block' : 'none';
  }
}

function viewerChangeSession() {
  // Clear saved session code so viewer can enter a new one
  try {
    localStorage.removeItem('ffm_last_viewer_code');
    localStorage.removeItem('ffm_state');
  } catch(e) {}
  // Reset session state but keep OAuth identity
  S.sessionCode = null;
  S.isLive = false;
  S.roster = [];
  S.events = [];
  S.viewers = {};
  stopAbly();
  // Hide picker/dash, show join form
  const joinDiv = document.getElementById('vp-join');
  const pickerDiv = document.getElementById('vp-picker');
  const dashDiv = document.getElementById('vp-dash');
  if (joinDiv) joinDiv.style.display = 'block';
  if (pickerDiv) { pickerDiv.style.display = 'none'; pickerDiv.innerHTML = ''; }
  if (dashDiv) { dashDiv.style.display = 'none'; dashDiv.innerHTML = ''; }
  // Clear and focus the session code input
  const vcodeEl = document.getElementById('vcode');
  if (vcodeEl) { vcodeEl.value = ''; vcodeEl.focus(); }
  // Hide error
  const err = document.getElementById('vjoin-err');
  if (err) err.style.display = 'none';
  setUIMode('viewer');
  goTab('viewer', document.getElementById('nb-viewer'));
}

function clearOAuth() {
  oauthUser = null;
  localStorage.removeItem('ffm_oauth');
  const userEl = document.getElementById('oauth-user');
  const btnsEl = document.getElementById('oauth-btns');
  const joinBtn = document.getElementById('join-btn');
  const manualSection = document.getElementById('manual-name-section');
  if (userEl) userEl.style.display = 'none';
  if (btnsEl) btnsEl.style.display = 'block';
  if (manualSection) manualSection.style.display = 'block';
  if (joinBtn) { joinBtn.disabled = false; joinBtn.style.opacity = '1'; joinBtn.style.cursor = 'pointer'; joinBtn.textContent = 'Join →'; }
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
      const vcodeEl = document.getElementById('vcode');
      if (vcodeEl) vcodeEl.value = session;
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
  const saved = localStorage.getItem('ffm_oauth');
  if (saved && !oauthUser) {
    try { oauthUser = JSON.parse(saved); renderOAuthUser(); } catch(e) {}
  }
}


async function autoRejoinViewer(){
  try{
    const oauth = localStorage.getItem('ffm_oauth');
    if(!oauth) return;
    const user = JSON.parse(oauth);
    // Find any saved picks to determine last session code
    const keys = Object.keys(localStorage).filter(k=>k.startsWith('ffm_viewer_picks_'));
    if(!keys.length) return;
    // Get the last used session code from the vcode input if set, or skip
    // We don't auto-rejoin without a code — just pre-fill the form
    const savedCode = localStorage.getItem('ffm_last_viewer_code');
    if(!savedCode) return;
    // Pre-fill and attempt rejoin silently
    const vcodeEl = document.getElementById('vcode');
    if(vcodeEl) vcodeEl.value = savedCode;
    if(user) setOAuthUser(user.username, user.platform, user.avatar, user.id);
    // Attempt join
    await joinGame();
  }catch(e){}
}

let _joinAttempts=0,_joinBlock=0;
async function joinGame(){
  const err=document.getElementById('vjoin-err');
  if(Date.now()<_joinBlock){
    const secs=Math.ceil((_joinBlock-Date.now())/1000);
    err.style.display='block';
    err.textContent=`Too many attempts. Please wait ${secs}s.`;
    return;
  }
  if(entriesLocked){
    err.style.display='block';
    err.textContent='New entries are currently closed. Wait for the streamer to open entries.';
    return;
  }
  if(!oauthUser){
    err.style.display='block';
    err.textContent=t('err_signin');
    return;
  }
  const name=sanitise(oauthUser.username,40);
  const code=sanitise(document.getElementById('vcode').value.trim().toUpperCase(),12);
  if(!code){err.style.display='block';err.textContent=t('err_code');return;}
  const session=await db('get_session',{session_id:code});
  // For seasons, allow joining even when not live (viewers use same code between streams)
  const sessionValid = session && (session.is_live || session.type === 'season');
  if(!sessionValid){
    _joinAttempts++;
    if(_joinAttempts>=5){_joinBlock=Date.now()+60000;_joinAttempts=0;}
    err.style.display='block';err.textContent=t('err_not_found');return;
  }
  // Populate season fields from session
  S.type=session.type||'oneoff';
  S.seasonEnd=session.season_end||null;
  S.allowNewJoiners=session.allow_new_joiners!==undefined?session.allow_new_joiners:true;
  S.transfersPerViewer=session.transfers_per_viewer||3;
  _joinAttempts=0;
  err.style.display='none';
  try{ localStorage.setItem('ffm_last_viewer_code', code); }catch(e){}
  const roster=await db('get_roster',{session_id:code});
  const events=await db('get_events',{session_id:code});
  const viewers=await db('get_viewers',{session_id:code});
  S.sessionCode=code;
  S.isLive=true;
  S.roster=Array.isArray(roster)?roster.map(p=>({name:p.name,pos:p.pos,avatar:loadAvatar(p.name)})):[];
  S.events=Array.isArray(events)?events.map(e=>({player:e.player_name,pos:e.pos,eventType:e.event_type,points:Number(e.points),time:new Date(e.created_at).toLocaleTimeString(),ts:new Date(e.created_at).getTime()})):[];
  S.viewers={};
  if(Array.isArray(viewers)){
    viewers.forEach(v=>{S.viewers[v.viewer_name]={picks:{DEF:v.pick_def,MID:v.pick_mid,ATT:v.pick_att,CAP:v.pick_cap||null},locked:v.locked,platform:v.platform||'manual',oauthId:v.oauth_id||null,lockedAtTs:v.events_at_lock||0,transfersUsed:v.transfers_used||0,isMod:v.is_mod||false};});
  }
  // Block NEW viewers (not yet in DB) if entries are locked — returning locked viewers can still access
  if(session.is_entries_locked && !S.viewers[name]){
    err.style.display='block';
    err.textContent='New entries are currently closed. Wait for the streamer to open entries.';
    S={sessionCode:null,roster:[],events:[],viewers:{},isLive:false,type:'oneoff',seasonEnd:null,allowNewJoiners:true,transfersPerViewer:3};
    return;
  }
  if(!S.viewers[name])S.viewers[name]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:false,transfersUsed:0};
  // Block new viewers if season doesn't allow new joiners
  if(S.type==='season'&&!S.allowNewJoiners&&!S.viewers[name].locked){
    err.style.display='block';
    err.textContent='This season is not accepting new players.';
    S={sessionCode:null,roster:[],events:[],viewers:{},isLive:false,type:'oneoff',seasonEnd:null,allowNewJoiners:true,transfersPerViewer:3};
    return;
  }
  // Restore any locally saved picks (in case they were picking before DB updated)
  try{
    const savedPicks=localStorage.getItem('ffm_viewer_picks_'+name);
    if(savedPicks){
      const p=JSON.parse(savedPicks);
      if(!S.viewers[name].locked)Object.assign(S.viewers[name].picks,p);
    }
  }catch(e){}
  if(S.viewers[name].locked)showDash(name);else showPicker(name);
  const myData = S.viewers[name];
  setUIMode(myData && myData.isMod ? 'mod' : 'viewer');
  save();
  startPolling();
}

function showPicker(vname){
  document.getElementById('vp-join').style.display='none';
  document.getElementById('vp-dash').style.display='none';
  const panel=document.getElementById('vp-picker');panel.style.display='block';
  if(!S.viewers[vname])S.viewers[vname]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:false};
  const viewer=S.viewers[vname];
  if(!viewer.picks)viewer.picks={DEF:null,MID:null,ATT:null,CAP:null};
  if(viewer.picks.CAP===undefined)viewer.picks.CAP=null;
  // Restore picks from localStorage if they exist
  try{
    const saved=localStorage.getItem('ffm_viewer_picks_'+vname);
    if(saved){const p=JSON.parse(saved);Object.assign(viewer.picks,p);}
  }catch(e){}
  const byPos={DEF:[],MID:[],ATT:[]};
  S.roster.forEach(p=>{if(byPos[p.pos])byPos[p.pos].push(p);});
  const posQ={DEF:'Pick your defender',MID:'Pick your midfielder',ATT:'Pick your attacker'};
  let html=`<div style="font-family:var(--font-ui);font-size:22px;font-weight:700;color:var(--txt);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${t('pick_title')}, ${vname}</div><div style="font-size:13px;color:var(--txt2);margin-bottom:18px">${t('pick_sub')}</div>`;
  ['DEF','MID','ATT'].forEach(pos=>{
    html+=`<div class="pos-section"><div class="pos-heading">${posQ[pos]}</div>`;
    byPos[pos].forEach(p=>{
      const sel=viewer.picks[pos]===p.name;
      const safeName=p.name.replace(/'/g,"\'");
      html+=`<div class="pick-row ${sel?'sel':''}" onclick="pickPlayer('${vname}','${pos}','${safeName}')"><span class="badge b-${pos}">${pos}</span><span style="font-size:14px;font-weight:500;color:var(--txt);margin-left:6px;flex:1">${p.name}</span>${sel?'<span class="pick-check">&#x2713;</span>':''}</div>`;
    });
    html+=`</div>`;
  });
  // Captain pick - any player from squad
  html+=`<div class="pos-section"><div class="pos-heading" style="color:#f5c842;border-color:#f5c84244">⭐ Pick your captain (2× points)</div>`;
  html+=`<div style="font-size:12px;color:var(--txt3);margin-bottom:8px">Must be a different player to your DEF, MID and ATT picks</div>`;
  S.roster.forEach(p=>{
    const sel=viewer.picks.CAP===p.name;
    const safeCapName=p.name.replace(/'/g,"\'");
    html+=`<div class="pick-row ${sel?'sel':''}" onclick="pickPlayer('${vname}','CAP','${safeCapName}')" style="${sel?'border-color:#f5c842;background:#1a1600':''}"><span class="badge" style="background:#2a2200;color:#f5c842">${p.pos}</span><span style="font-size:14px;font-weight:500;color:var(--txt);margin-left:6px;flex:1">${p.name}</span>${sel?'<span style="color:#f5c842;font-weight:700;font-size:16px">★</span>':''}</div>`;
  });
  html+=`</div>`;
  const p=viewer.picks;
  const capIsUnique=p.CAP&&p.CAP!==p.DEF&&p.CAP!==p.MID&&p.CAP!==p.ATT;
  const allPicked=p.DEF&&p.MID&&p.ATT&&capIsUnique;
  html+=`<button class="btn ${allPicked?'btn-accent':''}" onclick="lockPicks('${vname}')" ${allPicked?'':'disabled'} style="${allPicked?'':'opacity:0.35;cursor:not-allowed'}">${allPicked?t('lock_btn'):t('lock_wait')}</button>`;
  panel.innerHTML=html;
}

function pickPlayer(vname,pos,pname){
  if(!S.viewers[vname])S.viewers[vname]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:false};
  if(!S.viewers[vname].picks)S.viewers[vname].picks={DEF:null,MID:null,ATT:null,CAP:null};
  // Validate: CAP must be different from all 3 picks, and positional picks can't clash with each other
  const picks=S.viewers[vname].picks;
  if(pos==='CAP'){
    // CAP can be anyone - but clear it if it was accidentally set to null
    picks.CAP=pname;
  } else {
    // Clear captain if it was same as what we're replacing
    if(picks[pos]&&picks.CAP===picks[pos])picks.CAP=null;
    picks[pos]=pname;
  }
  // Save picks to localStorage for persistence
  try{localStorage.setItem('ffm_viewer_picks_'+vname, JSON.stringify(picks));}catch(e){}
  showPicker(vname);
}

async function lockPicks(vname){
  if(!S.viewers[vname])S.viewers[vname]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:false};
  S.viewers[vname].locked=true;
  // Use max DB-sourced event ts at lock time (not Date.now()) to stay in DB clock space
  const lastEventTs = S.events.length ? Math.max(...S.events.map(e=>e.ts||0)) : 0;
  S.viewers[vname].lockedAtTs = lastEventTs;
  const v=S.viewers[vname];
  // Show dashboard immediately with local state - don't wait for DB
  showDash(vname);
  refreshStats();
  // Save to DB in background
  db('upsert_viewer',{
    session_id:S.sessionCode,
    viewer_name:vname,
    pick_def:v.picks.DEF,
    pick_mid:v.picks.MID,
    pick_att:v.picks.ATT,
    pick_cap:v.picks.CAP||null,
    events_at_lock:S.viewers[vname].lockedAtTs, // repurpose column to store ms timestamp
    locked:true,
    platform: oauthUser ? oauthUser.platform : 'manual',
    oauth_id: oauthUser ? oauthUser.oauthId : null,
    avatar_url: oauthUser ? oauthUser.avatar : null
  }).then(()=>{
    try{localStorage.removeItem('ffm_viewer_picks_'+vname);}catch(e){}
    announcePicks(vname, v.picks);
  });
}

function showDash(vname,updateDataset=true){
  document.getElementById('vp-join').style.display='none';
  document.getElementById('vp-picker').style.display='none';
  const panel=document.getElementById('vp-dash');
  panel.style.display='block';
  if(updateDataset)panel.dataset.viewer=vname;
  if(!S.viewers[vname])S.viewers[vname]={picks:{DEF:null,MID:null,ATT:null,CAP:null},locked:true};
  const v=S.viewers[vname];
  // Restore picks from localStorage or DB viewer data
  if(!v.picks||(!v.picks.DEF&&!v.picks.MID&&!v.picks.ATT)){
    try{
      const saved=localStorage.getItem('ffm_viewer_picks_'+vname);
      if(saved)v.picks=JSON.parse(saved);
    }catch(e){}
  }
  const picks=v.picks||{DEF:null,MID:null,ATT:null,CAP:null};
  const total=getViewerScore(vname);
  const lb=getLeaderboard();const rank=lb.findIndex(x=>x.name===vname)+1;
  const posN={DEF:'Defender',MID:'Midfielder',ATT:'Attacker'};
  let html=`<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px">
    <div>
      <div style="font-family:var(--font-ui);font-size:22px;font-weight:700;color:var(--txt);text-transform:uppercase;letter-spacing:0.3px">${vname}'s squad</div>
      <div style="font-size:11px;color:var(--txt3);font-family:var(--font-ui);text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">${rank>0?'Rank #'+rank+' of '+lb.length:'&mdash;'}</div>
    </div>
    <div style="text-align:right">
      <div class="viewer-dash-total">${total}</div>
      <div style="font-size:11px;color:var(--txt3);font-family:var(--font-ui);text-transform:uppercase;letter-spacing:0.5px">pts</div>
    </div>
  </div>`;
  ['DEF','MID','ATT'].forEach(pos=>{
    const pname=picks[pos];const pts=pname?getScore(pname,v.lockedAtTs||0):0;
    const isCap=pname&&picks.CAP===pname;
    html+=`<div class="player-row" style="margin-bottom:6px"><span class="badge b-${pos}">${posN[pos]}</span><span class="player-name-t" style="margin-left:4px">${pname||'&mdash;'}${isCap?'<span style="color:#f5c842;margin-left:6px;font-size:12px">★ CAP</span>':''}</span><span class="score-num ${pts>0?'has-pts':''}">${pts}</span>${isCap?'<span style="font-size:10px;color:#f5c842;margin-left:4px;font-family:var(--font-ui);font-weight:700">×2</span>':''}</div>`;
  });
  if(picks.CAP&&picks.CAP!==picks.DEF&&picks.CAP!==picks.MID&&picks.CAP!==picks.ATT){
    const capPts=getScore(picks.CAP,v.lockedAtTs||0);
    html+=`<div class="player-row" style="margin-bottom:6px;border-color:#f5c84244;background:#1a1600"><span class="badge" style="background:#2a2200;color:#f5c842">CAP</span><span class="player-name-t" style="margin-left:4px">${picks.CAP} <span style="color:#f5c842;font-size:12px">★</span></span><span class="score-num ${capPts>0?'has-pts':''}">${capPts*2}</span></div>`;
  }
  html+=`<button class="btn" onclick="document.getElementById('vp-join').style.display='block';document.getElementById('vp-dash').style.display='none'" style="margin-top:12px;font-size:11px">Switch account</button>`;
  html+=renderTransferUI(vname);
  panel.innerHTML=html;
}

async function refreshLeague(){
  const btn = document.querySelector('[onclick="refreshLeague()"]');
  if(btn){ btn.textContent='Refreshing...'; btn.disabled=true; }
  if(S.sessionCode){
    await reloadFromDB();
  }
  renderLeague();
  if(btn){ btn.textContent='Refresh'; btn.disabled=false; }
}

function getLeaderboard(){
  return Object.entries(S.viewers).filter(([,v])=>v.locked).map(([name,v])=>{
    const pts=getViewerScore(name);
    return{name,picks:v.picks,pts,platform:v.platform||'manual'};
  }).sort((a,b)=>b.pts-a.pts);
}

function renderLeague(){
  const lgEmpty=document.getElementById('lg-empty');
  const lgPanel=document.getElementById('lg-panel');
  if(!S.sessionCode){
    if(lgEmpty)lgEmpty.style.display='block';
    if(lgPanel)lgPanel.style.display='none';
    return;
  }
  if(lgEmpty)lgEmpty.style.display='none';
  if(lgPanel)lgPanel.style.display='block';

  // ── Manager Table ──────────────────────────────────────────
  const lb=getLeaderboard();
  const list=document.getElementById('lg-list');
  if(list){
    if(!lb.length){list.innerHTML=`<div style="font-size:13px;color:var(--txt3);padding:8px 0">No viewers have locked picks yet.</div>`;}
    else{list.innerHTML=lb.map((v,i,arr)=>{
      // Joint ranking: find true rank (how many people have MORE points)
      const rank = arr.filter(x=>x.pts>v.pts).length + 1;
      const cls=rank===1?'top1':rank===2?'top2':rank===3?'top3':'';
      const rCls=rank===1?'gold':rank===2?'silver':rank===3?'bronze':'';
      const picks=[v.picks.DEF,v.picks.MID,v.picks.ATT].filter(Boolean).join(' &middot; ');
      const capDisplay=v.picks.CAP?` &middot; <span style="color:#f5c842">★${v.picks.CAP}</span>`:'';
      const platBadge = v.platform==='twitch'?'<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#9146ff22;color:#9146ff;font-family:var(--font-ui);font-weight:700;margin-left:4px">TW</span>'
        :v.platform==='youtube'?'<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#ff000022;color:#ff0000;font-family:var(--font-ui);font-weight:700;margin-left:4px">YT</span>':'';
      return`<div class="league-row ${cls}"><span class="rank-num ${rCls}">#${rank}</span><span class="lg-name">${v.name}${platBadge}</span><span class="lg-picks">${picks}${capDisplay}</span><span class="lg-pts ${rank<=3?'top':''}">${v.pts}</span></div>`;
    }).join('');}
  }

  // ── Shared pick/cap data ───────────────────────────────────
  const locked=Object.entries(S.viewers).filter(([,v])=>v.locked);
  const total=locked.length;
  const pickCounts={}, capCounts={};
  locked.forEach(([,v])=>{
    [v.picks.DEF,v.picks.MID,v.picks.ATT].filter(Boolean).forEach(p=>{pickCounts[p]=(pickCounts[p]||0)+1;});
    if(v.picks.CAP)capCounts[v.picks.CAP]=(capCounts[v.picks.CAP]||0)+1;
  });

  // helper: small stat row with bar
  function statRow(name, count, outOf, extra=''){
    const pos=S.roster.find(r=>r.name===name)?.pos||'?';
    const pct=outOf?Math.round(count/outOf*100):0;
    const pts=getScore(name);
    return`<div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span class="badge b-${pos}" style="font-size:9px;padding:1px 5px">${pos}</span>
        <span style="font-size:12px;font-weight:600;color:var(--txt);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
        <span style="font-family:var(--font-ui);font-size:12px;font-weight:700;color:var(--accent)">${extra||count}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;height:3px;background:var(--bg4);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px"></div></div>
        <span style="font-size:10px;color:var(--txt3);min-width:28px;text-align:right">${outOf?`${count}/${outOf}`:(pts>0?`+${pts}`:pts)+'pts'}</span>
      </div>
    </div>`;
  }

  // ── Top Players (by points) ────────────────────────────────
  const topPlayers=document.getElementById('lg-top-players');
  if(topPlayers){
    const scored=S.roster.map(p=>({name:p.name,pos:p.pos,pts:getScore(p.name)}))
      .filter(p=>p.pts>0).sort((a,b)=>b.pts-a.pts).slice(0,6);
    const maxPts=scored[0]?.pts||1;
    topPlayers.innerHTML=scored.length
      ?scored.map(p=>{
        const pct=Math.round(p.pts/maxPts*100);
        return`<div style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span class="badge b-${p.pos}" style="font-size:9px;padding:1px 5px">${p.pos}</span>
            <span style="font-size:12px;font-weight:600;color:var(--txt);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</span>
            <span style="font-family:var(--font-ui);font-size:12px;font-weight:700;color:var(--accent)">+${p.pts}</span>
          </div>
          <div style="height:3px;background:var(--bg4);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px"></div></div>
        </div>`;
      }).join('')
      :`<div style="font-size:12px;color:var(--txt3)">No scores yet.</div>`;
  }

  // ── Top Goalscorers ────────────────────────────────────────
  const topScorers=document.getElementById('lg-top-scorers');
  if(topScorers){
    const goals={};
    S.events.filter(e=>(e.event_type||e.eventType)==='goal').forEach(e=>{goals[e.player]=(goals[e.player]||0)+1;});
    const sorted=Object.entries(goals).sort((a,b)=>b[1]-a[1]).slice(0,6);
    const maxG=sorted[0]?.[1]||1;
    topScorers.innerHTML=sorted.length
      ?sorted.map(([name,g])=>{
        const pos=S.roster.find(r=>r.name===name)?.pos||'?';
        const pct=Math.round(g/maxG*100);
        return`<div style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span class="badge b-${pos}" style="font-size:9px;padding:1px 5px">${pos}</span>
            <span style="font-size:12px;font-weight:600;color:var(--txt);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
            <span style="font-family:var(--font-ui);font-size:12px;font-weight:700;color:#f5a623">${g} ⚽</span>
          </div>
          <div style="height:3px;background:var(--bg4);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#f5a623;border-radius:2px"></div></div>
        </div>`;
      }).join('')
      :`<div style="font-size:12px;color:var(--txt3)" data-i18n="no_goals">No goals yet.</div>`;
  }

  // ── Most Picked ────────────────────────────────────────────
  const mostPicked=document.getElementById('lg-most-picked');
  if(mostPicked){
    const sorted=Object.entries(pickCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
    mostPicked.innerHTML=sorted.length&&total
      ?sorted.map(([name,count])=>statRow(name,count,total)).join('')
      :`<div style="font-size:12px;color:var(--txt3)">No picks yet.</div>`;
  }

  // ── Most Captained ─────────────────────────────────────────
  const mostCaptained=document.getElementById('lg-most-captained');
  if(mostCaptained){
    const sorted=Object.entries(capCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
    mostCaptained.innerHTML=sorted.length&&total
      ?sorted.map(([name,count])=>statRow(name,count,total,`★${count}`)).join('')
      :`<div style="font-size:12px;color:var(--txt3)">No captains yet.</div>`;
  }
}

async function handleEndOrReset(){
  if(S.type==='season'){
    if(!confirm('End this season? This will clear all scores, picks and viewers permanently.'))return;
    await resetAll();
  } else {
    await resetAll();
  }
}

async function resetAll(){
  if(!confirm('Reset session? All scores and viewers will be cleared.'))return;
  if(S.sessionCode)await db('reset_session',{session_id:S.sessionCode});
  stopAbly();
  S={sessionCode:null,roster:[],events:[],viewers:{},isLive:false,type:'oneoff',seasonEnd:null,allowNewJoiners:true,transfersPerViewer:3};
  save();
  document.getElementById('sp-upload').style.display='block';
  document.getElementById('sp-roster').style.display='none';
  document.getElementById('sp-done').style.display='none';
  document.getElementById('live-pill').style.display='none';
  document.getElementById('session-pill').textContent='';
  document.getElementById('live-locked').style.display='block';
  document.getElementById('live-panel').style.display='none';
  document.getElementById('lg-empty').style.display='block';
  document.getElementById('lg-panel').style.display='none';
  document.getElementById('squad-preview').style.display='none';
  document.getElementById('squad-file').value='';
  const seasonBadge=document.getElementById('season-badge');
  const seasonSettingsBtn=document.getElementById('season-settings-btn');
  if(seasonBadge)seasonBadge.style.display='none';
  if(seasonSettingsBtn)seasonSettingsBtn.style.display='none';
  updateSquadTab();
}

// ── Season settings editor ───────────────────────────────────────────────────
function showSeasonSettingsModal(){
  const m=document.getElementById('season-settings-modal');
  if(!m)return;
  document.getElementById('edit-season-end').value=S.seasonEnd?S.seasonEnd.slice(0,16):'';
  document.getElementById('edit-allow-new-joiners').checked=S.allowNewJoiners;
  document.getElementById('edit-transfers-per-viewer').value=S.transfersPerViewer;
  m.style.display='flex';
}
function hideSeasonSettingsModal(){
  const m=document.getElementById('season-settings-modal');
  if(m)m.style.display='none';
}
async function saveSeasonSettings(){
  const allowNewJoiners=document.getElementById('edit-allow-new-joiners').checked;
  const transfersPerViewer=parseInt(document.getElementById('edit-transfers-per-viewer').value,10);
  if(isNaN(transfersPerViewer)||transfersPerViewer<1){alert('Transfers must be at least 1.');return;}
  await db('update_season_settings',{session_id:S.sessionCode,season_end:null,allow_new_joiners:allowNewJoiners,transfers_per_viewer:transfersPerViewer});
  S.allowNewJoiners=allowNewJoiners;
  S.transfersPerViewer=transfersPerViewer;
  hideSeasonSettingsModal();
}

// ── Squad management tab ─────────────────────────────────────────────────────
function renderSquadManage(){
  const list=document.getElementById('squad-manage-list');
  if(!list)return;
  if(!S.roster.length){list.innerHTML='<div style="font-size:13px;color:var(--txt3)">No players in squad.</div>';return;}
  const byPos={DEF:[],MID:[],ATT:[]};
  S.roster.forEach(p=>{if(byPos[p.pos])byPos[p.pos].push(p);});
  list.innerHTML=['DEF','MID','ATT'].map(pos=>{
    if(!byPos[pos].length)return'';
    return`<div style="margin-bottom:14px">
      <div style="font-family:var(--font-ui);font-size:11px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${PL[pos]}</div>
      ${byPos[pos].map(p=>`
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
          ${posAvatar(p.pos,24)}
          <span style="flex:1;font-size:13px;color:var(--txt)">${p.name}</span>
        </div>`).join('')}
    </div>`;
  }).join('');
}

async function squadAddPlayer(){
  const nameEl=document.getElementById('squad-add-name');
  const posEl=document.getElementById('squad-add-pos');
  const errEl=document.getElementById('squad-add-err');
  const name=sanitise(nameEl.value.trim(),60);
  const pos=posEl.value;
  errEl.style.display='none';
  if(!name){errEl.style.display='block';errEl.textContent='Please enter a player name.';return;}
  if(S.roster.find(p=>p.name.toLowerCase()===name.toLowerCase())){errEl.style.display='block';errEl.textContent='Player already in squad.';return;}
  S.roster.push({name,pos});
  await db('save_roster',{session_id:S.sessionCode,players:S.roster});
  nameEl.value='';
  renderSquadManage();
}


function updateSquadTab(){
  const card=document.getElementById('squad-mgmt-card');
  if(card)card.style.display=S.type==='season'&&checkStreamerAuth()?'block':'none';
}

// ── Transfer UI (viewer side) ────────────────────────────────────────────────
function renderTransferUI(vname){
  console.log('renderTransferUI called — S.type:',S.type,'S.transfersPerViewer:',S.transfersPerViewer,'viewer:',S.viewers[vname]);
  if(S.type!=='season')return '';
  const v=S.viewers[vname];
  if(!v)return '';
  const used=v.transfersUsed||0;
  const total=S.transfersPerViewer||3;
  const remaining=total-used;
  const posLabels={DEF:'Defender',MID:'Midfielder',ATT:'Attacker',CAP:'Captain (2×)'};
  const posKeys=['DEF','MID','ATT','CAP'];
  const posOptions=(pos)=>{
    const filterPos=pos==='CAP'?null:pos;
    return S.roster
      .filter(p=>filterPos?p.pos===filterPos:true)
      .map(p=>`<option value="${p.name}"${v.picks[pos]===p.name?' selected':''}>${p.name}</option>`)
      .join('');
  };
  if(remaining<=0){
    return `<div class="transfer-panel" style="margin-top:16px;padding:12px 14px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
      <div style="font-size:13px;color:var(--txt3);text-align:center">All ${total} transfers used — picks locked for this season.</div>
    </div>`;
  }
  return `<div class="transfer-panel" style="margin-top:16px;padding:14px;background:var(--bg3);border-radius:8px;border:1px solid var(--accent)44">
    <div style="font-size:13px;font-weight:600;color:var(--accent);margin-bottom:10px">Transfers remaining: ${remaining}/${total}</div>
    ${posKeys.map(pos=>`
      <div style="margin-bottom:8px">
        <div style="font-size:11px;color:var(--txt3);margin-bottom:3px">${posLabels[pos]}</div>
        <select id="transfer-${pos}" style="width:100%;background:var(--bg4);color:var(--txt);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px">${posOptions(pos)}</select>
      </div>`).join('')}
    <button class="btn btn-accent" onclick="submitTransfers('${vname}')" style="width:100%;margin-top:8px;font-size:13px">Save transfers</button>
  </div>`;
}

async function submitTransfers(vname){
  if(!oauthUser)return;
  const v=S.viewers[vname];
  if(!v)return;
  const posKeys=['DEF','MID','ATT','CAP'];
  const changes=[];
  for(const pos of posKeys){
    const el=document.getElementById('transfer-'+pos);
    if(el&&el.value!==v.picks[pos])changes.push({pos:('pick_'+pos.toLowerCase()),newPlayer:el.value,displayPos:pos});
  }
  if(!changes.length){alert('No changes detected.');return;}
  const used=v.transfersUsed||0;
  const remaining=S.transfersPerViewer-used;
  if(changes.length>remaining){alert(`You only have ${remaining} transfer(s) remaining but made ${changes.length} change(s). Please reduce your changes.`);return;}
  for(const {pos,newPlayer,displayPos} of changes){
    const res=await db('use_transfer',{session_id:S.sessionCode,oauth_id:oauthUser.oauthId,pos,new_player:newPlayer});
    if(res&&res.error){alert('Transfer failed: '+res.error);return;}
    // Update local state
    v.picks[displayPos]=newPlayer;
    v.transfersUsed=(v.transfersUsed||0)+1;
  }
  showDash(vname);
}

// ── Mod promotion / demotion ─────────────────────────────────────────────────
async function promoteMod(viewerName) {
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  if (!jwt) { alert('You must be logged in as a streamer to do this.'); return; }
  const safeName = sanitise(viewerName, 60);
  const res = await db('promote_mod', { session_id: S.sessionCode, viewer_name: safeName, user_jwt: jwt });
  if (res && res.error) { alert('Could not promote: ' + res.error); return; }
  if (S.viewers[viewerName]) S.viewers[viewerName].isMod = true;
  renderViewerList();
}

async function demoteMod(viewerName) {
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  if (!jwt) { alert('You must be logged in as a streamer to do this.'); return; }
  const safeName = sanitise(viewerName, 60);
  const res = await db('demote_mod', { session_id: S.sessionCode, viewer_name: safeName, user_jwt: jwt });
  if (res && res.error) { alert('Could not demote: ' + res.error); return; }
  if (S.viewers[viewerName]) S.viewers[viewerName].isMod = false;
  renderViewerList();
}

function renderViewerList() {
  const el = document.getElementById('viewer-list');
  if (!el) return;
  const viewers = Object.entries(S.viewers);
  if (!viewers.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--txt3)">No viewers have joined yet.</div>';
    return;
  }
  el.innerHTML = viewers.map(([name, v]) => {
    const isMod = v.isMod || false;
    const locked = v.locked ? '🔒' : '⏳';
    const platBadge = v.platform === 'twitch'
      ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#9146ff22;color:#9146ff;font-family:var(--font-ui);font-weight:700;margin-left:4px">TW</span>'
      : v.platform === 'youtube'
        ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:#ff000022;color:#ff0000;font-family:var(--font-ui);font-weight:700;margin-left:4px">YT</span>'
        : '';
    const modBadge = isMod ? '<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:#1a1f2e;color:#f5a623;font-family:var(--font-ui);font-weight:700;margin-left:4px;border:1px solid #f5a62355">MOD</span>' : '';
    const safeName = name.replace(/'/g, "\\'");
    const modBtn = isMod
      ? `<button class="evt-btn" onclick="demoteMod('${safeName}')" style="font-size:10px;color:var(--att)">Demote</button>`
      : `<button class="evt-btn" onclick="promoteMod('${safeName}')" style="font-size:10px;color:#f5a623">Make Mod</button>`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:13px;color:var(--txt);font-weight:500;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${locked} ${name}${platBadge}${modBadge}</span>
      ${modBtn}
    </div>`;
  }).join('');
}

// ── Admin dashboard ──────────────────────────────────────────────────────────
let adminRefreshInterval = null;

async function adminEndSession(sessionId) {
  if (!confirm(`Force-end session ${sessionId}? This sets it to not-live but keeps all data.`)) return;
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  const res = await db('end_stream', { session_id: sessionId, user_jwt: jwt });
  if (res && res.error) { alert('Error: ' + res.error); return; }
  renderAdminTab();
}

async function adminInspectSession(sessionId) {
  const modal = document.getElementById('inspect-modal');
  const content = document.getElementById('inspect-content');
  if (!modal || !content) return;
  content.innerHTML = '<div style="font-size:13px;color:var(--txt3)">Loading...</div>';
  modal.style.display = 'flex';
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  const data = await db('admin_inspect_session', { session_id: sessionId, user_jwt: jwt });
  if (!data || data.error) {
    content.innerHTML = `<div style="font-size:13px;color:var(--att)">${data?.error || 'Failed to load.'}</div>`;
    return;
  }
  const { session, streamer_email, streamer_channel, roster, events, viewers } = data;
  const created = new Date(session.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const liveBadge = session.is_live
    ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:#0a200a;color:#4aff91;font-family:var(--font-ui);font-weight:700;border:1px solid #4aff9155">LIVE</span>'
    : '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--bg3);color:var(--txt3);font-family:var(--font-ui);font-weight:700">ENDED</span>';
  const typeBadge = session.type === 'season'
    ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:#1a0a2e;color:#c084fc;font-family:var(--font-ui);font-weight:700;border:1px solid #c084fc55;margin-left:4px">SEASON</span>'
    : '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--bg3);color:var(--txt3);font-family:var(--font-ui);font-weight:700;margin-left:4px">ONE-OFF</span>';
  const channelDisplay = streamer_channel
    ? `<span style="color:var(--accent);font-weight:600">${streamer_channel}</span> <span style="color:var(--txt3)">(${streamer_email})</span>`
    : `<span style="color:var(--txt2)">${streamer_email}</span>`;

  // Compute scores inline (same logic as getScore)
  const SC_local = {DEF:{goal:3,assist:3,clean_sheet:5},MID:{goal:3,assist:5,clean_sheet:3},ATT:{goal:5,assist:3,clean_sheet:1}};
  const evtPts = {};
  events.forEach(e => {
    evtPts[e.player_name] = (evtPts[e.player_name] || 0) + Number(e.points);
  });

  // Leaderboard
  const lb = viewers
    .filter(v => v.locked)
    .map(v => {
      const base_pts = evtPts[v.pick_def] || 0;
      const picks = [v.pick_def, v.pick_mid, v.pick_att];
      let pts = picks.reduce((sum, p) => sum + (evtPts[p] || 0), 0);
      if (v.pick_cap) pts += (evtPts[v.pick_cap] || 0); // cap 2x = +1x on top
      return { name: v.viewer_name, pts, picks, cap: v.pick_cap, platform: v.platform, isMod: v.is_mod };
    })
    .sort((a, b) => b.pts - a.pts);

  // By-position roster
  const byPos = { DEF: [], MID: [], ATT: [] };
  roster.forEach(p => { if (byPos[p.pos]) byPos[p.pos].push(p); });

  const posColours = { DEF: '#4a9eff', MID: '#f5a623', ATT: '#ff5a5a' };

  content.innerHTML = `
    <!-- Header -->
    <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
      <div style="font-size:16px;font-weight:700;color:var(--txt);margin-bottom:4px">${session.id} ${liveBadge}${typeBadge}</div>
      <div style="font-size:13px;margin-bottom:2px">${channelDisplay}</div>
      <div style="font-size:11px;color:var(--txt3)">${created} · ${viewers.length} viewer${viewers.length!==1?'s':''} · ${events.length} event${events.length!==1?'s':''}</div>
      ${session.type==='season' && session.season_end ? `<div style="font-size:11px;color:#c084fc;margin-top:2px">Season ends ${new Date(session.season_end).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</div>` : ''}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">

      <!-- LEFT: Squad + Events -->
      <div>
        <div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);margin-bottom:8px">Squad (${roster.length})</div>
        ${['DEF','MID','ATT'].map(pos => {
          const players = byPos[pos];
          if (!players.length) return '';
          return `<div style="margin-bottom:10px">
            <div style="font-size:10px;font-weight:700;color:${posColours[pos]};font-family:var(--font-ui);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${pos}</div>
            ${players.map(p => {
              const pts = evtPts[p.name] || 0;
              return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)22">
                <span style="color:var(--txt)">${p.name}</span>
                ${pts ? `<span style="color:var(--accent);font-weight:700;font-family:var(--font-ui)">+${pts}</span>` : '<span style="color:var(--txt3)">0</span>'}
              </div>`;
            }).join('')}
          </div>`;
        }).join('')}

        <div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);margin-top:16px;margin-bottom:8px">Events (${events.length})</div>
        ${events.length ? [...events].reverse().slice(0,15).map(e =>
          `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--border)22;color:var(--txt2)">
            <span style="color:${posColours[e.pos]||'var(--txt3)'};font-weight:600">${e.player_name}</span>
            <span style="color:var(--txt3)"> · ${e.event_type.replace(/_/g,' ')}</span>
            <span style="color:var(--accent);font-weight:700;float:right">${Number(e.points)>0?'+':''}${e.points}</span>
          </div>`
        ).join('') + (events.length > 15 ? `<div style="font-size:11px;color:var(--txt3);margin-top:4px">+${events.length-15} more events</div>` : '')
        : '<div style="font-size:12px;color:var(--txt3)">No events yet.</div>'}
      </div>

      <!-- RIGHT: Leaderboard -->
      <div>
        <div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);margin-bottom:8px">Managers (${viewers.length})</div>
        ${viewers.length ? viewers.map(v => {
          const isLocked = v.locked;
          const platBadge = v.platform === 'twitch'
            ? '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#9146ff22;color:#9146ff;font-family:var(--font-ui);font-weight:700;margin-left:3px">TW</span>'
            : v.platform === 'youtube'
              ? '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#ff000022;color:#ff0000;font-family:var(--font-ui);font-weight:700;margin-left:3px">YT</span>'
              : '';
          const modBadge = v.is_mod ? '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#1a1f2e;color:#f5a623;font-family:var(--font-ui);font-weight:700;margin-left:3px;border:1px solid #f5a62355">MOD</span>' : '';
          const lockIcon = isLocked ? '🔒' : '⏳';
          const picks = [v.pick_def,v.pick_mid,v.pick_att].filter(Boolean).join(' · ') || '—';
          const capStr = v.pick_cap ? ` · ★${v.pick_cap}` : '';
          // Simple pts: sum of picked players' event points (cap counts double via +1x)
          let pts = [v.pick_def, v.pick_mid, v.pick_att, v.pick_cap].filter(Boolean)
            .reduce((sum, p) => sum + (evtPts[p] || 0), 0);
          return `<div style="padding:7px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
              <div style="font-size:12px;font-weight:600;color:var(--txt)">${lockIcon} ${v.viewer_name}${platBadge}${modBadge}</div>
              ${isLocked ? `<div style="font-family:var(--font-ui);font-size:13px;font-weight:700;color:var(--accent)">${pts}pts</div>` : '<div style="font-size:11px;color:var(--txt3)">not locked</div>'}
            </div>
            <div style="font-size:11px;color:var(--txt3)">${picks}${capStr}</div>
          </div>`;
        }).join('')
        : '<div style="font-size:12px;color:var(--txt3)">No viewers yet.</div>'}
      </div>

    </div>`;
}

async function renderAdminTab() {
  const el = document.getElementById('admin-sessions-list');
  if (!el) return;
  el.innerHTML = '<div style="font-size:13px;color:var(--txt3)">Loading...</div>';
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  if (!jwt) { el.innerHTML = '<div style="font-size:13px;color:var(--att)">Not authenticated.</div>'; return; }
  const data = await db('admin_get_sessions', { user_jwt: jwt });
  if (!Array.isArray(data)) {
    el.innerHTML = '<div style="font-size:13px;color:var(--att)">' + (data && data.error ? data.error : 'Failed to load.') + '</div>';
    return;
  }
  if (!data.length) { el.innerHTML = '<div style="font-size:13px;color:var(--txt3)">No sessions found.</div>'; return; }
  const live = data.filter(s => s.is_live);
  const notLive = data.filter(s => !s.is_live);
  const renderRow = (s) => {
    const created = new Date(s.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const liveBadge = s.is_live
      ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:#0a200a;color:#4aff91;font-family:var(--font-ui);font-weight:700;border:1px solid #4aff9155">LIVE</span>'
      : '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:var(--bg3);color:var(--txt3);font-family:var(--font-ui);font-weight:700">ENDED</span>';
    const typeBadge = s.type === 'season'
      ? '<span style="font-size:10px;padding:2px 7px;border-radius:3px;background:#1a0a2e;color:#c084fc;font-family:var(--font-ui);font-weight:700;border:1px solid #c084fc55;margin-left:4px">SEASON</span>'
      : '';
    // Show channel name if set, otherwise fall back to email username
    const channelDisplay = s.streamer_channel
      ? `<span style="color:var(--accent);font-weight:600">${s.streamer_channel}</span> <span style="font-size:11px;color:var(--txt3)">(${s.streamer_email})</span>`
      : (() => { const p = (s.streamer_email||'Unknown').split('@'); return p[0]+'<span style="color:var(--txt3)">@'+p[1]+'</span>'; })();
    const endBtn = s.is_live
      ? `<button class="evt-btn" onclick="adminEndSession('${s.id}')" style="font-size:10px;color:var(--att);white-space:nowrap;flex-shrink:0">End session</button>`
      : '';
    const inspectBtn = `<button class="evt-btn" onclick="adminInspectSession('${s.id}')" style="font-size:10px;color:var(--accent);white-space:nowrap;flex-shrink:0">Inspect</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:var(--txt);font-weight:600;margin-bottom:3px">${s.id} ${liveBadge}${typeBadge}</div>
        <div style="font-size:12px;color:var(--txt2);font-family:monospace">${channelDisplay}</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:2px">${created} &middot; ${s.viewer_count} viewer${s.viewer_count !== 1 ? 's' : ''}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">${inspectBtn}${endBtn}</div>
    </div>`;
  };
  let html = '';
  if (live.length) {
    html += `<div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#4aff91;margin-bottom:4px">Live (${live.length})</div>`;
    html += live.map(renderRow).join('');
  }
  if (notLive.length) {
    html += `<div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);margin:12px 0 4px">Recent (${notLive.length})</div>`;
    html += notLive.map(renderRow).join('');
  }
  el.innerHTML = html;
  const ts = document.getElementById('admin-last-refresh');
  if (ts) ts.textContent = 'Updated: ' + new Date().toLocaleTimeString();
}

// ── Auth ────────────────────────────────────────────────────────────────────
let streamerAuthed = false;
let uiMode = localStorage.getItem('ffm_ui_mode') || null; // null | 'viewer' | 'streamer'

function setUIMode(mode) {
  uiMode = mode;
  try { localStorage.setItem('ffm_ui_mode', mode); } catch(e) {}
  const tabs = {
    'nb-home':     { viewer: true,  streamer: true,  mod: true  },
    'nb-setup':    { viewer: false, streamer: true,  mod: false },
    'nb-live':     { viewer: false, streamer: true,  mod: true  },
    'nb-viewer':   { viewer: true,  streamer: false, mod: true  },
    'nb-league':   { viewer: true,  streamer: true,  mod: true  },
    'nb-streamer': { viewer: false, streamer: true,  mod: false },
    'nb-admin':    { viewer: false, streamer: false, mod: false },
  };
  Object.entries(tabs).forEach(([id, vis]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const show = mode === 'viewer' ? vis.viewer : mode === 'streamer' ? vis.streamer : mode === 'mod' ? vis.mod : id === 'nb-home';
    el.style.display = show ? '' : 'none';
  });
  // Admin tab: only show when streamer AND admin access_type
  const adminTab = document.getElementById('nb-admin');
  if(adminTab){
    const isAdmin = mode === 'streamer' && localStorage.getItem('ffm_access_type') === 'admin';
    adminTab.style.display = isAdmin ? '' : 'none';
  }
  // Update switch link
  const switchEl = document.getElementById('mode-switch-link');
  if (switchEl) {
    if (mode === 'viewer') {
      switchEl.innerHTML = 'Switch to streamer view';
      switchEl.onclick = () => { setUIMode('streamer'); goTab('streamer', document.getElementById('nb-streamer')); };
    } else if (mode === 'streamer') {
      switchEl.innerHTML = 'Switch to viewer';
      switchEl.onclick = () => { setUIMode('viewer'); goTab('viewer', document.getElementById('nb-viewer')); };
    } else if (mode === 'mod') {
      switchEl.innerHTML = 'Switch to viewer view';
      switchEl.onclick = () => { setUIMode('viewer'); goTab('viewer', document.getElementById('nb-viewer')); };
    }
    switchEl.style.display = mode ? 'inline' : 'none';
  }
}

function clearUIMode() {
  uiMode = null;
  try { localStorage.removeItem('ffm_ui_mode'); } catch(e) {}
  ['nb-setup','nb-live','nb-viewer','nb-league','nb-streamer','nb-admin'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const switchEl = document.getElementById('mode-switch-link');
  if (switchEl) switchEl.style.display = 'none';
}

function checkStreamerAuth() {
  return streamerAuthed === true && localStorage.getItem('ffm_streamer_authed') === 'true';
}

function requireAuth(tab, btn) {
  if (!checkStreamerAuth()) {
    // Redirect to streamer tab
    goTab('streamer', document.getElementById('nb-streamer'));
    return false;
  }
  return true;
}

function goTab(tab, btn) {
  // Protect setup tab from non-streamers
  if (tab === 'setup' && !checkStreamerAuth()) {
    tab = 'streamer';
    btn = document.getElementById('nb-streamer');
  }
  // Protect live tab: streamers and mods can access, others redirect
  if (tab === 'live' && !checkStreamerAuth() && uiMode !== 'mod') {
    tab = 'streamer';
    btn = document.getElementById('nb-streamer');
  }
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sec-' + tab).classList.add('active');
  if(btn) btn.classList.add('active');
  if (tab === 'admin') {
    renderAdminTab();
    // Auto-refresh every 30s while on admin tab
    if (adminRefreshInterval) clearInterval(adminRefreshInterval);
    adminRefreshInterval = setInterval(renderAdminTab, 30000);
  } else {
    if (adminRefreshInterval) { clearInterval(adminRefreshInterval); adminRefreshInterval = null; }
  }
  if (tab === 'league') renderLeague();
  if (tab === 'streamer') renderStreamerTab();
  if (tab === 'admin') renderAdminTab();
  if (tab === 'live') { updateSquadTab(); renderSquadManage(); }
  updateSetupTabLabel();
}

function updateSetupTabLabel(){
  const btn=document.getElementById('nb-setup');
  if(!btn)return;
  if(S.isLive&&S.type==='season') btn.textContent='Season Settings';
  else if(S.isLive) btn.textContent='Session Settings';
  else btn.textContent='Setup';
}

function formatDateDisplay(isoString){
  if(!isoString)return'';
  const d=new Date(isoString);
  return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

function updateDateDisplay(inputId, displayId){
  const input=document.getElementById(inputId);
  const display=document.getElementById(displayId);
  if(!input||!display)return;
  input.addEventListener('change',()=>{
    display.textContent=input.value?'✓ '+formatDateDisplay(new Date(input.value).toISOString()):'';
  });
}

function updateSeasonEndConfirm() {
  const input = document.getElementById('season-end-input');
  const display = document.getElementById('season-end-display');
  if (!input || !display) return;
  if (input.value) {
    const d = new Date(input.value);
    display.textContent = '✓ ' + d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' });
    display.style.color = '#4aff91';
  } else {
    display.textContent = '';
  }
}

// Initialise date displays
document.addEventListener('DOMContentLoaded',()=>{
  updateDateDisplay('season-end-input','season-end-display');
  updateDateDisplay('edit-season-end','edit-season-end-display');
});

async function saveChannelName() {
  const input = document.getElementById('channel-name-input');
  const status = document.getElementById('channel-name-status');
  const jwt = localStorage.getItem('ffm_streamer_jwt');
  if (!input || !jwt) return;
  const val = input.value.trim();
  if (!val) { if (status) { status.textContent = 'Please enter a channel name.'; status.style.color = 'var(--att)'; } return; }
  if (status) { status.textContent = 'Saving...'; status.style.color = 'var(--txt3)'; }
  const res = await db('update_channel_name', { channel_name: val, user_jwt: jwt });
  if (res && res.ok) {
    localStorage.setItem('ffm_channel_name', val);
    if (status) { status.textContent = '✓ Saved'; status.style.color = '#4aff91'; }
    // Hide the profile banner if it was showing
    const banner = document.getElementById('profile-banner');
    if (banner) banner.style.display = 'none';
    setTimeout(() => { if (status) status.textContent = ''; }, 2500);
  } else {
    if (status) { status.textContent = 'Error saving. Try again.'; status.style.color = 'var(--att)'; }
  }
}

function renderStreamerTab() {
  if (checkStreamerAuth()) {
    document.getElementById('str-login').style.display = 'none';
    document.getElementById('str-dash').style.display = 'block';
    const accessType = localStorage.getItem('ffm_access_type');
    const channelName = localStorage.getItem('ffm_channel_name') || '';
    // Populate channel name input
    const cnInput = document.getElementById('channel-name-input');
    if (cnInput) cnInput.value = channelName;
    // Show/hide "complete your profile" banner
    const banner = document.getElementById('profile-banner');
    if (banner) banner.style.display = channelName ? 'none' : 'block';
    if (accessType === 'admin') {
      document.getElementById('admin-panel').style.display = 'block';
      loadStreamers();
      const adminTab = document.getElementById('nb-admin');
      if (adminTab) adminTab.style.display = '';
    }
    loadTwitchChannel();
    updateSquadTab();
  } else {
    document.getElementById('str-login').style.display = 'block';
    document.getElementById('str-dash').style.display = 'none';
  }
}

async function streamerLogin() {
  const email = document.getElementById('str-email').value.trim();
  const pass = document.getElementById('str-pass').value;
  const err = document.getElementById('str-err');
  if (!email || !pass) { err.style.display = 'block'; err.textContent = 'Please enter your email and password.'; return; }
  err.style.display = 'none';

  const btn = document.querySelector('#str-login .btn-accent');
  btn.textContent = 'Signing in...';
  btn.disabled = true;

  try {
    const r = await fetch('/.netlify/functions/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'auth_login', payload: { email, password: pass } })
    });
    const data = await r.json();
    if (data.error) {
      err.style.display = 'block';
      if (data.error === 'NEEDS_PAYMENT') {
        err.innerHTML = 'A subscription is required to access FantasyFM. <a href="#" onclick="document.getElementById(\'checkout-section\').scrollIntoView({behavior:\'smooth\'});return false;" style="color:var(--accent);text-decoration:underline">Subscribe below →</a>';
      } else if (data.error === 'SUBSCRIPTION_EXPIRED') {
        err.innerHTML = 'Your subscription has expired. <a href="#" onclick="document.getElementById(\'checkout-section\').scrollIntoView({behavior:\'smooth\'});return false;" style="color:var(--accent);text-decoration:underline">Renew below →</a>';
      } else {
        err.textContent = data.error;
      }
      btn.textContent = 'Sign in →';
      btn.disabled = false;
    } else {
      localStorage.setItem('ffm_streamer_authed', 'true');
      localStorage.setItem('ffm_streamer_email', data.email);
      localStorage.setItem('ffm_access_type', data.access_type || 'beta');
      localStorage.setItem('ffm_channel_name', data.channel_name || '');
      if(data.access_token) localStorage.setItem('ffm_streamer_jwt', data.access_token);
      if(data.user_id) localStorage.setItem('ffm_streamer_uid', data.user_id);
      streamerAuthed = true;
      btn.textContent = 'Sign in →';
      btn.disabled = false;
      setUIMode('streamer');
      renderStreamerTab();
    }
  } catch(e) {
    err.style.display = 'block';
    err.textContent = 'Connection error. Please try again.';
    btn.textContent = 'Sign in →';
    btn.disabled = false;
  }
}

function streamerLogout() {
  localStorage.removeItem('ffm_streamer_authed');
  localStorage.removeItem('ffm_streamer_email');
  localStorage.removeItem('ffm_access_type');
  localStorage.removeItem('ffm_channel_name');
  localStorage.removeItem('ffm_streamer_jwt');
  localStorage.removeItem('ffm_streamer_uid');
  streamerAuthed = false;
  clearUIMode();
  goTab('home', document.getElementById('nb-home'));
  renderStreamerTab();
}

async function startCheckout() {
  const email = document.getElementById('checkout-email').value.trim();
  const err = document.getElementById('checkout-err');
  if (!email || !email.includes('@')) { err.style.display='block'; err.textContent='Please enter a valid email address.'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('#str-login .btn-accent:last-of-type');
  const checkoutBtn = document.querySelector('#checkout-email + * + * + button, button[onclick="startCheckout()"]');
  if (checkoutBtn) { checkoutBtn.textContent = 'Redirecting to payment...'; checkoutBtn.disabled = true; }
  const result = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create_checkout', payload: { email } })
  }).then(r => r.json());
  if (result.error) {
    err.style.display = 'block';
    err.textContent = result.error;
    if (checkoutBtn) { checkoutBtn.textContent = 'Get access — £5/month →'; checkoutBtn.disabled = false; }
    return;
  }
  if (result.url) window.location.href = result.url;
}

// Handle return from Stripe checkout
function checkCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') === 'success') {
    // Show success message on streamer tab
    goTab('streamer', document.getElementById('nb-streamer'));
    document.getElementById('checkout-success').style.display = 'block';
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('checkout') === 'cancelled') {
    goTab('streamer', document.getElementById('nb-streamer'));
    window.history.replaceState({}, '', window.location.pathname);
  }
}


// ── Admin ────────────────────────────────────────────────────────────────────
let currentStreamerData = null;

async function submitWaitlist(){
  const name = document.getElementById('wl-name').value.trim();
  const email = document.getElementById('wl-email').value.trim();
  const channel = document.getElementById('wl-twitch').value.trim();
  const err = document.getElementById('wl-err');
  if(!name || !email || !channel){ err.style.display='block'; err.textContent='Name, email and channel are required.'; return; }
  if(!email.includes('@')){ err.style.display='block'; err.textContent='Please enter a valid email.'; return; }
  err.style.display='none';
  const btn = document.querySelector('#waitlist-form .btn-accent');
  if(btn){ btn.textContent='Joining...'; btn.disabled=true; }
  const result = await db('add_waitlist', { name, email, channel: channel||null });
  if(btn){ btn.textContent='Join waitlist →'; btn.disabled=false; }
  if(result && result.error){
    err.style.display='block';
    err.textContent = result.error.includes('duplicate') ? 'This email is already on the waitlist!' : result.error;
    return;
  }
  document.getElementById('waitlist-form').style.display='none';
  document.getElementById('waitlist-success').style.display='block';
}

async function loadWaitlist(){
  const list = document.getElementById('waitlist-list');
  if(!list) return;
  list.innerHTML = '<div style="font-size:13px;color:var(--txt3)">Loading...</div>';
  const data = await db('get_waitlist', {});
  if(!Array.isArray(data) || !data.length){
    list.innerHTML = '<div style="font-size:13px;color:var(--txt3)">No waitlist entries yet.</div>';
    return;
  }
  list.innerHTML = data.map(w => {
    const date = new Date(w.created_at).toLocaleDateString('en-GB');
    const channelBadge = w.channel ? `<span style="font-size:11px;color:var(--txt3)"> · ${w.channel}</span>` : '';
    const grantBtn = `<button class="evt-btn" onclick="grantFromWaitlist('${w.email}','${w.name.replace(/'/g,"\'")}',${w.id})" style="font-size:10px;color:#4aff91">Grant access</button>`;
    const removeBtn = `<button class="evt-btn" onclick="removeWaitlist(${w.id})" style="font-size:10px;color:var(--att)">Remove</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;color:var(--txt);font-weight:500">${w.name} <span style="font-size:11px;color:var(--txt3)">&lt;${w.email}&gt;</span>${channelBadge}</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:2px">Joined ${date}</div>
      </div>
      ${grantBtn}${removeBtn}
    </div>`;
  }).join('');
}

async function grantFromWaitlist(email, name, waitlistId){
  if(!confirm(`Grant beta access to ${name} (${email})?\n\nThis will:\n• Create their streamer account\n• Auto-generate a secure password\n• Send them a welcome email from welcome@fantasyfm.io\n• Remove them from the waitlist`)) return;

  // Show loading state on the button
  const btn = event.target;
  const origText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  const result = await fetch('/.netlify/functions/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'grant_and_email', payload: { email, name, waitlist_id: waitlistId } })
  }).then(r => r.json());

  btn.textContent = origText;
  btn.disabled = false;

  if(result && result.error){
    alert('Error: ' + result.error);
    return;
  }
  // Success — show confirmation
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;top:20px;right:20px;background:#161820;border:1px solid #4aff91;border-radius:8px;padding:14px 20px;font-size:13px;color:#4aff91;z-index:9999;font-family:var(--font-ui);font-weight:600;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,0.4)';
  msg.innerHTML = `✓ Access granted &amp; welcome email sent to <strong>${email}</strong>`;
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 4000);
  loadWaitlist();
  loadStreamers();
}

async function removeWaitlist(id){
  if(!confirm('Remove this entry from the waitlist?')) return;
  await db('remove_waitlist', { id });
  loadWaitlist();
}

function switchAdminTab(tab){
  const streamersDiv = document.getElementById('streamers-list');
  const waitlistDiv  = document.getElementById('waitlist-list');
  const bugsDiv      = document.getElementById('bugs-list');
  const addForm      = document.getElementById('add-streamer-form');
  const btnS = document.getElementById('btn-tab-streamers');
  const btnW = document.getElementById('btn-tab-waitlist');
  const btnB = document.getElementById('btn-tab-bugs');
  // Hide all
  if(streamersDiv) streamersDiv.style.display='none';
  if(waitlistDiv)  waitlistDiv.style.display='none';
  if(bugsDiv)      bugsDiv.style.display='none';
  if(addForm)      addForm.style.display='none';
  // Reset all tab buttons
  [btnS,btnW,btnB].forEach(b=>{ if(b){ b.style.borderColor='var(--border)'; b.style.color='var(--txt3)'; } });
  if(tab==='waitlist'){
    if(waitlistDiv) waitlistDiv.style.display='block';
    if(btnW){ btnW.style.borderColor='var(--mid)'; btnW.style.color='var(--mid)'; }
    loadWaitlist();
  } else if(tab==='bugs'){
    if(bugsDiv) bugsDiv.style.display='block';
    if(btnB){ btnB.style.borderColor='var(--att)'; btnB.style.color='var(--att)'; }
    loadBugReports();
  } else {
    if(streamersDiv) streamersDiv.style.display='block';
    if(btnS){ btnS.style.borderColor='var(--accent)'; btnS.style.color='var(--accent)'; }
  }
}

// ── Bug reporting ────────────────────────────────────────────────────────────
function toggleBugForm(){
  const form = document.getElementById('bug-form');
  const btn  = document.getElementById('bug-toggle-btn');
  const isOpen = form.style.display !== 'none';
  form.style.display = isOpen ? 'none' : 'block';
  btn.textContent = isOpen ? 'Report →' : 'Cancel';
  // Reset state
  document.getElementById('bug-err').style.display='none';
  document.getElementById('bug-success').style.display='none';
}

async function submitBug(){
  const category    = document.getElementById('bug-category').value;
  const description = document.getElementById('bug-description').value.trim();
  const steps       = document.getElementById('bug-steps').value.trim();
  const errEl       = document.getElementById('bug-err');
  const successEl   = document.getElementById('bug-success');
  if(!description){ errEl.style.display='block'; errEl.textContent='Please describe the bug.'; return; }
  errEl.style.display='none';
  const btn = document.querySelector('#bug-form .btn-accent');
  if(btn){ btn.textContent='Submitting...'; btn.disabled=true; }
  const email = localStorage.getItem('ffm_streamer_email') || 'unknown';
  const result = await db('submit_bug',{ streamer_email:email, category, description, steps:steps||null });
  if(btn){ btn.textContent='Submit report'; btn.disabled=false; }
  if(result && result.error){ errEl.style.display='block'; errEl.textContent='Error submitting. Please try again.'; return; }
  document.getElementById('bug-description').value='';
  document.getElementById('bug-steps').value='';
  successEl.style.display='block';
  setTimeout(()=>{ toggleBugForm(); successEl.style.display='none'; },2500);
}

async function loadBugReports(){
  const list = document.getElementById('bugs-list');
  if(!list) return;
  list.innerHTML='<div style="font-size:13px;color:var(--txt3)">Loading...</div>';
  const data = await db('get_bugs',{});
  if(!Array.isArray(data)||!data.length){
    list.innerHTML='<div style="font-size:13px;color:var(--txt3)">No bug reports yet.</div>';
    return;
  }
  const catLabels={scoring:'Scoring',clean_sheet:'Clean sheets',captain:'Captain bonus',refresh:'Page/Table refresh',picks:'Player picks',session:'Session/Login',overlay:'OBS Overlay',other:'Other'};
  const open   = data.filter(b=>!b.resolved);
  const closed = data.filter(b=>b.resolved);
  const renderBug = b => {
    const date = new Date(b.created_at).toLocaleDateString('en-GB');
    const cat  = catLabels[b.category]||b.category;
    const statusCol = b.resolved ? 'var(--txt3)' : 'var(--att)';
    const statusTxt = b.resolved ? '✓ Resolved' : '● Open';
    const toggleLabel = b.resolved ? 'Re-open' : 'Resolve';
    return `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <span style="font-size:10px;font-family:var(--font-ui);font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:2px 7px;border-radius:3px;background:var(--bg3);color:var(--txt2);margin-right:6px">${cat}</span>
          <span style="font-size:11px;color:${statusCol};font-weight:600">${statusTxt}</span>
          <span style="font-size:11px;color:var(--txt3);margin-left:8px">${date} · ${b.streamer_email}</span>
        </div>
        <button class="evt-btn" onclick="resolveBug(${b.id},${!b.resolved})" style="font-size:10px;color:${b.resolved?'var(--txt3)':'#4aff91'};white-space:nowrap;flex-shrink:0">${toggleLabel}</button>
      </div>
      <div style="font-size:13px;color:var(--txt);line-height:1.5;margin-bottom:${b.steps?'4px':'0'}">${b.description}</div>
      ${b.steps?`<div style="font-size:11px;color:var(--txt3);font-style:italic;line-height:1.5">Steps: ${b.steps}</div>`:''}
    </div>`;
  };
  let html='';
  if(open.length){
    html+=`<div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--att);margin-bottom:4px">Open (${open.length})</div>`;
    html+=open.map(renderBug).join('');
  }
  if(closed.length){
    html+=`<div style="font-family:var(--font-ui);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--txt3);margin:12px 0 4px">Resolved (${closed.length})</div>`;
    html+=closed.map(renderBug).join('');
  }
  list.innerHTML=html;
}

async function resolveBug(id,resolved){
  await db('resolve_bug',{id,resolved});
  loadBugReports();
}

async function loadStreamers() {
  const list = document.getElementById('streamers-list');
  if (!list) return;
  list.innerHTML = '<div style="font-size:13px;color:var(--txt3)">Loading...</div>';
  const data = await db('get_streamers', {});
  if (!Array.isArray(data) || !data.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--txt3)">No streamers yet.</div>';
    return;
  }
  list.innerHTML = data.map(s => {
    const expired = s.expires_at && new Date(s.expires_at) < new Date();
    const expLabel = s.expires_at ? new Date(s.expires_at).toLocaleDateString('en-GB') : 'Never';
    const typeCls = s.access_type === 'admin' ? 'color:var(--accent)' : s.access_type === 'paid' ? 'color:#4aff91' : 'color:var(--mid)';
    const expiredBadge = expired ? ' ⚠ EXPIRED' : '';
    const actionBtns = s.access_type !== 'admin' 
      ? '<button class="evt-btn" onclick="extendAccess(' + s.id + ',\'' + s.access_type + '\')" style="font-size:10px">Extend</button><button class="evt-btn" onclick="revokeAccess(' + s.id + ')" style="font-size:10px;color:var(--att)">Revoke</button>'
      : '';
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-size:13px;color:var(--txt);font-weight:500">' + s.email + '</div>'
      + '<div style="font-size:11px;margin-top:2px;color:var(--txt3)"><span style="font-family:var(--font-ui);font-weight:700;' + typeCls + ';text-transform:uppercase">' + s.access_type + '</span>'
      + ' · Expires: ' + expLabel + (expired ? ' <span style="color:var(--att)">⚠ EXPIRED</span>' : '') + '</div>'
      + '</div>' + actionBtns + '</div>';
  }).join('');
}

function showAddStreamer() {
  document.getElementById('add-streamer-form').style.display = 'block';
  // Default expiry to 3 months from now
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
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
  btn.textContent = 'Adding...'; btn.disabled = true;
  const result = await db('add_streamer', {
    email, password: pass, access_type: type,
    expires_at: expiry ? new Date(expiry).toISOString() : null
  });
  btn.textContent = 'Add streamer'; btn.disabled = false;
  if (result && result.error) { err.style.display='block'; err.textContent=result.error; return; }
  document.getElementById('add-streamer-form').style.display = 'none';
  document.getElementById('new-email').value = '';
  document.getElementById('new-pass').value = '';
  loadStreamers();
}

async function extendAccess(id, type) {
  const months = prompt('Extend by how many months?', '3');
  if (!months || isNaN(months)) return;
  const d = new Date();
  d.setMonth(d.getMonth() + parseInt(months));
  await db('update_streamer', { id, access_type: type, expires_at: d.toISOString() });
  loadStreamers();
}

async function revokeAccess(id) {
  if (!confirm('Revoke this streamer access?')) return;
  await db('remove_streamer', { id });
  loadStreamers();
}


// ── Twitch Chat Bot ──────────────────────────────────────────────────────────
function saveTwitchChannel(){
  const ch = document.getElementById('twitch-channel');
  if(ch) localStorage.setItem('ffm_twitch_channel', ch.value.trim().toLowerCase());
}

function loadTwitchChannel(){
  const saved = localStorage.getItem('ffm_twitch_channel');
  const el = document.getElementById('twitch-channel');
  if(saved && el) el.value = saved;
  return saved || '';
}

async function sendChatMessage(message){
  const channel = loadTwitchChannel();
  if(!channel) return;
  try{
    await fetch('/.netlify/functions/twitch-chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channel, message})
    });
  }catch(e){ console.log('Chat error:', e); }
}

async function testChatBot(){
  const channel = loadTwitchChannel();
  const status = document.getElementById('chat-status');
  if(!channel){ if(status) status.textContent = 'Enter your channel name first.'; return; }
  if(status) status.textContent = 'Sending test message...';
  try{
    const r = await fetch('/.netlify/functions/twitch-chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({channel, message:'👋 FantasyFM bot is connected! Type !leaderboard to see the live standings.'})
    });
    const data = await r.json();
    if(data.ok){ if(status){ status.textContent = '✓ Message sent successfully!'; status.style.color='var(--accent)'; }}
    else{ if(status){ status.textContent = '✗ ' + (data.error||'Failed'); status.style.color='var(--att)'; }}
  }catch(e){
    if(status){ status.textContent = '✗ Connection error'; status.style.color='var(--att)'; }
  }
}

async function announcePicks(vname, picks){
  const cap = picks.CAP ? ` ⭐ Captain: ${picks.CAP}` : '';
  const msg = `🎮 ${vname} has locked in their squad! DEF: ${picks.DEF||'—'} · MID: ${picks.MID||'—'} · ATT: ${picks.ATT||'—'}${cap}`;
  await sendChatMessage(msg);
}

async function announceEvent(playerName, eventType, points){
  const icons = {goal:'⚽', assist:'🅰️', clean_sheet:'🧤', motm:'⭐', rating:'📊'};
  const labels = {goal:'scores', assist:'gets an assist', clean_sheet:'keeps a clean sheet', motm:'is Player of the Match', rating:'earns a rating bonus'};
  const icon = icons[eventType] || '📌';
  const label = labels[eventType] || eventType;
  const msg = `${icon} ${playerName} ${label}! (+${points}pts for managers who picked them)`;
  await sendChatMessage(msg);
}

async function announceLeaderboard(){
  const lb = getLeaderboard().slice(0, 3);
  if(!lb.length){await sendChatMessage('📊 No managers locked in yet! Join at fantasyfm.io');return;}
  const top = lb.map((v,i) => `${['🥇','🥈','🥉'][i]} ${v.name} ${v.pts}pts`).join(' · ');
  await sendChatMessage(`📊 TOP 3: ${top} | fantasyfm.io`);
}

async function announceMatchEnd(){
  const lb = getLeaderboard();
  if(!lb.length) return;
  const winner = lb[0];
  await sendChatMessage(`🏆 Match over! Top manager: ${winner.name} with ${winner.pts} points! Full leaderboard at fantasyfm.io`);
}

function enlargeMatchImg(){
  const src=document.getElementById('match-img').src;
  const lb=document.getElementById('match-lightbox');
  const lg=document.getElementById('match-img-large');
  if(lb&&lg){lg.src=src;lb.style.display='flex';}
}

function toggleAccessMgmt() {
  const body = document.getElementById('access-mgmt-body');
  const chevron = document.getElementById('access-mgmt-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function toggleScoring() {
  const col = document.getElementById('scoring-collapse');
  const chev = document.getElementById('scoring-chevron');
  const badge = document.getElementById('scoring-badge');
  const open = col.style.display === 'none';
  col.style.display = open ? 'block' : 'none';
  chev.style.transform = open ? 'rotate(180deg)' : '';
  badge.textContent = open ? 'Open' : 'Click to open';
}

function renderInsights() {
  const el = document.getElementById('player-insights');
  if (!el) return;
  const locked = Object.entries(S.viewers).filter(([,v]) => v.locked);
  if (!locked.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--txt3)">No lock-ins yet.</div>';
    return;
  }
  // Count player picks
  const picks = {};
  const capPicks = {};
  locked.forEach(([,v]) => {
    [v.picks.DEF, v.picks.MID, v.picks.ATT].filter(Boolean).forEach(p => { picks[p] = (picks[p]||0)+1; });
    if (v.picks.CAP) capPicks[v.picks.CAP] = (capPicks[v.picks.CAP]||0)+1;
  });
  const sorted = Object.entries(picks).sort((a,b) => b[1]-a[1]).slice(0,6);
  const total = locked.length;
  el.innerHTML = sorted.map(([name, count]) => {
    const pct = Math.round(count/total*100);
    const caps = capPicks[name] || 0;
    const pts = getScore(name);
    const posData = S.roster.find(r => r.name === name);
    const pos = posData?.pos || '?';
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
        <span style="font-size:12px;color:var(--txt);font-weight:500">${name} <span style="font-size:9px;color:var(--txt3)">${pos}</span></span>
        <span style="font-size:11px;color:var(--txt2)">${count}/${total} <span style="color:var(--txt3);font-size:10px">(${pct}%)${caps?` · ★${caps}cap`:''}</span>${pts?` <span style="color:var(--accent);font-weight:700">${pts}pts</span>`:''}</span>
      </div>
      <div style="height:4px;background:var(--bg4);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px;transition:width 0.4s"></div>
      </div>
    </div>`;
  }).join('');
}

function setLastMatch(home, homeScore, away, awayScore, scorers) {
  document.getElementById('lm-home').textContent = home || '—';
  document.getElementById('lm-away').textContent = away || '—';
  document.getElementById('lm-score').textContent = `${homeScore} : ${awayScore}`;
  document.getElementById('last-match-date').textContent = new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  const gl = document.getElementById('lm-goals');
  if (scorers && scorers.length) {
    gl.innerHTML = scorers.map(s =>
      `<div style="padding:3px 0;border-bottom:1px solid var(--border)"><span style="color:var(--accent);margin-right:4px">⚽</span>${s.name}${s.team?' <span style="color:var(--txt3);font-size:10px">('+s.team+')</span>':''}</div>`
    ).join('');
  } else {
    gl.innerHTML = '<div style="color:var(--txt3)">No goals recorded</div>';
  }
  // Show content, hide empty state
  const empty = document.getElementById('lm-empty-state');
  const content_ = document.getElementById('lm-content');
  const clearBtn = document.getElementById('lm-clear-btn');
  if (empty) empty.style.display = 'none';
  if (content_) content_.style.display = 'block';
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  try { localStorage.setItem('ffm_last_match_'+S.sessionCode, JSON.stringify({home,homeScore,away,awayScore,scorers,ts:Date.now()})); } catch(e) {}
}

function clearLastMatch() {
  const empty = document.getElementById('lm-empty-state');
  const content_ = document.getElementById('lm-content');
  const clearBtn = document.getElementById('lm-clear-btn');
  const dateEl = document.getElementById('last-match-date');
  if (empty) empty.style.display = 'block';
  if (content_) content_.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'none';
  if (dateEl) dateEl.textContent = '';
  try { localStorage.removeItem('ffm_last_match_'+S.sessionCode); } catch(e) {}
}

function loadLastMatch() {
  if (!S.sessionCode) return;
  try {
    const saved = localStorage.getItem('ffm_last_match_'+S.sessionCode);
    if (saved) {
      const d = JSON.parse(saved);
      setLastMatch(d.home, d.homeScore, d.away, d.awayScore, d.scorers);
    }
  } catch(e) {}
}

function showLastMatchForm() {
  const existing = document.getElementById('lm-form');
  if (existing) { existing.remove(); return; }
  const card = document.getElementById('last-match-card');
  const form = document.createElement('div');
  form.id = 'lm-form';
  form.style.cssText = 'margin-top:12px;display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center';
  form.innerHTML = `
    <input class="input-field" id="lm-home-in" placeholder="Home team" style="font-size:12px;padding:7px 10px">
    <div style="display:flex;gap:4px;align-items:center">
      <input class="input-field" id="lm-hs-in" placeholder="0" style="width:44px;text-align:center;font-size:14px;font-weight:700;padding:7px 4px">
      <span style="color:var(--txt3);font-weight:700">:</span>
      <input class="input-field" id="lm-as-in" placeholder="0" style="width:44px;text-align:center;font-size:14px;font-weight:700;padding:7px 4px">
    </div>
    <input class="input-field" id="lm-away-in" placeholder="Away team" style="font-size:12px;padding:7px 10px">
    <div style="grid-column:1/-1;margin-top:4px">
      <input class="input-field" id="lm-scorers-in" placeholder="Scorers e.g. Mané (H), Salah (H), Kane (A)" style="font-size:12px;padding:7px 10px;width:100%">
    </div>
    <div style="grid-column:1/-1;display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-success" onclick="submitLastMatch()" style="font-size:11px">Save</button>
      <button class="btn" onclick="document.getElementById('lm-form').remove()" style="font-size:11px">Cancel</button>
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
    if (m) return {name: m[1].trim(), team: m[2].toUpperCase()==='H' ? home : away};
    return {name: s.trim(), team: ''};
  }).filter(s=>s.name) : [];
  document.getElementById('lm-form')?.remove();
  setLastMatch(home, hs, away, as_, scorers);
}

function setMatchHeader(text){
  const el=document.getElementById('match-result-header');
  if(el){el.textContent=text;el.style.display='block';}
}

function updateOverlayUrl(){
  if(!S.sessionCode)return;
  const url=`${window.location.origin}/overlay.html?session=${S.sessionCode}`;
  const el=document.getElementById('overlay-url');
  if(el)el.textContent=url;
}

function copyOverlayUrl(){
  const el=document.getElementById('overlay-url');
  if(!el||el.textContent==='—')return;
  navigator.clipboard.writeText(el.textContent).then(()=>{
    const btn=document.querySelector('button[onclick="copyOverlayUrl()"]');
    if(btn){const orig=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=orig,2000);}
  });
}


function openModal(id){
  document.getElementById('modal-'+id).style.display='block';
  document.getElementById('modal-overlay').style.display='block';
  document.body.style.overflow='hidden';
}
function closeModal(){
  ['privacy','terms','pricing','changelog'].forEach(id=>{
    const el=document.getElementById('modal-'+id);
    if(el)el.style.display='none';
  });
  document.getElementById('modal-overlay').style.display='none';
  document.body.style.overflow='';
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});


// Restore streamer auth state from localStorage
if(localStorage.getItem('ffm_streamer_authed')==='true') streamerAuthed=true;

load().then(() => {
  checkOAuthReturn();
  // Auto-rejoin viewer session if we have stored picks and a code
  autoRejoinViewer();
  // Restore UI mode — but only for streamers (restoreUI sets it correctly).
  // Viewers/mods get their mode set fresh by joinGame() so we clear stale viewer/mod modes.
  const savedMode = localStorage.getItem('ffm_ui_mode');
  if (savedMode === 'streamer') setUIMode('streamer');
  else clearUIMode();
});
checkCheckoutReturn();
renderRefMatchStatus();
loadLastSubmission();
setLang(currentLang);

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
    alert('No image found in clipboard. Take a screenshot first (Win+Shift+S or Cmd+Shift+4), then click Paste.');
  } catch (err) {
    // Clipboard API might need permission - fall back to keyboard paste hint
    alert('Click here then press Ctrl+V / Cmd+V to paste your screenshot.');
  }
}

function handleImagePaste(f, forceType){
  if(!f)return;
  if(document.activeElement)document.activeElement.blur();
  if(forceType){
    readFileAs(f,forceType);
    return;
  }
  // Detect current tab from nav
  const activeNav=document.querySelector('.nav-btn.active');
  const navId=activeNav?activeNav.id:'';
  if(navId==='nb-setup'){
    const spUpload=document.getElementById('sp-upload');
    const spRoster=document.getElementById('sp-roster');
    const spDone=document.getElementById('sp-done');
    if(spUpload)spUpload.style.display='block';
    if(spRoster)spRoster.style.display='none';
    if(spDone)spDone.style.display='none';
    readFileAs(f,'squad');
  } else if(navId==='nb-live'&&S.isLive){
    readFileAs(f,'match');
  }
}

document.addEventListener('paste',function(e){
  const items=Array.from((e.clipboardData||e.originalEvent.clipboardData).items);
  const imageItem=items.find(item=>item.type.startsWith('image/'));
  if(!imageItem)return;
  // Don't intercept text paste in inputs
  const tag=(e.target.tagName||'').toLowerCase();
  const isTextInput=(tag==='input'||tag==='textarea'||e.target.isContentEditable);
  const hasText=items.some(item=>item.type==='text/plain');
  if(isTextInput&&hasText)return;
  const f=imageItem.getAsFile();
  if(!f)return;
  e.preventDefault();
  handleImagePaste(f,null);
});

// Also handle Ctrl+V / Cmd+V as a keyboard shortcut
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='v'){
    const tag=(e.target.tagName||'').toLowerCase();
    const isTextInput=(tag==='input'||tag==='textarea'||e.target.isContentEditable);
    if(isTextInput)return; // let normal paste work in inputs
    const activeNav=document.querySelector('.nav-btn.active');
    const navId=activeNav?activeNav.id:'';
    if(navId==='nb-setup'){
      e.preventDefault();
      pasteFromClipboard('squad');
    } else if(navId==='nb-live'&&S.isLive){
      e.preventDefault();
      pasteFromClipboard('match');
    }
  }
});

function readFileAs(file,type){
  const reader=new FileReader();
  reader.onload=function(ev){
    const b64=ev.target.result.split(',')[1];
    const mime=file.type||'image/png';
    if(type==='squad'){
      document.getElementById('squad-img').src=ev.target.result;
      document.getElementById('squad-preview').style.display='block';
      runSquadRead(b64,mime);
    }else if(type==='squad2'){
      runSquadRead2(b64,mime);
    }else if(type==='stats'||type==='match'){
      statsScreenB64=b64; statsScreenMime=mime;
      document.getElementById('stats-img').src=ev.target.result;
      document.getElementById('stats-preview').style.display='block';
      updateReadBtn();
    }else{
      statsScreenB64=b64; statsScreenMime=mime;
      document.getElementById('stats-img').src=ev.target.result;
      document.getElementById('stats-preview').style.display='block';
      updateReadBtn();
    }
  };
  reader.readAsDataURL(file);
}

