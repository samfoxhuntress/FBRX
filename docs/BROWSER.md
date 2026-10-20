# FBRX Browser

A web browser inside FBRX OS, in its own window. It is a real browser — tabs, an address bar, back and forward,
bookmarks, history, downloads — that also works with the rest of FBRX: the local AI reads and explains the page, the
password vault fills a saved sign-in, Notes keeps a page, FBRX Shield checks what you download, and an organization's
FBRX Command decides which sites may open.

Open it from the sidebar (**Browser**), the tray (**Open FBRX Browser**), or a link in FBRX. It opens in a window of
its own, beside FBRX.

## What it does

| | |
| --- | --- |
| **Tabs** | New tab (Ctrl/⌘+T), close (Ctrl/⌘+W), a private tab (nothing kept once it closes). |
| **Address bar** | Type a web address, or a search. The search engine is yours to pick (Settings → Browser): DuckDuckGo (the default), Startpage, Google, Bing or Brave. A lock shows a secure (https) connection. |
| **Fabrix** | The side panel (the ✶ button) asks the **local AI** about the page — *Summarize*, *Key points*, *Explain simply*, or your own question. It reads the page here on the computer; nothing is sent away. A private tab is never read. |
| **Bookmarks and history** | The tag in the address bar keeps a page; the menu opens Bookmarks and History, each searchable, with a way to clear history. |
| **Saved sign-ins** | The menu → *Saved sign-ins* lists the passwords in your FBRX vault and copies one to paste into a form (and clears it from the clipboard shortly after). The vault must be unlocked. |
| **Downloads** | Every download is checked by **FBRX Shield** when it finishes; a threat is quarantined and you are told. (Turn Shield on under FBRX Shield for this.) |
| **Keep a page** | The menu saves a page to **Notes**, copies its link, or opens it in the system browser. |
| **Find and zoom** | Ctrl/⌘+F finds on the page; Ctrl/⌘+ +/−/0 zooms. |

## Safe and separate

- **Its own storage.** Web pages load in locked-down views with their own cookies and sign-ins
  (`persist:fbrx-web`), kept apart from FBRX's own pages. A private tab uses a session that keeps nothing.
- **Web permissions are off by default.** The camera, microphone, location and the like are refused unless a page is
  given them; only full screen and copying are allowed without asking.
- **Downloads are checked**, as above.
- **Do Not Track.** FBRX Browser sends the Do Not Track and Global Privacy Control signals by default (Settings →
  Browser turns this off).

## For an organization (FBRX Command)

An organization can decide which sites open in FBRX Browser, pushed as managed settings (the person cannot change
them):

- **Allowed sites** (`browser.allowed`): when set, only addresses matching one of these may open — an allow-list.
- **Blocked sites** (`browser.blocked`): addresses matching one of these are blocked.
- **Safe browsing** (`browser.safeBrowsing`): on a student's or child's computer, keeps known-adult and unsafe sites
  out.

A blocked address shows a plain "This page is blocked" with the reason. The person can add their own blocks too, on
their own computer.

Host patterns match a site and its subdomains: `example.com` matches `www.example.com` and `shop.example.com`; `*`
matches everything.

## Settings

Settings → Browser: the home page, the search engine, Do Not Track, whether new tabs are private, and whether Fabrix
may read pages. The allowed/blocked lists and safe browsing are usually an organization's (FBRX Command).
