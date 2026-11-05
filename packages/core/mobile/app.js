/*
 * FBRX Mobile: a small web app served by your FBRX OS computer to phones you pair with it.
 * Every request is sealed with NaCl box (this phone's secret key + the computer's public key) and carries a fresh
 * id and timestamp, so it cannot be read, forged or replayed on the network. Pairing proves both sides know the
 * one-time code (HMAC-SHA512 over both public keys) before keys are trusted.
 *
 * The same app also runs inside the App Store and Google Play app (store/mobile): window.FBRX_NATIVE is set there.
 * It then reaches the computer at the address it paired with, signs in to the FBRX account and buys through the store.
 */
(function () {
  'use strict';
  var nacl = window.nacl;
  var NATIVE = window.FBRX_NATIVE || null;
  var MESH_PORT = 47800;
  var STORE = 'fbrx.mobile.v1';
  var ALPHA = /[^0-9A-HJKMNP-TV-Z]/g;
  var app = document.getElementById('app');
  var state = { tab: 'home', status: null, approvals: [], jobs: {}, alerts: [], messages: [], tasks: [], online: false, unread: 0, error: null, perms: {}, home: null, models: null };
  var DISMISSED = 'fbrx.mobile.dismissed';
  var cfg = load();
  var pollTimer = null;
  var alarm = null;

  // ------------------------------------------------------------------------------------------ helpers
  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || 'null');
    } catch (e) {
      return null;
    }
  }
  function save(c) {
    cfg = c;
    if (c) localStorage.setItem(STORE, JSON.stringify(c));
    else localStorage.removeItem(STORE);
  }
  function b64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function unb64(s) {
    var b = atob(s);
    var u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function utf8(s) {
    return new TextEncoder().encode(s);
  }
  function hex(u8) {
    return Array.prototype.map.call(u8, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function fingerprint(pkB64) {
    return hex(nacl.hash(unb64(pkB64))).slice(0, 32);
  }
  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
  /** HMAC-SHA512 built on nacl.hash (Web Crypto is unavailable on plain-http local addresses). */
  function hmac(keyStr, msgStr) {
    var key = utf8(keyStr);
    if (key.length > 128) key = nacl.hash(key);
    var k = new Uint8Array(128);
    k.set(key);
    var ipad = new Uint8Array(128);
    var opad = new Uint8Array(128);
    for (var i = 0; i < 128; i++) {
      ipad[i] = k[i] ^ 0x36;
      opad[i] = k[i] ^ 0x5c;
    }
    return b64(nacl.hash(concat(opad, nacl.hash(concat(ipad, utf8(msgStr))))));
  }
  function normalizeCode(c) {
    return String(c || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function ago(iso) {
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function rid() {
    return hex(nacl.randomBytes(12));
  }

  // ------------------------------------------------------------------------------------------ network
  /** Where the computer is: the page's own origin when it served this app, its address in the store app. */
  function base() {
    return (cfg && cfg.base) || '';
  }
  /**
   * The computer's address from what was scanned or typed: "192.168.1.20", "192.168.1.20:47800", or the whole pairing
   * link (http://…/m/#pair=CODE&fp=ID), which also carries the code.
   */
  function parseTarget(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    var u;
    try {
      u = new URL(s);
    } catch (e) {
      return null;
    }
    if (!u.hostname) return null;
    var h = new URLSearchParams(u.hash.slice(1));
    return { base: 'http://' + u.hostname + ':' + (u.port || MESH_PORT), code: h.get('pair') || '', fp: h.get('fp') || '' };
  }

  function rpc(method, params) {
    var req = { id: rid(), ts: Date.now(), method: method, params: params || {} };
    var nonce = nacl.randomBytes(24);
    var box = nacl.box(utf8(JSON.stringify(req)), nonce, unb64(cfg.desktopPk), unb64(cfg.sk));
    return fetch(base() + '/mesh/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.myId, nonce: b64(nonce), box: b64(box) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.nonce) {
          var msg = (j.error && j.error.message) || 'Request refused';
          if (j.error && j.error.code === 'UNAUTHENTICATED' && /not paired/.test(msg)) {
            save(null);
            render();
          }
          throw new Error(msg);
        }
        var out = nacl.box.open(unb64(j.box), unb64(j.nonce), unb64(cfg.desktopPk), unb64(cfg.sk));
        if (!out) throw new Error('The reply could not be verified');
        var reply = JSON.parse(new TextDecoder().decode(out));
        if (reply.re !== req.id) throw new Error('Unexpected reply');
        if (!reply.ok) throw new Error(reply.error ? reply.error.message : 'Request failed');
        return reply.result;
      });
  }

  /** at: the computer's address (store app); the page's own origin otherwise. */
  function pair(codeRaw, expectFp, at) {
    var code = normalizeCode(codeRaw);
    if (code.replace(ALPHA, '').length !== 20) return Promise.reject(new Error('Enter the 20-character code shown on your computer'));
    var root = at || '';
    return fetch(root + '/mesh/hello')
      .then(function (r) { return r.json(); })
      .then(function (hello) {
        if (fingerprint(hello.publicKey) !== hello.id) throw new Error('The computer sent an inconsistent identity');
        if (expectFp && hello.id !== expectFp) throw new Error('This is not the computer that showed the QR code');
        var kp = nacl.box.keyPair();
        var pk = b64(kp.publicKey);
        var body = {
          publicKey: pk,
          kind: 'mobile',
          name: deviceName(),
          platform: /iPhone|iPad/.test(navigator.userAgent) ? 'iOS' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone',
          version: NATIVE ? 'app ' + (NATIVE.version || '') : 'web',
          mac: hmac(code, 'fbrx-pair-v1|' + pk + '|' + hello.publicKey),
        };
        return fetch(root + '/mesh/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            var myId = fingerprint(pk);
            if (res.deviceId !== myId || res.mac !== hmac(code, 'fbrx-pair-v1-ack|' + hello.publicKey + '|' + pk + '|' + myId)) {
              throw new Error('The computer could not prove it knows the code; pairing stopped');
            }
            save({ sk: b64(kp.secretKey), pk: pk, myId: myId, desktopPk: hello.publicKey, desktopId: hello.id, desktopName: res.name, pairedAt: new Date().toISOString(), base: root || undefined });
          });
      });
  }

  function deviceName() {
    var ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    var m = ua.match(/Android[^;]*;\s*([^;)]+)/);
    return m ? m[1].trim().slice(0, 40) : 'Phone';
  }

  // ------------------------------------------------------------------------------------------- sync
  function sync() {
    if (!cfg) return;
    rpc('sync')
      .then(function (r) {
        state.online = true;
        state.error = null;
        state.perms = r.permissions || {};
        if (r.name && r.name !== cfg.desktopName) save(Object.assign({}, cfg, { desktopName: r.name }));
        state.approvals = r.approvals || [];
        state.home = r.home || null;
        (r.jobs || []).forEach(function (j) { state.jobs[j.jobId] = Object.assign(state.jobs[j.jobId] || {}, j); });
        (r.items || []).forEach(handleItem);
        render();
      })
      .catch(function (e) {
        state.online = false;
        state.error = e.message;
        render();
      });
  }
  function handleItem(it) {
    if (it.type === 'alert') {
      state.alerts.unshift(it.alert);
      state.unread++;
      banner(it.alert.title, it.alert.body);
    } else if (it.type === 'message') {
      state.messages.push(it.message);
      banner('Message from ' + it.message.fromName, it.message.text);
    } else if (it.type === 'job') {
      state.jobs[it.job.jobId] = Object.assign(state.jobs[it.job.jobId] || {}, it.job);
    } else if (it.type === 'notify') {
      banner(it.title, it.body);
    } else if (it.type === 'locate') {
      locate();
    }
  }
  function banner(title, body) {
    if (navigator.vibrate) navigator.vibrate(120);
    var el = document.createElement('div');
    el.className = 'banner';
    el.innerHTML = '<b>' + esc(title) + '</b><div class="muted">' + esc(body).slice(0, 300) + '</div>';
    el.onclick = function () { el.remove(); };
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }
  function locate() {
    banner('Your computer is looking for this phone', 'Tap to stop');
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.2;
      o.connect(g).connect(ctx.destination);
      o.start();
      alarm = setInterval(function () { g.gain.value = g.gain.value ? 0 : 0.2; if (navigator.vibrate) navigator.vibrate(300); }, 400);
      document.body.addEventListener('click', function stop() { clearInterval(alarm); o.stop(); ctx.close(); document.body.removeEventListener('click', stop); }, { once: true });
    } catch (e) {
      /* audio blocked */
    }
  }
  function startPolling() {
    stopPolling();
    sync();
    pollTimer = setInterval(sync, 4000);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopPolling();
    else if (cfg) startPolling();
  });

  // ------------------------------------------------------------------------------------------ views
  function render() {
    var accountPage = !!NATIVE && state.tab === 'account';
    if (!cfg && !accountPage) return renderPair();
    var t = state.tab;
    var html = cfg
      ? '<div class="row brand"><div class="mark"></div><div class="spacer"><h1>' + esc(cfg.desktopName) + '</h1><div class="muted"><span class="dot ' + (state.online ? 'ok' : 'bad') + '"></span> ' + (state.online ? 'Connected' : 'Not reachable') + (state.error && !state.online ? ' · ' + esc(state.error) : '') + '</div></div>' +
        (NATIVE ? '<button class="small" data-tab="' + (accountPage ? 'home' : 'account') + '">' + (accountPage ? 'Back' : 'Account') + '</button>' : '') + '</div>'
      : '<div class="row brand"><div class="mark"></div><div class="spacer"><h1>FBRX</h1></div><button class="small" data-tab="pair">Back</button></div>';
    if (t === 'account') html += viewAccount();
    if (t === 'home') html += essentials() ? viewEssentialsHome() : viewHome();
    if (t === 'models') html += viewModels();
    if (t === 'ask') html += viewAsk();
    if (t === 'approvals') html += viewApprovals();
    if (t === 'tasks') html += viewTasks();
    if (t === 'alerts') html += viewAlerts();
    if (cfg) html += tabs();
    app.innerHTML = html;
    mountBoard();
    bind();
  }
  /** The computer runs Endpoint Essentials: Home is the split-flap board and notes from FBRX, no dashboard. */
  function essentials() {
    return !!state.home && state.home.tier === 'essentials';
  }
  function tabs() {
    if (essentials()) {
      var few = [['home', 'Home', 0], ['ask', 'Ask', 0]];
      if (state.approvals.length) few.push(['approvals', 'Approve', state.approvals.length]);
      few.push(['models', 'AI', 0]);
      return '<nav class="tabs">' + few.map(function (i) {
        return '<button data-tab="' + i[0] + '" class="' + (state.tab === i[0] ? 'on' : '') + '">' + i[1] + (i[2] ? '<span class="badge">' + i[2] + '</span>' : '') + '</button>';
      }).join('') + '</nav>';
    }
    var items = [
      ['home', 'Home', 0],
      ['ask', 'Ask', 0],
      ['approvals', 'Approve', state.approvals.length],
      ['tasks', 'Tasks', 0],
      ['alerts', 'Alerts', state.unread],
    ];
    return '<nav class="tabs">' + items.map(function (i) {
      return '<button data-tab="' + i[0] + '" class="' + (state.tab === i[0] ? 'on' : '') + '">' + i[1] + (i[2] ? '<span class="badge">' + i[2] + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
  }
  function viewHome() {
    var s = state.status;
    var out = '<h2>Status</h2>';
    if (!state.perms.status) out += '<div class="card muted">This phone is not allowed to see status. Change it on the computer under Mesh &amp; phone.</div>';
    else if (!s) out += '<div class="card muted">Loading…</div><span data-load="status"></span>';
    else {
      out += '<div class="stats">' +
        stat('Processor', s.cpu != null ? Math.round(s.cpu) + '%' : '—') +
        stat('Memory', s.memUsedPct != null ? s.memUsedPct + '%' : '—') +
        stat('Battery', s.battery ? s.battery.percent + '%' + (s.battery.charging ? ' ⚡' : '') : 'n/a') +
        stat('Open tasks', s.openTasks) +
        stat('Waiting approvals', s.pendingApprovals) +
        stat('Unread alerts', s.alerts ? s.alerts.unread : 0) +
        '</div>';
      out += '<div class="card"><div class="muted">Services</div>' + (s.services || []).map(function (x) { return '<div class="row"><span class="dot ' + (x.state === 'running' ? 'ok' : x.state === 'failed' ? 'bad' : '') + '"></span> ' + esc(x.name) + '<span class="spacer"></span><span class="muted">' + esc(x.state) + '</span></div>'; }).join('') + '</div>';
      out += '<button data-load="status">Refresh</button>';
    }
    out += '<h2>Messages</h2><div class="card">' + (state.messages.slice(-10).map(function (m) { return '<div class="bubble' + (m.fromId === cfg.myId ? ' me' : '') + '"><div class="muted">' + esc(m.fromName) + ' · ' + ago(m.at) + '</div>' + esc(m.text) + '</div>'; }).join('') || '<div class="muted">No messages yet.</div>') +
      '<div class="row" style="margin-top:8px"><input id="msg" placeholder="Message your computer" /><button class="primary" data-act="send-msg">Send</button></div></div>';
    out += '<h2>This phone</h2><div class="card"><div class="muted">Fingerprint</div><div class="mono">' + cfg.myId.slice(0, 16).toUpperCase().match(/.{4}/g).join(' ') + '</div><div class="muted" style="margin-top:6px">Computer ' + cfg.desktopId.slice(0, 16).toUpperCase().match(/.{4}/g).join(' ') + '</div><div style="margin-top:10px"><button class="danger" data-act="forget">Forget this computer</button></div></div>';
    return out;
  }
  // ------------------------------------------------------------------------- Essentials Home
  function dismissed() {
    try {
      return JSON.parse(localStorage.getItem(DISMISSED) || '[]');
    } catch (e) {
      return [];
    }
  }
  function viewEssentialsHome() {
    var h = state.home;
    var gone = dismissed();
    var notes = (h.notes || []).filter(function (n) { return gone.indexOf(n.id) < 0; });
    var out = '<div class="flapwrap" id="flapwrap"></div>';
    out += '<button class="primary wide" data-tab="ask">Ask ' + esc(h.agentName) + '</button>';
    out += '<h2>From FBRX</h2>';
    out += notes.map(function (n) {
      return '<div class="card note ' + esc(n.kind) + '">' +
        ((n.kind === 'tip' || n.kind === 'welcome') ? '<button class="x" data-dismiss="' + esc(n.id) + '" aria-label="Dismiss">×</button>' : '') +
        '<b>' + esc(n.title) + '</b><div class="muted">' + esc(n.body) + '</div>' +
        (n.action ? '<div class="note-act"><button' + (n.kind === 'upgrade' ? ' class="primary"' : '') + ' data-note="' + esc(n.action.to) + '">' + esc(n.action.label) + '</button></div>' : '') +
        '</div>';
    }).join('');
    return out;
  }
  function viewModels() {
    if (!state.perms.ask) return '<div class="card muted">This phone is not allowed to use the AI. Change it on the computer under Mesh &amp; phone.</div>';
    var m = state.models;
    if (!m) return '<h2>AI models</h2><div class="card muted">Loading…</div><span data-load="models"></span>';
    return '<h2>AI models on your computer</h2><div class="card">' + (m.installed.map(function (x) {
      var on = x.id === m.current;
      return '<div class="item row"><div class="spacer"><div>' + esc(x.name) + '</div><div class="muted">' + (x.sizeBytes / 1e9).toFixed(1) + ' GB' + (on ? ' · in use' : '') + '</div></div>' + (on ? '<span class="dot ok"></span>' : '<button data-use="' + esc(x.id) + '">Use</button>') + '</div>';
    }).join('') || '<div class="muted">No models yet.</div>') + '</div><p class="muted">A bigger model answers better, a smaller one is quicker. Get more on your computer, in AI models.</p>';
  }

  // The split-flap board: one board for the whole visit (render() rebuilds the page; the board moves along).
  var CHARSET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;-+%/#!?&@()';
  var COLS = 16;
  var LINES = 2;
  var board = null;
  function fitRows(rows) {
    var out = [];
    for (var r = 0; r < LINES; r++) {
      var t = String(rows[r] || '').toUpperCase().replace(/[^ A-Z0-9.,:;\-+%\/#!?&@()]/g, ' ').slice(0, COLS);
      var pad = Math.floor((COLS - t.length) / 2);
      out.push((new Array(pad + 1).join(' ') + t + new Array(COLS + 1).join(' ')).slice(0, COLS));
    }
    return out.join('');
  }
  function mountBoard() {
    var host = document.getElementById('flapwrap');
    if (!host) return;
    if (!board) {
      var el = document.createElement('div');
      el.className = 'flap';
      el.setAttribute('aria-live', 'polite');
      var cells = [];
      for (var i = 0; i < COLS * LINES; i++) {
        var c = document.createElement('span');
        c.textContent = ' ';
        el.appendChild(c);
        cells.push(c);
      }
      board = { el: el, cells: cells, shown: new Array(COLS * LINES + 1).join(' ').split(''), target: '', msg: 0, tick: null };
      showMessage();
      setInterval(function () { board.msg++; showMessage(); }, 6500);
    }
    host.appendChild(board.el);
  }
  function showMessage() {
    var msgs = (state.home && state.home.board) || [['FBRX', 'HOME']];
    board.target = fitRows(msgs[board.msg % msgs.length]);
    board.el.setAttribute('aria-label', board.target.replace(/\s+/g, ' ').trim());
    var start = Date.now();
    clearInterval(board.tick);
    board.tick = setInterval(function () {
      var busy = false;
      for (var i = 0; i < board.cells.length; i++) {
        var want = board.target[i];
        if (board.shown[i] === want) continue;
        busy = true;
        // Column by column, like the boards in a station.
        if (Date.now() - start < (i % COLS) * 35) continue;
        var k = CHARSET.indexOf(board.shown[i]);
        board.shown[i] = CHARSET[(k + 1) % CHARSET.length];
        board.cells[i].textContent = board.shown[i];
      }
      if (!busy) clearInterval(board.tick);
    }, 40);
  }

  function stat(label, value) {
    return '<div class="stat"><span class="muted">' + label + '</span><b>' + esc(value) + '</b></div>';
  }
  function viewAsk() {
    if (!state.perms.ask) return '<div class="card muted">This phone is not allowed to ask the agent. Change it on the computer under Mesh &amp; phone.</div>';
    var jobs = Object.keys(state.jobs).map(function (k) { return state.jobs[k]; }).reverse();
    return '<h2>Ask your agent</h2><div class="card"><textarea id="prompt" placeholder="For example: is my computer OK? What is on my task list today?"></textarea><div style="margin-top:8px"><button class="primary" data-act="ask">Send</button></div></div>' +
      jobs.map(function (j) {
        return '<div class="card"><div class="bubble me">' + esc(j.prompt || 'Request') + '</div><div class="muted">' + esc(j.status.replace('-', ' ')) + (j.tools && j.tools.length ? ' · used ' + esc(j.tools.join(', ')) : '') + '</div>' + (j.text ? '<div class="bubble">' + esc(j.text) + '</div>' : '') + (j.error ? '<div class="error">' + esc(j.error) + '</div>' : '') + '</div>';
      }).join('');
  }
  function viewApprovals() {
    if (!state.perms.approve) return '<div class="card muted">This phone is not allowed to approve actions.</div>';
    if (!state.approvals.length) return '<h2>Approvals</h2><div class="card muted">Nothing is waiting for you.</div>';
    return '<h2>Approvals</h2>' + state.approvals.map(function (a) {
      return '<div class="card"><b>' + esc(a.toolTitle) + '</b><div class="muted">' + esc(a.reason) + '</div><pre class="mono muted" style="white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto">' + esc(JSON.stringify(a.input, null, 2)).slice(0, 1500) + '</pre><div class="row"><button class="danger" data-deny="' + esc(a.id) + '">Deny</button><span class="spacer"></span><button class="primary" data-approve="' + esc(a.id) + '">Approve</button></div></div>';
    }).join('');
  }
  function viewTasks() {
    if (!state.perms.workspace) return '<div class="card muted">This phone is not allowed to see tasks.</div>';
    var open = state.tasks.filter(function (t) { return t.status !== 'done'; });
    return '<h2>Tasks</h2><div class="card"><div class="row"><input id="newtask" placeholder="Add a task" /><button class="primary" data-act="add-task">Add</button></div></div><div class="card">' +
      (open.map(function (t) { return '<div class="item row"><button class="check" data-done="' + esc(t.id) + '" aria-label="Done"></button><div class="spacer"><div>' + esc(t.title) + '</div><div class="muted">' + esc(t.priority) + (t.due ? ' · due ' + esc(t.due.slice(0, 10)) : '') + '</div></div></div>'; }).join('') || '<div class="muted">All clear.</div>') +
      '</div><span data-load="tasks"></span>';
  }
  function viewAlerts() {
    state.unread = 0;
    return '<h2>Alerts</h2><div class="card">' + (state.alerts.map(function (a) { return '<div class="item"><div class="row"><span class="sev ' + esc(a.severity) + '">' + esc(a.severity) + '</span><span class="muted">' + ago(a.createdAt) + '</span></div><b>' + esc(a.title) + '</b><div class="muted">' + esc(a.body) + '</div></div>'; }).join('') || '<div class="muted">No alerts.</div>') + '</div><span data-load="alerts"></span>';
  }

  // ---------------------------------------------------------------- FBRX account (store app)
  // Sign in to the FBRX account and buy Standard or Ultra through the App Store or Google Play. The account checks each
  // purchase with the store; every computer signed in to the same account turns the edition on by itself.
  var ACCOUNT_KEY = 'fbrx.mobile.account';
  var NAMES = (NATIVE && NATIVE.editions) || {};
  var account = { token: null, view: null, prices: {}, making: false, busy: false, error: null, note: null };
  try {
    account.token = localStorage.getItem(ACCOUNT_KEY);
  } catch (e) {
    /* private storage */
  }
  function setToken(t) {
    account.token = t;
    if (!t) account.view = null;
    try {
      if (t) localStorage.setItem(ACCOUNT_KEY, t);
      else localStorage.removeItem(ACCOUNT_KEY);
    } catch (e) {
      /* private storage */
    }
  }
  /** This phone, as its sign-ins say: signing in again from it takes the place of its last sign-in. */
  function phoneDevice() {
    var id = null;
    try {
      id = localStorage.getItem('fbrx.mobile.install');
      if (!id) localStorage.setItem('fbrx.mobile.install', (id = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(8)), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('')));
    } catch (e) {
      /* private storage */
    }
    var ios = NATIVE.platform === 'ios';
    return { name: ios ? 'iPhone or iPad app' : 'Android app', kind: 'phone', platform: ios ? 'iOS' : 'Android', appVersion: NATIVE.version || undefined, installId: id || undefined };
  }
  function accountCall(method, path, body) {
    return fetch(NATIVE.accountServer + path, {
      method: method,
      headers: Object.assign({}, account.token ? { authorization: 'Bearer ' + account.token } : {}, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        // Signed out elsewhere (or the account is gone): sign in again.
        if (r.status === 401 && method === 'GET') setToken(null);
        if (!r.ok) {
          var e = new Error((j.error && j.error.message) || 'Something went wrong (' + r.status + ')');
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }
  function editionProduct(id) {
    return NATIVE.products.filter(function (p) { return p.productId === id; })[0] || null;
  }
  /** The store's own price for this phone's country, once it has said; the price list's until then. */
  function priceOf(p) {
    return account.prices[p.productId] || p.price;
  }
  function loadPrices() {
    NATIVE.purchases.products({ ids: NATIVE.products.map(function (p) { return p.productId; }) }).then(function (r) {
      (r.products || []).forEach(function (p) { if (p.price) account.prices[p.id] = p.price; });
      if (state.tab === 'account') render();
    }, function () { /* the store is not reachable: the price list's prices */ });
  }

  /** Gives a store purchase to the FBRX account, which checks it with the store and turns the edition on. */
  function record(p) {
    var sent = p.store === 'apple'
      ? accountCall('POST', '/v1/billing/apple/transactions', { signedTransaction: p.signedTransaction })
      : accountCall('POST', '/v1/billing/google/purchases', { productId: p.productId, purchaseToken: p.purchaseToken });
    return sent.then(function (view) {
      account.view = view;
      return NATIVE.purchases.finish({ transactionId: p.transactionId || '' });
    }, function (e) {
      // Refused for good (bought in a test copy, or by another FBRX account): finished, so it does not come back.
      // Not reached, or signed out: kept, and sent again the next time the app opens.
      if (e.status === 400 || e.status === 403) NATIVE.purchases.finish({ transactionId: p.transactionId || '' });
      throw e;
    });
  }
  function thanks() {
    account.note = NAMES[account.view.tier] + ' is on for your FBRX account. Computers signed in to it turn it on within a few minutes.';
  }
  function busyWhile(promise) {
    account.busy = true;
    account.error = null;
    render();
    return promise
      .catch(function (e) { account.error = e.message; })
      .then(function () {
        account.busy = false;
        render();
      });
  }
  function buy(productId) {
    var a = account.view;
    var store = NATIVE.purchases;
    var started = NATIVE.platform === 'ios'
      ? store.buy({ productId: productId, appAccountToken: a.appAccountToken })
      : store.restore().then(function (r) {
          // Standard to Ultra on Google Play replaces the subscription this account already has there.
          var old = (r.purchases || []).filter(function (x) { return x.accountId === a.id && x.productId !== productId && editionProduct(x.productId); })[0];
          return store.buy({ productId: productId, accountId: a.id, oldPurchaseToken: old ? old.purchaseToken : '' });
        });
    return busyWhile(started.then(function (r) {
      if (r.state === 'canceled') return;
      if (r.state === 'pending') {
        account.note = 'The store is waiting on the payment (or on a parent’s approval). Your edition turns on as soon as it goes through.';
        return;
      }
      return record(r).then(thanks);
    }));
  }
  /** Restore purchases: the subscriptions this phone's store account has, given to the FBRX account again. */
  function restorePurchases() {
    return busyWhile(NATIVE.purchases.restore().then(function (r) {
      var list = (r.purchases || []).filter(function (x) { return !x.pending && editionProduct(x.productId); });
      if (!list.length) {
        account.note = 'No FBRX subscriptions were found in this store account.';
        return;
      }
      return list.reduce(function (done, x) { return done.then(function () { return record(x); }); }, Promise.resolve()).then(thanks);
    }));
  }

  function viewAccount() {
    var out = '<h2>FBRX account</h2>';
    if (!NATIVE.accountServer) return out + '<div class="card muted">FBRX accounts open soon. Until then, pair this phone with your FBRX computer and use it from here.</div>';
    if (account.note) out += '<div class="card note">' + esc(account.note) + '</div>';
    if (!account.token) {
      var m = account.making;
      return out + '<div class="card"><form id="signin" class="stack">' +
        '<b>' + (m ? 'Make your FBRX account' : 'Sign in') + '</b>' +
        (m ? '<input name="name" placeholder="Your name" autocomplete="name" required maxlength="120" />' : '') +
        '<input name="email" type="email" placeholder="Email" autocomplete="email" required />' +
        '<input name="password" type="password" placeholder="Password' + (m ? ' (at least 12 characters)' : '') + '" autocomplete="' + (m ? 'new-password' : 'current-password') + '" required minlength="' + (m ? 12 : 1) + '" />' +
        '<div class="row"><button class="primary" type="submit"' + (account.busy ? ' disabled' : '') + '>' + (m ? 'Make my account' : 'Sign in') + '</button><span class="spacer"></span><button type="button" data-acct="swap">' + (m ? 'I have an account' : 'Make an account') + '</button></div>' +
        (m ? '' : '<button type="button" data-acct="forgot">Forgot your password?</button>') +
        '<div class="error">' + esc(account.error || '') + '</div></form></div>' +
        '<p class="muted">One FBRX account for this phone and your computers: what you buy here turns on wherever you sign in.</p>';
    }
    var a = account.view;
    if (!a) {
      return out + (account.error
        ? '<div class="card"><div class="error">' + esc(account.error) + '</div><div class="note-act"><button data-load="account">Try again</button></div></div>'
        : '<div class="card muted">Loading…</div><span data-load="account"></span>');
    }
    var bought = a.entitlements.filter(function (e) { return e.valid; });
    var offers = NATIVE.products.filter(function (p) {
      return (p.tier === 'basic' && a.tier === 'essentials') || (p.tier === 'ultra' && (a.tier === 'essentials' || a.tier === 'basic'));
    });
    out += '<div class="card"><div class="row"><div class="spacer"><b>' + esc(a.name) + '</b><div class="muted">' + esc(a.email) + '</div></div><span class="ed">' + esc(NAMES[a.tier] || a.tier) + '</span></div>' +
      (bought.length ? '<div class="muted acct-list">' + bought.map(function (e) { return esc(NAMES[e.tier] || e.productId) + ' · ' + esc(NATIVE.sources[e.source] || e.source) + (e.periodEnd ? ', renews ' + esc(new Date(e.periodEnd).toLocaleDateString()) : ''); }).join('<br>') + '</div>' : '<div class="muted acct-list">Essentials is free. Standard and Ultra add more on your computers.</div>') +
      '</div>';
    if (offers.length) {
      out += '<h2>Editions</h2>' + offers.map(function (p) {
        return '<div class="card note upgrade"><b>' + esc(NAMES[p.tier]) + '</b><div class="muted">' + esc(p.summary) + '</div>' +
          '<ul class="muted perks">' + (p.points || []).map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' +
          '<div class="note-act"><button class="primary" data-buy="' + esc(p.productId) + '"' + (account.busy ? ' disabled' : '') + '>Get ' + esc(NAMES[p.tier]) + ', ' + esc(priceOf(p)) + ' a month</button></div>' +
          '<div class="muted fine">Renews every month until you cancel it in ' + (NATIVE.platform === 'ios' ? 'your Apple Account’s subscriptions' : 'Google Play’s subscriptions') + '.</div></div>';
      }).join('');
    }
    out += '<div class="error">' + esc(account.error || '') + '</div>';
    out += '<div class="card stack"><button data-acct="restore"' + (account.busy ? ' disabled' : '') + '>Restore purchases</button><button data-acct="manage">Manage subscription</button><button data-acct="signout">Sign out</button></div>';
    if (NATIVE.terms || NATIVE.privacy) {
      out += '<p class="muted center">' + [NATIVE.terms ? '<a href="' + esc(NATIVE.terms) + '" target="_blank" rel="noopener">Terms of use</a>' : '', NATIVE.privacy ? '<a href="' + esc(NATIVE.privacy) + '" target="_blank" rel="noopener">Privacy policy</a>' : ''].filter(Boolean).join(' · ') + '</p>';
    }
    out += '<div class="card"><b>Delete your FBRX account</b><div class="muted">Everything it holds goes. A subscription from the store keeps running until you cancel it there.</div><div class="note-act"><button class="danger" data-acct="delete">Delete my account</button></div></div>';
    return out;
  }
  function bindAccount() {
    if (!NATIVE) return;
    var form = document.getElementById('signin');
    if (form) {
      form.onsubmit = function (e) {
        e.preventDefault();
        var making = account.making;
        var body = { email: form.email.value.trim(), password: form.password.value, device: phoneDevice() };
        if (making) body.name = form.name.value.trim();
        busyWhile(accountCall('POST', making ? '/v1/accounts/signup' : '/v1/accounts/login', body).then(function (r) {
          setToken(r.token);
          account.view = r.account;
          account.note = null;
          sendWaiting();
        }));
      };
    }
    Array.prototype.forEach.call(app.querySelectorAll('[data-buy]'), function (b) {
      b.onclick = function () { buy(b.getAttribute('data-buy')); };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-acct]'), function (b) {
      var what = b.getAttribute('data-acct');
      b.onclick = function () {
        if (what === 'swap') {
          account.making = !account.making;
          account.error = null;
          render();
        } else if (what === 'forgot') {
          var email = form && form.email.value.trim();
          if (!email) {
            account.error = 'Type your email first.';
            return render();
          }
          busyWhile(accountCall('POST', '/v1/accounts/password/forgot', { email: email }).then(function () {
            account.note = 'If ' + email + ' has an FBRX account, a link to choose a new password is on its way. It opens in your browser.';
          }));
        } else if (what === 'restore') restorePurchases();
        else if (what === 'manage') {
          var mine = (account.view.entitlements || []).filter(function (e) { return e.valid && e.source === (NATIVE.platform === 'ios' ? 'apple' : 'google'); })[0];
          NATIVE.purchases.manage({ productId: mine ? mine.productId : '' }).catch(fail);
        } else if (what === 'signout') {
          accountCall('POST', '/v1/accounts/logout', {}).catch(function () {}).then(function () {
            setToken(null);
            account.note = null;
            render();
          });
        } else if (what === 'delete') {
          var pw = prompt('To delete your FBRX account, enter its password.');
          if (!pw) return;
          busyWhile(accountCall('DELETE', '/v1/accounts/me', { password: pw }).then(function (r) {
            setToken(null);
            account.note = 'Your FBRX account is deleted.' + (r.note ? ' ' + r.note : '');
          }));
        }
      };
    });
  }
  /**
   * Purchases the FBRX account has not recorded yet (the app closed, or the network dropped, right after buying): sent
   * now. On iPhone the store hands them over by itself (the "transaction" event); Google Play is asked.
   */
  function sendWaiting() {
    if (!NATIVE || !account.token || NATIVE.platform === 'ios') return;
    NATIVE.purchases.restore().then(function (r) {
      (r.purchases || []).filter(function (x) { return !x.pending && !x.acknowledged && editionProduct(x.productId); }).forEach(function (x) {
        record(x).then(render, function () {});
      });
    }, function () {});
  }
  if (NATIVE && NATIVE.accountServer) {
    // Purchases that finish later (a parent approved it, a payment went through) and renewals.
    NATIVE.purchases.addListener('transaction', function (p) {
      if (!account.token || p.pending || !editionProduct(p.productId)) return;
      record(p).then(render, function () {});
    });
    loadPrices();
    sendWaiting();
  }

  function bind() {
    bindAccount();
    Array.prototype.forEach.call(app.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { state.tab = b.getAttribute('data-tab'); render(); };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-load]'), function (el) {
      var what = el.getAttribute('data-load');
      if (el.tagName === 'BUTTON') el.onclick = function () { loadData(what, true); };
      else loadData(what, false);
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-approve],[data-deny]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-approve') || b.getAttribute('data-deny');
        b.disabled = true;
        rpc('approvals.resolve', { id: id, decision: b.hasAttribute('data-approve') ? 'approve' : 'deny' }).then(sync, fail);
      };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-dismiss]'), function (b) {
      b.onclick = function () {
        var gone = dismissed();
        gone.push(b.getAttribute('data-dismiss'));
        try { localStorage.setItem(DISMISSED, JSON.stringify(gone)); } catch (e) { /* private mode */ }
        render();
      };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-note]'), function (b) {
      b.onclick = function () {
        var to = b.getAttribute('data-note');
        if (to === 'agent') state.tab = 'ask';
        else if (to === 'models') state.tab = 'models';
        else if (to === 'edition' && NATIVE) state.tab = 'account';
        else if (to === 'edition') return banner('The editions', 'On your computer: Settings → Edition shows Standard and Ultra and what they add. Sign in to your FBRX account there to buy one.');
        render();
      };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-use]'), function (b) {
      b.onclick = function () {
        b.disabled = true;
        rpc('models.use', { id: b.getAttribute('data-use') }).then(function () { loadData('models', true); banner('Done', 'Your computer uses that model now.'); }, fail);
      };
    });
    Array.prototype.forEach.call(app.querySelectorAll('[data-done]'), function (b) {
      b.onclick = function () {
        var t = state.tasks.filter(function (x) { return x.id === b.getAttribute('data-done'); })[0];
        if (t) rpc('tasks.save', { id: t.id, title: t.title, status: 'done' }).then(function () { loadData('tasks', true); }, fail);
      };
    });
    var act = function (name, fn) { var el = app.querySelector('[data-act="' + name + '"]'); if (el) el.onclick = fn; };
    act('send-msg', function () {
      var el = document.getElementById('msg');
      var text = el.value.trim();
      if (!text) return;
      rpc('chat.send', { id: rid(), text: text }).then(function () {
        state.messages.push({ id: rid(), fromId: cfg.myId, fromName: 'This phone', text: text, at: new Date().toISOString() });
        render();
      }, fail);
    });
    act('ask', function () {
      var el = document.getElementById('prompt');
      var prompt = el.value.trim();
      if (!prompt) return;
      rpc('ask', { prompt: prompt }).then(function (job) {
        job.prompt = prompt;
        state.jobs[job.jobId] = job;
        render();
      }, fail);
    });
    act('add-task', function () {
      var el = document.getElementById('newtask');
      if (!el.value.trim()) return;
      rpc('tasks.save', { title: el.value.trim() }).then(function () { loadData('tasks', true); }, fail);
    });
    act('forget', function () {
      if (confirm('Forget this computer? You will need to pair again.')) {
        save(null);
        stopPolling();
        render();
      }
    });
  }
  var loaded = {};
  function loadData(what, force) {
    if (loaded[what] && !force) return;
    loaded[what] = true;
    if (what === 'status') rpc('status').then(function (s) { state.status = s; render(); }, fail);
    if (what === 'tasks') rpc('tasks.list').then(function (t) { state.tasks = t; render(); }, fail);
    if (what === 'alerts') rpc('alerts.list').then(function (a) { state.alerts = a; render(); }, function () {});
    if (what === 'models') rpc('models').then(function (m) { state.models = m; render(); }, fail);
    if (what === 'account') {
      account.error = null;
      accountCall('GET', '/v1/accounts/me').then(function (v) { account.view = v; render(); }, function (e) { account.error = account.token ? e.message : null; render(); });
    }
  }
  function fail(e) {
    banner('Something went wrong', e.message);
  }

  /** In the store app: scan the code the computer shows (its address and the code), or type them. */
  function renderPairNative() {
    app.innerHTML = '<div class="row brand"><div class="mark"></div><div class="spacer"><h1>FBRX</h1><div class="muted">Pair this phone with your FBRX computer</div></div><button class="small" data-tab="account">Account</button></div>' +
      '<div class="card"><p class="muted">On the computer open <b>Mesh &amp; phone → Add a device → Show a code on this computer</b>. Keep this phone on the same Wi-Fi.</p>' +
      '<button class="primary wide" id="scan">Scan the code</button>' +
      '<details class="typed"><summary>Type it instead</summary>' +
      '<input id="addr" placeholder="Address, for example 192.168.1.20" autocomplete="off" autocapitalize="off" inputmode="url" />' +
      '<input id="code" class="code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" />' +
      '<div class="note-act"><button class="primary" id="pairbtn">Pair</button></div></details>' +
      '<div class="error" id="err"></div></div>' +
      '<p class="muted">Requests are end-to-end encrypted with keys made on this phone, so nobody else on the network can read them.</p>';
    var err = document.getElementById('err');
    var done = function () {
      state.tab = 'home';
      render();
      startPolling();
    };
    var go = function (target, code) {
      if (!target) {
        err.textContent = 'Enter the address the computer shows under the code';
        return;
      }
      err.textContent = 'Pairing…';
      pair(code || target.code, target.fp, target.base).then(done, function (e) {
        err.textContent = /fetch|network|load failed/i.test(e.message) ? 'Could not reach ' + target.base.replace('http://', '') + '. Is the phone on the same Wi-Fi as the computer?' : e.message;
      });
    };
    document.getElementById('scan').onclick = function () {
      err.textContent = '';
      NATIVE.scan().then(function (text) {
        var t = parseTarget(text);
        if (!t || !t.code) throw new Error('That is not an FBRX pairing code');
        go(t);
      }).catch(function (e) {
        if (!/cancel/i.test(e.message || '')) err.textContent = e.message;
      });
    };
    document.getElementById('pairbtn').onclick = function () {
      go(parseTarget(document.getElementById('addr').value), document.getElementById('code').value);
    };
    app.querySelector('[data-tab="account"]').onclick = function () {
      state.tab = 'account';
      render();
    };
  }

  function renderPair() {
    if (NATIVE) return renderPairNative();
    var params = new URLSearchParams(location.hash.slice(1));
    var code = params.get('pair') || '';
    var fp = params.get('fp') || '';
    app.innerHTML = '<div class="row brand"><div class="mark"></div><div><h1>FBRX Mobile</h1><div class="muted">Pair this phone with your FBRX OS computer</div></div></div>' +
      '<div class="card"><p class="muted">On the computer open <b>Mesh &amp; phone → Pair a device</b>, then scan the QR code or type the code shown.</p>' +
      '<input id="code" class="code" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" value="' + esc(code) + '" autocomplete="off" autocapitalize="characters" />' +
      '<div style="margin-top:10px"><button class="primary" id="pairbtn">Pair</button></div><div class="error" id="err"></div></div>' +
      '<p class="muted">Pair only on a network you trust (your home or office Wi-Fi). Requests are end-to-end encrypted with keys created on this phone.</p>';
    var go = function () {
      var btn = document.getElementById('pairbtn');
      btn.disabled = true;
      pair(document.getElementById('code').value, fp).then(function () {
        history.replaceState(null, '', location.pathname);
        state.tab = 'home';
        render();
        startPolling();
      }, function (e) {
        btn.disabled = false;
        document.getElementById('err').textContent = e.message;
      });
    };
    document.getElementById('pairbtn').onclick = go;
    if (code && fp) go();
  }

  render();
  if (cfg) startPolling();
})();
