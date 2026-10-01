# @fbrx/plugin-sdk

Build tools for the FBRX OS agent and connect it to anything.

```js
// index.js
import { definePlugin, defineTool } from '@fbrx/plugin-sdk';

export default definePlugin({
  tools: [
    defineTool({
      name: 'lookup',
      title: 'Look up an order',
      description: 'Fetches an order from the ACME order service by id.',
      risk: 'network',
      inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      async run({ orderId }, ctx) {
        const token = await ctx.secrets.get('ACME_TOKEN');
        const res = await ctx.http.fetch(`https://orders.acme.example/api/orders/${orderId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return { output: res.body.slice(0, 4000), data: JSON.parse(res.body) };
      },
    }),
  ],
});
```

```json
// fbrx-plugin.json
{
  "id": "com.acme.orders",
  "name": "ACME Orders",
  "version": "1.0.0",
  "namespace": "acme",
  "main": "index.js",
  "engines": { "fbrx": ">=1.0.0" },
  "permissions": ["network:orders.acme.example", "secrets:ACME_TOKEN"]
}
```

See `docs/PLUGINS.md` in the FBRX OS repository for the full guide (permissions, sandboxing, packaging,
remote deployment through the control plane).
