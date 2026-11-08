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
export const DIGGER_VERSION = '1.1.1';

export type AppFlavor = 'os' | 'digger';

/**
 * The pages Digger shows: the Network Center and its settings, and the chat while FBRX Endpoint's AI is there to answer
 * it. A router's or device's own page opens in the computer's browser.
 */
export const DIGGER_PAGES = ['network', 'settings', 'agent'] as const;

/** Digger's one AI: FBRX Endpoint's, on the same computer, found while Endpoint runs. */
export const DIGGER_AI_PROVIDER: ProviderConfig = { id: 'fbrx-endpoint', type: 'fbrx-endpoint', name: 'FBRX Endpoint', enabled: true, cloud: false };
/** The settings tabs that apply to Digger. */
export const DIGGER_SETTINGS = ['general', 'appearance', 'updates', 'logs'] as const;

/**
 * Digger's icon: a mole in a miner's helmet, its lamp lit, peeking out of the ground over a few specks of dirt, drawn
 * in one line of FBRX's honey-to-red on black. The window and installer icons are drawn from it
 * (apps/desktop/build/digger-icon.svg and .png), and the sidebar shows it.
 */
export const DIGGER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="dg-ink" gradientUnits="userSpaceOnUse" x1="260" y1="170" x2="764" y2="900"><stop offset="0" stop-color="#ffb547"/><stop offset="0.5" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff4d5e"/></linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#0b0b0c"/>
  <g fill="none" stroke="url(#dg-ink)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
    <path d="M512 214V174M432 236L412 202M592 236L612 202"/>
    <path d="M326 452C336 330 414 266 512 266C610 266 688 330 698 452"/>
    <path d="M292 456H732"/>
    <circle cx="512" cy="356" r="42"/>
    <path d="M344 474C300 540 286 630 296 712M680 474C724 540 738 630 728 712"/>
    <path d="M404 566q30 -28 60 0M560 566q30 -28 60 0"/>
    <path d="M196 712H828"/>
    <path d="M362 712a50 42 0 0 1 100 0M562 712a50 42 0 0 1 100 0"/>
  </g>
  <ellipse cx="512" cy="628" rx="38" ry="26" fill="url(#dg-ink)"/>
  <g fill="url(#dg-ink)">
    <circle cx="300" cy="790" r="18"/><circle cx="430" cy="812" r="12"/><circle cx="560" cy="792" r="16"/><circle cx="700" cy="818" r="14"/>
    <circle cx="368" cy="868" r="10"/><circle cx="620" cy="872" r="11"/><circle cx="496" cy="880" r="8"/><circle cx="236" cy="850" r="9"/><circle cx="780" cy="858" r="9"/>
  </g>
</svg>`;
