/* Notch Buddy — renderer */
const api = window.island;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const islandEl = $('#island');
const eyes = $('#eyes');
const miniEyes = $('#miniEyes');
const RING_C = 2 * Math.PI * 18;
const RING_XL = 2 * Math.PI * 19;

const S = {
  expanded: false,
  sticky: false,          // opened by shortcut / tray / attention
  over: false,
  view: 'home',
  store: { pinned: false, followCursor: true, expandOnAttention: true, focusMinutes: 25, notes: '', jobs: {}, focusDone: {} },
  claude: { connected: false, active: null, sessions: [], jobsToday: 0, log: [] },
  media: { has: false, recvAt: 0 },
  artKey: '',
  clips: [],
  focus: { mode: 'focus', total: 1500, left: 1500, running: false, endAt: 0 },
  lastActivity: Date.now(),
  mouseAt: 0
};

/* ---------------- helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const mmss = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; };
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const icon = id => `<svg><use href="#${id}"/></svg>`;
function setRing(el, pct, circ = RING_C) {
  el.style.strokeDasharray = `${circ} ${circ}`;
  el.style.strokeDashoffset = String(circ * (1 - Math.max(0, Math.min(1, pct))));
}
function setIcon(btn, id) {
  const use = btn.querySelector('use');
  if (use.getAttribute('href') !== '#' + id) use.setAttribute('href', '#' + id);
}
function appName(aumid = '') {
  const a = aumid.toLowerCase();
  if (a.includes('spotify')) return 'Spotify';
  if (a.includes('msedge')) return 'Microsoft Edge';
  if (a.includes('chrome')) return 'Chrome';
  if (a.includes('firefox') || a.includes('308046b0af4a39cb')) return 'Firefox';
  if (a.includes('applemusic')) return 'Apple Music';
  if (a.includes('zunemusic')) return 'Media Player';
  if (a.includes('vlc')) return 'VLC';
  if (a.includes('brave')) return 'Brave';
  if (a.includes('opera')) return 'Opera';
  const tail = aumid.split('!').pop().replace(/\.exe$/i, '');
  return tail || 'Media';
}

/* ---------------- expand / collapse ---------------- */
let expandTimer = null, collapseTimer = null;
function expand(view) {
  if (!view && !S.expanded && typeof ASK !== 'undefined' && ASK.unseen) view = 'ask';
  if (!S.expanded) api.log('expand', S.view);
  clearTimeout(collapseTimer);
  if (view) go(view);
  if (S.expanded) return;
  S.expanded = true;
  api.setInteractive(true);
  islandEl.classList.remove('ghost');
  fitWindow();
  requestAnimationFrame(() => requestAnimationFrame(() => islandEl.classList.add('expanded')));
}
function collapse() {
  if (S.store.pinned) return;
  api.log('collapse');
  S.expanded = false; S.sticky = false;
  eyes.style.transform = '';
  islandEl.classList.remove('expanded');
  api.setInteractive(false);
  fitWindow();
  if (document.activeElement) document.activeElement.blur();
  setTimeout(() => { if (!S.expanded && !editing) go('home'); }, 400);
}
function go(view) {
  S.view = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  $$('.pebble').forEach(b => b.classList.toggle('active', b.dataset.go === view));
  $('#stage').dataset.view = view;
  setText($('#bigTitle'), { claude: 'What Claude is up to', music: 'Now playing', focus: 'Focus', launch: 'Launchers', clipboard: 'Things you copied', notes: 'Scratchpad', settings: 'Make it yours', ask: 'Ask Claude' }[view] || '');
  if (view === 'ask') { ASK.unseen = false; setTimeout(() => askInput.focus(), 260); }
  gaze(view === 'home' ? null : 'down');
  fitWindow();
  if (view === 'notes') setTimeout(() => $('#notes').focus(), 250);
  renderAll();
}

/* The window hugs the island: it grows before the island grows, and shrinks after it shrinks. */
const SIZES = { collapsed: [168, 36], peeking: [300, 36], expanded: [580, 322], detail: [580, 374] };
const EAR = 14;
let winW = 0, winH = 0, shrinkTimer = null;
function targetWindow() {
  const [w, h] = S.expanded ? (S.view === 'home' ? SIZES.expanded : SIZES.detail) : islandEl.classList.contains('peeking') ? SIZES.peeking : SIZES.collapsed;
  return [w + EAR * 2, h + (S.expanded ? 22 : 4)];
}
function fitWindow() {
  const [tw, th] = targetWindow();
  if (tw === winW && th === winH) return;
  if (tw >= winW && th >= winH) {            // growing: resize now
    clearTimeout(shrinkTimer);
    winW = tw; winH = th; api.setSize(tw, th);
  } else {                                   // shrinking: grow what needs growing, shrink after the animation
    const gw = Math.max(tw, winW), gh = Math.max(th, winH);
    if (gw !== winW || gh !== winH) { winW = gw; winH = gh; api.setSize(gw, gh); }
    clearTimeout(shrinkTimer);
    shrinkTimer = setTimeout(() => {
      const [w2, h2] = targetWindow();
      winW = w2; winH = h2; api.setSize(w2, h2);
    }, 560);
  }
}
// While closed, the window is click-through and Windows floods it with forwarded enter/leave
// events, so DOM hover is only trusted while the island is open. The main process (which polls
// the real cursor) is the source of truth while closed.
document.documentElement.addEventListener('mouseenter', () => { if (S.expanded) setOver(true); });
document.documentElement.addEventListener('mouseleave', () => { if (S.expanded) setOver(false); });
document.addEventListener('mousedown', e => api.log('dom mousedown', e.clientX, e.clientY));
window.addEventListener('error', e => api.log('js error', e.message, e.lineno));
let domMoveAt = 0;
document.addEventListener('mousemove', () => { domMoveAt = Date.now(); if (S.expanded && !S.over) setOver(true); });
api.on('hover', over => setOver(over));
api.on('cursor', p => {
  S.mouseAt = Date.now();
  trackDwell(p.x, p.y);
  lookAt(p.x, p.y);
  // backup for a missed mouseleave: cursor clearly outside the window
  if (S.over && Date.now() - domMoveAt > 3000 && (p.x < -4 || p.y < -4 || p.x > window.innerWidth + 4 || p.y > window.innerHeight + 4)) setOver(false);
});
/* Opening needs intent: the cursor has to rest on the notch for a moment.
   Passing over it on the way to a browser tab only makes it fade. */
let dwellAnchor = null;
function startDwell() {
  clearTimeout(expandTimer);
  expandTimer = setTimeout(() => { if (S.over && !S.expanded) expand(); }, S.store.hoverDelay || 450);
}
function setOver(over) {
  if (over === S.over) return;
  S.over = over;
  if (over) {
    if (S.sticky === 'until-enter') S.sticky = false;
    S.lastActivity = Date.now();
    clearTimeout(collapseTimer);
    if (!S.expanded) {
      if (S.store.ghost !== false) islandEl.classList.add('ghost');
      dwellAnchor = null;
      startDwell();
    }
  } else {
    clearTimeout(expandTimer);
    islandEl.classList.remove('ghost');
    if (!S.expanded || S.store.pinned) return;
    if (S.sticky) return;
    if (S.view === 'ask' && (document.activeElement === askInput && askInput.value.trim() || ASK.busy)) return;
    collapseTimer = setTimeout(collapse, 450);
  }
}
function trackDwell(x, y) {
  if (!S.over || S.expanded) return;
  if (!dwellAnchor) { dwellAnchor = { x, y }; return; }
  if (Math.hypot(x - dwellAnchor.x, y - dwellAnchor.y) > 8) { dwellAnchor = { x, y }; startDwell(); }
}
$('.compact').addEventListener('click', () => expand());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { S.store.pinned ? null : collapse(); } });

/* clicks */
document.addEventListener('click', e => {
  const stop = e.target.closest('[data-stop]');
  if (stop) return;
  const g = e.target.closest('[data-go]');
  if (g) { go(g.dataset.go); S.sticky = false; }
});

/* ---------------- eyes ---------------- */
let lookTimer = null;
function lookAt(x, y) {
  if (!S.store.followCursor || eyeMode() !== 'idle' || S.expanded) return;
  const r = eyes.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = Math.max(-1, Math.min(1, (x - cx) / 160));
  const dy = Math.max(-1, Math.min(1, (y - cy) / 60));
  eyes.style.transform = `translate(${dx * 4}px, ${dy * 2}px)`;
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => { eyes.style.transform = ''; }, 2500);
}
function blink() {
  if (eyes.classList.contains('happy') || eyes.classList.contains('sleep')) return;
  eyes.classList.add('blink'); miniEyes.classList.add('blink');
  setTimeout(() => { eyes.classList.remove('blink'); miniEyes.classList.remove('blink'); }, 130);
}
(function blinkLoop() {
  blink();
  if (Math.random() < .25) setTimeout(blink, 240);
  setTimeout(blinkLoop, 2600 + Math.random() * 3800);
})();
// idle glances
setInterval(() => {
  if (eyeMode() !== 'idle' || Date.now() - S.mouseAt < 4000) return;
  const r = Math.random();
  if (r < .35) { eyes.style.transform = `translateX(${Math.random() < .5 ? -4 : 4}px)`; setTimeout(() => eyes.style.transform = '', 1400); }
  else if (r < .45) happyFor(1600);
}, 5000);

let happyUntil = 0;
function happyFor(ms) { happyUntil = Date.now() + ms; renderEyes(); setTimeout(renderEyes, ms + 20); }

function eyeMode() {
  const a = S.claude.active;
  if (a && a.attention) return 'wide';
  if (Date.now() < happyUntil) return 'happy';
  if (a && a.working) return 'reading';
  if (typeof ASK !== 'undefined' && ASK.busy) return 'reading';
  const busy = (S.media.has && S.media.status === 'Playing') || S.focus.running;
  if (!busy && Date.now() - S.lastActivity > 10 * 60 * 1000) return 'sleep';
  return 'idle';
}
const MOUTHS = {
  idle: 'M6 4 Q12 9 18 4', happy: 'M4 3 Q12 12 20 3', reading: 'M9.5 6 Q12 3.5 14.5 6 Q12 8.5 9.5 6',
  wide: 'M6 7 Q8 4 10 7 Q12 10 14 7 Q16 4 18 7', sleep: 'M8 6 L16 6'
};
function renderEyes() {
  const m = eyeMode();
  ['wide', 'happy', 'reading', 'sleep'].forEach(c => eyes.classList.toggle(c, c === m));
  const mp = $('#mouthPath'), d = MOUTHS[m] || MOUTHS.idle;
  if (mp.getAttribute('d') !== d) mp.setAttribute('d', d);
  $('#face').classList.toggle('happy', m === 'happy');
  if (m !== 'idle') eyes.style.transform = '';
}

/* ---------------- compact "live activity" ---------------- */
let peekKey = '';
function renderPeek() {
  const a = S.claude.active;
  const now = Date.now();
  let kind = null;
  if (a && a.attention) kind = 'attn';
  else if (a && a.working) kind = 'work';
  else if (a && a.doneAt && now - a.doneAt < 8000) kind = 'done';
  else if (ASK.busy) kind = 'asking';
  else if (ASK.unseen && now - ASK.doneAt < 60000) kind = 'answer';
  else if (S.focus.running) kind = 'focus';
  else if (S.media.has && S.media.status === 'Playing') kind = 'music';

  if (islandEl.classList.contains('peeking') !== !!kind) { islandEl.classList.toggle('peeking', !!kind); fitWindow(); }
  islandEl.classList.toggle('attention', kind === 'attn');
  const L = $('#peekLeft'), R = $('#peekRight');
  const key = kind + '|' + (kind === 'music' ? S.artKey + !!S.media.art : '');
  if (key !== peekKey) {
    peekKey = key;
    switch (kind) {
      case 'work': L.innerHTML = `<span class="pk-spin">${icon('i-spark')}</span>`; R.innerHTML = `<span class="pk-text claude" id="pkT"></span>`; break;
      case 'attn': L.innerHTML = `<span class="pk-badge warn">!</span>`; R.innerHTML = `<span class="pk-text claude">Needs you</span>`; break;
      case 'done': L.innerHTML = `<span class="pk-badge ok">${icon('i-check')}</span>`; R.innerHTML = `<span class="pk-text ok" id="pkT"></span>`; break;
      case 'asking': L.innerHTML = `<span class="pk-dots"><i></i><i></i><i></i></span>`; R.innerHTML = `<span class="pk-text claude">Thinking…</span>`; break;
      case 'answer': L.innerHTML = `<span class="pk-badge ok">${icon('i-check')}</span>`; R.innerHTML = `<span class="pk-text ok">Answer ready</span>`; break;
      case 'focus': L.innerHTML = `<svg class="pk-ring ring" viewBox="0 0 44 44"><circle class="ring-bg" cx="22" cy="22" r="18" style="stroke-width:6"/><circle id="pkRing" class="ring-fg" cx="22" cy="22" r="18" style="stroke-width:6;stroke:#b996ff"/></svg>`; R.innerHTML = `<span class="pk-text focus" id="pkT"></span>`; break;
      case 'music':
        L.innerHTML = S.media.art ? `<img class="pk-art" src="${S.media.art}">` : `<span class="pk-badge" style="background:#c43b4b;padding:4px">${icon('i-music')}</span>`;
        R.innerHTML = `<div class="bars" style="margin:0;height:14px"><i></i><i></i><i></i><i></i><i></i></div>`;
        R.classList.add('playing');
        break;
      default: L.innerHTML = ''; R.innerHTML = '';
    }
    if (kind !== 'music') R.classList.remove('playing');
  }
  const t = $('#pkT');
  if (kind === 'work' && t) setText(t, mmss((now - a.startedAt) / 1000));
  if (kind === 'done' && t) setText(t, `Done · ${mmss(a.lastDuration / 1000)}`);
  if (kind === 'focus' && t) { setText(t, mmss(S.focus.left)); const pr = $('#pkRing'); if (pr) setRing(pr, S.focus.left / S.focus.total); }
}

/* ---------------- clock & battery ---------------- */
function renderClock() {
  const d = new Date();
  setText($('#date'), d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', ''));
  setText($('#time'), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
}
if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    const upd = () => {
      const el = $('#battery');
      const lvl = b.level;
      const n = Math.max(1, Math.ceil(lvl * 4));
      el.querySelectorAll('i').forEach((i, k) => i.classList.toggle('on', k < n));
      el.style.setProperty('--bat', lvl <= .2 ? '#ff4d5a' : lvl <= .5 ? '#ffc94d' : '#3ddc84');
      el.classList.toggle('charging', b.charging && lvl < 1);
      el.title = `Battery ${Math.round(lvl * 100)}%${b.charging ? ' · charging' : ''}`;
    };
    upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
  });
}

/* ---------------- Claude ---------------- */
function renderClaude() {
  const C = S.claude, a = C.active, now = Date.now();
  const working = !!(a && a.working), attn = !!(a && a.attention);
  const pct = a && a.contextPct != null ? a.contextPct : null;

  for (const [wrap, fg, lab] of [['#cRing', '#cRingFg', '#cRingLabel'], ['#cvRing', '#cvRingFg', '#cvRingLabel']]) {
    const w = $(wrap);
    w.classList.toggle('working', working);
    w.classList.toggle('attention', attn);
    if (!working) setRing($(fg), (pct || 0) / 100);
    setText($(lab), pct == null ? '–' : pct + '%');
    w.title = pct == null ? 'Context used' : `${pct}% of context window used`;
  }

  // home bubble: the creature narrates
  let say, big = '';
  if (attn) say = 'Hey! Claude needs you';
  else if (working) { say = a.tool ? `${a.status} ${a.tool}…` : `${a.status}…`; big = mmss((now - a.startedAt) / 1000); }
  else if (a && a.doneAt && now - a.doneAt < 60000) say = `All done in ${mmss(a.lastDuration / 1000)} ✨`;
  else if (C.jobsToday) say = `${C.jobsToday} job${C.jobsToday === 1 ? '' : 's'} done today`;
  else say = S.store.hooksInstalled ? 'Waiting for Claude…' : "Claude isn't connected yet";
  setText($('#cSay'), say); setText($('#cBig'), big);
  // detail view
  setText($('#cvProject'), a ? a.project : 'Claude Code');
  setText($('#cvStatus'), a ? a.status : (S.store.hooksInstalled ? 'Waiting for a session' : 'Not connected'));
  setText($('#cvTool'), a && a.tool ? a.tool : '');
  setText($('#cvElapsed'), a ? mmss((working ? now - a.startedAt : a.lastDuration || 0) / 1000) : '0:00');
  setText($('#cvJobs'), String(C.jobsToday));
  $('.b-claude').classList.toggle('has-dot', attn);
}
let logKey = '';
function renderClaudeLists() {
  const C = S.claude;
  const key = JSON.stringify([C.log.length && C.log[0].t, C.sessions]);
  if (key === logKey) return;
  logKey = key;
  $('#cvLog').innerHTML = C.log.map(l => {
    const d = new Date(l.t);
    return `<li><span class="t">${pad(d.getHours())}:${pad(d.getMinutes())}</span><span class="k ${l.kind}"></span><span class="x" title="${esc(l.project + ' · ' + l.text)}">${esc(l.text)}</span></li>`;
  }).join('');
  $('#cvSessions').innerHTML = C.sessions.length > 1
    ? C.sessions.map(s => `<span class="chip ${s.attention ? 'attention' : s.working ? 'working' : ''}"><i></i>${esc(s.project)}</span>`).join('')
    : '';
  const showEmpty = !C.log.length;
  $('#cvEmpty').classList.toggle('show', showEmpty);
  const installed = !!S.store.hooksInstalled;
  $('#installHooks').style.display = installed ? 'none' : '';
  setText($('#hookHint'), installed ? 'Hooks are installed. Start or restart a Claude Code session and activity will appear here.' : 'Adds a few lines to ~/.claude/settings.json (a backup is kept).');
  if (installed) $('#cvEmpty p').textContent = 'No activity yet.';
}
async function doInstallHooks() {
  const r = await api.installHooks();
  if (r && r.ok) { S.store = await api.getStore(); logKey = ''; renderAll(); }
  else setText($('#hookHint'), 'Could not install: ' + (r && r.error));
}
$('#installHooks').addEventListener('click', doInstallHooks);
$('#installHooks2').addEventListener('click', doInstallHooks);

/* ---------------- Music ---------------- */
function mediaPos() {
  const m = S.media;
  if (!m.has) return 0;
  let p = m.pos || 0;
  if (m.status === 'Playing') p += (Date.now() - m.recvAt) / 1000;
  return m.dur ? Math.min(p, m.dur) : p;
}
function applyArt() {
  const src = S.media.art;
  for (const sel of ['#mArt', '#mvArt']) {
    const box = $(sel), img = box.querySelector('img');
    if (src) { if (img.src !== src) img.src = src; box.classList.add('has-img'); }
    else { img.removeAttribute('src'); box.classList.remove('has-img'); }
  }
  const card = $('#musicCard'), view = $('#musicView');
  const reset = () => ['--art-mid', '--art-end', '--art-glow'].forEach(v => { card.style.removeProperty(v); view.style.removeProperty(v); });
  if (!src) return reset();
  const im = new Image();
  im.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 12;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const w = 1 + (mx - mn) / 40;        // favour saturated pixels
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; n += w;
      }
      r /= n; g /= n; b /= n;
      const mx = Math.max(r, g, b, 1), boost = Math.min(2.2, 190 / mx);
      const end = [r, g, b].map(v => Math.round(Math.min(255, v * boost)));
      const mid = end.map(v => Math.round(v * .5));
      for (const el of [card, view]) {
        el.style.setProperty('--art-end', `rgb(${end})`);
        el.style.setProperty('--art-mid', `rgb(${mid})`);
        el.style.setProperty('--art-glow', `rgba(${end},.55)`);
      }
    } catch { reset(); }
  };
  im.src = src;
}
function renderMusic() {
  const m = S.media, has = !!m.has, playing = has && m.status === 'Playing';
  $('#musicCard').classList.toggle('playing', playing);
  $('#musicView').classList.toggle('playing', playing);
  setText($('#mWho'), has ? (playing ? `Playing on ${appName(m.app)}` : 'Paused') : 'Music');
  setText($('#mTitle'), has ? (m.title || 'Unknown track') : "It's quiet in here");
  setText($('#mArtist'), has ? (m.artist || appName(m.app)) : 'Play something and I\'ll show it');
  setText($('#mvApp'), has ? appName(m.app) : 'No media');
  setText($('#mvTitle'), has ? (m.title || 'Unknown track') : 'Nothing playing');
  setText($('#mvArtist'), has ? [m.artist, m.album].filter(Boolean).join(' — ') : 'Start music in Spotify, a browser or any player');
  for (const b of [$('#mToggle'), $('#mvToggle')]) { setIcon(b, playing ? 'i-pause' : 'i-play'); b.disabled = !has; }
  const p = mediaPos();
  $('#mvFill').style.width = has && m.dur ? (p / m.dur * 100).toFixed(2) + '%' : '0%';
  setText($('#mvPos'), mmss(p));
  setText($('#mvDur'), mmss(m.dur || 0));
}
$('#mToggle').addEventListener('click', () => api.media('toggle'));
$('#mvToggle').addEventListener('click', () => api.media('toggle'));
$$('[data-media]').forEach(b => b.addEventListener('click', () => api.media(b.dataset.media)));

/* ---------------- Focus ---------------- */
function focusSet(mode, minutes) {
  const F = S.focus;
  F.mode = mode; F.total = Math.round(minutes * 60); F.left = F.total; F.running = false;
  renderFocus();
}
function focusToggle() {
  const F = S.focus;
  if (F.running) { F.left = Math.max(0, (F.endAt - Date.now()) / 1000); F.running = false; }
  else { F.endAt = Date.now() + F.left * 1000; F.running = true; S.lastActivity = Date.now(); }
  renderFocus();
}
function chime() {
  try {
    const ctx = new AudioContext();
    [[880, 0], [1175, .18], [1568, .36]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, ctx.currentTime + t);
      g.gain.linearRampToValueAtTime(.18, ctx.currentTime + t + .02);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + .9);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 1);
    });
  } catch {}
}
function focusComplete(skipped) {
  const F = S.focus;
  if (!skipped) chime();
  if (F.mode === 'focus') {
    if (!skipped) { api.focusComplete(); api.notify('Focus session complete', 'Nice work. Take a 5 minute break.'); happyFor(3000); }
    focusSet('break', 5);
  } else {
    if (!skipped) api.notify('Break over', 'Ready for another focus session?');
    focusSet('focus', S.store.focusMinutes || 25);
  }
}
function renderFocus() {
  const F = S.focus;
  if (F.running) { F.left = Math.max(0, (F.endAt - Date.now()) / 1000); if (F.left <= 0) return focusComplete(false); }
  const t = mmss(Math.ceil(F.left - 0.001));
  setText($('#fBig'), t); setText($('#fvTime'), t);
  const fresh = F.left >= F.total - .01;
  const sub = F.mode === 'break' ? (F.running ? 'Stretch a little' : 'Break time!') : F.running ? 'Stay with it…' : fresh ? 'Ready when you are' : 'Paused';
  setText($('#fSub'), sub);
  setText($('#fvMode'), F.mode === 'break' ? 'Break' : F.running ? 'Focusing' : 'Focus');
  setRing($('#fvRingFg'), F.left / F.total, RING_XL);
  for (const b of [$('#fToggle'), $('#fvToggle')]) setIcon(b, F.running ? 'i-pause' : 'i-play');
  $$('#fvPresets button').forEach(b => b.classList.toggle('on', F.mode === 'focus' && +b.dataset.min === (S.store.focusMinutes || 25)));
  setText($('#fvDone'), String((S.store.focusDone || {})[todayKey()] || 0));
}
$('#fToggle').addEventListener('click', focusToggle);
$('#fvToggle').addEventListener('click', focusToggle);
$('#fvReset').addEventListener('click', () => focusSet(S.focus.mode, S.focus.mode === 'break' ? 5 : (S.store.focusMinutes || 25)));
$('#fvSkip').addEventListener('click', () => focusComplete(true));
$$('#fvPresets button').forEach(b => b.addEventListener('click', async () => {
  const min = +b.dataset.min;
  S.store = await api.setStore({ focusMinutes: min });
  focusSet('focus', min);
}));

/* ---------------- Clipboard ---------------- */
function renderClips() {
  $('#clips').innerHTML = S.clips.map((c, i) => `<li data-i="${i}" title="${esc(c.slice(0, 500))}">${esc(c.replace(/\s+/g, ' ').slice(0, 200))}</li>`).join('');
  $('#clipsEmpty').style.display = S.clips.length ? 'none' : '';
}
$('#clips').addEventListener('click', e => {
  const li = e.target.closest('li'); if (!li) return;
  api.copy(S.clips[+li.dataset.i]);
  li.classList.add('copied'); setTimeout(() => li.classList.remove('copied'), 600);
});
$('#clipClear').addEventListener('click', () => api.clearClips());

/* ---------------- Notes ---------------- */
let notesTimer = null;
$('#notes').addEventListener('input', e => {
  setText($('#notesSaved'), 'Saving…');
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => { S.store = await api.setStore({ notes: e.target.value }); setText($('#notesSaved'), 'Saved'); }, 500);
});

/* ---------------- Settings ---------------- */
function renderSettings() {
  $$('[data-setting]').forEach(i => { i.checked = i.dataset.setting === 'ghost' ? S.store.ghost !== false : !!S.store[i.dataset.setting]; });
  $$('#posSeg [data-pos]').forEach(b => b.classList.toggle('on', b.dataset.pos === (S.store.position || 'center')));
  $$('#modelSeg [data-model]').forEach(b => b.classList.toggle('on', b.dataset.model === (S.store.askModel || 'default')));
  $$('#delaySeg [data-delay]').forEach(b => b.classList.toggle('on', +b.dataset.delay === (S.store.hoverDelay || 450)));
  const inst = !!S.store.hooksInstalled;
  setText($('#hooksRow'), inst ? 'Claude Code hooks installed ✓' : 'Claude Code hooks');
  $('#installHooks2').disabled = inst;
  setText($('#installHooks2'), inst ? 'Installed' : 'Install');
}
$$('[data-setting]').forEach(i => i.addEventListener('change', async () => {
  S.store = await api.setStore({ [i.dataset.setting]: i.checked });
  if (i.dataset.setting === 'pinned') { if (i.checked) expand(); }
  renderSettings();
}));
$('#quitBtn').addEventListener('click', () => api.quit());
$('#posSeg').addEventListener('click', async e => { const b = e.target.closest('[data-pos]'); if (!b) return; S.store = await api.setStore({ position: b.dataset.pos }); renderSettings(); });
$('#delaySeg').addEventListener('click', async e => { const b = e.target.closest('[data-delay]'); if (!b) return; S.store = await api.setStore({ hoverDelay: +b.dataset.delay }); renderSettings(); });



/* ---------------- Ask Claude (via the user's Claude Code login) ---------------- */
const askLog = $('#askLog'), askInput = $('#askInput'), askSend = $('#askSend'), askClip = $('#askClip');
const ASK = { msgs: [], busy: false, reqId: 0, clipOn: false, clipText: '', unseen: false, doneAt: 0 };
function mdLite(src) {
  // tiny, safe markdown: escape first, then code blocks, inline code, bold, bullets, paragraphs
  const blocks = [];
  let t = esc(src).replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c.replace(/\n$/, '')); return `\u0000${blocks.length - 1}\u0000`; });
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const out = t.split(/\n{2,}/).map(par => {
    const lines = par.split('\n');
    if (lines.every(l => /^\s*([-*•]|\d+\.)\s+/.test(l) || !l.trim())) return '<ul>' + lines.filter(l => l.trim()).map(l => `<li>${l.replace(/^\s*([-*•]|\d+\.)\s+/, '')}</li>`).join('') + '</ul>';
    return `<p>${lines.join('<br>')}</p>`;
  }).join('');
  return out.replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => `<pre><code>${blocks[a ?? b]}</code></pre>`);
}
function eyesMini() { return `<span class="av"><span class="eyes" data-style="${S.store.eyes || 'classic'}"><i class="eye"></i><i class="eye"></i></span></span>`; }
function renderAsk() {
  $('#askEmpty').style.display = ASK.msgs.length ? 'none' : '';
  askLog.innerHTML = ASK.msgs.map((m, i) => m.role === 'you'
    ? `<div class="msg you">${esc(m.text)}${m.clip ? `<span class="att">+ clipboard (${m.clip.length} chars)</span>` : ''}</div>`
    : `<div class="msg bot${m.error ? ' err' : ''}">${eyesMini()}<div class="body"><div class="txt${m.pending && m.text ? ' caret' : ''}">${m.pending && !m.text ? '<span class="dots"><i></i><i></i><i></i></span>' : mdLite(m.error && !m.text ? m.error : m.text + (m.error ? '\n\n' + m.error : ''))}</div>${!m.pending && !m.error ? `<div class="acts"><button data-copy="${i}">Copy</button><button data-note="${i}">Save to notes</button></div>` : ''}</div></div>`).join('');
  askLog.scrollTop = askLog.scrollHeight;
  askSend.classList.toggle('stop', ASK.busy);
  setIcon(askSend, ASK.busy ? 'i-stop' : 'i-send');
  askSend.title = ASK.busy ? 'Stop' : 'Send (Enter)';
}
function growInput() { askInput.style.height = 'auto'; askInput.style.height = Math.min(84, askInput.scrollHeight) + 'px'; }
async function refreshClipChip() {
  if (!ASK.clipOn) { askClip.classList.remove('on'); askClip.querySelector('span').textContent = 'Clipboard'; return; }
  ASK.clipText = (await api.readClipboard() || '').trim();
  askClip.classList.toggle('on', !!ASK.clipText);
  askClip.querySelector('span').textContent = ASK.clipText ? `“${ASK.clipText.replace(/\s+/g, ' ').slice(0, 18)}…”` : 'Clipboard is empty';
  if (!ASK.clipText) ASK.clipOn = false;
}
askClip.addEventListener('click', () => { ASK.clipOn = !ASK.clipOn; refreshClipChip(); askInput.focus(); });
function sendAsk(text) {
  text = (text ?? askInput.value).trim();
  if (ASK.busy) { api.askCancel(); return; }
  if (!text) return;
  const clip = ASK.clipOn && ASK.clipText ? ASK.clipText.slice(0, 12000) : '';
  const prompt = clip ? `${text}\n\nHere is the text from my clipboard:\n\`\`\`\n${clip}\n\`\`\`` : text;
  ASK.msgs.push({ role: 'you', text, clip });
  ASK.msgs.push({ role: 'bot', text: '', pending: true });
  ASK.busy = true; ASK.reqId++; ASK.unseen = false;
  askInput.value = ''; growInput();
  ASK.clipOn = false; refreshClipChip();
  renderAsk(); renderEyes(); renderPeek();
  api.ask(ASK.reqId, prompt);
}
askSend.addEventListener('click', () => sendAsk());
askInput.addEventListener('input', growInput);
askInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); }
  if (e.key === 'Escape') { e.stopPropagation(); askInput.blur(); }
});
$('.ask-sugs').addEventListener('click', e => {
  const b = e.target.closest('[data-sug]'); if (!b) return;
  askInput.value = b.dataset.sug + (ASK.clipOn ? '' : ': '); growInput(); askInput.focus();
  if (!ASK.clipOn) { ASK.clipOn = true; refreshClipChip(); }
});
askLog.addEventListener('click', async e => {
  const c = e.target.closest('[data-copy]'), n = e.target.closest('[data-note]');
  if (c) { api.copy(ASK.msgs[+c.dataset.copy].text); c.textContent = 'Copied ✓'; setTimeout(() => (c.textContent = 'Copy'), 1200); }
  if (n) {
    const m = ASK.msgs[+n.dataset.note], d = new Date();
    const notes = (S.store.notes ? S.store.notes.replace(/\s*$/, '') + '\n\n' : '') + `— Claude, ${pad(d.getHours())}:${pad(d.getMinutes())} —\n${m.text}`;
    S.store = await api.setStore({ notes }); $('#notes').value = notes;
    n.textContent = 'Saved ✓'; setTimeout(() => (n.textContent = 'Save to notes'), 1200);
  }
});
$('#askClear').addEventListener('click', () => { api.askReset(); ASK.msgs = []; ASK.busy = false; renderAsk(); renderEyes(); askInput.focus(); });
api.on('ask-update', u => {
  if (u.reqId !== ASK.reqId) return;
  const m = ASK.msgs[ASK.msgs.length - 1]; if (!m || m.role !== 'bot') return;
  if (typeof u.text === 'string') m.text = u.text;
  if (u.done) {
    m.pending = false; ASK.busy = false;
    if (u.cancelled) m.error = m.text ? '' : 'Stopped.';
    else if (u.error) m.error = u.error;
    else { happyFor(1400); if (!(S.expanded && S.view === 'ask')) { ASK.unseen = true; ASK.doneAt = Date.now(); } }
  }
  renderAsk(); renderEyes(); renderPeek();
});
api.on('ask-open', () => {
  if (S.expanded && S.view === 'ask') { S.sticky = false; collapse(); return; }
  expand('ask'); S.sticky = true; api.focusWindow();
  setTimeout(() => askInput.focus(), 120);
});
// don't snap shut while someone is typing a question or waiting for an answer
window.addEventListener('blur', () => { if (S.expanded && !S.over && !S.store.pinned) setTimeout(() => { if (!S.over) collapse(); }, 200); });
$('#modelSeg').addEventListener('click', async e => { const b = e.target.closest('[data-model]'); if (!b) return; S.store = await api.setStore({ askModel: b.dataset.model }); renderSettings(); });

/* ---------------- Gaze: the creature looks at what you point at ---------------- */
function gaze(dir) {
  if (!S.expanded) return;
  const t = { left: 'translate(-4px, 2px)', right: 'translate(4px, 2px)', down: 'translate(0, 3px)' }[dir] || '';
  eyes.style.transform = t;
}
$$('[data-gaze]').forEach(el => {
  el.addEventListener('mouseenter', () => { if (S.view === 'home') gaze(el.dataset.gaze); });
  el.addEventListener('mouseleave', () => { if (S.view === 'home') gaze(null); });
});

/* ---------------- Eye styles ---------------- */
const EYE_STYLES = [
  ['classic', 'Classic'], ['kawaii', 'Kawaii'], ['visor', 'Visor'], ['pixel', 'Pixel'], ['cat', 'Cat'],
  ['owl', 'Owl'], ['cyclops', 'Cyclops'], ['flame', 'Flame'], ['rune', 'Rune']
];
$('#eyeStyles').innerHTML = EYE_STYLES.map(([id, name]) => `<button class="eye-opt" data-eyes="${id}"><span class="eye-prev"><span class="eyes" data-style="${id}"><i class="eye"></i><i class="eye"></i></span></span>${name}</button>`).join('');
$('#eyeStyles').addEventListener('click', async e => {
  const b = e.target.closest('[data-eyes]'); if (!b) return;
  S.store.eyes = b.dataset.eyes; applyAppearance(); happyFor(1200);
  S.store = await api.setStore({ eyes: b.dataset.eyes });
});

/* ---------------- Themes & fonts ---------------- */
const THEMES = [
  { id: 'midnight', name: 'Midnight', bg: '#000', eye: '#d9ffdc', c: ['#b06a45', '#a8323f', '#8a5ad8'] },
  { id: 'clay', name: 'Clay', bg: '#f4efe6', eye: '#c96442', c: ['#d97757', '#c4545f', '#8a6cd1'] },
  { id: 'ember', name: 'Ember', bg: '#110906', eye: '#ffbf94', c: ['#e0632a', '#c23b1e', '#e8a33a'] },
  { id: 'aurora', name: 'Aurora', bg: '#02100e', eye: '#a6ffe4', c: ['#1fb38d', '#1a8fb0', '#6a5cff'] },
  { id: 'sakura', name: 'Sakura', bg: '#13090f', eye: '#ffd0e3', c: ['#e46a9c', '#d04a86', '#b07ae8'] },
  { id: 'ocean', name: 'Ocean', bg: '#020a17', eye: '#b4e2ff', c: ['#2f7fe0', '#1e5fb0', '#22a6b8'] },
  { id: 'neon', name: 'Neon', bg: '#0a0313', eye: '#ff9be6', c: ['#e02ad0', '#7a2cff', '#12c8e8'] },
  { id: 'forest', name: 'Forest', bg: '#060e08', eye: '#d2f7a8', c: ['#5d9a4a', '#7d7426', '#b9912e'] },
  { id: 'sunset', name: 'Sunset', bg: '#120706', eye: '#ffe0a3', c: ['#f08a4b', '#e0457a', '#a24bd0'] },
  { id: 'mono', name: 'Mono', bg: '#000', eye: '#ffffff', c: ['#5a5a5a', '#444', '#6e6e6e'] }
];
$('#themes').innerHTML = THEMES.map(t => `<button class="theme-sw" data-theme="${t.id}"><span class="sw" style="background:${t.bg}"><i style="background:${t.eye};box-shadow:0 0 5px ${t.eye}"></i><i style="background:${t.eye};box-shadow:0 0 5px ${t.eye}"></i>${t.c.map(c => `<b style="background:${c}"></b>`).join('')}</span>${t.name}</button>`).join('');
function applyAppearance() {
  document.documentElement.dataset.theme = S.store.theme || 'midnight';
  document.documentElement.dataset.font = S.store.font || 'claude';
  eyes.dataset.style = S.store.eyes || 'classic';
  $$('.eye-opt').forEach(b => b.classList.toggle('on', b.dataset.eyes === (S.store.eyes || 'classic')));
  $$('.theme-sw').forEach(b => b.classList.toggle('on', b.dataset.theme === (S.store.theme || 'midnight')));
  $$('.font-opt').forEach(b => b.classList.toggle('on', b.dataset.font === (S.store.font || 'claude')));
}
$('#themes').addEventListener('click', async e => {
  const b = e.target.closest('.theme-sw'); if (!b) return;
  S.store.theme = b.dataset.theme; applyAppearance();
  S.store = await api.setStore({ theme: b.dataset.theme });
});
$('#fonts').addEventListener('click', async e => {
  const b = e.target.closest('.font-opt'); if (!b) return;
  S.store.font = b.dataset.font; applyAppearance();
  S.store = await api.setStore({ font: b.dataset.font });
});

/* ---------------- Launchers ---------------- */
const EMOJIS = ['🚀', '💼', '💻', '🎮', '🎨', '🎵', '📚', '⚡', '🧪', '🌐', '✍️', '🎬', '☕', '🔧', '📈'];
let editing = null;
const launchers = () => S.store.launchers || [];
const iconHTML = icon => icon && icon.type === 'img' ? `<img src="${icon.value}" alt="">` : esc((icon && icon.value) || '🚀');
function renderLaunchers() {
  const list = launchers();
  $('#launchGrid').innerHTML = list.map(l => `
    <div class="ltile" data-run="${l.id}" title="${esc(l.apps.map(a => a.name).join(', ') || 'No apps yet')}">
      <button class="ledit" data-edit="${l.id}" data-stop title="Edit">✎</button>
      <div class="licon">${iconHTML(l.icon)}</div>
      <div class="lname">${esc(l.name)}</div>
      <div class="lcount">${l.apps.length} item${l.apps.length === 1 ? '' : 's'}</div>
    </div>`).join('') + `
    <div class="ltile add" data-new data-stop><div class="licon">+</div><div class="lname">New launcher</div><div class="lcount">apps, sites, folders</div></div>`;
  $('#quick').innerHTML = list.slice(0, 4).map(l => `<button data-run="${l.id}" data-stop title="Open ${esc(l.name)}">${iconHTML(l.icon)}</button>`).join('');
}
async function runLauncher(id, tile) {
  const l = launchers().find(x => x.id === id); if (!l) return;
  if (!l.apps.length) return openEditor(l);
  if (tile) { tile.classList.remove('launched'); void tile.offsetWidth; tile.classList.add('launched'); }
  happyFor(1500);
  const errs = await api.launch(l.apps);
  if (errs && errs.length) api.notify(`Couldn't open everything in ${l.name}`, errs.join('\n').slice(0, 250));
  else setTimeout(() => { if (!S.store.pinned) collapse(); }, 500);
}
function openEditor(l) {
  editing = l ? JSON.parse(JSON.stringify(l)) : { id: 'l' + Date.now().toString(36), name: '', icon: { type: 'emoji', value: '🚀' }, apps: [], isNew: true };
  $('#edName').value = editing.name;
  $('#edDelete').style.visibility = editing.isNew ? 'hidden' : 'visible';
  $('#editor').classList.add('show');
  renderEditor();
  setTimeout(() => $('#edName').focus(), 50);
}
function closeEditor() { editing = null; $('#editor').classList.remove('show'); }
function renderEditor() {
  if (!editing) return;
  $('#edIcon').innerHTML = iconHTML(editing.icon);
  $('#edApps').innerHTML = editing.apps.length ? editing.apps.map((a, i) => `
    <li title="${esc(a.path)}">${a.icon ? `<img src="${a.icon}" alt="">` : `<span class="gi">${a.type === 'url' ? '🌐' : a.type === 'folder' ? '📁' : '▫️'}</span>`}
      <span class="nm">${esc(a.name)}<small>${a.type === 'url' ? 'website' : a.type === 'folder' ? 'folder' : ''}</small></span>
      <button class="rm" data-rm="${i}" data-stop title="Remove">✕</button></li>`).join('')
    : `<span class="none">Add the apps, websites or folders this launcher should open.</span>`;
  $('#edIconFromApp').style.display = editing.apps.some(a => a.icon) ? '' : 'none';
}
// while a system dialog is open the mouse leaves the island; don't collapse under the user
async function withHold(fn) { S.sticky = true; try { return await fn(); } finally { S.sticky = 'until-enter'; api.focusWindow(); } }
$('#edEmojis').innerHTML = EMOJIS.map(e => `<button data-emoji="${e}" data-stop>${e}</button>`).join('');
$('#edEmojis').addEventListener('click', e => { const b = e.target.closest('[data-emoji]'); if (b && editing) { editing.icon = { type: 'emoji', value: b.dataset.emoji }; renderEditor(); } });
$('#edIcon').addEventListener('click', async () => { const url = await withHold(() => api.pickIcon()); if (url && editing) { editing.icon = { type: 'img', value: url }; renderEditor(); } });
$('#edIconFromApp').addEventListener('click', () => { const a = editing && editing.apps.find(x => x.icon); if (a) { editing.icon = { type: 'img', value: a.icon }; renderEditor(); } });
$('#edAddApps').addEventListener('click', async () => { const items = await withHold(() => api.pickApps()); if (editing && items.length) { editing.apps.push(...items); renderEditor(); } });
$('#edAddFolder').addEventListener('click', async () => { const items = await withHold(() => api.pickFolder()); if (editing && items.length) { editing.apps.push(...items); renderEditor(); } });
$('#edUrl').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !editing) return;
  let v = e.target.value.trim(); if (!v) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  let name = v; try { name = new URL(v).hostname.replace(/^www\./, ''); } catch {}
  editing.apps.push({ type: 'url', path: v, name, icon: null });
  e.target.value = ''; renderEditor();
});
$('#edApps').addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b && editing) { editing.apps.splice(+b.dataset.rm, 1); renderEditor(); } });
$('#edCancel').addEventListener('click', closeEditor);
$('#edDelete').addEventListener('click', async () => {
  if (!editing) return;
  S.store = await api.setStore({ launchers: launchers().filter(l => l.id !== editing.id) });
  closeEditor(); renderLaunchers();
});
$('#edSave').addEventListener('click', async () => {
  if (!editing) return;
  editing.name = $('#edName').value.trim() || (editing.apps[0] && editing.apps[0].name) || 'Launcher';
  const { isNew, ...clean } = editing;
  const list = launchers().slice();
  const i = list.findIndex(l => l.id === clean.id);
  if (i >= 0) list[i] = clean; else list.push(clean);
  S.store = await api.setStore({ launchers: list });
  closeEditor(); renderLaunchers();
});
$('#launchGrid').addEventListener('click', e => {
  const ed = e.target.closest('[data-edit]'); if (ed) return openEditor(launchers().find(l => l.id === ed.dataset.edit));
  if (e.target.closest('[data-new]')) return openEditor(null);
  const t = e.target.closest('[data-run]'); if (t) runLauncher(t.dataset.run, t);
});
$('#quick').addEventListener('click', e => { const b = e.target.closest('[data-run]'); if (b) runLauncher(b.dataset.run, null); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && editing) { e.stopImmediatePropagation(); closeEditor(); } }, true);

/* ---------------- render loop ---------------- */
function renderAll() {
  applyAppearance(); renderLaunchers();
  renderClaude(); renderClaudeLists(); renderMusic(); renderFocus(); renderSettings(); renderEyes(); renderPeek(); renderClock();
}
setInterval(() => { renderClock(); renderClaude(); renderMusic(); renderFocus(); renderPeek(); renderEyes(); }, 250);

/* ---------------- IPC ---------------- */
api.on('claude', c => {
  const prev = S.claude.active;
  S.claude = c;
  const a = c.active;
  if (a && prev && prev.id === a.id && prev.working && !a.working && a.status === 'Done') happyFor(4000);
  S.lastActivity = Date.now();
  renderClaude(); renderClaudeLists(); renderEyes(); renderPeek();
});
api.on('attention', () => {
  if (!S.store.expandOnAttention) return;
  expand('claude');
  S.sticky = false;
  setTimeout(() => { if (!S.over && !S.store.pinned) collapse(); }, 6000);
});
api.on('media', m => {
  if (!m || !m.ok) { S.media = { has: false, recvAt: Date.now() }; renderMusic(); return; }
  const keyChanged = m.key !== S.artKey;
  const art = m.artChanged ? m.art : (keyChanged ? null : S.media.art);
  S.media = { ...m, art, recvAt: Date.now() };
  if (keyChanged || m.artChanged) { S.artKey = m.key || ''; applyArt(); }
  if (m.status === 'Playing') S.lastActivity = Date.now();
  renderMusic(); renderPeek();
});
api.on('clipboard', list => { S.clips = list; renderClips(); });
api.on('store', st => { S.store = st; renderAll(); if (st.pinned) expand(); });
api.on('toggle', () => {
  if (S.expanded) { S.sticky = false; if (S.store.pinned) return; collapse(); }
  else { expand(); S.sticky = true; api.focusWindow(); }
});

(async function init() {
  S.store = await api.getStore();
  S.claude = await api.getClaude();
  S.clips = await api.getClips();
  $('#notes').value = S.store.notes || '';
  focusSet('focus', S.store.focusMinutes || 25);
  renderClips();
  renderAll();
  fitWindow();
  if (S.store.pinned) expand();
})();
