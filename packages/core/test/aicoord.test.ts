import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeKernel, waitFor, USER } from './helpers';
import { AiCoordination } from '../src/aicoord/aicoord';

const SHIM = resolve(__dirname, '../src/aicoord/mcp-shim.ts');

describe('AI coordination', () => {
  it('lets an MCP client use FBRX tools through the governed Local API', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel({ localApiPort: 47831 });
    const client = new Client({ name: 'test-host', version: '1.0.0' });
    try {
      await waitFor(() => kernel.localApi.running);
      const tokenFile = JSON.parse(readFileSync(join(kernel.paths.root, 'localapi-agent.json'), 'utf8'));
      expect(tokenFile.url).toBe('http://127.0.0.1:47831');

      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', SHIM],
          env: { ...process.env, FBRX_DATA_DIR: kernel.paths.root } as Record<string, string>,
          cwd: resolve(__dirname, '../../..'),
        }),
      );
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['ask_fabric', 'time__now', 'workspace__add_task', 'fs__write_file']));

      const now = await client.callTool({ name: 'time__now', arguments: {} });
      expect(now.isError).toBe(false);
      expect((now.content as any[])[0].text).toMatch(/ISO \d{4}-/);

      const added = await client.callTool({ name: 'workspace__add_task', arguments: { title: 'From Claude' } });
      expect(added.isError).toBe(false);
      expect(kernel.workspace.listTasks()[0].title).toBe('From Claude');

      // Changing files still waits for the person at the workstation.
      const pending = client.callTool({ name: 'fs__write_file', arguments: { path: join(sandbox, 'x.txt'), content: 'x' } });
      const approval = await waitFor(() => kernel.approvals.list()[0]);
      expect(approval.origin).toBe('api');
      kernel.approvals.resolve(approval.id, 'deny', 'test-user');
      const denied = await pending;
      expect(denied.isError).toBe(true);
      expect(existsSync(join(sandbox, 'x.txt'))).toBe(false);
      expect(kernel.audit.query({ category: 'tool', limit: 5 }).some((e) => e.action === 'fs.write_file' && e.outcome === 'denied')).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await cleanup();
    }
  });

  it('describes how AI apps start the bridge', () => {
    const co = new AiCoordination({ shim: () => ({ command: 'FBRX OS.exe', args: ['fbrx-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', FBRX_DATA_DIR: 'C:/data' } }), localApiRunning: () => true });
    const bridge = co.bridge();
    expect(bridge.ready).toBe(true);
    expect(JSON.parse(bridge.snippet).mcpServers.fbrx).toEqual({ command: 'FBRX OS.exe', args: ['fbrx-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', FBRX_DATA_DIR: 'C:/data' } });
    // The snippet never contains a token: the bridge reads it from the data folder at start-up.
    expect(bridge.snippet).not.toMatch(/fbrx_lapi_/);
    expect(new AiCoordination({ shim: () => null, localApiRunning: () => false }).bridge()).toMatchObject({ ready: false });
    expect(new AiCoordination({ shim: () => ({ command: 'x', args: [], env: {} }), localApiRunning: () => false }).bridge().reason).toMatch(/Local API/);
  });

  it('is reachable from the core API', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const apps = (await kernel.call('aicoord.detect', undefined, USER)) as any[];
      expect(apps.find((a) => a.id === 'claude-desktop')).toMatchObject({ mcp: true });
      expect(((await kernel.call('aicoord.bridge', undefined, USER)) as any).ready).toBe(false); // no shim in the headless runner
    } finally {
      await cleanup();
    }
  });
});
