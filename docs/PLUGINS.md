# Extending FBRX OS: plugins, connectors and the Local API

There are three ways to add capabilities or connect FBRX OS to other software. All of them end up as **tools** in the
same registry, so everything the agent does with them is governed by policy, approvals and the audit log.

| You want to… | Use | Code needed |
| --- | --- | --- |
| Call an HTTP API (CRM, ticketing, ERP, an internal service) | **REST connector** | None — configure in **Connections** |
| Use an existing MCP server (GitHub, databases, Slack, …) | **MCP connector** (stdio or HTTP) | None |
| Push FBRX events to Slack/Teams/SIEM, or let the agent post messages | **Webhook connector** | None |
| Hand work to another workstation's agent | **FBRX peer connector** | None |
| Ship custom logic as an installable, versioned package | **Plugin** | JavaScript/TypeScript |
| Drive FBRX OS from scripts or another desktop app | **Local API** | Any language |

## Plugins

### Create one

```bash
npm run plugin:create -- order-lookup            # JavaScript; add --ts for TypeScript
# edit plugins/order-lookup/index.mjs
npm run plugin:pack -- plugins/order-lookup      # → plugins/order-lookup/dist-plugin/com.fbrx.order-lookup-0.1.0.tgz
```

Install the `.tgz` (or the folder, while developing) from **Tools & plugins → Install plugin**, push it to devices
from the admin console (**Plugins → Upload plugin**, then **Deploy**), or use
`window.fbrx.call('plugins.install', { path })` / the Local API.

`plugin:pack` validates the manifest, and with `--bundle` (automatic for TypeScript entry points) bundles the entry
point and its npm dependencies into a single `index.mjs`, so the package needs no `node_modules` on the target.

### Manifest — `fbrx-plugin.json`

```json
{
  "id": "com.acme.orders",
  "name": "ACME Orders",
  "version": "1.2.0",
  "description": "Look up and annotate orders in the ACME order service.",
  "author": "ACME IT",
  "namespace": "acme",
  "main": "index.mjs",
  "engines": { "fbrx": ">=1.0.0" },
  "permissions": ["network:orders.acme.example", "secrets:ACME_TOKEN", "storage"]
}
```

* `id` — reverse-DNS, unique. Installing the same id again upgrades in place (data is kept).
* `namespace` — tool prefix; `acme` + `lookup` → the agent sees `acme.lookup`. Must be unique per workstation.
* `permissions` — least privilege, enforced by the host:

| Permission | Grants |
| --- | --- |
| `storage` | `ctx.storage` — persistent JSON key/value store (travels with backups) |
| `notifications` | `ctx.notify(title, body)` |
| `secrets:<NAME>` | `ctx.secrets.get('<NAME>')` — one named vault secret (set it in **Vault**, or push it from the console) |
| `network:<host>` | `ctx.http.fetch` to that host; `*.example.com` and `*` allowed. Requests also pass network policy |

### Tools

```js
// @ts-check
/** @type {import('@fbrx/plugin-sdk').PluginDefinition} */
export default {
  async activate(ctx) {
    ctx.log.info('ready');
  },
  tools: [
    {
      name: 'lookup',
      title: 'Look up an order',
      description: 'Fetch an order by id from the ACME order service.', // the model reads this — be specific
      risk: 'network',
      inputSchema: {
        type: 'object',
        properties: { orderId: { type: 'string', description: 'e.g. SO-10442' } },
        required: ['orderId'],
      },
      async run({ orderId }, ctx, invocation) {
        const token = await ctx.secrets.get('ACME_TOKEN');
        const res = await ctx.http.fetch(`https://orders.acme.example/api/orders/${encodeURIComponent(orderId)}`, {
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: 15000,
        });
        if (res.status !== 200) return `Order service returned HTTP ${res.status}`;
        const order = JSON.parse(res.body);
        return { output: `Order ${order.id}: ${order.status}, ${order.lines.length} lines`, data: order };
      },
    },
  ],
};
```

* `risk` drives the default policy: `read` and `network` run, `write`, `execute` and `sensitive` ask for approval
  (administrators can change this per tool, per plugin or per origin).
* Return a string or `{ output, data }`. `output` goes back to the model (keep it short); `data` is for programmatic
  callers. Secret values are redacted from both.
* `invocation.signal` is aborted when the user cancels or the call times out.
* `deactivate()` runs before the worker stops.

### Sandbox

Each plugin runs in its own Node process:

* **Files** — Node's permission model limits reads to the plugin's own folder and writes to its data folder.
* **Processes** — child processes, worker threads and native addons are refused.
* **Network** — Node's permission model does not cover sockets, so the worker removes `fetch`, `WebSocket` and
  `EventSource`, refuses to load `net`, `tls`, `http(s)`, `http2`, `dgram`, `dns`, `child_process`, `cluster`,
  `worker_threads` and `inspector` (by import, `require` or `process.getBuiltinModule`), forbids installing further
  module loader hooks, and runs without stdio pipes. The only way out is `ctx.http.fetch`, which the host checks
  against the manifest's `network:` permissions and the workstation's network policy.
* **Secrets, storage, notifications** — brokered by the host and checked against the manifest.

Crashes are contained (the host restarts the worker with backoff) and every call is audited. This is defence in
depth, not a guarantee against a determined attacker with code execution, so treat plugins like any other software
you install: prefer packages published through your control plane, and review a plugin's permissions before
installing it.

## Connectors

Configure in **Connections → Add connection** (or push via managed configuration).

### REST

`baseUrl`, authentication (`bearer`, `basic`, custom header) using a **vault secret reference** — the credential
never appears in configuration or to the model. Requests are pinned to the base URL's origin. Without named
operations the agent gets a generic `<connection>.get` tool (and, if *allow write*, `<connection>.send` for
POST/PUT/PATCH/DELETE); named operations give it precise, documented tools:

```json
[
  { "name": "get_order", "method": "GET", "path": "orders/{id}", "description": "Fetch an order by id" },
  { "name": "add_note", "method": "POST", "path": "orders/{id}/notes", "description": "Append a note to an order" }
]
```

### MCP

* **stdio** — FBRX starts the server locally: `command` (`npx`, `uvx`, a binary), `args`, `env` (with
  `${secret:NAME}` placeholders resolved from the vault at launch), working directory.
* **HTTP** — Streamable HTTP endpoint with optional bearer/header auth from the vault.

Every MCP tool becomes `<connector>.<tool>` with a configurable default risk level, so a third-party server cannot
bypass approvals.

### Webhook (outgoing)

Sends selected events (`approval.requested`, `approval.resolved`, `agent.run.completed`, `agent.run.failed`,
`policy.denied`, `service.failed`, `fleet.changed`, `backup.completed`, `notification`) to any URL, signed with
`x-fbrx-signature: sha256=<hex HMAC of the raw body>` when a signing secret is set. Optionally the agent gets a
`<connection>.send` tool to post messages.

### FBRX peer

Points at another workstation's Local API with that machine's **agent-scoped** token. The agent gets
`<peer>.ask` (run a task on the peer's agent, under the peer's own policy) and `<peer>.status`.

## Local API

Enable in **Settings → Local API**. It listens on `http://127.0.0.1:47821` (remote access is opt-in) and accepts two
tokens shown on that page: **full** and **agent** (agent runs and tool calls only). Rotate them there.

```bash
TOKEN=...   # from Settings → Local API, or `fbrx-headless token`

# Run the agent to completion
curl -s localhost:47821/v1/agent/run -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"prompt":"Summarise the PDFs in ~/Reports into reports.md"}'

# Invoke a tool directly (still governed)
curl -s localhost:47821/v1/tools/fs.list_dir -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"input":{"path":"~/Documents"}}'

# Any core method (full token)
curl -s localhost:47821/v1/rpc -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"method":"backup.list","params":{}}'

# Live events (server-sent events)
curl -N "localhost:47821/v1/events?token=$TOKEN"
```

Errors come back as `{ "error": { "code", "message" } }` with matching HTTP status (403 for policy denials, 423
when the vault is locked, …). Calls made through the Local API are audited with origin `api`.

## Built-in tools

| Tool | Risk | Notes |
| --- | --- | --- |
| `fs.list_dir`, `fs.read_file`, `fs.search` | read | Allowed roots and deny patterns from policy |
| `fs.write_file`, `fs.make_dir`, `fs.delete_file` | write | Guardian blocks writes into system locations |
| `shell.run` | execute | Blocked patterns, timeout, working-directory confinement |
| `http.request` | network | Domain allow/block lists, private-network and rebinding protection |
| `system.info`, `system.processes`, `system.notify`, `time.now`, `fbrx.status`, `fbrx.audit_recent` | read | |
| `memory.remember`, `memory.recall`, `memory.forget` | write / read / write | Long-term memory stored locally; allowed without approval by the built-in policy rule |
