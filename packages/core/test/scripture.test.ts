import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { findBook, parseReference, Scripture } from '../src/scripture/scripture';
import { shortlistTools } from '../src/ai/tool-shortlist';
import { makeKernel } from './helpers';

const DIR = resolve(__dirname, '../../../apps/desktop/resources/scripture');
const bible = new Scripture(() => DIR);
const look = (ref: string, version?: string) => bible.lookup(ref, version).output;

describe('scripture.lookup: Bible verses word for word, offline', () => {
  it('quotes the exact words with the reference, KJV unless another version is named', () => {
    expect(look('John 3:16')).toBe(
      "John 3:16 (King James Version, KJV), word for word from FBRX's verified copy. Quote it exactly as it stands, with its reference:\n[16] For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.",
    );
    expect(look('John 3:16', 'WEB')).toMatch(/^John 3:16 \(World English Bible, WEB\)[^\n]*\n\[16\] For God so loved the world, that he gave his only born Son/);
    // The version may come with the reference.
    expect(look('John 3:16 (BSB)')).toMatch(/\(Berean Standard Bible, BSB\)/);
    expect(look('Jn 3:16', 'young')).toMatch(/Young's Literal Translation, YLT/);
    expect(look('John 3:16', 'NIV')).toMatch(/^FBRX has no "NIV" text\. It has: KJV \(King James Version\), ASV/);
  });

  it('reads references as people write them', () => {
    expect(look('Ps 23')).toMatch(/^Psalms 23:1-6 \(King James Version, KJV\)[^\n]*\n\[1\] The LORD is my shepherd; I shall not want\.\n\[2\][\s\S]*\[6\] /);
    expect(look('1 Cor 13:4-7').split('\n')).toHaveLength(5);
    expect(look('Genesis 1:31-2:3')).toMatch(/^Genesis 1:31-2:3[^\n]*\n\[1:31\] [^\n]+\n\[2:1\] Thus the heavens and the earth were finished/);
    expect(look('Isaiah 40-41')).toMatch(/^Isaiah 40:1-41:9 [\s\S]*…40 verses shown; the passage goes on from Isaiah 41:10\./);
    expect(look('Jude 3')).toMatch(/^Jude 1:3 /);
    expect(look('II Kings 2:11')).toMatch(/^2 Kings 2:11 [\s\S]*chariot of fire/);
    expect(look('First John 4:8')).toMatch(/^1 John 4:8 [\s\S]*God is love/);
    expect(look('Song of Songs 2:1')).toMatch(/^Song of Solomon 2:1 [\s\S]*rose of Sharon/);
    expect(look('Psalm 119')).toMatch(/^Psalms 119:1-40 [\s\S]*goes on from Psalms 119:41\./);
    for (const [text, book] of [['Deuter', 'Deuteronomy'], ['Philipp', 'Philippians'], ['Rev', 'Revelation'], ['Ecclesiasticus', 'Sirach'], ['Jud', null], ['Phil', 'Philippians']] as const) expect(findBook(text)).toBe(book);
    expect(parseReference('see John')).toEqual({ invalid: true });
  });

  it('gives a plain no for a book or verse that does not exist', () => {
    expect(look('3 Timothy 2:4')).toBe('No such book: there is no "3 Timothy" in the Bible (nor in the Apocrypha). Do not quote one.');
    expect(look('Hezekiah 4:12')).toBe('No such book: there is no "Hezekiah" in the Bible (nor in the Apocrypha). Do not quote one.');
    expect(look('Genesis 51:1')).toBe('No such verse: Genesis has 50 chapters, so there is no chapter 51. Do not quote one.');
    expect(look('John 3:99')).toBe('No such verse: John 3 has 36 verses, so there is no verse 99. Do not quote one.');
    expect(look('John 3:18-16')).toMatch(/runs backwards/);
    expect(look('the one about love')).toMatch(/is not a reference FBRX can read/);
  });

  it('says when a version leaves a verse out, and keeps the Apocrypha in the KJV', () => {
    expect(look('Matthew 17:21', 'ASV')).toMatch(/^Matthew 17:21 is not in the ASV: it leaves out a few verses .* The KJV has it/);
    expect(look('Matthew 17:20-22', 'ASV')).toMatch(/\[20\] [^\n]+\n\[22\] [^\n]+\n\(Not in the ASV: Matthew 17:21;/);
    expect(look('Tobit 1:1')).toMatch(/^Tobit 1:1 \(King James Version, Apocrypha, KJV\)/);
    expect(look('Tobit 1:1', 'ASV')).toMatch(/only in the KJV/);
  });

  it('refuses a damaged text instead of quoting it, and is hidden where the texts are not installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-scripture-'));
    const text = brotliDecompressSync(readFileSync(join(DIR, 'kjv.jsonl.br'))).toString('utf8').replace('For God so loved', 'For God so liked');
    // The fastest Brotli setting: the default (11) keeps a core busy for seconds and starves the timing tests beside
    // it.
    writeFileSync(join(dir, 'kjv.jsonl.br'), brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }));
    copyFileSync(join(DIR, 'kjv-build.json'), join(dir, 'kjv-build.json'));
    expect(() => new Scripture(() => dir).lookup('John 3:16')).toThrow(/damaged, so it is not quoted/);
    expect(new Scripture(() => null).unavailable()).toMatch(/not installed/);
    expect(new Scripture(() => join(dir, 'nowhere')).unavailable()).toMatch(/not installed/);
    expect(bible.unavailable()).toBeNull();
  });

  it('comes to a small model when the person asks for scripture, and not for a John who is a person', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const tool = kernel.registry.get('scripture.lookup')!;
      expect(tool.risk).toBe('read');
      const all = kernel.registry.list();
      const offered = (ask: string) => shortlistTools(all, [ask]).some((t) => t.name === 'scripture.lookup');
      for (const ask of ['What does John 3:16 say?', 'Read me Psalm 23', 'Can you give me a Bible verse about hope?', 'quote 1 Cor 13:4-7 in the KJV', 'Which verse says the Lord is my shepherd?']) expect(offered(ask), ask).toBe(true);
      for (const ask of ['Text John that I will be late', 'my job starts at 9', 'Mark the task as done', 'my MacBook Pro 14 is slow', 'the router is rev 2', 'meeting on Mar 15']) expect(offered(ask), ask).toBe(false);
      for (const ask of ['Rev 3:20 please', 'what does 1 Cor 13:4 say', 'Psalm 46']) expect(offered(ask), ask).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
