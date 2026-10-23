# FBRX Browser

A web browser inside FBRX OS, in its own window. It is a real browser — tabs, an address bar, back and forward,
bookmarks, history, downloads — that also works with the rest of FBRX: the local AI reads and explains the page, the
password vault hands over a saved password, Notes keeps a page, FBRX Shield checks what you download, and an organization's
FBRX Command decides which sites may open.

Open it from the sidebar (**Browser**), the tray (**Open FBRX Browser**), or Settings → Browser. It opens in a window
of its own, beside FBRX. It comes with Endpoint Standard and up, and on students' and children's computers (Endpoint
Essentials is the AI on its own).

## What it does

| | |
| --- | --- |
| **Tabs** | New tab (Ctrl/⌘+T), close (Ctrl/⌘+W), a private tab (nothing kept once it closes). |
| **Address bar** | Type a web address, or a search. The search engine is yours to pick (Settings → Browser): DuckDuckGo (the default), Startpage, Google, Bing or Brave. A lock shows a secure (https) connection. |
| **Fabrix** | The side panel (the ✶ button) asks the **local AI** about the page — *Summarize*, *Key points*, *Explain simply*, or your own question. It reads the page here on the computer; nothing is sent away. A private tab is never read. |
| **Bookmarks and history** | The tag in the address bar keeps a page; the menu opens Bookmarks and History, each searchable, with a way to clear history. |
| **Saved sign-ins** | The menu → *Saved sign-ins* lists the passwords in your FBRX vault and copies one to paste into a form (and clears it from the clipboard shortly after). The vault must be unlocked. |
| **Downloads** | Every download is checked by **FBRX Shield** when it finishes, as if it had landed in Downloads: malware goes to quarantine (when automatic quarantine is on) and Shield raises its alert; a suspicious file waits for your decision in FBRX Shield. With nothing found, you get one "Download finished". This needs FBRX Shield as the antivirus. |
| **Keep a page** | The menu saves a page to **Notes**, copies its link, or opens it in the system browser. |
| **Find and zoom** | Ctrl/⌘+F finds on the page; Ctrl/⌘+ +/−/0 zooms. |

## Safe and separate

- **Its own storage.** Web pages load in locked-down views with their own cookies and sign-ins
  (`persist:fbrx-web`), kept apart from FBRX's own pages. A private tab uses a session that keeps nothing.
- **Web permissions are off.** Pages cannot use the camera, the microphone, your location, notifications and the
  like; only full screen and copying to the clipboard are allowed.
- **Downloads are checked**, as above.
- **Do Not Track.** FBRX Browser sends the Do Not Track and Global Privacy Control signals by default (Settings →
  Browser turns this off).

## For an organization (FBRX Command)

An organization can decide which sites open in FBRX Browser, pushed as managed settings (the person cannot change
them):

- **Allowed sites** (`browser.allowed`): when set, only addresses matching one of these may open — an allow-list.
- **Blocked sites** (`browser.blocked`): addresses matching one of these are blocked.
- **Safe browsing** (`browser.safeBrowsing`): searches on Google, Bing, DuckDuckGo and Brave always use strict
  SafeSearch, and YouTube runs in Restricted Mode. It is on by itself on a student's or child's computer. It does not
  judge other sites' content: for that, use the allow-list, or the blocked list for sites you know.

The lists apply to every page and frame the browser loads — a link, a redirect or an embedded frame included — not
only to what is typed. A blocked page shows a plain "This page is blocked" with the reason. The person can add their
own blocks too (Settings → Browser), and remove only those.

Host patterns match a site and its subdomains: `example.com` matches `www.example.com` and `shop.example.com`; `*`
matches everything.

## Settings

Settings → Browser: the home page, the search engine, Do Not Track, whether new tabs open private, whether Fabrix may
read pages, your own blocked sites, and clearing history. What an organization sets is shown there too, and cannot be
changed on the computer.
