/* FLIP prototype — state, dashboard renderer, overlays, scenes. Requires flip.js. */
(function () {
  'use strict';
  var F = window.Flip;
  var Q = new URLSearchParams(location.search);
  var FROZEN_AT = Q.get('at');                      // e.g. 2026-10-06T04:43:00Z
  var SHOT = Q.has('shot');
  if (SHOT) { document.body.classList.add('shot'); document.documentElement.setAttribute('data-static', ''); }

  /* ------------------------------------------------------------------ state */
  var CITY_PRESETS = [
    ['LONDON', 'LHR', 'Europe/London'], ['NEW YORK', 'JFK', 'America/New_York'], ['TOKYO', 'HND', 'Asia/Tokyo'],
    ['SYDNEY', 'SYD', 'Australia/Sydney'], ['DUBAI', 'DXB', 'Asia/Dubai'], ['SAN FRANCISCO', 'SFO', 'America/Los_Angeles'],
    ['MANILA', 'MNL', 'Asia/Manila'], ['SINGAPORE', 'SIN', 'Asia/Singapore'], ['PARIS', 'CDG', 'Europe/Paris'],
    ['BERLIN', 'BER', 'Europe/Berlin'], ['MUMBAI', 'BOM', 'Asia/Kolkata'], ['HONG KONG', 'HKG', 'Asia/Hong_Kong'],
    ['TORONTO', 'YYZ', 'America/Toronto'], ['CHICAGO', 'ORD', 'America/Chicago'], ['SAO PAULO', 'GRU', 'America/Sao_Paulo'],
    ['AUCKLAND', 'AKL', 'Pacific/Auckland'], ['SEOUL', 'ICN', 'Asia/Seoul'], ['DENVER', 'DEN', 'America/Denver']
  ];
  var browserTz = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; } })();
  var S = {
    cfg: {
      h24: true, seconds: false, blink: false, shape: 'round', ghost: true, dateFmt: 'dow', meta: true,
      homeTz: Q.get('tz') || browserTz, layout: 'auto',
      mod: { date: true, ai: true, world: true, system: true, focus: true, keys: true },
      sys: { temps: true, gpu: true, net: true, disk: true, plot: true }, sample: 1, tempUnit: 'C',
      ai: { refresh: 2, warn: 0.9 },
      pomo: { focus: 25, short: 5, long: 15, sessions: 4, auto: false, sound: 'CHIME' },
      win: { onTop: true, startup: true, startMin: false, click: false, display: 2, mode: 'FULLSCREEN', hide: 3, shift: true, dim: 'OFF' }
    },
    cities: CITY_PRESETS.slice(0, 5).map(function (c) { return { name: c[0], code: c[1], tz: c[2] }; }),
    providers: null,
    sys: null,
    pomo: { phase: 'idle', running: false, left: 25 * 60, session: 2 },
    overlay: null, settingsTab: 'CLOCK', screen: 0
  };
  function defaultProviders() {
    return [
      { id: 'claude', name: 'CLAUDE', state: 'ok', source: 'LOCAL USAGE LOGS', metrics: [{ k: '5H', v: 0.71, label: '5-HOUR WINDOW', reset: 135 }, { k: '7D', v: 0.24, label: '7-DAY WINDOW', reset: 6 * 1440 + 1260 }] },
      { id: 'codex', name: 'CODEX', state: 'ok', source: 'ACCOUNT USAGE API', metrics: [{ k: '7D', v: 1.0, label: '7-DAY WINDOW', reset: 2 * 1440 + 300 }] }
    ];
  }
  S.providers = defaultProviders();

  /* seeded noise so screenshots are stable */
  var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function hist(n, base, amp) { var a = [], v = base; for (var i = 0; i < n; i++) { v = Math.max(0.03, Math.min(0.97, v + (rnd() - 0.5) * amp)); a.push(v); } return a; }
  S.sys = {
    host: 'DESKTOP-HOST', cpu: 0.34, cpuT: 62, ram: 18.4, ramTot: 32, gpu: 0.12, gpuT: 48, gpuName: 'RTX 4070', down: 12.4, up: 0.82,
    disks: [{ n: 'C:', u: 412, t: 953 }, { n: 'D:', u: 1210, t: 1863 }], cpuHist: hist(60, 0.34, 0.18), netHist: hist(60, 0.3, 0.3),
    cores: hist(16, 0.35, 0.5), uptime: 3 * 86400 + 4 * 3600 + 12 * 60, procs: 214,
    top: [['CODE.EXE', 0.112, 1.8], ['CHROME.EXE', 0.074, 3.2], ['CLAUDE.EXE', 0.031, 0.9], ['TEAMS.EXE', 0.022, 1.1], ['FLIP.EXE', 0.004, 0.08]],
    aiHist: hist(24, 0.4, 0.5)
  };

  /* ------------------------------------------------------------------ time */
  var t0 = Date.now(), frozen = FROZEN_AT ? new Date(FROZEN_AT).getTime() : null;
  function now() { return new Date(frozen !== null ? frozen + (SHOT ? 0 : Date.now() - t0) : Date.now()); }
  var fmts = {};
  function parts(tz, d) {
    var f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
    var o = {}; f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; }); o.hour = String(+o.hour % 24).padStart(2, '0'); return o;
  }
  function offsetMin(tz, d) {
    var o = parts(tz, d);
    return Math.round((Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  }
  var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function hm(o) { if (S.cfg.h24) return o.hour + ':' + o.minute; return ((+o.hour % 12) || 12) + ':' + o.minute; }
  function fmtOff(m, unit) { var s = m < 0 ? '-' : '+', a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60; if (!a) return '±0H'; return s + h + 'H' + (mm ? String(mm).padStart(2, '0') : ''); }
  function isoWeek(y, m, d) { var dt = new Date(Date.UTC(y, m - 1, d)); var day = dt.getUTCDay() || 7; dt.setUTCDate(dt.getUTCDate() + 4 - day); var y0 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1)); return Math.ceil(((dt - y0) / 86400000 + 1) / 7); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function dur(min) { var d = Math.floor(min / 1440), h = Math.floor(min % 1440 / 60), m = min % 60; return (d ? d + 'D ' : '') + (h || d ? h + 'H ' : '') + m + 'M'; }
  function pct(v) { return Math.round(v * 100) + '%'; }
  function temp(c) { return S.cfg.tempUnit === 'F' ? Math.round(c * 9 / 5 + 32) + '°F' : Math.round(c) + '°C'; }

  /* ------------------------------------------------------------------ pomodoro */
  var P = S.pomo;
  function phaseLen(ph) { return (ph === 'short' ? S.cfg.pomo.short : ph === 'long' ? S.cfg.pomo.long : S.cfg.pomo.focus) * 60; }
  function pomoToggle() { if (P.phase === 'idle') { P.phase = 'focus'; P.left = phaseLen('focus'); } P.running = !P.running; refreshAll(true); }
  function pomoReset() { P.phase = 'idle'; P.running = false; P.left = phaseLen('focus'); refreshAll(true); }
  function pomoSkip() {
    if (P.phase === 'focus' || P.phase === 'idle') { var last = P.session >= S.cfg.pomo.sessions; P.phase = last ? 'long' : 'short'; }
    else { P.session = P.phase === 'long' ? 1 : P.session + 1; P.phase = 'focus'; }
    P.left = phaseLen(P.phase); P.running = S.cfg.pomo.auto || P.running; refreshAll(true);
  }
  function pomoTick() { if (!P.running) return; P.left--; if (P.left <= 0) pomoSkip(); }
  var PHASE = { idle: 'READY', focus: 'FOCUS', short: 'SHORT BREAK', long: 'LONG BREAK' };

  /* ------------------------------------------------------------------ bindings */
  function homeParts() { return parts(S.cfg.homeTz, now()); }
  var B = {
    statusLeft: function () { return P.phase !== 'idle' ? (P.running ? '● ' : '‖ ') + PHASE[P.phase] + ' ' + mmss(P.left) : 'DISPLAY ' + S.cfg.win.display + ' · 2560×1440'; },
    indSys: function () { return 'SYS ' + S.cfg.sample + 'S'; },
    indAi: function () { var bad = S.providers.some(function (p) { return p.state === 'error'; }), load = S.providers.some(function (p) { return p.state === 'loading'; }); return 'AI ' + (bad ? 'ERR' : load ? 'SYNC' : S.cfg.ai.refresh + 'M'); },
    date: function () {
      var o = homeParts(), d = now(), dow = o.weekday.toUpperCase().slice(0, 3);
      if (S.cfg.dateFmt === 'iso') return o.year + '-' + o.month + '-' + o.day;
      if (S.cfg.dateFmt === 'eu') return o.day + '.' + o.month + '.' + o.year;
      return dow + ' ' + o.day + ' ' + MON[+o.month - 1];
    },
    dateMeta: function () { var o = homeParts(); return 'WK ' + isoWeek(+o.year, +o.month, +o.day) + ' · UTC' + fmtOff(offsetMin(S.cfg.homeTz, now())).replace('H', '').replace('±0', '+0'); },
    ampm: function () { return S.cfg.h24 ? '' : (+homeParts().hour < 12 ? 'AM' : 'PM'); },
    focusline: function () { var end = new Date(now().getTime() + P.left * 1000), o = parts(S.cfg.homeTz, end); return PHASE[P.phase] + ' ' + P.session + '/' + S.cfg.pomo.sessions + ' · ' + mmss(P.left) + ' · ENDS ' + o.hour + ':' + o.minute; },
    cpu: function () { return pct(S.sys.cpu); }, cpuT: function () { return S.cfg.sys.temps ? temp(S.sys.cpuT) : ''; },
    ram: function () { return S.sys.ram.toFixed(1) + ' / ' + S.sys.ramTot.toFixed(1) + ' GB'; }, ramP: function () { return pct(S.sys.ram / S.sys.ramTot); },
    gpu: function () { return pct(S.sys.gpu); }, gpuT: function () { return S.cfg.sys.temps ? temp(S.sys.gpuT) : ''; },
    down: function () { return '↓ ' + S.sys.down.toFixed(1) + ' MB/S'; }, up: function () { return '↑ ' + S.sys.up.toFixed(1); },
    disk0: function () { var k = S.sys.disks[0]; return k.u + ' / ' + k.t + ' GB'; }, disk0P: function () { var k = S.sys.disks[0]; return pct(k.u / k.t); },
    disk1: function () { var k = S.sys.disks[1]; return k.u + ' / ' + k.t + ' GB'; }, disk1P: function () { var k = S.sys.disks[1]; return pct(k.u / k.t); },
    uptime: function () { var u = S.sys.uptime; return 'UP ' + Math.floor(u / 86400) + 'D ' + String(Math.floor(u % 86400 / 3600)).padStart(2, '0') + 'H · ' + S.sys.procs + ' PROCS'; },
    pomoPhase: function () { return P.running || P.phase === 'idle' ? PHASE[P.phase] : 'PAUSED · ' + PHASE[P.phase]; },
    pomoLeft: function () { return mmss(P.left); },
    pomoSess: function () { return 'SESSION ' + P.session + ' / ' + S.cfg.pomo.sessions; },
    pomoDots: function () { var s = ''; for (var i = 1; i <= S.cfg.pomo.sessions; i++) s += i < P.session || (i === P.session && P.phase !== 'focus' && P.phase !== 'idle') ? '■' : i === P.session ? '▣' : '□'; return s; },
    pomoEnds: function () { if (P.phase === 'idle') return S.cfg.pomo.focus + ' MIN BLOCK'; var e = parts(S.cfg.homeTz, new Date(now().getTime() + P.left * 1000)); return 'ENDS ' + e.hour + ':' + e.minute; },
    pomoHint: function () { return (P.running ? 'SPACE PAUSE' : 'SPACE START') + ' · R RESET · S SKIP'; },
    cstrip_cpu: function () { return 'CPU ' + pct(S.sys.cpu) + (S.cfg.sys.temps ? ' ' + temp(S.sys.cpuT) : ''); },
    cstrip_ram: function () { return 'RAM ' + pct(S.sys.ram / S.sys.ramTot); },
    cstrip_gpu: function () { return 'GPU ' + pct(S.sys.gpu); },
    cstrip_net: function () { return '↓ ' + S.sys.down.toFixed(1) + ' ↑ ' + S.sys.up.toFixed(1) + ' MB/S'; },
    cstrip_pomo: function () { return P.phase === 'idle' ? 'FOCUS READY' : PHASE[P.phase] + ' ' + mmss(P.left) + (P.running ? '' : ' ‖'); }
  };
  function cityTime(i) { var o = parts(S.cities[i].tz, now()); return o.hour + ':' + o.minute; } /* boards stay 24h */
  function cityDiff(i) { var d = now(); return fmtOff(offsetMin(S.cities[i].tz, d) - offsetMin(S.cfg.homeTz, d)); }
  function pomoFrac() { return P.phase === 'idle' ? 0 : 1 - P.left / phaseLen(P.phase); }

  /* ------------------------------------------------------------------ dashboard */
  var instances = [];
  function Dash(host, opts) {
    this.host = host; this.opts = opts || {}; this.layoutName = null;
    host.classList.add('fl-display', 'fl-host');
    var self = this;
    this.ro = new ResizeObserver(function () { self.fit(); });
    this.ro.observe(host);
    instances.push(this);
    this.fit(true);
  }
  Dash.prototype.pickLayout = function (w, h) {
    if (this.opts.layout) return this.opts.layout;
    if (this.opts.primary && S.cfg.layout !== 'auto') return S.cfg.layout;
    if (w >= 1150 && h >= 620) return 'full';
    if (w >= 600 && h >= 300) return 'compact';
    return 'mini';
  };
  var BASE = { full: [1920, 1080], compact: [1280, 720], mini: [600, 260] };
  Dash.prototype.fit = function (force) {
    var w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return;
    var L = this.pickLayout(w, h), b = BASE[L];
    var u = Math.max(0.36, Math.min(1.5, Math.min(w / b[0], h / b[1])));
    this.host.style.setProperty('--u', u.toFixed(4));
    if (force || L !== this.layoutName) { this.layoutName = L; this.render(); }
    if (this.opts.onSize) this.opts.onSize(w, h, L);
  };
  Dash.prototype.render = function () {
    var L = this.layoutName, c = S.cfg, m = c.mod;
    var keys = []; S.providers.forEach(function (p) { if (p.state === 'ok') p.metrics.forEach(function (x) { if (keys.indexOf(x.k) < 0) keys.push(x.k); }); });
    var usage = '<div class="fl-usage" style="grid-template-columns:auto repeat(' + keys.length + ',auto)">' + S.providers.map(function (p) {
      var a = ' data-act="ai:' + p.id + '" title="' + p.name + ' usage detail"';
      var name = '<div class="fl-usage__name fl-hit' + (p.state === 'unavailable' ? ' is-dim' : '') + '"' + a + '>' + p.name + '</div>';
      if (p.state === 'loading') return name + '<div class="fl-usage__slot fl-usage__span fl-hit"' + a + '><div class="fl-usage__val fl-ink2">SYNCING</div><div class="fl-meter" data-load="1"></div></div>';
      if (p.state === 'unavailable') return name + '<div class="fl-usage__span is-dim fl-hit"' + a + '>NO DATA · NOT CONNECTED</div>';
      if (p.state === 'error') return name + '<div class="fl-usage__slot fl-usage__span fl-hit"' + a + '><div class="fl-usage__val fl-warn">ERR · AUTH EXPIRED</div><div class="fl-usage__meta">RETRY IN 30S · CLICK TO RECONNECT</div></div>';
      return name + keys.map(function (k) {
        var x = p.metrics.filter(function (q) { return q.k === k; })[0];
        if (!x) return '<div></div>';
        return '<div class="fl-usage__slot fl-hit"' + a + '><div class="fl-usage__val"><span>' + k + '</span><span data-v="' + pct(x.v) + '">' + pct(x.v) + '</span></div><div data-m="ai:' + p.id + ':' + k + '"></div></div>';
      }).join('');
    }).join('') + '</div>';
    var board = '<div class="fl-board" role="table" aria-label="World clock"><div class="fl-board__r fl-board__h" role="row"><span>DESTINATION</span><span>CODE</span><span class="r">TIME</span><span class="r">DIFF</span></div>' +
      S.cities.map(function (ct, i) { return '<div class="fl-board__r" role="row"><span>' + ct.name + '</span><span>' + ct.code + '</span><span class="r" data-b="city' + i + 'T"></span><span class="r" data-b="city' + i + 'D"></span></div>'; }).join('') + '</div>';
    var sy = c.sys;
    var sys = !m.system ? '' : '<section class="fl-blk fl-blk--sys" data-act="sys" title="System monitor detail">' +
      '<div class="fl-sec"><span>SYSTEM</span><span>' + S.sys.host + '</span></div>' +
      '<div class="fl-mrow fl-hit" data-act="sys"><span>CPU</span><div data-m="cpu"></div><b class="r" data-b="cpu"></b><span class="r" data-b="cpuT"></span></div>' +
      (sy.plot ? '<div class="fl-mrow fl-mrow--plot fl-opt"><span>LOAD 60S</span><div data-plot="cpuHist"></div></div>' : '') +
      '<div class="fl-mrow fl-hit" data-act="sys"><span>RAM</span><div data-m="ram"></div><b class="r" data-b="ram"></b><span class="r" data-b="ramP"></span></div>' +
      (sy.gpu ? '<div class="fl-mrow fl-hit" data-act="sys"><span>GPU</span><div data-m="gpu"></div><b class="r" data-b="gpu"></b><span class="r" data-b="gpuT"></span></div>' : '') +
      (sy.net ? '<div class="fl-mrow fl-hit" data-act="sys"><span>NET</span><div data-plot="netHist" data-rows="3"></div><b class="r" data-b="down"></b><span class="r" data-b="up"></span></div>' : '') +
      (sy.disk ? '<div class="fl-mrow fl-hit fl-opt" data-act="sys"><span>DISK C:</span><div data-m="disk0"></div><b class="r" data-b="disk0"></b><span class="r" data-b="disk0P"></span></div>' +
        '<div class="fl-mrow fl-hit fl-opt" data-act="sys"><span>DISK D:</span><div data-m="disk1"></div><b class="r" data-b="disk1"></b><span class="r" data-b="disk1P"></span></div>' : '') +
      '<div class="fl-mrow fl-opt" style="grid-template-columns:1fr;border:0;min-height:0;padding-top:10px"><span class="fl-ink3" data-b="uptime"></span></div>' +
      '</section>';
    var focus = !m.focus ? '' : '<section class="fl-blk fl-blk--focus" data-act="timer" title="Timer controls (P)">' +
      '<div class="fl-sec"><span>FOCUS · POMODORO</span><span data-b="pomoSess"></span></div>' +
      '<div class="fl-focus"><div class="fl-focus__main"><div class="fl-focus__phase" data-b="pomoPhase"></div><div class="fl-focus__time" data-b="pomoLeft"></div><div data-clock="pomo"></div></div>' +
      '<div class="fl-focus__side"><div class="fl-focus__dots" data-b="pomoDots"></div><div data-b="pomoEnds"></div></div>' +
      '<div data-m="pomo" class="fl-meter--sq"></div><div class="fl-focus__hint" data-b="pomoHint"></div></div></section>';
    var keysHelp = m.keys ? '<div class="fl-keys"><span><kbd>,</kbd> SETTINGS</span><span><kbd>SPACE</kbd> FOCUS</span><span><kbd>C</kbd> COMPACT</span><span><kbd>T</kbd> PIN</span><span><kbd>F11</kbd> FULLSCREEN</span></div>' : '';
    var cls = ['fl-dash', P.running ? 'is-running' : (P.phase !== 'idle' ? 'is-paused' : ''), m.date ? '' : 'no-date', m.ai ? '' : 'no-ai', m.world ? '' : 'no-world'].join(' ');
    var html = '<div class="' + cls + '" data-layout="' + L + '">' +
      '<header class="fl-status"><div class="fl-status__l"><span class="fl-word">FLIP</span><span data-b="statusLeft"></span></div>' +
      '<div class="fl-status__r"><span class="fl-ind"><i class="fl-led"></i><span data-b="indSys"></span></span>' +
      '<span class="fl-ind"><i class="fl-led' + (S.providers.some(function (p) { return p.state === 'error'; }) ? ' is-warn' : S.providers.some(function (p) { return p.state === 'loading'; }) ? ' is-pulse' : '') + '"></i><span data-b="indAi"></span></span>' +
      '<button class="fl-ctl' + (c.win.onTop ? ' is-on' : '') + '" data-act="ontop" title="Always on top (T)">' + (c.win.onTop ? 'PIN ON' : 'PIN OFF') + '</button>' +
      '<button class="fl-ctl" data-act="settings" title="Settings (,)">SETTINGS</button>' +
      '<button class="fl-ctl" data-act="compact" title="Toggle compact (C)">' + (L === 'full' ? 'COMPACT' : 'EXPAND') + '</button>' +
      '<button class="fl-ctl" data-act="min" title="Minimize to tray (Ctrl+M)" aria-label="Minimize">—</button>' +
      '<button class="fl-ctl" data-act="exit" title="Exit (Ctrl+Q)" aria-label="Exit">✕</button></div></header>' +
      ((m.system || m.focus) ? '<aside class="fl-left">' + sys + focus + keysHelp + '</aside>' : '') +
      '<main class="fl-right"><div class="fl-clockwrap" data-act="clock" title="Clock settings" role="timer" tabindex="0"><div data-clock="main"></div><div data-clock="sec"></div><div class="fl-ampm" data-b="ampm"></div></div>' +
      '<div class="fl-side"><div class="fl-date"><small data-b="dateMeta"' + (c.meta ? '' : ' hidden') + '></small><span data-b="date"></span></div>' +
      '<div class="fl-focusline fl-hit" data-act="timer"><span data-b="focusline"></span><div data-m="pomo2"></div></div>' + usage + '</div>' + board + '</main>' +
      '<div class="fl-cstrip"><span class="fl-hit" data-act="sys" data-b="cstrip_cpu"></span><span class="fl-hit" data-act="sys" data-b="cstrip_ram"></span><span class="fl-hit" data-act="sys" data-b="cstrip_gpu"></span><span class="fl-hit" data-act="sys" data-b="cstrip_net"></span><b class="fl-hit" data-act="timer" data-b="cstrip_pomo"></b></div>' +
      '</div>';
    if (this.opts.primary && S.overlay) html += overlayHTML(S.overlay);
    this.host.innerHTML = html;
    this.update(true);
  };
  var PITCH = { full: 28, compact: 17, mini: 10 };
  Dash.prototype.update = function (first) {
    var h = this.host, L = this.layoutName, c = S.cfg, d = now(), o = parts(c.homeTz, d);
    var colon = c.blink && (+o.second % 2) ? ';' : ':';
    var t = hm(o).replace(':', colon);
    var pitch = PITCH[L];
    h.querySelectorAll('[data-clock="main"]').forEach(function (el) { F.dotMatrix(el, t, { pitch: pitch, ghost: c.ghost, shape: c.shape }); });
    h.querySelectorAll('[data-clock="sec"]').forEach(function (el) { if (c.seconds) F.dotMatrix(el, o.second, { pitch: Math.round(pitch * 0.42), ghost: c.ghost, shape: c.shape }); else el.innerHTML = ''; });
    h.querySelectorAll('[data-clock="pomo"]').forEach(function (el) { F.dotMatrix(el, mmss(P.left), { pitch: L === 'full' ? 14 : 10, ghost: c.ghost, shape: c.shape }); });
    h.querySelectorAll('[data-clock="big"]').forEach(function (el) { F.dotMatrix(el, el.getAttribute('data-text') || mmss(P.left), { pitch: +el.getAttribute('data-pitch') || 12, ghost: c.ghost, shape: c.shape }); });
    h.querySelectorAll('[data-b]').forEach(function (el) {
      var k = el.getAttribute('data-b'), v;
      var cm = /^city(\d+)([TD])$/.exec(k);
      if (cm) v = cm[2] === 'T' ? cityTime(+cm[1]) : cityDiff(+cm[1]); else if (B[k]) v = B[k](); else return;
      if (first) { el.textContent = v; el.setAttribute('data-v', v); } else F.flipText(el, v);
    });
    h.querySelectorAll('[data-m]').forEach(function (el) {
      var k = el.getAttribute('data-m'), v = 0, cells = 24, warn = 0.9;
      if (k.indexOf('ai:') === 0) { var a = k.split(':'); var p = S.providers.filter(function (x) { return x.id === a[1]; })[0]; var mm = p && p.metrics.filter(function (x) { return x.k === a[2]; })[0]; v = mm ? mm.v : 0; warn = c.ai.warn; cells = +el.getAttribute('data-cells') || 22; }
      else if (k === 'cpu') v = S.sys.cpu; else if (k === 'ram') v = S.sys.ram / S.sys.ramTot; else if (k === 'gpu') v = S.sys.gpu;
      else if (k === 'disk0') v = S.sys.disks[0].u / S.sys.disks[0].t; else if (k === 'disk1') v = S.sys.disks[1].u / S.sys.disks[1].t;
      else if (k === 'pomo' || k === 'pomo2') { v = pomoFrac(); cells = k === 'pomo' ? c.pomo.focus : 12; warn = 2; }
      else if (k.indexOf('core') === 0) { v = S.sys.cores[+k.slice(4)]; cells = 20; }
      if (k === 'cpu' || k === 'ram' || k === 'gpu' || k.indexOf('disk') === 0) cells = 30;
      if (el.getAttribute('data-cells')) cells = +el.getAttribute('data-cells');
      F.meter(el, v, { cells: cells, warnAt: warn });
    });
    h.querySelectorAll('[data-load]').forEach(function (el) { F.meter(el, 0, { cells: 22, loading: true }); });
    h.querySelectorAll('[data-plot]').forEach(function (el) {
      var k = el.getAttribute('data-plot'), arr = k === 'cpuHist' ? S.sys.cpuHist : k === 'netHist' ? S.sys.netHist : k === 'netHistBig' ? S.sys.netHist : k === 'aiHist' ? S.sys.aiHist : S.sys.cpuHist;
      F.dotPlot(el, arr, { rows: +el.getAttribute('data-rows') || 5, pitch: +el.getAttribute('data-pitch') || 7 });
    });
  };
  function refreshAll(structural) { instances = instances.filter(function (i) { return i.host.isConnected; }); instances.forEach(function (i) { structural ? i.render() : i.update(false); }); }

  /* ------------------------------------------------------------------ overlays */
  function seg(path, opts) {
    var cur = getPath(path);
    return '<div class="fl-seg" role="radiogroup">' + opts.map(function (x) {
      var on = JSON.stringify(cur) === JSON.stringify(x[0]);
      return '<button role="radio" aria-checked="' + on + '" class="' + (on ? 'is-on' : '') + '" data-set="' + path + '" data-val=\'' + JSON.stringify(x[0]) + '\'>' + x[1] + '</button>';
    }).join('') + '</div>';
  }
  function onoff(path) { return seg(path, [[true, 'ON'], [false, 'OFF']]); }
  function row(label, ctl, hint) { return '<div class="fl-srow"><div class="fl-srow__l">' + label + '</div><div class="fl-srow__c">' + ctl + '</div><div class="fl-srow__hint">' + (hint || '') + '</div></div>'; }
  function head(t) { return '<div class="fl-srow fl-srow--head">' + t + '</div>'; }
  function getPath(p) { return p.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, S.cfg); }
  function setPath(p, v) { var ks = p.split('.'), o = S.cfg; ks.slice(0, -1).forEach(function (k) { o = o[k]; }); o[ks[ks.length - 1]] = v; }
  var TABS = ['CLOCK', 'LOCATIONS', 'AI', 'FOCUS', 'MODULES', 'SYSTEM', 'WINDOW', 'KEYS'];
  function settingsBody(tab) {
    var c = S.cfg;
    if (tab === 'CLOCK') return '<div class="fl-two" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr)"><div>' + head('FORMAT') +
      row('HOURS', seg('h24', [[true, '24H'], [false, '12H']])) + row('SECONDS', onoff('seconds'), 'Small digits beside the minutes') +
      row('COLON BLINK', onoff('blink'), 'Off by default: steadier on a second screen') + row('DATE', seg('dateFmt', [['dow', 'TUE 06 OCT'], ['iso', '2026-10-06'], ['eu', '06.10.2026']])) +
      row('WEEK + UTC LINE', onoff('meta')) + head('DOT MATRIX') + row('DOT SHAPE', seg('shape', [['round', 'ROUND'], ['square', 'SQUARE']])) +
      row('GHOST DOTS', onoff('ghost'), 'Show unlit dots at 4% for an LED panel look') +
      row('HOME ZONE', '<select class="fl-select" data-set-select="homeTz">' + uniqTz().map(function (z) { return '<option' + (z === c.homeTz ? ' selected' : '') + '>' + z + '</option>'; }).join('') + '</select>', 'DIFF column is relative to this zone') +
      '</div><div style="padding:calc(var(--u)*28px)"><div class="fl-sec"><span>PREVIEW</span><span>LIVE</span></div><div class="fl-preview" style="display:flex;justify-content:flex-end;padding-top:40px"><div data-clock="big" data-pitch="14" data-text="' + hm(homeParts()) + '"></div></div><div class="fl-date" style="justify-content:flex-end"><span data-b="date"></span></div></div></div>';
    if (tab === 'LOCATIONS') return head('DESTINATIONS · DRAG OR USE ↑ ↓ TO REORDER · MAX 8') +
      S.cities.map(function (ct, i) { return '<div class="fl-loc"><span class="grip">⋮⋮</span><span>' + ct.name + '</span><span class="fl-ink2">' + ct.code + '</span><span class="fl-ink3" style="text-transform:none">' + ct.tz + '</span><span class="fl-ink1" data-b="city' + i + 'D"></span><span><button class="fl-iconbtn" data-loc="up:' + i + '" aria-label="Move up">↑</button><button class="fl-iconbtn" data-loc="down:' + i + '" aria-label="Move down">↓</button><button class="fl-iconbtn" data-loc="del:' + i + '" aria-label="Remove">✕</button></span></div>'; }).join('') +
      '<div class="fl-loc"><span class="grip">+</span><span style="grid-column:span 4"><select class="fl-select" id="fl-addcity">' + CITY_PRESETS.filter(function (p) { return !S.cities.some(function (c2) { return c2.tz === p[2]; }); }).map(function (p) { return '<option value="' + p[2] + '">' + p[0] + ' · ' + p[1] + '</option>'; }).join('') + '</select></span><span><button class="fl-btn" data-loc="add">ADD</button></span></div>' +
      head('DISPLAY') + row('CODE COLUMN', seg('code', [[true, 'IATA'], [false, 'HIDE']])) + row('SORT', seg('sort', [['manual', 'MANUAL'], ['offset', 'BY OFFSET']]));
    if (tab === 'AI') return head('PROVIDERS') + S.providers.map(function (p, i) {
      return row(p.name, seg('__prov' + i, [['ok', 'OK'], ['loading', 'LOADING'], ['unavailable', 'UNAVAILABLE'], ['error', 'ERROR']]), 'SOURCE · ' + p.source + ' — state preview (prototype)');
    }).join('') + row('+ ADD PROVIDER', '<button class="fl-btn">GEMINI</button><button class="fl-btn">CURSOR</button><button class="fl-btn">CUSTOM JSON</button>', 'Adapters return { window, used, resetsAt }') +
      head('BEHAVIOUR') + row('REFRESH EVERY', seg('ai.refresh', [[1, '1M'], [2, '2M'], [5, '5M'], [15, '15M']]), 'Backs off to 15M after 3 failures') +
      row('WARN AT', seg('ai.warn', [[0.8, '80%'], [0.9, '90%'], [1, '100%']]), 'Meter turns amber at or above this') + row('NOTIFY ON RESET', onoff('ai.notify'), 'Windows toast when a window resets');
    if (tab === 'FOCUS') return head('POMODORO') + row('FOCUS', seg('pomo.focus', [[25, '25'], [45, '45'], [50, '50'], [90, '90']]), 'Minutes') +
      row('SHORT BREAK', seg('pomo.short', [[5, '5'], [10, '10']])) + row('LONG BREAK', seg('pomo.long', [[15, '15'], [20, '20'], [30, '30']])) +
      row('SESSIONS', seg('pomo.sessions', [[3, '3'], [4, '4'], [6, '6']])) + row('AUTO-START NEXT', onoff('pomo.auto')) +
      row('SOUND', seg('pomo.sound', [['CHIME', 'CHIME'], ['FLAP', 'SPLIT-FLAP'], ['OFF', 'OFF']])) + row('DURING FOCUS', seg('pomo.dnd', [[true, 'REMIND: DO NOT DISTURB'], [false, 'NOTHING']]), 'Windows has no public API to toggle it; FLIP opens the setting');
    if (tab === 'MODULES') return head('MODULES · ORDER IS FIXED IN V1, REARRANGE IN A LATER RELEASE') +
      row('CLOCK', '<span class="fl-ink3">ALWAYS ON</span>') + row('DATE', onoff('mod.date')) + row('AI USAGE', onoff('mod.ai')) + row('WORLD CLOCK', onoff('mod.world')) +
      row('SYSTEM MONITOR', onoff('mod.system')) + row('POMODORO', onoff('mod.focus')) + row('SHORTCUT HINTS', onoff('mod.keys')) +
      head('LAYOUT') + row('LAYOUT', seg('layout', [['auto', 'AUTO'], ['full', 'FULL'], ['compact', 'COMPACT'], ['mini', 'MINI']]), 'AUTO picks by window size: ≥1150×620 FULL, ≥600×300 COMPACT');
    if (tab === 'SYSTEM') return head('METRICS') + row('TEMPERATURES', onoff('sys.temps'), 'Needs a sensor provider; shows N/A without one') + row('GPU', onoff('sys.gpu')) +
      row('NETWORK', onoff('sys.net')) + row('DISKS', onoff('sys.disk')) + row('CPU HISTORY', onoff('sys.plot')) +
      head('SAMPLING') + row('SAMPLE EVERY', seg('sample', [[1, '1S'], [2, '2S'], [5, '5S']]), 'Lower = less CPU for FLIP itself') + row('TEMPERATURE', seg('tempUnit', [['C', '°C'], ['F', '°F']]));
    if (tab === 'WINDOW') return head('WINDOW') + row('ALWAYS ON TOP', onoff('win.onTop'), 'T') + row('LAUNCH ON STARTUP', onoff('win.startup'), 'Adds a Run key for the current user') +
      row('START IN TRAY', onoff('win.startMin')) + row('MODE', seg('win.mode', [['FULLSCREEN', 'FULLSCREEN'], ['WINDOWED', 'WINDOWED'], ['COMPACT', 'COMPACT']]), 'F11 toggles fullscreen') +
      row('DISPLAY', seg('win.display', [[1, '1 · 1920×1080'], [2, '2 · 2560×1440']]), 'Remembered per monitor setup') + row('CLICK-THROUGH', onoff('win.click'), 'Mouse passes through; tray to undo') +
      head('SCREEN CARE') + row('HIDE CONTROLS AFTER', seg('win.hide', [[3, '3S'], [10, '10S'], [0, 'NEVER']])) + row('PIXEL SHIFT', onoff('win.shift'), 'Moves content 1–2px every 10 min (OLED)') +
      row('DIM AFTER', seg('win.dim', [['OFF', 'OFF'], ['30M', '30M IDLE'], ['NIGHT', '22:00–07:00']]));
    if (tab === 'KEYS') return head('KEYBOARD') + [['SPACE', 'Start / pause focus'], ['R', 'Reset focus timer'], ['S', 'Skip to next phase'], ['P', 'Timer controls'], [',', 'Settings'], ['C', 'Toggle compact'], ['T', 'Always on top'], ['F11', 'Fullscreen'], ['ESC', 'Close panel / exit fullscreen'], ['CTRL+ALT+F', 'Show FLIP (global)'], ['CTRL+M', 'Minimize to tray'], ['CTRL+Q', 'Quit']].map(function (k) { return row('<span class="fl-kbd" style="font-size:1em;padding:2px 8px">' + k[0] + '</span>', '<span class="fl-ink1" style="text-transform:none">' + k[1] + '</span>'); }).join('');
    return '';
  }
  function uniqTz() { var a = [S.cfg.homeTz, browserTz, 'Asia/Singapore', 'Asia/Manila', 'UTC']; CITY_PRESETS.forEach(function (p) { a.push(p[2]); }); return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  function overlayHTML(ov) {
    if (ov === 'settings') return '<div class="fl-scrim" data-close="1"><div class="fl-ov" role="dialog" aria-label="Settings"><div class="fl-sheet"><div class="fl-sheet__h"><span>SETTINGS</span><button class="fl-ctl" data-close="1">ESC CLOSE</button></div>' +
      '<div class="fl-tabs" role="tablist">' + TABS.map(function (t) { return '<button role="tab" class="' + (t === S.settingsTab ? 'is-on' : '') + '" data-tab="' + t + '">' + t + '</button>'; }).join('') + '</div>' +
      '<div class="fl-sheet__b">' + settingsBody(S.settingsTab) + '</div><div class="fl-sheet__f"><span class="fl-ink3 grow" style="font-size:.8em">CHANGES APPLY LIVE · SAVED TO %APPDATA%\\FLIP\\SETTINGS.JSON</span><button class="fl-btn" data-reset="1">RESTORE DEFAULTS</button><button class="fl-btn fl-btn--primary" data-close="1">DONE <kbd>ESC</kbd></button></div></div></div></div>';
    if (ov.indexOf('ai:') === 0) {
      var p = S.providers.filter(function (x) { return x.id === ov.slice(3); })[0] || S.providers[0];
      var o = homeParts();
      var stateLine = p.state === 'ok' ? 'CONNECTED' : p.state === 'loading' ? 'SYNCING…' : p.state === 'error' ? '<span class="fl-warn">ERR · AUTH EXPIRED (401)</span>' : 'NOT CONNECTED';
      return '<div class="fl-scrim" data-close="1"><div class="fl-ov fl-ov--ai" role="dialog"><div class="fl-sheet"><div class="fl-sheet__h"><span>' + p.name + ' · USAGE</span><button class="fl-ctl" data-close="1">ESC CLOSE</button></div><div class="fl-sheet__b"><div class="fl-two"><div>' +
        p.metrics.map(function (m) {
          return '<div class="fl-detail"><div class="fl-sec" style="border:0;padding:0"><span>' + m.label + '</span><span>' + (p.state === 'ok' ? 'RESETS IN ' + dur(m.reset) : '—') + '</span></div><div class="fl-detail__big"><div data-clock="big" data-pitch="11" data-text="' + Math.round(m.v * 100) + '"></div><span class="fl-ink2" style="font-size:calc(var(--u)*26px)">% USED</span></div><div data-m="ai:' + p.id + ':' + m.k + '" data-cells="48"></div></div>';
        }).join('') + (p.state === 'ok' && p.metrics[0].k === '5H' ? '<div class="fl-kv"><span>PACE</span><span>~14% / HOUR THIS WINDOW</span></div><div class="fl-kv"><span>PROJECTION</span><span class="fl-warn">LIMIT ≈ 14:47 · 11 MIN BEFORE RESET</span></div>' : '') +
        '</div><div><div class="fl-detail"><div class="fl-sec" style="border:0;padding:0"><span>LAST 24H · HOURLY</span><span>' + o.hour + ':00</span></div><div data-plot="aiHist" data-rows="8" data-pitch="12"></div><div class="fl-ink3" style="display:flex;justify-content:space-between;font-size:calc(var(--u)*12px)"><span>-24H</span><span>-12H</span><span>NOW</span></div></div>' +
        '<div class="fl-kv"><span>STATUS</span><span>' + stateLine + '</span></div><div class="fl-kv"><span>SOURCE</span><span>' + p.source + '</span></div><div class="fl-kv"><span>LAST SYNC</span><span>' + o.hour + ':' + String(Math.max(0, +o.minute - 2)).padStart(2, '0') + ' · EVERY ' + S.cfg.ai.refresh + ' MIN</span></div><div class="fl-kv"><span>WARN AT</span><span>' + pct(S.cfg.ai.warn) + '</span></div></div></div></div>' +
        '<div class="fl-sheet__f"><button class="fl-btn">REFRESH NOW <kbd>R</kbd></button><button class="fl-btn">OPEN USAGE PAGE <kbd>O</kbd></button><span class="grow"></span><button class="fl-btn fl-btn--primary" data-close="1">CLOSE <kbd>ESC</kbd></button></div></div></div></div>';
    }
    if (ov === 'sys') {
      return '<div class="fl-scrim" data-close="1"><div class="fl-ov fl-ov--sys" role="dialog"><div class="fl-sheet"><div class="fl-sheet__h"><span>SYSTEM · ' + S.sys.host + '</span><button class="fl-ctl" data-close="1">ESC CLOSE</button></div><div class="fl-sheet__b"><div class="fl-two"><div>' +
        '<div class="fl-detail"><div class="fl-sec" style="border:0;padding:0"><span>CPU · 16 THREADS</span><span data-b="cpu"></span></div><div data-plot="cpuHist" data-rows="10" data-pitch="9"></div></div>' +
        '<div class="fl-cores">' + S.sys.cores.map(function (v, i) { return '<div class="fl-core"><span>CORE ' + String(i).padStart(2, '0') + '</span><div data-m="core' + i + '"></div><span class="r">' + pct(v) + '</span></div>'; }).join('') + '</div>' +
        '<div class="fl-kv"><span>TEMPERATURE</span><span data-b="cpuT"></span></div><div class="fl-kv"><span>SENSOR</span><span class="fl-ink2">LIBREHARDWAREMONITOR · OK</span></div></div><div>' +
        '<div class="fl-detail"><div class="fl-sec" style="border:0;padding:0"><span>NETWORK · ETHERNET</span><span data-b="down"></span></div><div data-plot="netHistBig" data-rows="6" data-pitch="9"></div></div>' +
        '<div class="fl-kv"><span>MEMORY</span><span data-b="ram"></span></div><div class="fl-kv"><span>GPU · ' + S.sys.gpuName + '</span><span><span data-b="gpu"></span> · <span data-b="gpuT"></span></span></div><div class="fl-kv"><span>DISK C:</span><span data-b="disk0"></span></div><div class="fl-kv"><span>DISK D:</span><span data-b="disk1"></span></div>' +
        '<div class="fl-ptab"><div class="fl-board__r fl-board__h"><span>PROCESS</span><span class="r">CPU</span><span class="r">MEMORY</span></div>' + S.sys.top.map(function (t) { return '<div class="fl-board__r"><span>' + t[0] + '</span><span class="r">' + (t[1] * 100).toFixed(1) + '%</span><span class="r">' + t[2].toFixed(1) + ' GB</span></div>'; }).join('') + '</div></div></div></div>' +
        '<div class="fl-sheet__f"><button class="fl-btn">OPEN TASK MANAGER</button><span class="grow"></span><span class="fl-ink3" style="font-size:.8em">SAMPLING EVERY ' + S.cfg.sample + 'S</span><button class="fl-btn fl-btn--primary" data-close="1">CLOSE <kbd>ESC</kbd></button></div></div></div></div>';
    }
    if (ov === 'timer') {
      return '<div class="fl-scrim fl-scrim--clear" data-close="1"><div class="fl-timer" role="dialog" aria-label="Timer controls"><div class="fl-sheet"><div class="fl-sheet__h"><span data-b="pomoPhase"></span><span class="fl-ink3" data-b="pomoSess"></span></div><div class="fl-sheet__b">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-end"><div data-clock="big" data-pitch="13"></div><div class="fl-focus__side"><div class="fl-focus__dots" data-b="pomoDots"></div><div data-b="pomoEnds"></div></div></div>' +
        '<div data-m="pomo" class="fl-meter--sq"></div>' +
        '<div class="fl-timer__row"><button class="fl-btn fl-btn--primary" data-pomo="toggle">' + (P.running ? 'PAUSE' : 'START') + ' <kbd>SPACE</kbd></button><button class="fl-btn" data-pomo="reset">RESET <kbd>R</kbd></button><button class="fl-btn" data-pomo="skip">SKIP <kbd>S</kbd></button><button class="fl-btn" data-pomo="plus">+5 MIN <kbd>+</kbd></button></div>' +
        '<div class="fl-timer__row" style="justify-content:space-between;align-items:center"><span class="fl-ink3" style="font-size:.8em">BLOCK</span>' + seg('pomo.focus', [[25, 'FOCUS 25'], [45, 'FOCUS 45'], [50, 'FOCUS 50']]) + '</div>' +
        '</div></div></div></div>';
    }
    return '';
  }

  /* ------------------------------------------------------------------ events */
  function act(a, host) {
    if (a === 'clock') { S.settingsTab = 'CLOCK'; S.overlay = 'settings'; }
    else if (a === 'settings') { S.overlay = 'settings'; }
    else if (a === 'sys') { S.overlay = 'sys'; }
    else if (a === 'timer') { S.overlay = 'timer'; }
    else if (a.indexOf('ai:') === 0) { S.overlay = a; }
    else if (a === 'ontop') { S.cfg.win.onTop = !S.cfg.win.onTop; }
    else if (a === 'compact') { S.cfg.layout = (S.cfg.layout === 'compact' || S.cfg.layout === 'mini') ? 'auto' : 'compact'; instances.forEach(function (i) { i.layoutName = null; i.fit(); }); }
    else if (a === 'min' || a === 'exit') { toast(a === 'min' ? 'MINIMIZED TO TRAY · CTRL+ALT+F TO RESTORE' : 'QUIT FLIP? CTRL+Q CONFIRMS'); return; }
    refreshAll(true);
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0b0b0b;border:1px solid #4a4a4a;color:#c8c8c8;padding:10px 18px;font:500 12px/1 var(--font-mono);letter-spacing:.12em;z-index:200';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2200);
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-set],[data-tab],[data-loc],[data-pomo],[data-reset],[data-act],[data-close],[data-screen],[data-proto]');
    if (!el) return;
    if (el.hasAttribute('data-set')) {
      var p = el.getAttribute('data-set'), v = JSON.parse(el.getAttribute('data-val'));
      var pm = /^__prov(\d+)$/.exec(p);
      if (pm) S.providers[+pm[1]].state = v; else setPath(p, v);
      if (p === 'pomo.focus' && P.phase === 'idle') P.left = v * 60;
      if (p === 'layout') instances.forEach(function (i) { i.layoutName = null; i.fit(); });
      refreshAll(true); return;
    }
    if (el.hasAttribute('data-tab')) { S.settingsTab = el.getAttribute('data-tab'); refreshAll(true); return; }
    if (el.hasAttribute('data-loc')) {
      var a = el.getAttribute('data-loc').split(':'), i = +a[1], C = S.cities;
      if (a[0] === 'up' && i > 0) C.splice(i - 1, 0, C.splice(i, 1)[0]);
      if (a[0] === 'down' && i < C.length - 1) C.splice(i + 1, 0, C.splice(i, 1)[0]);
      if (a[0] === 'del' && C.length > 1) C.splice(i, 1);
      if (a[0] === 'add' && C.length < 8) { var sel = document.getElementById('fl-addcity'); var pr = CITY_PRESETS.filter(function (x) { return x[2] === sel.value; })[0]; if (pr) C.push({ name: pr[0], code: pr[1], tz: pr[2] }); }
      refreshAll(true); return;
    }
    if (el.hasAttribute('data-pomo')) { var k = el.getAttribute('data-pomo'); if (k === 'toggle') pomoToggle(); if (k === 'reset') pomoReset(); if (k === 'skip') pomoSkip(); if (k === 'plus') { P.left += 300; refreshAll(true); } return; }
    if (el.hasAttribute('data-reset')) { toast('DEFAULTS RESTORED'); return; }
    if (el.hasAttribute('data-screen')) { go(+el.getAttribute('data-screen')); return; }
    if (el.hasAttribute('data-proto')) { if (frozen === null) { frozen = new Date('2026-10-06T04:43:00Z').getTime(); t0 = Date.now(); S.cfg.homeTz = 'Asia/Singapore'; } else { frozen = null; S.cfg.homeTz = browserTz; } buildBar(); refreshAll(true); return; }
    if (el.hasAttribute('data-close')) { if (el === e.target || el.tagName === 'BUTTON') { S.overlay = null; refreshAll(true); } return; }
    if (el.hasAttribute('data-act')) { e.stopPropagation(); act(el.getAttribute('data-act'), el.closest('.fl-host')); }
  });
  document.addEventListener('change', function (e) {
    var p = e.target.getAttribute && e.target.getAttribute('data-set-select');
    if (p) { setPath(p, e.target.value); refreshAll(true); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    var k = e.key;
    if (k === ' ') { e.preventDefault(); pomoToggle(); }
    else if (k === 'r' || k === 'R') pomoReset();
    else if (k === 's' || k === 'S') pomoSkip();
    else if (k === '+') { P.left += 300; refreshAll(true); }
    else if (k === 'p' || k === 'P') act('timer');
    else if (k === ',') act('settings');
    else if (k === 'c' || k === 'C') act('compact');
    else if (k === 't' || k === 'T') act('ontop');
    else if (k === 'Escape') { S.overlay = null; refreshAll(true); }
    else if (k === ']' || k === 'PageDown') go((S.screen + 1) % SCREENS.length);
    else if (k === '[' || k === 'PageUp') go((S.screen + SCREENS.length - 1) % SCREENS.length);
  });

  /* ------------------------------------------------------------------ scenes */
  function taskbar(trayOn) {
    var o = homeParts();
    return '<div class="sc-taskbar"><div class="apps"><i></i><i></i><i></i><i class="flip on"></i><i></i></div><div class="sc-tray"><span class="ti">⌃</span><span class="ti' + (trayOn ? ' is-on' : '') + '"><svg width="14" height="18" viewBox="0 0 3 5"><g fill="#f2f2f2"><circle cx=".5" cy=".5" r=".38"/><circle cx="1.5" cy=".5" r=".38"/><circle cx="2.5" cy=".5" r=".38"/><circle cx=".5" cy="1.5" r=".38"/><circle cx=".5" cy="2.5" r=".38"/><circle cx="1.5" cy="2.5" r=".38"/><circle cx=".5" cy="3.5" r=".38"/><circle cx=".5" cy="4.5" r=".38"/></g></svg></span><span class="ti">⌁</span><span class="ti">◖</span><div class="sc-time">' + o.hour + ':' + o.minute + '<br>' + o.day + '/' + o.month + '/' + o.year + '</div></div></div>';
  }
  function winFrame(id, x, y, w, h, title, extra) {
    return '<div class="fl-win fl-display" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;--u:.8;' + (extra || '') + '"><div class="fl-titlebar"><span>FLIP <span style="color:#5a5a5a">·</span> <span id="' + id + '-t">' + title + '</span></span><div class="fl-titlebar__c"><button title="Always on top">⊤</button><button title="Minimize">—</button><button title="Maximize">▢</button><button class="x" title="Close">✕</button></div></div><div class="fl-host" id="' + id + '" style="flex:1"></div></div>';
  }
  var SCREENS = [
    { n: 'DASHBOARD', html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } },
    { n: 'FOCUS ACTIVE', pre: function () { P.phase = 'focus'; P.running = true; P.left = 18 * 60 + 42; P.session = 2; }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } },
    {
      n: 'AI STATES', pre: function () {
        S.providers = defaultProviders();
        S.providers[1].state = 'loading';
        S.providers.push({ id: 'gemini', name: 'GEMINI', state: 'unavailable', source: '—', metrics: [{ k: '7D', v: 0, label: '7-DAY WINDOW', reset: 0 }] });
        S.providers.push({ id: 'cursor', name: 'CURSOR', state: 'error', source: 'ACCOUNT API', metrics: [{ k: '30D', v: 0.4, label: 'MONTHLY', reset: 9000 }] });
      }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); }
    },
    {
      n: 'WINDOWED', html: function () {
        return '<div class="sc-desk">' + winFrame('w', 170, 64, 1580, 900, 'WINDOWED', 'resize:both;min-width:360px;min-height:200px') + '<div class="sc-cap" style="left:170px;top:980px">DRAG THE CORNER TO RESIZE · LAYOUT SWITCHES <b>FULL → COMPACT → MINI</b> BY SIZE</div>' + taskbar(false) + '</div>';
      }, mount: function () { new Dash(byId('w'), { primary: true, onSize: function (w, h, L) { var t = byId('w-t'); if (t) t.textContent = L.toUpperCase() + ' · ' + w + '×' + h; } }); }
    },
    {
      n: 'COMPACT + MINI', html: function () {
        return '<div class="sc-desk">' + winFrame('c', 110, 150, 1080, 640, 'COMPACT') +
          '<div class="fl-win fl-display" style="left:1290px;top:150px;width:520px;height:236px"><div class="fl-host" id="mi" style="flex:1"></div></div>' +
          '<div class="sc-cap" style="left:110px;top:812px"><b>COMPACT</b> · 1080 × 608 · LAPTOP OR 1366×768 SCREENS · SYSTEM COLLAPSES TO ONE STRIP</div>' +
          '<div class="sc-cap" style="left:1290px;top:408px;width:520px;line-height:1.7"><b>MINI WIDGET</b> · 520 × 236 · BORDERLESS, ALWAYS ON TOP<br>CONTROLS APPEAR ON HOVER</div>' + taskbar(false) + '</div>';
      }, mount: function () { new Dash(byId('c'), { primary: true, layout: 'compact' }); new Dash(byId('mi'), { layout: 'mini' }); }
    },
    { n: 'SETTINGS', pre: function () { S.overlay = 'settings'; S.settingsTab = 'CLOCK'; }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } },
    {
      n: 'TRAY', html: function () {
        var c = S.cfg.win;
        function mi(chk, label, key) { return '<div class="fl-menu__i"><span>' + (chk ? '✓' : '') + '</span><span>' + label + '</span><span class="fl-ink3">' + (key || '') + '</span></div>'; }
        return '<div class="sc-desk">' +
          '<div class="sc-cap" style="right:470px;bottom:480px">LEFT-CLICK · <b>FLYOUT</b></div>' +
          '<div class="fl-win fl-display" style="right:470px;bottom:62px;width:520px;height:352px;border-radius:8px"><div class="fl-host" id="fly" style="height:236px;flex:none;border-bottom:1px solid var(--rule)"></div>' +
          '<div style="padding:14px 18px;display:flex;flex-direction:column;gap:12px;--u:.82"><div style="display:flex;justify-content:space-between;font-size:12px;letter-spacing:.12em;color:var(--ink-3)"><span>FOCUS · <span class="fl-ink1" data-tb="pomo"></span></span><span>SESSION ' + P.session + '/4</span></div>' +
          '<div style="display:flex;gap:8px"><button class="fl-btn fl-btn--primary" data-pomo="toggle">' + (P.running ? 'PAUSE' : 'START FOCUS') + '</button><button class="fl-btn" data-screen="0">OPEN FLIP</button><button class="fl-btn" data-screen="5">SETTINGS</button></div></div></div>' +
          '<div class="sc-cap" style="right:24px;bottom:510px">RIGHT-CLICK · <b>MENU</b></div>' +
          '<div class="fl-menu fl-display" style="position:absolute;right:24px;bottom:62px;--u:1">' +
          '<div class="fl-menu__head">FLIP 1.0 · <span data-tb="clock"></span></div>' + mi(false, 'SHOW FLIP', 'CTRL+ALT+F') + mi(false, P.running ? 'PAUSE FOCUS' : 'START FOCUS', 'SPACE') +
          '<div class="fl-menu__sep"></div>' + mi(c.onTop, 'ALWAYS ON TOP', 'T') + mi(c.startup, 'LAUNCH ON STARTUP') + mi(c.click, 'CLICK-THROUGH') +
          '<div class="fl-menu__sep"></div>' + mi(false, 'MODE · ' + c.mode, '›') + mi(false, 'DISPLAY · ' + c.display + ' · 2560×1440', '›') +
          '<div class="fl-menu__sep"></div>' + mi(false, 'SETTINGS…', ',') + mi(false, 'QUIT FLIP', 'CTRL+Q') + '</div>' + taskbar(true) + '</div>';
      }, mount: function () { new Dash(byId('fly'), { layout: 'mini' }); }
    },
    {
      n: 'MULTI-MONITOR', html: function () {
        return '<div class="sc-desk" style="background:#0b0b0c;background-image:none">' +
          '<div class="sc-cap" style="left:120px;top:70px;font-size:15px"><b>DISPLAYS</b> · FLIP REMEMBERS WHERE IT LIVES PER MONITOR SETUP</div>' +
          '<div class="sc-mon" style="left:120px;top:250px;width:660px;height:380px"><div class="scr"><div class="sc-ghostwin" style="left:20px;top:20px;width:380px;height:270px"></div><div class="sc-ghostwin" style="left:300px;top:90px;width:300px;height:230px"></div></div><div class="stand"></div><div class="lbl">1 · PRIMARY · <span>1920×1080 · WORK APPS</span></div></div>' +
          '<div class="sc-mon" style="left:860px;top:170px;width:940px;height:540px"><div class="scr fl-host" id="mm"></div><div class="stand"></div><div class="lbl">2 · DELL U2723QE · <span>2560×1440 · FLIP FULLSCREEN · ALWAYS ON TOP</span></div></div>' +
          '<div class="fl-display" style="position:absolute;left:120px;right:120px;top:800px;--u:1;background:transparent">' +
          '<div class="fl-srow"><div class="fl-srow__l">OPEN ON</div><div class="fl-srow__c">' + seg('win.display', [[1, '1 · 1920×1080'], [2, '2 · 2560×1440']]) + '</div><div class="fl-srow__hint">Tray › Display, or drag the window</div></div>' +
          '<div class="fl-srow"><div class="fl-srow__l">IF DISPLAY 2 DISCONNECTS</div><div class="fl-srow__c">' + seg('win.fallback', [['compact', 'MOVE TO 1 AS COMPACT'], ['tray', 'HIDE TO TRAY'], ['full', 'MOVE TO 1 FULL']]) + '</div><div class="fl-srow__hint">Returns automatically on reconnect</div></div>' +
          '<div class="fl-srow"><div class="fl-srow__l">DPI</div><div class="fl-srow__c"><span class="fl-ink1">PER-MONITOR V2 · SCALE FROM WINDOW SIZE, NOT DPI</span></div><div class="fl-srow__hint">Crisp at 100%–200% scaling</div></div></div>' + '</div>';
      }, pre: function () { if (!S.cfg.win.fallback) S.cfg.win.fallback = 'compact'; }, mount: function () { new Dash(byId('mm'), { layout: 'full' }); }
    },
    { n: 'AI DETAIL', pre: function () { S.overlay = 'ai:claude'; }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } },
    { n: 'SYSTEM DETAIL', pre: function () { S.overlay = 'sys'; }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } },
    { n: 'TIMER CONTROLS', pre: function () { S.overlay = 'timer'; P.phase = 'focus'; P.running = true; P.left = 18 * 60 + 42; }, html: function () { return '<div class="sc-full" id="m"></div>'; }, mount: function () { new Dash(byId('m'), { primary: true }); } }
  ];
  function byId(id) { return document.getElementById(id); }
  var stage, bar;
  function go(i) {
    S.screen = i; S.overlay = null;
    if (S.providers.length !== 2 || S.providers.some(function (p) { return p.state !== 'ok'; })) S.providers = defaultProviders();
    if (i !== 1 && i !== 10 && i !== 6 && SCREENS[S.prev] && (S.prev === 1 || S.prev === 10)) { P.phase = 'idle'; P.running = false; P.left = S.cfg.pomo.focus * 60; }
    S.prev = i;
    var sc = SCREENS[i]; if (sc.pre) sc.pre();
    instances.forEach(function (d) { d.ro.disconnect(); }); instances = [];
    stage.innerHTML = sc.html(); sc.mount();
    buildBar();
    try { history.replaceState(null, '', '#' + (i + 1)); } catch (e) { }
  }
  function buildBar() {
    if (!bar) return;
    bar.innerHTML = '<b>FLIP</b>' + SCREENS.map(function (s, i) { return '<button data-screen="' + i + '" class="' + (i === S.screen ? 'is-on' : '') + '">' + String(i + 1).padStart(2, '0') + ' ' + s.n + '</button>'; }).join('') +
      '<span class="sp"></span><button data-proto="time" title="Freeze at the brief\'s sample time (12:43 Singapore)">' + (frozen === null ? 'LIVE TIME' : 'SPEC TIME 12:43') + '</button>';
  }
  function fitStage() { var v = document.querySelector('.proto-view'); var s = Math.min(v.clientWidth / 1920, v.clientHeight / 1080); stage.style.transform = 'translate(-50%,-50%) scale(' + s + ')'; }

  /* ------------------------------------------------------------------ boot */
  function tick() {
    if (frozen === null || !SHOT) {
      pomoTick();
      if (frozen === null) {
        var s = S.sys;
        s.cpu = Math.max(0.04, Math.min(0.96, s.cpu + (Math.random() - 0.5) * 0.08)); s.cpuHist.push(s.cpu); s.cpuHist.shift();
        s.cpuT = Math.max(40, Math.min(88, s.cpuT + (Math.random() - 0.5) * 1.6));
        s.gpu = Math.max(0.02, Math.min(0.98, s.gpu + (Math.random() - 0.5) * 0.05));
        s.down = Math.max(0.1, s.down + (Math.random() - 0.5) * 3); s.up = Math.max(0.05, s.up + (Math.random() - 0.5) * 0.4);
        s.netHist.push(Math.min(1, s.down / 40)); s.netHist.shift();
        s.ram = Math.max(8, Math.min(31, s.ram + (Math.random() - 0.5) * 0.15)); s.uptime++;
        s.cores = s.cores.map(function (v) { return Math.max(0.02, Math.min(0.98, v + (Math.random() - 0.5) * 0.2)); });
      }
    }
    refreshAll(false);
    document.querySelectorAll('[data-tb="clock"]').forEach(function (el) { var o = homeParts(); el.textContent = o.hour + ':' + o.minute; });
    document.querySelectorAll('[data-tb="pomo"]').forEach(function (el) { el.textContent = P.phase === 'idle' ? 'READY ' + mmss(P.left) : PHASE[P.phase] + ' ' + mmss(P.left); });
    setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  }
  window.addEventListener('DOMContentLoaded', function () {
    stage = document.querySelector('.proto-stage'); bar = document.querySelector('.proto-bar');
    if (FROZEN_AT && !Q.get('tz')) S.cfg.homeTz = 'Asia/Singapore';
    var start = +(Q.get('screen') || (location.hash || '#1').slice(1)) - 1;
    go(isNaN(start) || start < 0 || start >= SCREENS.length ? 0 : start);
    fitStage(); window.addEventListener('resize', fitStage);
    tick();
  });
  window.FLIP_PROTO = { S: S, go: go, SCREENS: SCREENS };
})();
