# Fabrix at work

Fabrix (the agent; its name is yours to change in Settings → Agent) does more than answer. It reads the files and
pictures you give it, makes documents and pictures, reads the web, does jobs by itself on a schedule, and looks at
your screen when you hand it a snapshot. Everything here follows the computer's policy like any other tool: what
needs a yes asks for one, and the audit log keeps what was done.

## How Fabrix works

Whatever model answers (on this computer, on your FBRX Server, FBRX Cloud AI or another cloud AI), FBRX gives it the
same rules:

- **Build alongside you, and heal what it touches.** It leaves files, settings and systems better than it found them,
  never worse, and prefers the fix that repairs a problem over one that hides it.
- **Do no harm, whoever asks.** Being told to is not enough: when a request would damage data, a computer, a network or
  a person, it says so and offers a safe way to what you need.
- **Point out what else needs care.** While it works it notices other problems (a failing service, a setting that
  weakens security, a nearly full disk) and lists them after the task under *Also noticed*, with the fix it recommends.
  It changes them only when you say yes.
- **Only claim what a tool confirmed.** If a tool failed, or it has none for what you asked, it says so.

## Its room: the context window and the monthly budget

- **The gauge under the chat** shows how much of the model's context window the conversation takes, such as
  *Context 9.8K / 16K tokens*: estimated when a chat opens, then as the provider counted each request. Amber past three
  quarters, red when full. Click it for AI usage.
- **Fabrix knows it too.** Once its room fills (past half of the context window or of the month's budget, or once
  older requests are folded), a short note goes with your message: its context window, how full it is, its longest
  answer, its steps for the task and, with a monthly budget, the month. Near a limit it works in fewer, smaller steps
  and says so once; at a limit it stops cleanly, with what is done, what is left and how to go on.
- **The built-in model's window fits the computer.** On **Auto** (the default from 2.2.0; Settings → Agent →
  Thinking → Memory of the built-in model) FBRX reads from the model file how much memory each token of context takes
  and gives it as much as the computer holds comfortably, after the model itself and 2 GB for everything else, up to
  64K tokens and never more than the model was made for. The context's memory is kept in 8 bits with flash attention,
  about half the size, so the same memory holds twice the conversation; a model or runtime that cannot do that is
  loaded again with the full-size one.
- **Long conversations are folded, not cut.** When the older requests no longer fit, they become a short digest: what
  was asked, what came of it, the tools used and the ids made (a project's, a note's), exactly. Nothing in the digest is
  made up, because no model is asked to summarize. The gauge says how many requests are folded.
- **Monthly cloud AI budget** (Settings → Agent): the most cloud AI may read and write on this computer in a month.
  Models on this computer are not counted. Past three quarters Fabrix works sparingly; at the limit a task stops between
  steps and new chats with cloud AI wait for next month or a higher budget.
- **AI usage** (next to AI models): this month's tokens by day and by model, the budget, what the agent's model holds,
  and your FBRX account's FBRX Cloud AI. Only counts are kept, never what was said.

## Skills: jobs it knows how to do

A skill is how Fabrix does a job of several steps, written down so it does it the same good way next time.

- **Starter skills** come with FBRX: *Slow or dropping Wi-Fi* (the channel planner, then ping and a speed test),
  *Free up disk space* (the storage report and the space hogs, safe things first), *Computer feels slow*, *Security
  check-up*, *What's on my network* and *Plan my day*.
- **Learned skills**: after a job that took three or more tool steps and is likely to come up again, Fabrix saves how
  it did it (`skills.save`). FBRX asks you first, like any change, so a skill is kept only when you approve it.
- **Your own**: Settings → Skills → **Add a skill**: a name, when to use it and the steps, one per line.
- The skills that fit what you ask (by the words of their name, when and keywords) go with your message, and the
  tools their steps name join a small model's short list of tools, so even a small model follows steps that worked.
  Settings → Skills shows each skill's steps and how often it was used, turns any of them off, and edits or deletes
  yours and the learned ones.

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
* **Scenes:** *"draw a mouse knight facing a giant by a castle"* becomes a storybook picture made from FBRX's own art:
  a backdrop (day, sunset, night, forest, sea, desert, snow, space, a castle hall), characters (a person, a giant, a
  mouse, a cat, a dog, a bird, a dragon) that can wear a helmet, crown, wizard hat, cap or hood and hold a sword,
  shield, staff, club, flag, lantern or torch, and scenery (trees, mountains, houses, castles, tents, a campfire, a
  treasure chest, boats, cars, rockets, the sun, the moon, clouds, stars), each recolored and named as asked. Fabrix
  only says what goes where; FBRX draws every piece, outlined and shaded, so even a small model on a laptop makes a
  good picture.
* **Pictures:** other drawings (charts, diagrams, icons, logos) are drawn on the computer, offline, as SVG and PNG.
  Generated images (photos and paintings from a description) need an image service: an OpenAI-compatible
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
5. Or press **Drag out** and drop the picture straight into another app (a chat, an email, a document, a folder), marks
   and crop included, saved or not. Snapshots in the list drag out the same way.

On a Mac, the first snapshot asks for **Screen Recording** permission (System Settings → Privacy & Security). On Linux
with Wayland, the system may ask which screen to share. Snapshot is in Endpoint Standard and up.

## Fabrix on FBRX Server

FBRX Server's console has a **Fabrix** page too: a chat with the server's own AI, which sets itself up with the best
model the server runs well. See [SERVER.md](SERVER.md#fabrix-in-the-console).
