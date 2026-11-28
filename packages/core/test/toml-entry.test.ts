import { describe, expect, it } from 'vitest';
import { readTomlEntry, setTomlEntry } from '../src/aicoord/toml-entry';

const entry = { command: '/opt/FBRX OS/fbrx', args: ['fbrx-mcp.mjs'], env: { FBRX_DATA_DIR: '/home/sam/.fbrx' } };

describe("FBRX's table in a TOML config (Codex)", () => {
  it('adds, replaces and removes only its own table, sub-tables included', () => {
    const own = '# Codex\nmodel = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "npx"\n\n[profiles.work]\nmodel = "o4"\n';
    const added = setTomlEntry(own, 'mcp_servers', 'fbrx', entry);
    expect(added).toBe(`${own}\n[mcp_servers.fbrx]\ncommand = "/opt/FBRX OS/fbrx"\nargs = ["fbrx-mcp.mjs"]\nenv = { "FBRX_DATA_DIR" = "/home/sam/.fbrx" }\n`);
    expect(readTomlEntry(added, 'mcp_servers', 'fbrx')).toEqual(entry);
    // Replaced in place, with an old env sub-table taken along; what follows stays.
    const older = '[mcp_servers.fbrx]\ncommand = "old"\n[mcp_servers.fbrx.env]\nA = "1"\n\n[profiles.work]\nmodel = "o4"\n';
    expect(setTomlEntry(older, 'mcp_servers', 'fbrx', { command: 'new', args: [] })).toBe('[mcp_servers.fbrx]\ncommand = "new"\nargs = []\n\n[profiles.work]\nmodel = "o4"\n');
    expect(setTomlEntry(added, 'mcp_servers', 'fbrx', null)).toBe(own);
    expect(setTomlEntry('', 'mcp_servers', 'fbrx', null)).toBe('');
    expect(readTomlEntry(own, 'mcp_servers', 'fbrx')).toBeNull();
  });

  it('leaves an entry written another way alone, and says so', () => {
    expect(() => setTomlEntry('[mcp_servers]\nfbrx = { command = "x" }\n', 'mcp_servers', 'fbrx', entry)).toThrow(/written in a form FBRX does not change/);
    expect(() => setTomlEntry('mcp_servers.fbrx.command = "x"\n', 'mcp_servers', 'fbrx', entry)).toThrow(/written in a form/);
  });

  it('writes values TOML reads back as written (quotes, backslashes, Windows paths)', () => {
    const w = { command: 'C:\\Program Files\\FBRX OS\\FBRX OS.exe', args: ['say "hi"'], env: { 'A B': 'x\\y' } };
    expect(readTomlEntry(setTomlEntry('', 'mcp_servers', 'fbrx', w), 'mcp_servers', 'fbrx')).toEqual(w);
  });
});
