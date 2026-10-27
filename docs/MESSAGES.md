# Messages

**Messages** (in the sidebar, under Glass, in every edition) is chat between computers, for two kinds of
neighbors:

* **My devices**: your other computers and your phone on FBRX Mesh. Messages go straight from one device to the
  other, encrypted end to end; nothing passes through FBRX Command or any other server.
* **Your organization or family**: every computer in the same FBRX Command tenant. FBRX Command passes these
  messages on at once over the connection each computer already keeps open, and keeps them for 180 days, so a
  computer that was off finds them when it starts.

A family can talk here instead of using the help desk: "Can I play for ten more minutes?" goes from a child's laptop
to a parent's desktop in a second, and the answer comes straight back. On a Home tenant, the Help desk tab stays with
Endpoint Ultra (a parent's computer that receives the children's requests, say); Messages is in every edition. Work
and School tenants keep the help desk for tickets to IT, next to Messages.

## Conversations

| Conversation | Who is in it |
| --- | --- |
| **Everyone on my mesh** | Every paired device that takes messages (Mesh & phone → its permissions → Messages) |
| A computer or phone on your mesh | Just the two of you |
| **Everyone at** *your organization* | Every computer in the tenant, and FBRX Command's own people, who can post here too |
| A computer in your organization | Just the two computers |

Small organizations (up to 12 computers) list every computer; larger ones list the computers you have talked with,
and **New message** finds any other by name. Each conversation shows whether the other computer is online, what was
said last and how many messages are new. The sidebar counts everything unread.

Writing: **Enter** sends, **Shift+Enter** starts a new line, up to 4,000 characters.

## Delivery

* A mesh message to a computer that is switched off waits on yours and goes when that computer is back (for up to a
  week); it shows *waiting* until then. A computer that turned Messages off answers so, and the message shows *not
  delivered* with **Try again**.
* A message to everyone on the mesh goes to every device that is on; it shows how many it reached.
* Phones get messages the next time FBRX Mobile checks in.
* Organization messages wait in FBRX Command for computers that are off.

A notification pops up for each new message, with **Open**, except for the conversation already on the screen.
Presenter-safe mode keeps them quiet and blurs Messages, like other private lists.

## Settings and policy

Settings → **Messages** on each computer:

| Setting | What it does |
| --- | --- |
| Messages | The page itself. Off hides it and turns messages from your mesh away. |
| Chat with *your organization* | Messages with the other computers in the tenant. Off keeps Messages to your own mesh. |
| Notify me about new messages | The pop-ups. |

In FBRX Command:

* **Profiles & groups → Organization defaults → Messages** turns organization messages on or off for the whole
  tenant.
* In a profile, the **Messages** area holds the same three switches (`messages.enabled`,
  `messages.organization`, `messages.notify`), and the **No chatting** preset turns Messages off and locks it, for a
  classroom group say. Help desk tickets keep working.
* Student computers in a School tenant start with organization messages off; the school's own profiles can turn them
  on. Children's computers at home have them on.
* The **Messages** page shows the *Everyone* conversation: post to it (operators and up) and remove what does not
  belong. Messages between two computers are not shown in the console; FBRX Command keeps them for 180 days, then
  drops them.

## For developers

Thread ids are `mesh:all`, `mesh:<device fingerprint>`, `org:all` and `org:<device id>`. The core methods are
`messages.overview`, `messages.thread`, `messages.send`, `messages.read`, `messages.focus`, `messages.resend`,
`messages.directory` and `messages.unread`; `messages.changed` fires on every new message, delivery change and read.
FBRX Command's device routes live under `/v1/device/chat` and its console routes under `/v1/admin/chat/messages`;
new messages reach computers as `chat.message` over the device WebSocket.
