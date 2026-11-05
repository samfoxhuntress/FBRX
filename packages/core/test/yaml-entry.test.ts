import { describe, expect, it } from 'vitest';
import { readYamlEntry, setYamlEntry } from '../src/aicoord/yaml-entry';

const FBRX = { command: '/opt/FBRX OS/fbrx', args: ['fbrx-mcp.mjs'], env: { FBRX_DATA_DIR: 'C:\\data' } };

const HERMES = `# Hermes Agent settings
model:
  default: some-model   # the usual one

mcp_servers:
  # Files on this computer
  files:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"]

  github:
    url: https://example.com/mcp

terminal:
  backend: local
`;

describe('YAML config entries', () => {
  it('adds, replaces and removes its entry and keeps every other line', () => {
    const added = setYamlEntry(HERMES, 'mcp_servers', 'fbrx', FBRX);
    expect(added).toBe(HERMES.replace('    url: https://example.com/mcp\n', `    url: https://example.com/mcp\n  fbrx: {"command": "/opt/FBRX OS/fbrx", "args": ["fbrx-mcp.mjs"], "env": {"FBRX_DATA_DIR": "C:\\\\data"}}\n`));
    expect(readYamlEntry(added, 'mcp_servers', 'fbrx')).toEqual(FBRX);

    const replaced = setYamlEntry(added, 'mcp_servers', 'fbrx', { ...FBRX, args: ['other.mjs'] });
    expect(replaced.split('\n')).toHaveLength(added.split('\n').length);
    expect(readYamlEntry(replaced, 'mcp_servers', 'fbrx')).toMatchObject({ args: ['other.mjs'] });

    expect(setYamlEntry(replaced, 'mcp_servers', 'fbrx', null)).toBe(HERMES);
    expect(setYamlEntry(HERMES, 'mcp_servers', 'fbrx', null)).toBe(HERMES);
    expect(readYamlEntry(HERMES, 'mcp_servers', 'files')).toEqual({}); // written by hand: found, not parsed
  });

  it('starts the servers list when the file has none, or an empty one', () => {
    expect(setYamlEntry('', 'mcp_servers', 'fbrx', { command: 'x', args: [] })).toBe('mcp_servers:\n  fbrx: {"command": "x", "args": []}\n');
    expect(setYamlEntry('model: m\n', 'mcp_servers', 'fbrx', { command: 'x', args: [] })).toBe('model: m\n\nmcp_servers:\n  fbrx: {"command": "x", "args": []}\n');
    expect(setYamlEntry('mcp_servers: {}\nother: 1\n', 'mcp_servers', 'fbrx', { command: 'x', args: [] })).toBe('mcp_servers:\n  fbrx: {"command": "x", "args": []}\nother: 1\n');
  });

  it("follows the file's indent and line endings, and leaves a one-line servers list alone", () => {
    const crlf = 'mcp_servers:\r\n    files:\r\n        command: npx\r\nother: 1\r\n';
    expect(setYamlEntry(crlf, 'mcp_servers', 'fbrx', { command: 'x', args: [] })).toBe('mcp_servers:\r\n    files:\r\n        command: npx\r\n    fbrx: {"command": "x", "args": []}\r\nother: 1\r\n');
    expect(() => setYamlEntry('mcp_servers: {files: {command: npx}}\n', 'mcp_servers', 'fbrx', FBRX)).toThrow(/on one line/);
  });
});
