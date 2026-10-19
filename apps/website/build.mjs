/**
 * Builds the FBRX website into dist/: plain HTML, one stylesheet and two small scripts, with every price taken from
 * packages/shared/src/plans.ts (the same list the app, FBRX Command and billing use). Static: host it anywhere.
 *
 *   FBRX_ACCOUNT_SERVER=https://command.example.com npm run build -w apps/website
 *
 * FBRX_ACCOUNT_SERVER is the FBRX Command that FBRX accounts live on (its FBRX_CP_WEBSITE_ORIGINS must name this site);
 * without it the account page says accounts open soon.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_PLAN, EDITION_PLANS, ESSENTIALS_TIPS, PURCHASE_SOURCE_NAMES, STANDARD_TRIAL_DAYS, RELEASE_REPO, SERVER_OFFER, TENANT_DISCOUNT, TIERS, TIER_SHORT, VERTICAL_NAMES, editionPoints, formatPrice } from '@fbrx/shared';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const api = (process.env.FBRX_ACCOUNT_SERVER ?? '').replace(/\/+$/, '');
const REPO = `https://github.com/${RELEASE_REPO}`;
const DOWNLOAD = `${REPO}/releases/latest/download/FBRX-OS.zip`;
const off = `${Math.round(TENANT_DISCOUNT * 100)}%`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const logo = readFileSync(join(here, '..', '..', 'docs', 'assets', 'fbrx-logo-dark.svg'), 'utf8')
  .replace(/#ffffff/gi, 'currentColor')
  .replace(/width="96" height="96"/, 'width="30" height="30" aria-hidden="true"')
  .replace(/<title>FBRX<\/title>/, '');

/** A split-flap board drawn in CSS (no script): rows padded to the board's width. */
function board(rows, cols = 18) {
  const cells = rows.flatMap((r) => {
    const t = r.toUpperCase().slice(0, cols);
    const pad = Math.floor((cols - t.length) / 2);
    return (' '.repeat(pad) + t).padEnd(cols, ' ').split('');
  });
  return `<div class="flap" style="--cols:${cols}" role="img" aria-label="${esc(rows.join(' '))}">${cells.map((c, i) => `<span style="--i:${i % cols}">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')}</div>`;
}

function page({ file, title, description, body, scripts = [] }) {
  const connect = api ? ` ${new URL(api).origin}` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'${connect}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="top">
  <a class="brand" href="index.html">${logo}<span>FBRX</span></a>
  <nav>
    <a href="pricing.html"${file === 'pricing.html' ? ' aria-current="page"' : ''}>Pricing</a>
    <a href="index.html#command">For organizations</a>
    <a href="index.html#server">FBRX Server</a>
    <a href="account.html"${file === 'account.html' ? ' aria-current="page"' : ''}>Account</a>
    <a class="btn primary small" href="${DOWNLOAD}">Download</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <div class="foot-brand">${logo}<span>FBRX</span></div>
  <p>FBRX 2.0 is in beta: new versions arrive often, and the app updates itself.</p>
  <p><a href="pricing.html">Pricing</a> · <a href="account.html">Account</a> · <a href="${REPO}">Source and docs</a></p>
</footer>
${scripts.map((s) => `<script src="${s}"></script>`).join('\n')}
</body>
</html>
`;
  writeFileSync(join(out, file), html);
}

const editionCard = (t, cta) => {
  const p = EDITION_PLANS[t];
  const price =
    p.monthly === 0
      ? '<b>Free</b>'
      : p.monthly == null
        ? `<b>${formatPrice(p.tenantMonthly)}</b><small> a month per computer, with FBRX Command</small>`
        : `<b>${formatPrice(p.monthly)}</b><small> a month</small>`;
  return `<article class="plan ${t}">
  <h3>${TIER_SHORT[t]}</h3>
  <div class="price">${price}</div>
  <p>${esc(p.summary)}</p>
  <ul>${editionPoints(t).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
  ${cta}
</article>`;
};

/** What a computer of an edition costs a month in FBRX Command. */
const tenantRate = (t) => {
  const p = EDITION_PLANS[t];
  if (!p.tenantMonthly) return 'Free';
  return `${formatPrice(p.tenantMonthly)} <span class="muted">(${p.monthly == null ? 'an add-on, for the people who run it' : `${off} off`})</span>`;
};

const serverSection = `<section class="band server" id="server">
  <div class="wrap two">
    <div>
      <span class="eyebrow">Coming soon</span>
      <h2>FBRX Server</h2>
      <p class="lead">${esc(SERVER_OFFER.summary.replace(/ Coming soon\.$/, ''))}</p>
      <ul class="ticks">${SERVER_OFFER.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
    </div>
    <div class="card offer">
      <div class="price"><b>${formatPrice(SERVER_OFFER.price)}</b><small> once</small></div>
      <p>The installer stays on your FBRX account, or your organization’s FBRX Command, for good.</p>
      <p class="muted">Not on sale yet.</p>
    </div>
  </div>
</section>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------------------------------------ Home
page({
  file: 'index.html',
  title: 'FBRX: your own AI, on your computer',
  description: 'FBRX puts a private AI on your computer. Free to start, with editions that grow with you and FBRX Command for your organization.',
  body: `<section class="hero">
  <div class="wrap two">
    <div>
      <span class="eyebrow">FBRX 2.0 Beta</span>
      <h1>Your own AI, on your computer.</h1>
      <p class="lead">FBRX puts a private AI assistant right on your computer. Your chats stay there, and it asks before it uses the internet or changes anything. Free to start.</p>
      <div class="ctas">
        <a class="btn primary" href="${DOWNLOAD}">Download FBRX, free</a>
        <a class="btn" href="pricing.html">See pricing</a>
      </div>
      <p class="muted small">For Mac, Windows and Linux. The app sets up its AI by itself the first time it opens.</p>
    </div>
    <div class="hero-board">${board(['YOUR AI', 'ON YOUR COMPUTER'])}</div>
  </div>
</section>
<section class="wrap features">
  <div class="feature"><h3>Private by default</h3><p>The AI runs on your computer. Chats start offline, and nothing leaves without you saying so.</p></div>
  <div class="feature"><h3>Grows with you</h3><p>Essentials is the AI on its own, free, working as hard as you like. Standard adds the everyday tools and control over your AI, free to try for ${STANDARD_TRIAL_DAYS} days; Ultra the expert ones.</p></div>
  <div class="feature"><h3>One account, every device</h3><p>Buy once with your FBRX account and sign in on your computers and your phone: each one turns on what you have.</p></div>
</section>
<section class="wrap">
  <h2 class="center">Four editions</h2>
  <div class="plans compact">
    ${TIERS.map((t) => editionCard(t, '')).join('\n')}
  </div>
  <p class="center"><a class="btn" href="pricing.html">Compare the editions</a></p>
</section>
<section class="band" id="command">
  <div class="wrap two">
    <div>
      <span class="eyebrow">For organizations</span>
      <h2>FBRX Command</h2>
      <p class="lead">${esc(COMMAND_PLAN.summary)}</p>
      <ul class="ticks">${COMMAND_PLAN.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
      <p class="ctas"><a class="btn primary" href="account.html?start=organization">Start an FBRX Command</a></p>
    </div>
    <div class="card offer">
      <div class="price"><b>${formatPrice(COMMAND_PLAN.monthly)}</b><small> a month</small></div>
      <p>Plus each computer at its edition, ${off} off: Standard ${formatPrice(EDITION_PLANS.basic.tenantMonthly)}, Ultra ${formatPrice(EDITION_PLANS.ultra.tenantMonthly)}. Black Hole ${formatPrice(EDITION_PLANS.blackhole.tenantMonthly)} for your admins. Essentials computers free.</p>
    </div>
  </div>
</section>
${serverSection}`,
});

// ------------------------------------------------------------------------------------------------ Pricing
const prices = { basic: EDITION_PLANS.basic.tenantMonthly, ultra: EDITION_PLANS.ultra.tenantMonthly, blackhole: EDITION_PLANS.blackhole.tenantMonthly, command: COMMAND_PLAN.monthly };
page({
  file: 'pricing.html',
  title: 'FBRX pricing',
  description: `Essentials is free. Standard ${formatPrice(EDITION_PLANS.basic.monthly)} and Ultra ${formatPrice(EDITION_PLANS.ultra.monthly)} a month. FBRX Command ${formatPrice(COMMAND_PLAN.monthly)} a month for your organization.`,
  scripts: ['pricing.js'],
  body: `<section class="wrap">
  <h1 class="center">Pricing</h1>
  <p class="lead center">Start free. Pay monthly for more, and stop any time. Prices in US dollars.</p>
  <div class="plans">
    ${editionCard('essentials', `<a class="btn" href="${DOWNLOAD}">Download</a>`)}
    ${editionCard('basic', `<a class="btn primary" href="account.html?buy=${EDITION_PLANS.basic.productId}">Get Standard</a><p class="muted small">Or try it free for ${STANDARD_TRIAL_DAYS} days in FBRX, no card needed.</p>`)}
    ${editionCard('ultra', `<a class="btn primary" href="account.html?buy=${EDITION_PLANS.ultra.productId}">Get Ultra</a>`)}
    ${editionCard('blackhole', `<a class="btn" href="account.html?start=organization">Start an FBRX Command</a>`)}
  </div>
</section>
<section class="band" id="command">
  <div class="wrap two">
    <div>
      <span class="eyebrow">For organizations</span>
      <h2>FBRX Command, ${formatPrice(COMMAND_PLAN.monthly)} a month</h2>
      <p class="lead">${esc(COMMAND_PLAN.summary)} You give each computer, or each person, an edition; the bill follows by itself.</p>
      <table class="rates">
        <thead><tr><th>Each computer</th><th>A month</th></tr></thead>
        <tbody>
          ${TIERS.map((t) => `<tr><td>${TIER_SHORT[t]}</td><td>${tenantRate(t)}</td></tr>`).join('\n          ')}
        </tbody>
      </table>
      <p class="muted small">Student and child computers count as Standard.</p>
    </div>
    <form class="card calc" id="calc" data-prices='${JSON.stringify(prices)}' aria-label="What a month comes to">
      <h3>What a month comes to</h3>
      ${[['basic', 10], ['ultra', 2], ['blackhole', 1], ['essentials', 20]].map(([t, n]) => `<label>${TIER_SHORT[t]} computers <input type="number" min="0" value="${n}" name="${t}"></label>`).join('\n      ')}
      <div class="total"><span>A month</span><b id="total">—</b></div>
      <p class="muted small">The FBRX Command plan included. Changes in the month are prorated.</p>
    </form>
  </div>
</section>
${serverSection}
<section class="wrap faq">
  <h2>Questions</h2>
  <details><summary>Is Essentials really free?</summary><p>Yes, on as many computers as you like, and in an organization too. It is your AI on its own: the chat, its memory and voice, and the AI models.</p></details>
  <details><summary>Where does my AI run?</summary><p>On your computer. ${esc(ESSENTIALS_TIPS.find((t) => t.id === 'tip-offline')?.body.replace('{agent}', 'It') ?? '')}</p></details>
  <details><summary>Can I switch editions?</summary><p>Any time, in Settings → Edition. Nothing you saved goes away when you switch down.</p></details>
  <details><summary>Can I try Standard first?</summary><p>Yes: every computer can try Standard free for ${STANDARD_TRIAL_DAYS} days, once, from Settings → Edition in FBRX. No card needed; when it ends, the computer goes back to Essentials unless you buy Standard. Standard used to be free, so a computer that ran FBRX before 2.0 starts its trial by itself when it updates.</p></details>
  <details><summary>How do I pay?</summary><p>On this site and in FBRX on your computer: by card, or with the wallet on your phone or computer when checkout offers it. In the phone apps, through the app store, once they leave beta. It all goes to one FBRX account, so what you buy anywhere works everywhere you sign in.</p></details>
  <details><summary>What does beta mean?</summary><p>FBRX 2.0 is finished enough to use every day, and still changing quickly: new versions arrive often and install by themselves. Tell us what breaks, right from the app. Prices are the ones above.</p></details>
  <details><summary>What is Black Hole?</summary><p>${esc(EDITION_PLANS.blackhole.summary)} It is an add-on in FBRX Command, ${formatPrice(EDITION_PLANS.blackhole.tenantMonthly)} a month per computer, and comes on wherever its person signs in.</p></details>
</section>`,
});

// ------------------------------------------------------------------------------------------------ Account
page({
  file: 'account.html',
  title: 'Your FBRX account',
  description: 'Sign in to your FBRX account: your edition, your purchases, your organizations.',
  scripts: ['config.js', 'account.js'],
  body: `<section class="wrap narrow">
  <h1>Your FBRX account</h1>
  <div id="account" class="account" aria-live="polite"><p class="muted">Loading…</p></div>
</section>`,
});

// What account.js needs from the price list and the shared names.
const site = {
  accountServer: api,
  editions: TIER_SHORT,
  kinds: VERTICAL_NAMES,
  sources: PURCHASE_SOURCE_NAMES,
  plans: Object.fromEntries(['basic', 'ultra'].map((t) => [t, { productId: EDITION_PLANS[t].productId, price: formatPrice(EDITION_PLANS[t].monthly) }])),
};
writeFileSync(join(out, 'config.js'), `window.FBRX_SITE = ${JSON.stringify(site)};\n`);
for (const f of ['styles.css', 'account.js', 'pricing.js']) copyFileSync(join(here, 'src', f), join(out, f));
writeFileSync(join(out, 'favicon.svg'), readFileSync(join(here, '..', '..', 'docs', 'assets', 'fbrx-logo-light.svg'), 'utf8'));
console.log(`Built the FBRX website in ${out}${api ? ` (accounts on ${api})` : ' (accounts open soon: no FBRX_ACCOUNT_SERVER)'}`);
