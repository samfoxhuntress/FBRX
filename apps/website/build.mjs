/**
 * Builds the FBRX website into dist/: plain HTML, one stylesheet and a few small scripts, with every price taken from
 * packages/shared/src/plans.ts (the same list the app, FBRX Command and billing use) and every download from
 * release.json (the versions FBRX installs are offered). Static: host it anywhere.
 *
 *   FBRX_ACCOUNT_SERVER=https://account.example.com npm run build -w @fbrx/website
 *
 * FBRX_ACCOUNT_SERVER is the FBRX Command that FBRX accounts live on (its FBRX_CP_WEBSITE_ORIGINS must name this site);
 * without it the account page says accounts open soon. Optional:
 *   FBRX_SITE_URL           the site's own address (https://example.com): canonical links, the sitemap, link previews
 *   FBRX_SUPPORT_EMAIL      where people write for help (otherwise the support page points at the repository's issues)
 *   FBRX_STATUS_URL         a status page, linked from the footer and the support page
 *   FBRX_INSTALLERS_SIGNED  1 once the installers are code-signed: the notes about opening an unsigned app go away
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_PLAN, DEFAULT_PRICE_BOOK, EDITION_PLANS, ESSENTIALS_TIPS, PURCHASE_SOURCE_NAMES, STANDARD_TRIAL_DAYS, RELEASE_REPO, SERVER_OFFER, TENANT_DISCOUNT, TIERS, TIER_SHORT, VERTICAL_NAMES, editionPoints, formatPrice, personalPlan } from '@fbrx/shared';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'dist');
const env = (name) => (process.env[name] ?? '').trim();
const api = env('FBRX_ACCOUNT_SERVER').replace(/\/+$/, '');
const siteUrl = env('FBRX_SITE_URL').replace(/\/+$/, '');
const supportEmail = env('FBRX_SUPPORT_EMAIL');
const statusUrl = env('FBRX_STATUS_URL');
const signed = env('FBRX_INSTALLERS_SIGNED') === '1';
const REPO = `https://github.com/${RELEASE_REPO}`;
const off = `${Math.round(TENANT_DISCOUNT * 100)}%`;

// What is released, as installed copies see it: the downloads are always the ones FBRX itself offers.
const release = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'));
const V = release.version;
const BETA = `FBRX ${V.split('.').slice(0, 2).join('.')} ${release.stage ?? 'Beta'}`;
const asset = (tag, name) => `${REPO}/releases/download/${tag}/${name}`;
const os = {
  windows: asset(`v${V}`, `FBRX-OS-Setup-${V}.exe`),
  macArm: asset(`v${V}`, `FBRX-OS-${V}-arm64.dmg`),
  macIntel: asset(`v${V}`, `FBRX-OS-${V}-x64.dmg`),
  appImage: asset(`v${V}`, `FBRX-OS-${V}-x86_64.AppImage`),
  deb: asset(`v${V}`, `FBRX-OS-${V}-amd64.deb`),
};
const digger = release.digger
  ? (() => {
      const d = release.digger.version;
      const tag = `digger-v${d}`;
      return { version: d, page: release.digger.page, windows: asset(tag, `FBRX-Digger-Setup-${d}.exe`), macArm: asset(tag, `FBRX-Digger-${d}-arm64.dmg`), macIntel: asset(tag, `FBRX-Digger-${d}-x64.dmg`), appImage: asset(tag, `FBRX-Digger-${d}-x86_64.AppImage`), deb: asset(tag, `FBRX-Digger-${d}-amd64.deb`) };
    })()
  : null;
const server = release.server ? { version: release.server.version, iso: release.server.bundle.replace(/[^/]+$/, `fbrx-server-${release.server.version}-amd64.iso`), bundle: release.server.bundle, page: release.server.page } : null;
// Your own copy, built on your computer with your own keys (the self-host page).
const SELF_HOST_ZIP = `${REPO}/releases/latest/download/FBRX-OS.zip`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** FBRX's maker, Fox Huntress Labs: its wordmark as a mask, drawn in the footer's text color. */
const labs = JSON.parse(readFileSync(join(root, 'packages', 'ui', 'src', 'fhl-wordmark.json'), 'utf8'));
const labsMark = `<span class="labs-mark" role="img" aria-label="Fox Huntress Labs" style="aspect-ratio:${labs.width}/${labs.height};-webkit-mask-image:url(${labs.mask});mask-image:url(${labs.mask})"></span>`;
const logo = readFileSync(join(root, 'docs', 'assets', 'fbrx-logo-dark.svg'), 'utf8')
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

/** The pages, for the header, the footer and the sitemap. */
const NAV = [
  ['endpoint.html', 'FBRX Endpoint'],
  ['digger.html', 'Digger'],
  ['server.html', 'Server'],
  ['command.html', 'For organizations'],
  ['pricing.html', 'Pricing'],
];
const built = [];

function page({ file, title, description, body, scripts = [] }) {
  const connect = api ? ` ${new URL(api).origin}` : '';
  const canonical = siteUrl ? `${siteUrl}/${file === 'index.html' ? '' : file}` : '';
  const current = (f) => (file === f ? ' aria-current="page"' : '');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'${connect}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n<meta property="og:url" content="${esc(canonical)}">\n` : ''}<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="top">
  <a class="brand" href="index.html">${logo}<span>FBRX</span></a>
  <nav>
    ${NAV.map(([f, label]) => `<a href="${f}"${current(f)}${f === 'pricing.html' ? '' : ' class="more"'}>${label}</a>`).join('\n    ')}
    <a href="account.html"${current('account.html')}>Account</a>
    <a class="btn primary small" href="download.html"${current('download.html')}>Download</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <div class="foot-cols">
    <div><div class="foot-brand">${logo}<span>FBRX</span></div><p>${esc(BETA)}: new versions arrive often, and the app updates itself.</p></div>
    <div><h4>Products</h4>${NAV.slice(0, 4).map(([f, label]) => `<a href="${f}">${label}</a>`).join('')}</div>
    <div><h4>Get FBRX</h4><a href="download.html">Download</a><a href="pricing.html">Pricing</a><a href="account.html">Your account</a><a href="self-host.html">Self-host FBRX</a></div>
    <div><h4>Help</h4><a href="support.html">Support</a>${statusUrl ? `<a href="${esc(statusUrl)}">Status</a>` : ''}<a href="terms.html">Terms</a><a href="privacy.html">Privacy</a><a href="${REPO}">Source and docs</a></div>
  </div>
  <div class="foot-maker"><span>FBRX is made by</span>${labsMark}</div>
</footer>
${scripts.map((s) => `<script src="${s}"></script>`).join('\n')}
</body>
</html>
`;
  writeFileSync(join(out, file), html);
  built.push(file);
}

/** The price list the site shows: where FBRX Command's price list starts (plans.ts). */
const book = DEFAULT_PRICE_BOOK;
/** "2 months free", for paying yearly. */
const yearlySaving = `${12 - book.yearlyMonths} ${12 - book.yearlyMonths === 1 ? 'month' : 'months'} free`;

const editionCard = (t, cta) => {
  const p = EDITION_PLANS[t];
  const price =
    p.monthly === 0
      ? '<b>Free</b>'
      : p.monthly == null
        ? `<b>${formatPrice(p.tenantMonthly)}</b><small> a month a person, with FBRX Command</small>`
        : `<b>${formatPrice(p.monthly)}</b><small> a month</small>`;
  const yearly = p.sold === 'personal' ? `<p class="muted small">or ${formatPrice(personalPlan(book, t, 'year').amount)} a year (${yearlySaving})</p>` : '';
  return `<article class="plan ${t}">
  <h3>${TIER_SHORT[t]}</h3>
  <div class="price">${price}</div>${yearly}
  <p>${esc(p.summary)}</p>
  <ul>${editionPoints(t).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
  ${cta}
</article>`;
};

/** What a person at an edition costs a month in FBRX Command, and the computers it covers. */
const tenantRate = (t) => {
  const p = EDITION_PLANS[t];
  if (!p.tenantMonthly) return 'Free';
  return `${formatPrice(p.tenantMonthly)} <span class="muted">(${p.monthly == null ? 'an add-on, for the people who run it' : `${off} off`}; ${book.computers.included[t]} computers, then ${formatPrice(book.computers.extra[t])} each)</span>`;
};

/** A grid of what something does: [title, text] pairs. */
const features = (list) => `<div class="features">${list.map(([h, p]) => `<div class="feature"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('')}</div>`;

/** A product page's opening: what it is, in a sentence or two, and what to do next. */
const hero = ({ eyebrow, title, lead, ctas, aside = '' }) => `<section class="hero">
  <div class="wrap${aside ? ' two' : ''}">
    <div>
      <span class="eyebrow">${esc(eyebrow)}</span>
      <h1>${esc(title)}</h1>
      <p class="lead">${esc(lead)}</p>
      <div class="ctas">${ctas}</div>
    </div>
    ${aside}
  </div>
</section>`;

const serverSection = `<section class="band server" id="server">
  <div class="wrap two">
    <div>
      <span class="eyebrow">Beta</span>
      <h2>FBRX Server</h2>
      <p class="lead">${esc(SERVER_OFFER.summary.replace(/ Coming soon\.$/, ''))}</p>
      <ul class="ticks">${SERVER_OFFER.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
      <p class="ctas"><a class="btn" href="server.html">About FBRX Server</a></p>
    </div>
    <div class="card offer">
      <div class="price"><b>Free</b><small> while in beta</small></div>
      <p>Install it on your own hardware: a spare PC, a mini PC or a rack server.</p>
    </div>
  </div>
</section>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------------------------------------ Home
page({
  file: 'index.html',
  title: 'FBRX: your own AI, on your computer',
  description: 'FBRX puts a private AI on your computer that looks after it with you. Free to start, with editions that grow with you and FBRX Command for your organization.',
  body: `<section class="hero">
  <div class="wrap two">
    <div>
      <span class="eyebrow">${esc(BETA)}</span>
      <h1>Your own AI, <span class="glow">on your computer.</span></h1>
      <p class="lead">FBRX puts a private AI assistant right on your computer, and it does real work with you: your network, your storage, your security. Your chats stay there, and it asks before it uses the internet or changes anything. Free to start.</p>
      <div class="ctas">
        <a class="btn primary" href="download.html">Download FBRX, free</a>
        <a class="btn" href="pricing.html">See pricing</a>
      </div>
      <p class="muted small">For Mac, Windows and Linux. The app sets up its AI by itself the first time it opens.</p>
    </div>
    <div class="hero-board">${board(['YOUR AI', 'ON YOUR COMPUTER'])}</div>
  </div>
</section>
<section class="wrap">
  ${features([
    ['Private by default', 'The AI runs on your computer. Chats start offline, and nothing leaves without you saying so.'],
    ['It does the work', 'Slow Wi-Fi, a full disk, a slow computer, a security check-up: it knows the steps, shows its plan and checks its work.'],
    ['One account, every device', 'Buy once with your FBRX account and sign in on your computers and your phone: each one turns on what you have.'],
  ])}
</section>
<section class="wrap">
  <h2 class="center">The FBRX lineup</h2>
  <div class="lineup">
    <a class="card" href="endpoint.html"><h3>FBRX Endpoint</h3><p>FBRX OS on the computer you have: your AI and its tools, free to start.</p></a>
    <a class="card" href="digger.html"><h3>FBRX Digger</h3><p>Every network tool FBRX has, as a small free app of its own.</p></a>
    <a class="card" href="server.html"><h3>FBRX Server</h3><p>Your own server: virtual machines, backups that prove they work, a big AI.</p></a>
    <a class="card" href="command.html"><h3>FBRX Command</h3><p>Your organization’s computers, people and licenses in one place.</p></a>
  </div>
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
      <p class="ctas"><a class="btn primary" href="account.html?start=organization">Start an FBRX Command</a><a class="btn" href="command.html">How it works</a></p>
    </div>
    <div class="card offer">
      <div class="price"><b>${formatPrice(COMMAND_PLAN.monthly)}</b><small> a month</small></div>
      <p>Plus each person at their edition, ${off} off: Pro ${formatPrice(EDITION_PLANS.basic.tenantMonthly)} (${book.computers.included.basic} computers), Ultra ${formatPrice(EDITION_PLANS.ultra.tenantMonthly)} (${book.computers.included.ultra}). Black Hole Edition ${formatPrice(EDITION_PLANS.blackhole.tenantMonthly)} for your admins. Essentials free. Monthly or yearly.</p>
    </div>
  </div>
</section>
${serverSection}`,
});

// ------------------------------------------------------------------------------------------------ Download
/** The note for a computer's first look at a downloaded app, while the installers are not code-signed yet. */
const firstOpen = (text) => (signed ? '' : `<details><summary>The first time it opens</summary><p>${text}</p></details>`);
page({
  file: 'download.html',
  title: 'Download FBRX',
  description: `Download FBRX ${V} for Windows, Mac or Linux: your own AI, free to start.`,
  scripts: ['download.js'],
  body: `<section class="hero">
  <div class="wrap">
    <span class="eyebrow">${esc(BETA)} · version ${esc(V)}</span>
    <h1>Download FBRX</h1>
    <p class="lead">Free to start. Install it, and it sets up its own AI the first time it opens, then signs in to your FBRX account when you want what you bought on every computer.</p>
    <div class="ctas" id="for-you" hidden><a class="btn primary" id="for-you-link" href="#"></a></div>
  </div>
</section>
<section class="wrap">
  <div class="downloads">
    <article class="card os" data-os="windows">
      <h3>Windows</h3>
      <p class="muted">Windows 10 and 11, on Intel, AMD and Arm.</p>
      <a class="btn primary" href="${os.windows}" data-label="Download for Windows">Download for Windows</a>
      <p class="muted small">FBRX-OS-Setup-${esc(V)}.exe</p>
      ${firstOpen('Windows may say it protected your PC from an app it does not know yet: choose <b>More info</b>, then <b>Run anyway</b>.')}
    </article>
    <article class="card os" data-os="mac">
      <h3>Mac</h3>
      <p class="muted">Apple silicon (M1 and later) or Intel.</p>
      <a class="btn primary" href="${os.macArm}" data-label="Download for Mac (Apple silicon)">Apple silicon</a>
      <a class="btn" href="${os.macIntel}">Intel Mac</a>
      ${firstOpen('Open the .dmg and drag FBRX OS to Applications. If macOS will not open it, go to <b>System Settings → Privacy &amp; Security</b> and choose <b>Open Anyway</b>.')}
    </article>
    <article class="card os" data-os="linux">
      <h3>Linux</h3>
      <p class="muted">64-bit PCs. The .deb is for Debian and Ubuntu.</p>
      <a class="btn primary" href="${os.deb}" data-label="Download for Linux (.deb)">.deb for Debian and Ubuntu</a>
      <a class="btn" href="${os.appImage}">AppImage, any Linux</a>
      <details><summary>Installing on Ubuntu</summary><p>Right-click the .deb in Files and choose <b>Open With → App Center</b> (Software Install on 22.04), then <b>Install</b>. Or in a terminal: <code>sudo apt install ~/Downloads/FBRX-OS-${esc(V)}-amd64.deb</code>. The AppImage runs without installing: Properties → <b>Executable as Program</b>, then double-click it (it may need <code>libfuse2t64</code>, or <code>libfuse2</code> on 22.04).</p></details>
    </article>
  </div>
  <p class="muted small center">Every file, with its checksums, is on the <a href="${esc(release.page)}">FBRX ${esc(V)} release</a>. FBRX keeps itself up to date from then on.</p>
</section>
<section class="band">
  <div class="wrap two">
    ${
      digger
        ? `<div class="card" id="digger">
      <span class="eyebrow">Free</span>
      <h2>FBRX Digger ${esc(digger.version)}</h2>
      <p>Every network tool FBRX has, as a small app of its own. <a href="digger.html">What it does</a></p>
      <p class="ctas"><a class="btn" href="${digger.windows}">Windows</a><a class="btn" href="${digger.macArm}">Mac (Apple silicon)</a><a class="btn" href="${digger.macIntel}">Mac (Intel)</a><a class="btn" href="${digger.deb}">Linux (.deb)</a><a class="btn" href="${digger.appImage}">AppImage</a></p>
    </div>`
        : ''
    }
    ${
      server
        ? `<div class="card" id="server">
      <span class="eyebrow">Beta</span>
      <h2>FBRX Server ${esc(server.version)}</h2>
      <p>Write the installer to a USB stick and start the server from it, or add FBRX Server to a Debian 13 server you have. <a href="server.html">What it does</a></p>
      <p class="ctas"><a class="btn" href="${server.iso}">Installer ISO</a><a class="btn" href="${server.bundle}">Bundle for Debian 13</a></p>
    </div>`
        : ''
    }
  </div>
</section>
<section class="wrap narrow center">
  <p class="muted">Running FBRX for your own company, with your own keys and your own FBRX Command? <a href="self-host.html">Self-host FBRX</a>.</p>
</section>`,
});

// ------------------------------------------------------------------------------------------------ Products
page({
  file: 'endpoint.html',
  title: 'FBRX Endpoint: your AI and its tools, on the computer you have',
  description: 'FBRX Endpoint brings FBRX OS to Windows, macOS and Linux: a private AI that does real work, with network, storage and security tools. Free to start.',
  body: `${hero({
    eyebrow: 'FBRX OS on the computer you have',
    title: 'FBRX Endpoint',
    lead: 'A private AI on your computer, with the tools to look after it: your network, your storage, your security. Essentials is free; Pro and Ultra add the everyday and expert tools.',
    ctas: '<a class="btn primary" href="download.html">Download, free</a><a class="btn" href="pricing.html">Editions and prices</a>',
  })}
<section class="wrap">
  <h2>Your AI, Fabrix</h2>
  ${features([
    ['Runs on your computer', 'The AI model runs right here, sized to your computer by itself. Chats start offline; cloud AI only when you choose it.'],
    ['Knows the steps', 'Everyday jobs it knows how to do: slow Wi-Fi, freeing disk space, a slow computer, a security check-up. It shows its plan and checks its work.'],
    ['Remembers you', 'It learns how you like things done and brings back related work, kept on your computer, with you deciding what it keeps.'],
  ])}
</section>
<section class="band">
  <div class="wrap">
    <h2>The tools it works with</h2>
    ${features([
      ['Network Center', 'Every device on your network, speed tests, a Wi-Fi channel planner that tells you the best channel and why, and consoles for your routers and switches.'],
      ['Storage', 'A space map of any drive, colored by kind of file, with one-click clean-ups for caches and build folders, and duplicate files on Ultra.'],
      ['Security', 'FBRX Shield, antivirus built in, next to the protection you already have, with a check-up that explains what it found.'],
      ['Snapshots and clipboard', 'Mark up a screenshot and drag it into any app; a clipboard history that keeps pictures too.'],
      ['Approvals', 'Anything that changes your computer or uses the internet waits for your yes. Everything it did is in the log.'],
      ['Every device', 'Sign in to your FBRX account and what you bought turns on, on every computer and your phone.'],
    ])}
  </div>
</section>
<section class="wrap">
  <h2 class="center">Four editions</h2>
  <div class="plans compact">${TIERS.map((t) => editionCard(t, '')).join('\n')}</div>
  <p class="center"><a class="btn" href="pricing.html">Compare the editions</a></p>
</section>`,
});

page({
  file: 'digger.html',
  title: 'FBRX Digger: the network toolkit',
  description: 'FBRX Digger: scan and compare your network, ping and trace route, speed tests, a Wi-Fi channel planner and device consoles, in one free app for Windows, macOS and Linux.',
  body: `${hero({
    eyebrow: 'Free, for anyone who looks after a network',
    title: 'FBRX Digger',
    lead: 'Every network tool FBRX has, and nothing else: scan your network, see what changed, find the best Wi-Fi channel and reach your devices, in one small app.',
    ctas: '<a class="btn primary" href="download.html#digger">Download Digger</a><a class="btn" href="endpoint.html">FBRX Endpoint</a>',
    aside: `<div class="hero-board">${board(['DIGGER', 'NETWORK TOOLS'])}</div>`,
  })}
<section class="wrap">
  ${features([
    ['Overview', 'This computer, the router, internet latency and loss, your public address and a plain verdict on how it is doing.'],
    ['Devices', 'Scan the network and name what is on it: computers, phones, printers, TVs, cameras, smart-home devices and storage. Save scans and compare two to see what joined and what left.'],
    ['Ping and trace route', 'Each hop identified: your router, a second router, your provider, the internet.'],
    ['Speed test', 'With its history, to see whether it is the network or the time of day.'],
    ['Wi-Fi channel planner', 'Every network around drawn over its channels, how busy each one is, and the best channel for yours with the reason.'],
    ['Device consoles', 'SSH and Telnet to routers, switches, firewalls and servers, straight from a scan, with host keys pinned on first use.'],
  ])}
  <p class="muted center">Runs next to FBRX on the same computer without getting in its way: its own settings, no global shortcuts.</p>
</section>`,
});

page({
  file: 'server.html',
  title: 'FBRX Server: your own server, with its own AI',
  description: 'FBRX Server: virtual machines, image backups that prove they work, your network’s router and firewall, and a large AI for your whole organization.',
  body: `${hero({
    eyebrow: 'Beta, free to try',
    title: 'FBRX Server',
    lead: 'FBRX OS for servers: virtual machines with their screens in your browser, backups checked by starting them, your network’s gate, and an AI big enough for your whole organization, all from one web console.',
    ctas: '<a class="btn primary" href="download.html#server">Download the installer</a><a class="btn" href="command.html">With FBRX Command</a>',
  })}
<section class="wrap">
  ${features([
    ['Virtual machines', 'Create, start and watch them from the browser: snapshots, storage, ISOs, networks, and a live map of the server’s hardware.'],
    ['Backups that prove they work', 'Image backups of your virtual machines and computers, each one checked by starting it as a throwaway machine.'],
    ['A big AI for everyone', 'Runs large open models with a long memory (up to 128K tokens), picks the right one for the hardware, and lends it to your other FBRX computers when theirs is too small.'],
    ['Your network’s gate', 'Routing, firewall rules, VLANs, DHCP and DNS, a VPN with QR-code setup, and changes that undo themselves unless you keep them.'],
    ['Threat watch', 'Watches the network through the gate and works with FBRX Shield on each computer; the AI explains what it saw.'],
    ['Management controller', 'Health, power and firmware settings through the server’s management controller.'],
  ])}
</section>
${serverSection}`,
});

page({
  file: 'command.html',
  title: 'FBRX Command: for organizations',
  description: `FBRX Command: your organization’s computers, people, licenses and billing in one place. ${formatPrice(COMMAND_PLAN.monthly)} a month, each person ${off} off.`,
  body: `${hero({
    eyebrow: 'For businesses, schools and families',
    title: 'FBRX Command',
    lead: `${COMMAND_PLAN.summary} Work, School and Home, in the cloud or on a computer of your own.`,
    ctas: '<a class="btn primary" href="account.html?start=organization">Start an FBRX Command</a><a class="btn" href="pricing.html#command">What a month comes to</a>',
  })}
<section class="wrap">
  ${features([
    ['Computers', 'Enroll them with a token or a setup file for your device-management tool, see how each is doing, and give each one, or each person, an edition.'],
    ['People and licenses', 'Invite people with a one-time code, set who may do what, and let the bill follow the editions you give.'],
    ['Policy', 'What the AI may do and where it may think, which tools are on, and approvals for the things that matter.'],
    ['FBRX Mesh', 'Your computers and servers talking to each other directly, end-to-end encrypted, lending each other their AI.'],
    ['Schools and families', 'Student and child computers with the learner edition, kept to what suits them.'],
    ['Your servers', 'FBRX Servers join like any computer; the Black Hole Edition gives your admins every tool.'],
  ])}
</section>
<section class="band">
  <div class="wrap two">
    <div>
      <h2>${formatPrice(COMMAND_PLAN.monthly)} a month, plus each person</h2>
      <table class="rates">
        <thead><tr><th>Each person</th><th>A month</th></tr></thead>
        <tbody>
          ${TIERS.map((t) => `<tr><td>${TIER_SHORT[t]}</td><td>${tenantRate(t)}</td></tr>`).join('\n          ')}
        </tbody>
      </table>
    </div>
    <div class="card offer"><h3>Your own keys?</h3><p>Run FBRX Command on a computer of your own, with your own license signing key. <a href="self-host.html">Self-host FBRX</a></p></div>
  </div>
</section>`,
});

// ------------------------------------------------------------------------------------------------ Pricing
/** "Get Ultra" (monthly) and "or yearly, $119.90": each opens its checkout from the account page. */
const buyLinks = (t) =>
  `<a class="btn primary" href="account.html?buy=${personalPlan(book, t, 'month').productId}">Get ${TIER_SHORT[t]}</a> <a class="btn" href="account.html?buy=${personalPlan(book, t, 'year').productId}">or yearly, ${formatPrice(personalPlan(book, t, 'year').amount)}</a>`;
const prices = { basic: EDITION_PLANS.basic.tenantMonthly, ultra: EDITION_PLANS.ultra.tenantMonthly, blackhole: EDITION_PLANS.blackhole.tenantMonthly, command: COMMAND_PLAN.monthly, yearlyMonths: book.yearlyMonths };
page({
  file: 'pricing.html',
  title: 'FBRX pricing',
  description: `Essentials is free. Pro ${formatPrice(EDITION_PLANS.basic.monthly)} and Ultra ${formatPrice(EDITION_PLANS.ultra.monthly)} a month. FBRX Command ${formatPrice(COMMAND_PLAN.monthly)} a month for your organization.`,
  scripts: ['pricing.js'],
  body: `<section class="wrap">
  <h1 class="center">Pricing</h1>
  <p class="lead center">Start free. Pay monthly or yearly for more (yearly, ${yearlySaving}), and stop any time. Prices in US dollars.</p>
  <div class="plans">
    ${editionCard('essentials', `<a class="btn" href="download.html">Download</a>`)}
    ${editionCard('basic', `${buyLinks('basic')}<p class="muted small">Or try it free for ${STANDARD_TRIAL_DAYS} days in FBRX, no card needed.</p>`)}
    ${editionCard('ultra', buyLinks('ultra'))}
    ${editionCard('blackhole', `<a class="btn" href="account.html?start=organization">Start an FBRX Command</a>`)}
  </div>
</section>
<section class="band" id="command">
  <div class="wrap two">
    <div>
      <span class="eyebrow">For organizations</span>
      <h2>FBRX Command, ${formatPrice(COMMAND_PLAN.monthly)} a month</h2>
      <p class="lead">${esc(COMMAND_PLAN.summary)} You give each person an edition, on the computers it includes, and shared or lab computers one of their own; the bill follows by itself. Pay monthly or yearly (${yearlySaving}).</p>
      <table class="rates">
        <thead><tr><th>Each person</th><th>A month</th></tr></thead>
        <tbody>
          ${TIERS.map((t) => `<tr><td>${TIER_SHORT[t]}</td><td>${tenantRate(t)}</td></tr>`).join('\n          ')}
        </tbody>
      </table>
      <p class="muted small">A shared, lab or student computer nobody pays for costs the same as a person. Student and child computers count as Pro.</p>
    </div>
    <form class="card calc" id="calc" data-prices='${JSON.stringify(prices)}' aria-label="What a month comes to">
      <h3>What a month comes to</h3>
      ${[['basic', 10], ['ultra', 2], ['blackhole', 1]].map(([t, n]) => `<label>${TIER_SHORT[t]} people <input type="number" min="0" value="${n}" name="${t}"></label>`).join('\n      ')}
      <div class="total"><span>A month</span><b id="total">—</b></div>
      <div class="total"><span>A year, paid yearly</span><b id="year">—</b></div>
      <p class="muted small">The FBRX Command plan included; Essentials people and computers are free. Changes are prorated.</p>
    </form>
  </div>
</section>
${serverSection}
<section class="wrap faq">
  <h2>Questions</h2>
  <details><summary>Is Essentials really free?</summary><p>Yes, on as many computers as you like, and in an organization too. It is your AI on its own: the chat, its memory and voice, and the AI models.</p></details>
  <details><summary>Where does my AI run?</summary><p>On your computer. ${esc(ESSENTIALS_TIPS.find((t) => t.id === 'tip-offline')?.body.replace('{agent}', 'It') ?? '')}</p></details>
  <details><summary>Can I switch editions?</summary><p>Any time, in Settings → Edition. Nothing you saved goes away when you switch down.</p></details>
  <details><summary>Can I try Pro first?</summary><p>Yes: every computer can try Pro free for ${STANDARD_TRIAL_DAYS} days, once, from Settings → Edition in FBRX. No card needed; when it ends, the computer goes back to Essentials unless you buy Pro. Pro used to be free, so a computer that ran FBRX before 2.0 starts its trial by itself when it updates.</p></details>
  <details><summary>How do I pay?</summary><p>On this site and in FBRX on your computer: by card, or with the wallet on your phone or computer when checkout offers it. In the phone apps, through the app store, once they leave beta. It all goes to one FBRX account, so what you buy anywhere works everywhere you sign in.</p></details>
  <details><summary>What does beta mean?</summary><p>FBRX is finished enough to use every day, and still changing quickly: new versions arrive often and install by themselves. Tell us what breaks, right from the app. Prices are the ones above.</p></details>
  <details><summary>What is Black Hole Edition?</summary><p>${esc(EDITION_PLANS.blackhole.summary)} It is an add-on in FBRX Command, ${formatPrice(EDITION_PLANS.blackhole.tenantMonthly)} a month a person (on up to ${book.computers.included.blackhole} computers), and comes on wherever its person signs in.</p></details>
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

// ------------------------------------------------------------------------------------------------ Self-host
page({
  file: 'self-host.html',
  title: 'Self-host FBRX',
  description: 'Build FBRX on your own computer with your own license signing key, and run your own FBRX Command.',
  body: `<section class="wrap narrow">
  <span class="eyebrow">For companies that run their own</span>
  <h1>Self-host FBRX</h1>
  <p class="lead">The download page’s installers sign in to FBRX accounts. To run FBRX entirely on your own, with your own license signing key and your own FBRX Command, build it yourself from the project.</p>
  <ol class="steps">
    <li><b>Download <a href="${SELF_HOST_ZIP}">FBRX-OS.zip</a></b> (always the newest release) and unzip it somewhere permanent, outside synced folders.</li>
    <li><b>Run Install FBRX OS</b> (<code>Install FBRX OS.command</code> on a Mac, <code>Install FBRX OS.cmd</code> on Windows). In 15 to 20 minutes it builds FBRX for this computer, makes your license signing key and opens straight into a chat with your own AI.</li>
    <li><b>Back up your signing key</b> (<code>~/.fbrx-keys</code>): it signs every license your FBRX Command issues.</li>
    <li><b>Run Install FBRX Command</b> on the computer that will run it for your company, school or family, with the same key, then enroll your computers from its Deploy page.</li>
  </ol>
  <p class="muted">The details, step by step: <a href="${REPO}/blob/HEAD/docs/INSTALL.md">Installing FBRX</a> and <a href="${REPO}/blob/HEAD/docs/DEPLOYMENT.md">running FBRX for an organization</a>.</p>
</section>`,
});

// ------------------------------------------------------------------------------------------------ Help and policies
page({
  file: 'support.html',
  title: 'FBRX support',
  description: 'Get help with FBRX: write to us, see the docs, or check whether FBRX’s services are up.',
  body: `<section class="wrap narrow">
  <h1>Support</h1>
  <div class="card">
    <h3>Ask us</h3>
    ${supportEmail ? `<p>Write to <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>. Say what you did, what you saw, and your FBRX version (Settings → Logs &amp; about).</p>` : `<p>Open an issue on <a href="${REPO}/issues">the project’s page</a>: say what you did, what you saw, and your FBRX version (Settings → Logs &amp; about).</p>`}
    <p class="muted">In FBRX, <b>Settings → Logs &amp; about</b> saves a support bundle you can attach: it leaves out your chats and keys.</p>
  </div>
  <div class="card">
    <h3>Answers</h3>
    <p>How everything works is in the <a href="${REPO}/tree/HEAD/docs">FBRX docs</a>, and Fabrix knows them too: ask it in the app.</p>
  </div>
  ${statusUrl ? `<div class="card"><h3>Is it just me?</h3><p>Whether FBRX accounts, purchases and FBRX Cloud AI are up: <a href="${esc(statusUrl)}">the status page</a>.</p></div>` : ''}
</section>`,
});

/** The terms and the privacy policy are being written: until they are here, these pages say so and say who to ask. */
const policyPlaceholder = (file, title, what) =>
  page({
    file,
    title: `FBRX ${title}`,
    description: `FBRX’s ${what}.`,
    body: `<section class="wrap narrow">
  <h1>${esc(title)}</h1>
  <p class="note">FBRX’s ${esc(what)} will be published here before FBRX accounts open to everyone.</p>
  <p>Until then, questions go to ${supportEmail ? `<a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>` : `<a href="support.html">support</a>`}.</p>
</section>`,
  });
policyPlaceholder('terms.html', 'Terms of use', 'terms of use and terms of sale');
policyPlaceholder('privacy.html', 'Privacy policy', 'privacy policy');

page({
  file: '404.html',
  title: 'Not found · FBRX',
  description: 'This page is not here.',
  body: `<section class="wrap narrow center">
  <h1>Not here</h1>
  <p class="lead">This page has moved or never was. <a href="index.html">Go to the home page</a> or <a href="download.html">download FBRX</a>.</p>
</section>`,
});

// ------------------------------------------------------------------------------------------------ Files beside the pages
// What account.js needs from the price list and the shared names.
const site = {
  accountServer: api,
  editions: TIER_SHORT,
  kinds: VERTICAL_NAMES,
  sources: PURCHASE_SOURCE_NAMES,
  plans: Object.fromEntries(['basic', 'ultra'].map((t) => [t, Object.fromEntries(['month', 'year'].map((i) => [i, { productId: personalPlan(book, t, i).productId, price: formatPrice(personalPlan(book, t, i).amount) }]))])),
};
writeFileSync(join(out, 'config.js'), `window.FBRX_SITE = ${JSON.stringify(site)};\n`);
for (const f of ['styles.css', 'account.js', 'pricing.js', 'download.js']) copyFileSync(join(here, 'src', f), join(out, f));
writeFileSync(join(out, 'favicon.svg'), readFileSync(join(root, 'docs', 'assets', 'fbrx-logo-light.svg'), 'utf8'));
// Response headers, for hosts that read a _headers file (the meta tag above carries the content security policy).
writeFileSync(
  join(out, '_headers'),
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
`,
);
writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${siteUrl ? `Sitemap: ${siteUrl}/sitemap.xml\n` : ''}`);
if (siteUrl) {
  const listed = built.filter((f) => f !== '404.html');
  writeFileSync(join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map((f) => `  <url><loc>${esc(`${siteUrl}/${f === 'index.html' ? '' : f}`)}</loc></url>`).join('\n')}\n</urlset>\n`);
}
console.log(`Built the FBRX website (${built.length} pages, FBRX ${V}) in ${out}${api ? `, accounts on ${api}` : ', accounts open soon: no FBRX_ACCOUNT_SERVER'}`);
