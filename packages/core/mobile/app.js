/*
 * FBRX Mobile: a small web app served by your FBRX OS computer to phones you pair with it.
 * Every request is sealed with NaCl box (this phone's secret key + the computer's public key) and carries a fresh
 * id and timestamp, so it cannot be read, forged or replayed on the network. Pairing proves both sides know the
 * one-time code (HMAC-SHA512 over both public keys) before keys are trusted.
 */
(function () {
  'use strict';
  var nacl = window.nacl;
  var STORE = 'fbrx.mobile.v1';
  var ALPHA = /[^0-9A-HJKMNP-TV-Z]/g;
  var app = document.getElementById('app');
  var state = { tab: 'home', status: null, approvals: [], jobs: {}, alerts: [], messages: [], tasks: [], online: false, unread: 0, error: null, perms: {} };
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
  function rpc(method, params) {
    var req = { id: rid(), ts: Date.now(), method: method, params: params || {} };
    var nonce = nacl.randomBytes(24);
    var box = nacl.box(utf8(JSON.stringify(req)), nonce, unb64(cfg.desktopPk), unb64(cfg.sk));
    return fetch('/mesh/rpc', {
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

  function pair(codeRaw, expectFp) {
    var code = normalizeCode(codeRaw);
    if (code.replace(ALPHA, '').length !== 20) return Promise.reject(new Error('Enter the 20-character code shown on your computer'));
    return fetch('/mesh/hello')
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
          version: 'web',
          mac: hmac(code, 'fbrx-pair-v1|' + pk + '|' + hello.publicKey),
        };
        return fetch('/mesh/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            var myId = fingerprint(pk);
            if (res.deviceId !== myId || res.mac !== hmac(code, 'fbrx-pair-v1-ack|' + hello.publicKey + '|' + pk + '|' + myId)) {
              throw new Error('The computer could not prove it knows the code; pairing stopped');
            }
            save({ sk: b64(kp.secretKey), pk: pk, myId: myId, desktopPk: hello.publicKey, desktopId: hello.id, desktopName: res.name, pairedAt: new Date().toISOString() });
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
    if (!cfg) return renderPair();
    var t = state.tab;
    var html = '<div class="row brand"><div class="mark"></div><div><h1>' + esc(cfg.desktopName) + '</h1><div class="muted"><span class="dot ' + (state.online ? 'ok' : 'bad') + '"></span> ' + (state.online ? 'Connected' : 'Not reachable') + (state.error && !state.online ? ' · ' + esc(state.error) : '') + '</div></div></div>';
    if (t === 'home') html += viewHome();
    if (t === 'ask') html += viewAsk();
    if (t === 'approvals') html += viewApprovals();
    if (t === 'tasks') html += viewTasks();
    if (t === 'alerts') html += viewAlerts();
    html += tabs();
    app.innerHTML = html;
    bind();
  }
  function tabs() {
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

  function bind() {
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
  }
  function fail(e) {
    banner('Something went wrong', e.message);
  }

  function renderPair() {
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
