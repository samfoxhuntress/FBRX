/**
 * FBRX Digger: FBRX's Network Center on its own, as a small app for anyone who works on networks. It is built from the
 * same code as FBRX OS (the desktop app's "digger" flavor), so every network tool FBRX OS gets, Digger gets too:
 * device scans and their comparison, ping and trace route, the speed test, the Wi-Fi channel planner, DNS and port
 * checks, device consoles (SSH, Telnet) and network environments. All of them, whatever the edition.
 */

export const DIGGER_NAME = 'FBRX Digger';
/** Digger's own version: its releases are tagged digger-v<version>. */
export const DIGGER_VERSION = '1.0.1';

export type AppFlavor = 'os' | 'digger';

/** The pages Digger shows: the Network Center, the browser (for router and device pages) and its settings. */
export const DIGGER_PAGES = ['network', 'browser', 'settings'] as const;
/** The settings tabs that apply to Digger. */
export const DIGGER_SETTINGS = ['general', 'appearance', 'browser', 'updates', 'logs'] as const;
