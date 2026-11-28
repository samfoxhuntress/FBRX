/** noVNC (core/rfb.js), as the FBRX Server console and FBRX View use it. */
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { username?: string; password?: string; target?: string }; wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    sendCtrlAltDel(): void;
    /** After credentialsrequired (FBRX View asks the person for the password). */
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void;
    clipboardPasteFrom(text: string): void;
  }
}
