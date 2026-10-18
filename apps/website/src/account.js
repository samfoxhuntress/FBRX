// The account page: sign in or make an account, see what it has, buy Standard or Ultra (Stripe Checkout), manage
// billing, start an FBRX Command, delete the account. Talks to the FBRX Command accounts live on (config.js).
(function () {
  'use strict';
  // config.js: the account server, and the names and prices from the price list (build.mjs).
  var SITE = window.FBRX_SITE || {};
  var API = SITE.accountServer || '';
  var PLANS = SITE.plans || {};
  var NAMES = SITE.editions || {};
  var KEY = 'fbrx.account.token';
  var root = document.getElementById('account');
  var params = new URLSearchParams(location.search);
  var mode = 'signin';
  var notice = params.get('checkout') === 'done' ? 'Thank you! Your computers turn on what you bought by themselves within a few minutes (or press Check now in Settings → FBRX account).' : params.get('checkout') === 'canceled' ? 'Checkout was canceled: nothing was charged.' : '';

  function token(v) {
    try {
      if (v === undefined) return localStorage.getItem(KEY);
      if (v === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch (e) {
      return null;
    }
    return v;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function call(method, path, body) {
    var t = token();
    return fetch(API + path, {
      method: method,
      headers: Object.assign({}, t ? { authorization: 'Bearer ' + t } : {}, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && t) token(null);
        if (!r.ok) throw new Error((j.error && j.error.message) || 'Something went wrong (' + r.status + ')');
        return j;
      });
    });
  }
  function busy(btn, on) {
    if (btn) btn.disabled = on;
  }
  function fail(e) {
    var el = document.getElementById('err');
    if (el) el.textContent = e.message;
    else alert(e.message);
  }

  function renderSignIn(err) {
    var making = mode === 'signup';
    root.innerHTML =
      (notice ? '<p class="note">' + esc(notice) + '</p>' : '') +
      '<div class="card"><form id="f">' +
      '<h2>' + (making ? 'Make your FBRX account' : 'Sign in') + '</h2>' +
      (making ? '<label>Your name<input name="name" autocomplete="name" required maxlength="120"></label>' : '') +
      '<label>Email<input name="email" type="email" autocomplete="email" required></label>' +
      '<label>Password' + (making ? ' <span class="muted small">(at least 12 characters)</span>' : '') + '<input name="password" type="password" autocomplete="' + (making ? 'new-password' : 'current-password') + '" required minlength="' + (making ? 12 : 1) + '"></label>' +
      '<div class="row"><button class="btn primary" type="submit">' + (making ? 'Make my account' : 'Sign in') + '</button>' +
      '<button class="btn" type="button" id="swap">' + (making ? 'I have an account' : 'Make an account') + '</button></div>' +
      '<p class="error" id="err">' + esc(err || '') + '</p></form></div>' +
      '<p class="muted small">One FBRX account for your computers and your phone: sign in on each, and it turns on what you have.</p>';
    document.getElementById('swap').onclick = function () {
      mode = making ? 'signin' : 'signup';
      renderSignIn();
    };
    document.getElementById('f').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target;
      var btn = f.querySelector('button[type=submit]');
      busy(btn, true);
      var body = { email: f.email.value.trim(), password: f.password.value, device: 'website' };
      if (making) body.name = f.name.value.trim();
      call('POST', making ? '/v1/accounts/signup' : '/v1/accounts/login', body)
        .then(function (r) {
          token(r.token);
          return show();
        })
        .catch(function (x) {
          busy(btn, false);
          fail(x);
        });
    };
  }

  function buyButtons(a) {
    var out = '';
    if (a.tier === 'essentials') out += '<button class="btn primary" data-buy="' + esc(PLANS.basic.productId) + '">Get ' + esc(NAMES.basic) + ', ' + esc(PLANS.basic.price) + ' a month</button>';
    if (a.tier !== 'ultra') out += '<button class="btn primary" data-buy="' + esc(PLANS.ultra.productId) + '">Get ' + esc(NAMES.ultra) + ', ' + esc(PLANS.ultra.price) + ' a month</button>';
    return out;
  }

  function renderAccount(a) {
    var bought = a.entitlements.filter(function (e) { return e.valid; });
    root.innerHTML =
      (notice ? '<p class="note">' + esc(notice) + '</p>' : '') +
      '<div class="card"><div class="row"><div style="flex:1"><h2 style="margin:0">' + esc(a.name) + '</h2><div class="muted">' + esc(a.email) + '</div></div><button class="btn small" id="out">Sign out</button></div>' +
      '<p>Your edition: <span class="badge">' + esc(NAMES[a.tier] || a.tier) + '</span>' + (a.tier === 'essentials' ? ' <span class="muted">(free; nothing bought yet)</span>' : '') + '</p>' +
      (bought.length ? '<p class="muted small">' + bought.map(function (e) { return esc(NAMES[e.tier] || e.productId) + ' · ' + esc(SITE.sources[e.source] || e.source) + (e.periodEnd ? ', renews ' + esc(new Date(e.periodEnd).toLocaleDateString()) : ''); }).join('<br>') + '</p>' : '') +
      '<div class="row">' + buyButtons(a) + (a.billingPortal ? '<button class="btn" id="portal">Manage billing</button>' : '') + '</div>' +
      '<p class="error" id="err"></p></div>' +
      '<div class="card"><h3>Your organizations</h3>' +
      (a.memberships.length
        ? '<p>' + a.memberships.map(function (m) { return esc(m.tenantName) + ' <span class="badge">' + esc(NAMES[m.tier] || m.tier) + '</span>'; }).join('<br>') + '</p><p class="muted small">Sign in on a computer (Settings → FBRX account) and join it to one of these: it runs the edition your organization gives you.</p>'
        : '<p class="muted">Run FBRX for your company, school or family: FBRX Command looks after its computers, people and billing.</p>') +
      '<form id="org" class="row"' + (params.get('start') === 'organization' ? '' : ' hidden') + '><input name="name" placeholder="Organization name" required maxlength="120"><select name="kind" aria-label="Kind">' + Object.keys(SITE.kinds).map(function (k) { return '<option value="' + esc(k) + '">' + esc(SITE.kinds[k]) + '</option>'; }).join('') + '</select><button class="btn primary" type="submit">Start my FBRX Command</button></form>' +
      (params.get('start') === 'organization' ? '' : '<button class="btn" id="startorg">Start an FBRX Command</button>') +
      '</div>' +
      '<div class="card"><h3>Delete your account</h3><p class="muted small">Subscriptions bought here end with it. One bought in an app store is ended in that store’s subscription settings.</p><button class="btn danger" id="del">Delete my account</button></div>';

    document.getElementById('out').onclick = function () {
      call('POST', '/v1/accounts/logout', {}).catch(function () {}).then(function () {
        token(null);
        renderSignIn();
      });
    };
    Array.prototype.forEach.call(root.querySelectorAll('[data-buy]'), function (b) {
      b.onclick = function () { checkout(b.getAttribute('data-buy'), b); };
    });
    var portal = document.getElementById('portal');
    if (portal) portal.onclick = function () {
      busy(portal, true);
      call('POST', '/v1/billing/portal', {}).then(function (r) { location.href = r.url; }, function (e) { busy(portal, false); fail(e); });
    };
    var start = document.getElementById('startorg');
    if (start) start.onclick = function () {
      document.getElementById('org').hidden = false;
      start.remove();
    };
    document.getElementById('org').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target;
      call('POST', '/v1/accounts/tenants', { name: f.name.value.trim(), kind: f.kind.value }).then(function (r) {
        root.insertAdjacentHTML('afterbegin', '<p class="note">Your FBRX Command is ready. Sign in to its console at <a href="' + esc(r.consoleUrl) + '">' + esc(r.consoleUrl) + '</a> with this account’s email and password.</p>');
        return show(true);
      }, fail);
    };
    document.getElementById('del').onclick = function () {
      var pw = prompt('To delete your FBRX account, enter its password.');
      if (!pw) return;
      call('DELETE', '/v1/accounts/me', { password: pw }).then(function (r) {
        token(null);
        notice = 'Your account is deleted.' + (r.note ? ' ' + r.note : '');
        renderSignIn();
      }, fail);
    };
  }

  function checkout(productId, btn) {
    busy(btn, true);
    return call('POST', '/v1/billing/checkout', { productId: productId }).then(function (r) { location.href = r.url; }, function (e) { busy(btn, false); fail(e); });
  }

  function show(keepNotice) {
    if (!keepNotice) notice = notice || '';
    return call('GET', '/v1/accounts/me').then(function (a) {
      renderAccount(a);
      // Came from Pricing with a plan picked: straight to its checkout.
      var buy = params.get('buy');
      if (buy && !notice) {
        params.delete('buy');
        history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
        checkout(buy, null);
      }
    });
  }

  if (!API) {
    root.innerHTML = '<div class="card"><h2>FBRX accounts open soon</h2><p class="muted">Until then FBRX Essentials is free to download, and organizations can run FBRX Command on a computer of their own.</p></div>';
    return;
  }
  if (params.get('start') === 'organization' || params.get('buy')) mode = 'signup';
  if (token()) show().catch(function () { renderSignIn(); });
  else renderSignIn();
})();
