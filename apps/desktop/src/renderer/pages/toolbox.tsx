import { useState, type ReactNode } from 'react';
import { AdvancedTag, Button, Card, Field, Input, Page, TextArea, Toggle, useToast } from '@fbrx/ui';

/** `advanced`: developer and network tools, shown in Advanced mode only. */
type Tool = { id: string; name: string; hint: string; advanced?: boolean };
const TOOLS: Tool[] = [
  { id: 'password', name: 'Passwords', hint: 'Strong random passwords' },
  { id: 'text', name: 'Text tools', hint: 'Counts, case, sort, de-duplicate' },
  { id: 'color', name: 'Colors', hint: 'HEX ↔ RGB ↔ HSL' },
  { id: 'time', name: 'Timestamps', hint: 'Unix time ↔ dates', advanced: true },
  { id: 'json', name: 'JSON formatter', hint: 'Format, minify and validate JSON', advanced: true },
  { id: 'base64', name: 'Base64', hint: 'Encode and decode text', advanced: true },
  { id: 'url', name: 'URL tools', hint: 'Encode, decode and take apart links', advanced: true },
  { id: 'hash', name: 'Hashes', hint: 'SHA-1, SHA-256, SHA-384, SHA-512', advanced: true },
  { id: 'uuid', name: 'UUIDs', hint: 'Random unique identifiers', advanced: true },
  { id: 'regex', name: 'Regex tester', hint: 'Try a pattern against text', advanced: true },
  { id: 'jwt', name: 'JWT decoder', hint: 'Read a token (no verification)', advanced: true },
  { id: 'subnet', name: 'Subnet calculator', hint: 'Network, mask, host range', advanced: true },
];

const b64enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64dec = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.trim().replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

function Out({ value }: { value: string }) {
  const toast = useToast();
  if (!value) return null;
  return (
    <div className="tool-out">
      <pre className="fx-code" style={{ margin: 0, maxHeight: 360 }}>
        {value}
      </pre>
      <Button size="sm" icon="copy" onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success('Copied'))}>
        Copy
      </Button>
    </div>
  );
}

function useRunner() {
  const [out, setOut] = useState('');
  const run = async (fn: () => string | Promise<string>) => {
    try {
      setOut(await fn());
    } catch (e) {
      setOut(`Error: ${(e as Error).message}`);
    }
  };
  return { out, run };
}

function Pane({ id }: { id: string }) {
  const [input, setInput] = useState('');
  const [extra, setExtra] = useState('');
  const [flag, setFlag] = useState(true);
  const { out, run } = useRunner();
  const area = (rows = 8, placeholder = '') => <TextArea code rows={rows} value={input} placeholder={placeholder} onChange={(e) => setInput(e.target.value)} />;
  const buttons = (items: Array<[string, () => string | Promise<string>, boolean?]>): ReactNode => (
    <div className="fx-actions">
      {items.map(([label, fn, primary]) => (
        <Button key={label} variant={primary ? 'primary' : undefined} onClick={() => void run(fn)}>
          {label}
        </Button>
      ))}
    </div>
  );
  switch (id) {
    case 'json':
      return (
        <>
          {area(12, '{"paste": "json"}')}
          {buttons([
            ['Format', () => JSON.stringify(JSON.parse(input), null, 2), true],
            ['Minify', () => JSON.stringify(JSON.parse(input))],
            [
              'Validate',
              () => {
                const v = JSON.parse(input);
                return `Valid JSON · ${Array.isArray(v) ? `array of ${v.length}` : v && typeof v === 'object' ? `object with ${Object.keys(v).length} keys` : typeof v}`;
              },
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'base64':
      return (
        <>
          {area()}
          {buttons([
            ['Encode', () => b64enc(input), true],
            ['Decode', () => b64dec(input)],
          ])}
          <Out value={out} />
        </>
      );
    case 'url':
      return (
        <>
          {area(5)}
          {buttons([
            ['Encode', () => encodeURIComponent(input), true],
            ['Decode', () => decodeURIComponent(input)],
            [
              'Take apart',
              () => {
                const u = new URL(input.trim());
                return JSON.stringify({ protocol: u.protocol, host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), hash: u.hash }, null, 2);
              },
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'hash':
      return (
        <>
          {area(6, 'Text to hash')}
          {buttons([
            [
              'Hash',
              async () => {
                const data = new TextEncoder().encode(input);
                const rows = await Promise.all(
                  ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].map(async (al) => {
                    const h = new Uint8Array(await crypto.subtle.digest(al, data));
                    return `${al.padEnd(8)} ${[...h].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
                  }),
                );
                return rows.join('\n');
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'uuid':
      return (
        <>
          <Field label="How many">
            <Input type="number" min={1} max={500} value={input || '5'} onChange={(e) => setInput(e.target.value)} style={{ width: 120 }} />
          </Field>
          {buttons([['Generate', () => Array.from({ length: Math.max(1, Math.min(500, Number(input) || 5)) }, () => crypto.randomUUID()).join('\n'), true]])}
          <Out value={out} />
        </>
      );
    case 'password':
      return (
        <>
          <div className="fx-row">
            <Field label="Length">
              <Input type="number" min={8} max={128} value={input || '24'} onChange={(e) => setInput(e.target.value)} />
            </Field>
            <Field label=" ">
              <Toggle checked={flag} onChange={setFlag} label="Include symbols" />
            </Field>
          </div>
          {buttons([
            [
              'Generate',
              () => {
                const cs = `ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789${flag ? '!@#$%^&*()-_=+[]{};:,.?' : ''}`;
                const n = Math.max(8, Math.min(128, Number(input) || 24));
                // Rejection sampling keeps every character equally likely.
                const pick = () => {
                  const limit = 256 - (256 % cs.length);
                  for (;;) {
                    const b = crypto.getRandomValues(new Uint8Array(1))[0];
                    if (b < limit) return cs[b % cs.length];
                  }
                };
                return Array.from({ length: 5 }, () => Array.from({ length: n }, pick).join('')).join('\n');
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'time':
      return (
        <>
          <Input placeholder="Unix seconds or milliseconds, or a date; leave empty for now" value={input} onChange={(e) => setInput(e.target.value)} />
          {buttons([
            [
              'Convert',
              () => {
                const t = input.trim();
                const d = !t ? new Date() : /^\d+$/.test(t) ? new Date(t.length > 11 ? Number(t) : Number(t) * 1000) : new Date(t);
                if (Number.isNaN(d.getTime())) throw new Error('Unrecognized date');
                return [`Local      ${d.toString()}`, `ISO (UTC)  ${d.toISOString()}`, `Unix (s)   ${Math.floor(d.getTime() / 1000)}`, `Unix (ms)  ${d.getTime()}`].join('\n');
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'regex':
      return (
        <>
          <div className="fx-row">
            <Field label="Pattern">
              <Input className="fx-input mono" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="\\b\\w+@\\w+\\.\\w+\\b" />
            </Field>
          </div>
          {area(8, 'Text to search')}
          {buttons([
            [
              'Find matches',
              () => {
                const rx = new RegExp(extra, 'g');
                const m = [...input.matchAll(rx)];
                return m.length ? `${m.length} match(es)\n\n${m.slice(0, 200).map((x, k) => `#${k + 1} at ${x.index}: ${JSON.stringify(x[0])}${x.length > 1 ? `  groups ${JSON.stringify(x.slice(1))}` : ''}`).join('\n')}` : 'No matches';
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'text': {
      const words = () => input.match(/[\p{L}\p{N}']+/gu) ?? [];
      return (
        <>
          {area(10)}
          {buttons([
            ['Count', () => `Characters  ${input.length}\nWords       ${words().length}\nLines       ${input ? input.split('\n').length : 0}\nReading     ~${Math.max(1, Math.round(words().length / 230))} min`, true],
            ['UPPER', () => input.toUpperCase()],
            ['lower', () => input.toLowerCase()],
            ['Title Case', () => input.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase())],
            ['snake_case', () => words().map((w) => w.toLowerCase()).join('_')],
            ['camelCase', () => words().map((w, k) => (k ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')],
            ['Sort lines', () => input.split('\n').sort((a, b) => a.localeCompare(b)).join('\n')],
            ['Remove duplicates', () => [...new Set(input.split('\n'))].join('\n')],
          ])}
          <Out value={out} />
        </>
      );
    }
    case 'color':
      return (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input className="fx-input mono" placeholder="#f0a530, rgb(240,165,48) or hsl(36,86%,56%)" value={input} onChange={(e) => setInput(e.target.value)} />
            <input type="color" aria-label="Pick a color" value={/^#[0-9a-f]{6}$/i.test(input) ? input : '#f0a530'} onChange={(e) => setInput(e.target.value)} style={{ width: 44, height: 34, border: 0, background: 'none' }} />
          </div>
          {buttons([
            [
              'Convert',
              () => {
                const v = input.trim() || '#f0a530';
                let r: number, g: number, b: number;
                let m: RegExpMatchArray | null;
                if ((m = v.match(/^#?([0-9a-f]{6})$/i))) {
                  const n = parseInt(m[1], 16);
                  [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
                } else if ((m = v.match(/^hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i))) {
                  const [h, s, l] = [Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100];
                  const f = (n: number) => {
                    const k = (n + h * 12) % 12;
                    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
                  };
                  [r, g, b] = [f(0), f(8), f(4)];
                } else if ((m = v.match(/(\d+)\D+(\d+)\D+(\d+)/))) [r, g, b] = m.slice(1, 4).map(Number);
                else throw new Error('Use #rrggbb, rgb(r,g,b) or hsl(h,s%,l%)');
                const max = Math.max(r, g, b) / 255;
                const min = Math.min(r, g, b) / 255;
                const l = (max + min) / 2;
                const d = max - min;
                const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
                let h = 0;
                if (d) {
                  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
                  h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
                  h = Math.round(h * 60 + 360) % 360;
                }
                return `HEX  #${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}\nRGB  rgb(${r}, ${g}, ${b})\nHSL  hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'jwt':
      return (
        <>
          {area(5, 'eyJhbGciOi…')}
          {buttons([
            [
              'Decode',
              () => {
                const [h, p] = input.trim().split('.');
                if (!h || !p) throw new Error('Not a JWT');
                const payload = JSON.parse(b64dec(p));
                const exp = payload.exp ? `\n\nExpires ${new Date(payload.exp * 1000).toISOString()}${payload.exp * 1000 < Date.now() ? ' (expired)' : ''}` : '';
                return `Header\n${JSON.stringify(JSON.parse(b64dec(h)), null, 2)}\n\nPayload\n${JSON.stringify(payload, null, 2)}${exp}\n\nThe signature is not verified.`;
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    case 'subnet':
      return (
        <>
          <Input className="fx-input mono" placeholder="192.168.1.20/24" value={input} onChange={(e) => setInput(e.target.value)} />
          {buttons([
            [
              'Calculate',
              () => {
                const m = input.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
                if (!m) throw new Error('Use address/prefix, for example 192.168.1.20/24');
                const parts = m.slice(1, 5).map(Number);
                const bits = Number(m[5]);
                if (parts.some((p) => p > 255) || bits > 32) throw new Error('Invalid address');
                const ip = parts.reduce((a, o) => (a << 8) + o, 0) >>> 0;
                const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
                const net = (ip & mask) >>> 0;
                const bc = (net | (~mask >>> 0)) >>> 0;
                const s = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255].join('.');
                const hosts = bits >= 31 ? 2 ** (32 - bits) : Math.max(0, 2 ** (32 - bits) - 2);
                return [`Network     ${s(net)}/${bits}`, `Mask        ${s(mask)}`, `Broadcast   ${s(bc)}`, `First host  ${s(bits >= 31 ? net : net + 1)}`, `Last host   ${s(bits >= 31 ? bc : bc - 1)}`, `Hosts       ${hosts.toLocaleString()}`].join('\n');
              },
              true,
            ],
          ])}
          <Out value={out} />
        </>
      );
    default:
      return null;
  }
}

/** Offline developer and everyday utilities. Nothing typed here leaves this computer. */
export function ToolboxPage({ advanced }: { advanced: boolean }) {
  const tools = TOOLS.filter((t) => advanced || !t.advanced);
  const [picked, setActive] = useState('password');
  const active = tools.some((t) => t.id === picked) ? picked : tools[0].id;
  const tool = tools.find((t) => t.id === active)!;
  return (
    <Page title="Toolbox" description={advanced ? 'Handy utilities that run entirely on this computer.' : 'Handy utilities that run entirely on this computer. Advanced mode adds developer and network tools.'}>
      <div className="toolbox">
        <Card className="toolbox-list" flush>
          {tools.map((t) => (
            <button key={t.id} className={`agent-conv${active === t.id ? ' active' : ''}`} onClick={() => setActive(t.id)}>
              <div className="agent-conv-title">
                {t.name}
                {t.advanced && <AdvancedTag />}
              </div>
              <div className="agent-conv-sub">{t.hint}</div>
            </button>
          ))}
        </Card>
        <Card title={tool.name} subtitle={tool.hint}>
          <div className="fx-grid" style={{ gap: 12 }} key={active}>
            <Pane id={active} />
          </div>
        </Card>
      </div>
    </Page>
  );
}
