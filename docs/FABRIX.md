# Fabrix at work

Fabrix (the agent; its name is yours to change in Settings → Agent) does more than answer. It reads the files and
pictures you give it, makes documents and pictures, reads the web, does jobs by itself on a schedule, and looks at
your screen when you hand it a snapshot. Everything here follows the computer's policy like any other tool: what
needs a yes asks for one, and the audit log keeps what was done.

## Attach files and pictures

The paperclip next to the chat box (or drag files onto the chat, or paste a picture) attaches up to 10 files to a
message, 25 MB each.

| What | What Fabrix gets |
| --- | --- |
| Text and code (`.txt`, `.md`, `.csv`, `.json`, source files…) | The text itself. |
| PDF | The text of every page (a scan without text has none: say what is in it, or attach a picture). |
| Documents (`.docx`, `.xlsx`, `.pptx`, and OpenDocument `.odt`, `.ods`, `.odp`) | Their text: paragraphs, cells row by row, slides in order. |
| Pictures (PNG, JPEG, GIF, WebP) | The picture, for models that see: cloud models, and local ones with *vision* or *vl* in their name. Others get its name only, and the chat says so before you send. Big pictures are made smaller first (2000 pixels at most). |
| Anything else | Its name and size; Fabrix can still open it with its file tools. |

A long file is shortened to fit what the model reads at once (the chat says when). Attached files are kept in the
workspace (`Attachments`), where Fabrix's file tools reach them by the path the chat gives; ones never sent go after a
day, and the rest go with their chat.

## Documents and pictures Fabrix makes

Ask for a file and Fabrix makes it: *"make a PDF report of my open tasks"*, *"put that table in a spreadsheet"*,
*"draw a diagram of my home network"*.

* **Documents:** PDF, `.docx` (for any word processor), web page (`.html`), Markdown, plain text and CSV, written from
  Markdown: headings, lists, tables, links, quotes and code. PDFs are printed by the app's own engine, with page
  numbers; on FBRX Server, FBRX writes them itself.
* **Pictures:** drawings (charts, diagrams, icons, simple illustrations) are drawn on the computer, offline, as SVG
  and PNG. Generated images (photos and paintings from a description) need an image service: an OpenAI-compatible
  images endpoint, or an image server on your network (Settings → Agent → *Files, pictures and the web*).
* **Where they go:** the FBRX folder in Documents (Settings → Agent; any folder the AI may use). A new file never
  replaces one already there: *Report (2).pdf*. Each one shows in the chat with a picture of it, **Open** and **Show in
  folder**. Making a new file in that folder needs no yes (the policy's *documents* and *pictures* rules).

## The web: pages, search and quotes

In an online chat (an offline one asks first), Fabrix can:

* **read a page**: its title, text and links, or a PDF on the web (up to 15 MB);
* **search the web**: a public search engine that needs no key, or your own SearXNG server for privacy (Settings →
  Agent → *Files, pictures and the web*);
* **look up a stock quote**: the latest price, the day's open, high, low and volume, from a free public source
  (delayed; not for trading).

Addresses on this computer and inside your network are refused (unless the policy allows private networks), and
the organization's blocked sites apply.

## Automations

Automations (Studio → **Automations**, Endpoint Standard and up) are jobs Fabrix does by itself and tells you about.
Each one is a request, as you would type it in the chat, with:

* **When:** every 15 minutes to 7 days, at a time on chosen days, when FBRX starts, or only when you run it.
* **Tell me:** every time, only when something changed (Fabrix answers *NO_CHANGE* when nothing is new, and nobody is
  told), or never (it stays in its chat).
* **Internet:** whether it may read the web, search and look up quotes.
* **Shortcut:** an optional key combination that runs it at once from any app.

Start from an idea (watch classified listings, check my stocks, a price drop alert, a morning brief, news on a topic,
a weekly PDF report) and fill in the parts in [brackets]. Each automation keeps its own chat (marked *automation* in
Conversations): open it to read every result and ask follow-up questions. **History** lists its last runs.

Nobody is there to approve anything while one runs, so it uses only the tools the policy allows without asking; an
offline one gets no internet tools at all. Automations run one at a time (a local model answers one question at a
time anyway), and a computer that slept runs each missed one once, not over and over. They are not in Endpoint
Essentials, nor on student computers.

## FBRX Snapshot

A picture of the screen (Workbench → **Snapshot**, or **Ctrl+Alt+S** from any app; Settings there can make the
**Print Screen** key take one too, or change the shortcut):

1. Every screen is captured at once, so an open menu stays as it was. Then pick: **Area** (drag over it; the size in
   pixels shows as you go), **Window** (from a list of the open windows, taken at its own size), or **Whole screen**.
   Esc cancels. From the Snapshot page you can wait 3, 5 or 10 seconds first.
2. It is saved as a PNG in Pictures → *FBRX Snapshots* (changeable), copied to the clipboard, and opened to mark up
   (or only announced, as you prefer).
3. Mark it up: **pen**, **highlighter**, **arrow**, **box**, **text**, **blur** (squares big enough that nothing under
   them can be read back: for passwords and account numbers) and **crop**, in eight colors and three sizes, with undo and
   redo. Keys: P, H, A, R, T, B, C for the tools; Ctrl+Z / Ctrl+Y; Ctrl+C copies; Ctrl+S saves.
4. Then **Copy**, **Save** (over the snapshot), **Save a copy**, **Show in folder**, **Delete**, or **Ask Fabrix**: a new
   chat with the picture attached, ready for your question ("what does this error mean?").

On a Mac, the first snapshot asks for **Screen Recording** permission (System Settings → Privacy & Security). On Linux
with Wayland, the system may ask which screen to share. Snapshot is in Endpoint Standard and up.

## Fabrix on FBRX Server

FBRX Server's console has a **Fabrix** page too: a chat with the server's own AI, which sets itself up with the best
model the server runs well. See [SERVER.md](SERVER.md#fabrix-in-the-console).
