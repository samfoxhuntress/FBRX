import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsSchema, TEXT_OPS, applySteps, expandMacro, slashAt, textOp, unescapeArg } from '../src';

const ctx = { name: 'Samuel Fox', callMe: 'Sam', host: 'LOBBY-PC', now: new Date(2026, 9, 2, 14, 5) };

describe('slash macros', () => {
  it('fills in placeholders and places the cursor', () => {
    expect(expandMacro('Thanks,\n{name}', ctx)).toEqual({ text: 'Thanks,\nSamuel Fox', cursor: 18 });
    expect(expandMacro('Hi {callme}, {cursor} from {host} on {isodate}', ctx)).toEqual({ text: 'Hi Sam,  from LOBBY-PC on 2026-10-02', cursor: 8 });
    expect(expandMacro('{clipboard}!', { ...ctx, clipboard: 'pasted' }).text).toBe('pasted!');
    expect(expandMacro('{CallMe}', { ...ctx, callMe: '' }).text).toBe('Samuel');
    expect(expandMacro('{unknown} stays', ctx).text).toBe('{unknown} stays');
  });

  it('finds the slash command before the caret, but not inside paths', () => {
    expect(slashAt('/sig', 4)).toEqual({ start: 0, word: 'sig' });
    expect(slashAt('please /st', 10)).toEqual({ start: 7, word: 'st' });
    expect(slashAt('/', 1)).toEqual({ start: 0, word: '' });
    expect(slashAt('/snip', 5)).toEqual({ start: 0, word: 'snip', arg: '' });
    expect(slashAt('run /snip dns flush', 19)).toEqual({ start: 4, word: 'snip', arg: 'dns flush' });
    expect(slashAt('C:/Users', 8)).toBeNull();
    expect(slashAt('cd /var/log', 11)).toBeNull();
    expect(slashAt('/sig and more', 13)).toBeNull();
  });

  it('ships default macros that pass the settings schema', () => {
    expect(() => SettingsSchema.parse(DEFAULT_SETTINGS)).not.toThrow();
    expect(DEFAULT_SETTINGS.macros.map((m) => m.trigger)).toEqual(['sig', 'stamp', 'flushdns']);
    expect(DEFAULT_SETTINGS.clipboard.history).toBe(false);
  });
});

describe('clipboard transforms', () => {
  const run = (text: string, ...steps: Array<{ op: string; a?: string; b?: string; flag?: boolean }>) => {
    const r = applySteps(text, steps);
    expect(r.errors).toEqual([]);
    return r.text;
  };

  it('every step has a unique id and runs on ordinary text', () => {
    expect(new Set(TEXT_OPS.map((o) => o.id)).size).toBe(TEXT_OPS.length);
    for (const op of TEXT_OPS) {
      if (op.id === 'jsonPretty' || op.id === 'jsonMinify' || op.id === 'base64Decode') continue;
      expect(() => op.run('Hello  "world"\nhello again\n', { op: op.id })).not.toThrow();
    }
  });

  it('cleans up, de-duplicates and sorts lines', () => {
    expect(run('  b \n\n a\nb\n', { op: 'trimLines' }, { op: 'removeBlank' }, { op: 'dedupe' }, { op: 'sort' })).toBe('a\nb');
    expect(run('B\nb\na', { op: 'dedupe', flag: true })).toBe('B\na');
    expect(run('item10\nitem9\nitem1', { op: 'sort' })).toBe('item1\nitem9\nitem10');
    expect(run('a\nb', { op: 'sort', flag: true })).toBe('b\na');
    expect(run('“Smart” ‘quotes’ — and…', { op: 'straightQuotes' })).toBe(`"Smart" 'quotes' - and...`);
    expect(run('a\u200bb\u00a0c', { op: 'invisible' })).toBe('ab c');
    expect(run('<p>Hi &amp; <b>bye</b></p><br>x &#65;', { op: 'stripHtml' })).toBe('Hi & bye\n\nx A');
    expect(run('\u001b[31mred\u001b[0m', { op: 'stripAnsi' })).toBe('red');
    expect(run('a\nb', { op: 'lineEndings' })).toBe('a\r\nb');
  });

  it('builds a PowerShell array from lines (the built-in macro)', () => {
    const m = DEFAULT_SETTINGS.clipboard.macros.find((x) => x.id === 'c-ps')!;
    expect(applySteps(' srv1\nsrv2\n\nsrv1 ', m.steps)).toEqual({ text: "@('srv1', 'srv2')", errors: [] });
  });

  it('changes case and joins, splits and wraps', () => {
    expect(run('hello big world', { op: 'title' })).toBe('Hello Big World');
    expect(run('HELLO. how ARE you? fine', { op: 'sentence' })).toBe('Hello. How are you? Fine');
    expect(run('Get user name', { op: 'camel' })).toBe('getUserName');
    expect(run('getUserName', { op: 'snake' })).toBe('get_user_name');
    expect(run('Get User Name', { op: 'kebab' })).toBe('get-user-name');
    expect(run('a,b , c', { op: 'split' })).toBe('a\nb\nc');
    expect(run('a\nb', { op: 'join', a: ' | ' })).toBe('a | b');
    expect(run('a\nb', { op: 'join', a: '\\t' })).toBe('a\tb');
    expect(run('a\nb', { op: 'numberLines' })).toBe('1. a\n2. b');
    expect(run('x', { op: 'wrap', a: '[', b: ']' })).toBe('[x]');
  });

  it('finds, replaces, filters and extracts', () => {
    expect(run('a.b.c', { op: 'replace', a: '.', b: '-' })).toBe('a-b-c');
    expect(run('v1 v22', { op: 'replace', a: 'v(\\d+)', b: 'n$1', flag: true })).toBe('n1 n22');
    expect(run('ok\nERROR one\nwarn', { op: 'keep', a: 'error' })).toBe('ERROR one');
    expect(run('ok\nERROR one\nwarn', { op: 'drop', a: '^(ok|warn)$', flag: true })).toBe('ERROR one');
    expect(run('mail sam@example.com and x@y.org, again sam@example.com', { op: 'emails' })).toBe('sam@example.com\nx@y.org');
    expect(run('see https://fbrx.example/a?b=1. and http://x.io', { op: 'urls' })).toBe('https://fbrx.example/a?b=1\nhttp://x.io');
    expect(run('gw 192.168.1.1, bad 999.1.1.1, v6 fe80::1:2:3:4', { op: 'ips' })).toContain('192.168.1.1');
    expect(run('gw 192.168.1.1, bad 999.1.1.1', { op: 'ips' })).not.toContain('999');
    expect(run('aa:bb:cc:dd:ee:ff and 0011.2233.4455', { op: 'macs' })).toBe('aa:bb:cc:dd:ee:ff\n0011.2233.4455');
    expect(run('order 12 costs 3.50', { op: 'extract', a: '\\d+(\\.\\d+)?' })).toBe('12\n3.50');
  });

  it('encodes and formats', () => {
    expect(run('héllo ✓', { op: 'base64Encode' }, { op: 'base64Decode' })).toBe('héllo ✓');
    expect(run('a b&c', { op: 'urlEncode' })).toBe('a%20b%26c');
    expect(run('a+b%26c', { op: 'urlDecode' })).toBe('a b&c');
    expect(run('{"a":1,"b":[2]}', { op: 'jsonPretty' })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(run('{ "a" : 1 }', { op: 'jsonMinify' })).toBe('{"a":1}');
    expect(run('<a href="x">', { op: 'htmlEscape' })).toBe('&lt;a href=&quot;x&quot;&gt;');
    expect(run('Name,Role\n"Fox, Sam",Admin\nAlex,User', { op: 'csvTable' })).toBe('| Name | Role |\n| --- | --- |\n| Fox, Sam | Admin |\n| Alex | User |');
    expect(run('A\tB\n1\t2', { op: 'csvTable' })).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('reports a failing step and keeps going', () => {
    const r = applySteps('not json', [{ op: 'jsonPretty' }, { op: 'upper' }, { op: 'nope' }]);
    expect(r.text).toBe('NOT JSON');
    expect(r.errors.map((e) => e.index)).toEqual([0, 2]);
    expect(r.errors[0].message).toMatch(/Format JSON/);
    expect(textOp('upper')?.label).toBe('UPPERCASE');
    expect(unescapeArg('a\\nb\\tc\\\\')).toBe('a\nb\tc\\');
  });
});
