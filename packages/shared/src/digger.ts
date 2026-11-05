import type { ProviderConfig } from './settings';

/**
 * FBRX Digger: FBRX's Network Center on its own, as a small app for anyone who works on networks. It is built from the
 * same code as FBRX OS (the desktop app's "digger" flavor), so every network tool FBRX OS gets, Digger gets too:
 * device scans and their comparison, ping and trace route, the speed test, the Wi-Fi channel planner, DNS and port
 * checks, device consoles (SSH, Telnet) and network environments. All of them, whatever the edition.
 *
 * It runs on its own: no edition, no FBRX account, no AI of its own and none of FBRX Endpoint's background work. When
 * FBRX Endpoint runs on the same computer, Digger's agent thinks with Endpoint's AI (DIGGER_AI_PROVIDER).
 */

export const DIGGER_NAME = 'FBRX Digger';
/** Digger's own version: its releases are tagged digger-v<version>. */
export const DIGGER_VERSION = '1.1.0';

export type AppFlavor = 'os' | 'digger';

/**
 * The pages Digger shows: the Network Center, the browser (for router and device pages) and its settings, and the
 * chat while FBRX Endpoint's AI is there to answer it.
 */
export const DIGGER_PAGES = ['network', 'browser', 'settings', 'agent'] as const;

/** Digger's one AI: FBRX Endpoint's, on the same computer, found while Endpoint runs. */
export const DIGGER_AI_PROVIDER: ProviderConfig = { id: 'fbrx-endpoint', type: 'fbrx-endpoint', name: 'FBRX Endpoint', enabled: true, cloud: false };
/** The settings tabs that apply to Digger. */
export const DIGGER_SETTINGS = ['general', 'appearance', 'browser', 'updates', 'logs'] as const;

/**
 * Digger's icon: a mole in a miner's helmet (its lamp lit, in FBRX's Tropical colors), peeking out of the ground. The
 * window and installer icons are drawn from it (apps/desktop/build/digger-icon.svg and .png), and the sidebar shows it.
 */
export const DIGGER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="dg-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1b14"/><stop offset="1" stop-color="#140b07"/></linearGradient>
    <linearGradient id="dg-hat" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc24a"/><stop offset="1" stop-color="#ff4f6d"/></linearGradient>
    <radialGradient id="dg-glow"><stop offset="0" stop-color="#fff3c4" stop-opacity="0.75"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#dg-sky)"/>
  <ellipse cx="512" cy="610" rx="262" ry="250" fill="#7a5c4f"/>
  <ellipse cx="512" cy="660" rx="168" ry="150" fill="#a8857a"/>
  <path d="M296 420 C 300 300 400 238 512 238 C 624 238 724 300 728 420 Z" fill="url(#dg-hat)"/>
  <rect x="262" y="404" width="500" height="44" rx="22" fill="url(#dg-hat)"/>
  <circle cx="512" cy="322" r="120" fill="url(#dg-glow)"/>
  <circle cx="512" cy="322" r="46" fill="#fff6d8" stroke="#3a2418" stroke-width="12"/>
  <path d="M402 528 q 32 -34 64 0" fill="none" stroke="#1d110b" stroke-width="20" stroke-linecap="round"/>
  <path d="M558 528 q 32 -34 64 0" fill="none" stroke="#1d110b" stroke-width="20" stroke-linecap="round"/>
  <circle cx="392" cy="596" r="30" fill="#ff8fa3" opacity="0.55"/>
  <circle cx="632" cy="596" r="30" fill="#ff8fa3" opacity="0.55"/>
  <ellipse cx="512" cy="600" rx="56" ry="40" fill="#ff7f98"/>
  <ellipse cx="496" cy="588" rx="14" ry="9" fill="#ffd0da"/>
  <g stroke="#3a2418" stroke-width="8" stroke-linecap="round" opacity="0.7">
    <path d="M444 616 L346 600"/><path d="M444 634 L350 650"/><path d="M580 616 L678 600"/><path d="M580 634 L674 650"/>
  </g>
  <path d="M480 652 q 32 26 64 0" fill="none" stroke="#1d110b" stroke-width="12" stroke-linecap="round"/>
  <path d="M64 800 C 210 740 360 770 512 772 C 664 770 814 740 960 800 L960 760 L960 760 L960 760 C 960 870 870 960 760 960 L264 960 C 154 960 64 870 64 760 Z" fill="#4a2e1f"/>
  <g fill="#f2c9b8">
    <ellipse cx="370" cy="790" rx="78" ry="46"/>
    <ellipse cx="654" cy="790" rx="78" ry="46"/>
  </g>
  <g stroke="#7a5c4f" stroke-width="10" stroke-linecap="round">
    <path d="M330 770 L322 742"/><path d="M370 764 L370 734"/><path d="M410 770 L418 742"/>
    <path d="M614 770 L606 742"/><path d="M654 764 L654 734"/><path d="M694 770 L702 742"/>
  </g>
  <g fill="#6b4430"><circle cx="210" cy="880" r="16"/><circle cx="820" cy="866" r="12"/><circle cx="560" cy="900" r="10"/><circle cx="320" cy="920" r="9"/></g>
</svg>`;
