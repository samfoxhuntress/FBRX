/**
 * FBRX View: the remote desktop app. Every way into another machine in one window, in tabs: RDP and VNC drawn inside
 * the app (IronRDP and noVNC, through the app's own proxy), SSH and Telnet consoles, the connections saved in one list
 * with their logins in the vault, and Ask Fabrix in a session. Built from the same code as FBRX OS (the desktop app's
 * "view" flavor) and, like FBRX Digger, it comes with Ultra: it runs at the edition FBRX Endpoint's license gives the
 * computer, and thinks with FBRX Endpoint's AI when Endpoint runs on the same computer.
 */

export const VIEW_NAME = 'FBRX View';
/** View's own version: its releases are tagged view-v<version>. */
export const VIEW_VERSION = '1.0.0';

/** The pages View shows: its connections and sessions, its settings, and the chat while FBRX Endpoint's AI is there. */
export const VIEW_PAGES = ['view', 'settings', 'agent'] as const;

/** A connection FBRX Endpoint or FBRX Digger hands to FBRX View ("Open in View"): where, and who as, never a password. */
export interface ViewRequest {
  protocol: 'rdp' | 'vnc' | 'ssh' | 'telnet';
  host: string;
  port?: number;
  username?: string;
  label?: string;
}

/** The file an app writes in its own data folder for FBRX View to pick up. */
export const VIEW_REQUEST_FILE = 'view-request.json';

/** The settings tabs that apply to View. */
export const VIEW_SETTINGS = ['general', 'appearance', 'updates', 'logs'] as const;

/** The AI tools View's Fabrix has besides the everyday ones: reading and typing in its console sessions. */
export const VIEW_TOOLS: readonly string[] = ['device_console.sessions', 'device_console.read', 'device_console.send'];

/**
 * View's icon: a viewfinder's four corners around a mouse pointer (seeing another screen and using it), in FBRX's
 * honey-to-red on black, like Digger's mole. The window and installer icons are drawn from it
 * (apps/desktop/build/view-icon.svg and .png), and the sidebar shows it.
 */
export const VIEW_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="vw-ink" gradientUnits="userSpaceOnUse" x1="232" y1="232" x2="792" y2="792"><stop offset="0" stop-color="#ffb547"/><stop offset="0.5" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ff4d5e"/></linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#0b0b0c"/>
  <g fill="none" stroke="url(#vw-ink)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round">
    <path d="M232 372V300a68 68 0 0 1 68 -68H372"/>
    <path d="M652 232H724a68 68 0 0 1 68 68V372"/>
    <path d="M792 652V724a68 68 0 0 1 -68 68H652"/>
    <path d="M372 792H300a68 68 0 0 1 -68 -68V652"/>
  </g>
  <path d="M440 372V646L508 584L558 690L606 668L556 564L648 556Z" fill="url(#vw-ink)" stroke="url(#vw-ink)" stroke-width="28" stroke-linejoin="round"/>
</svg>`;
