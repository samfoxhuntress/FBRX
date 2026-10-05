import { useEffect, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { MacLookup } from '@fbrx/shared';
import { AdvancedTag, Button, Card, Field, Input, Page, Select, TextArea, Toggle, useToast } from '@fbrx/ui';
import { call } from '../client';
import { navigate } from '../app';
import { useCore } from '../hooks';
import { AskButton } from '../widgets';
import { COMMAND_GROUPS } from '../command-library';
import { unlockTrophy } from '../fun';
import { UltraHint } from '../edition';

interface Example {
  label: string;
  input?: string;
  extra?: string;
}
/** `advanced`: developer and network tools, in Endpoint Ultra only. `examples` fill the tool with a sample. */
type Tool = { id: string; name: string; hint: string; advanced?: boolean; examples?: Example[] };

const jwtSample = () => {
  const enc = (o: unknown) => b64enc(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'goose-42', name: 'Silly Goose', role: 'honker', iat: 1767225600, exp: 1767312000 })}.not-a-real-signature`;
};

const TOOLS: Tool[] = [
  { id: 'password', name: 'Passwords', hint: 'Strong random passwords' },
  { id: 'qr', name: 'QR codes', hint: 'Guest Wi-Fi, links and text as a QR code', examples: [{ label: 'Guest Wi-Fi', input: 'wifi' }, { label: 'A link', input: 'https://www.microsoft.com/windows' }] },
  { id: 'text', name: 'Text tools', hint: 'Counts, case, sort, de-duplicate', examples: [{ label: 'A messy list', input: 'banana\napple\nBanana\ncherry\napple\n  date  ' }] },
  { id: 'diff', name: 'Compare text', hint: 'What changed between two versions or lists', examples: [{ label: 'Two guest lists', input: 'Anna\nBen\nChloe\nDavid', extra: 'Anna\nChloe\nDavid\nEmma' }] },
  { id: 'sizes', name: 'Sizes & numbers', hint: 'GB vs GiB, and decimal, hex, binary', examples: [{ label: 'Why 1 TB shows as 931 GB', input: '1 TB' }, { label: 'Hex color part', input: '0xF0' }, { label: 'A big file', input: '4.7 GB' }] },
  { id: 'decide', name: 'Decision maker', hint: 'Flip a coin, roll dice, pick from a list', examples: [{ label: 'Lunch', input: 'Pizza\nSushi\nTacos\nSalad' }] },
  { id: 'color', name: 'Colors', hint: 'HEX ↔ RGB ↔ HSL', examples: [{ label: 'FBRX amber', input: '#f0a530' }, { label: 'Tropical mango', input: '#ffa23a' }, { label: 'An HSL color', input: 'hsl(200, 80%, 50%)' }] },
  { id: 'time', name: 'Timestamps', hint: 'Unix time ↔ dates', advanced: true, examples: [{ label: 'The 2038 problem', input: '2147483647' }, { label: 'Right now', input: '' }] },
  { id: 'json', name: 'JSON formatter', hint: 'Format, minify and validate JSON', advanced: true, examples: [{ label: 'Settings sample', input: '{"name":"FBRX","features":["agent","mesh"],"limits":{"tabs":12,"geese":1},"enabled":true}' }] },
  { id: 'base64', name: 'Base64', hint: 'Encode and decode text', advanced: true, examples: [{ label: 'Encode', input: 'Hello, FBRX!' }, { label: 'Decode a secret', input: 'SG9uayBob25r' }] },
  { id: 'url', name: 'URL tools', hint: 'Encode, decode and take apart links', advanced: true, examples: [{ label: 'A tracking link', input: 'https://shop.example.com/cart?utm_source=mail&utm_campaign=fall&item=42#reviews' }] },
  { id: 'hash', name: 'Hashes', hint: 'SHA-1, SHA-256, SHA-384, SHA-512', advanced: true, examples: [{ label: 'hello', input: 'hello' }] },
  { id: 'uuid', name: 'UUIDs', hint: 'Random unique identifiers', advanced: true },
  { id: 'regex', name: 'Regex tester', hint: 'Try a pattern against text', advanced: true, examples: [{ label: 'Find e-mails', extra: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', input: 'Write to anna@example.com or ops@fbrx.example today.' }, { label: 'IP addresses', extra: '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b', input: 'Router 192.168.1.1, printer 192.168.1.20, NAS 192.168.1.5' }] },
  { id: 'jwt', name: 'JWT decoder', hint: 'Read a token (no verification)', advanced: true, examples: [{ label: 'Sample token', input: '__jwt__' }] },
  { id: 'subnet', name: 'Subnet calculator', hint: 'Network, mask, host range', advanced: true, examples: [{ label: 'Home network', input: '192.168.1.20/24' }, { label: 'Office /22', input: '10.20.4.9/22' }] },
  { id: 'mac', name: 'MAC vendor lookup', hint: 'Who made a network device (IEEE registry)', advanced: true, examples: [{ label: 'Ubiquiti', input: 'F0:9F:C2:12:34:56' }, { label: 'Cisco', input: '00-00-0C-12-34-56' }, { label: 'A phone (private)', input: 'DA:A1:19:00:00:01' }] },
  { id: 'ports', name: 'Port reference', hint: 'What runs on which port, and is it risky', advanced: true, examples: [{ label: 'Remote Desktop', input: '3389' }, { label: 'Printers', input: 'print' }] },
  { id: 'commands', name: 'Command library', hint: 'Ready-made Windows commands', advanced: true },
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

function Pane({ id, seed, fun }: { id: string; seed: Example | null; fun: boolean }) {
  const [input, setInput] = useState(seed?.input === '__jwt__' ? jwtSample() : (seed?.input ?? ''));
  const [extra, setExtra] = useState(seed?.extra ?? '');
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
              <Input className="mono" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="\\b\\w+@\\w+\\.\\w+\\b" />
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
            <Input className="mono" placeholder="#f0a530, rgb(240,165,48) or hsl(36,86%,56%)" value={input} onChange={(e) => setInput(e.target.value)} />
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
          <Input className="mono" placeholder="192.168.1.20/24" value={input} onChange={(e) => setInput(e.target.value)} />
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
    case 'qr':
      return <QrTool seed={seed} />;
    case 'decide':
      return <DecideTool seed={seed} fun={fun} />;
    case 'diff':
      return <DiffTool seed={seed} />;
    case 'sizes':
      return <SizesTool seed={seed} />;
    case 'mac':
      return <MacTool seed={seed} />;
    case 'ports':
      return <PortsTool seed={seed} />;
    case 'commands':
      return <CommandsTool />;
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------ new tools

/** Wi-Fi QR codes use this format; phones join the network when they scan it. */
function wifiQr(ssid: string, password: string, security: string, hidden: boolean) {
  const esc = (v: string) => v.replace(/([\;,:"])/g, '\\$1');
  return `WIFI:T:${security === 'none' ? 'nopass' : security};S:${esc(ssid)};${security === 'none' ? '' : `P:${esc(password)};`}${hidden ? 'H:true;' : ''};`;
}

function QrTool({ seed }: { seed: Example | null }) {
  const [mode, setMode] = useState<'wifi' | 'text'>(seed?.input && seed.input !== 'wifi' ? 'text' : 'wifi');
  const [text, setText] = useState(seed?.input && seed.input !== 'wifi' ? seed.input : '');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [security, setSecurity] = useState('WPA');
  const [hidden, setHidden] = useState(false);
  const [img, setImg] = useState('');
  const payload = mode === 'wifi' ? (ssid ? wifiQr(ssid, password, security, hidden) : '') : text;
  useEffect(() => {
    if (!payload) return setImg('');
    void QRCode.toDataURL(payload, { margin: 2, width: 280, errorCorrectionLevel: 'M' }).then(setImg, () => setImg(''));
  }, [payload]);
  return (
    <>
      <div className="seg" role="group">
        <button className={mode === 'wifi' ? 'on' : ''} onClick={() => setMode('wifi')}>
          Wi-Fi network
        </button>
        <button className={mode === 'text' ? 'on' : ''} onClick={() => setMode('text')}>
          Link or text
        </button>
      </div>
      {mode === 'wifi' ? (
        <>
          <div className="fx-row">
            <Field label="Network name">
              <Input value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="Guest Wi-Fi" />
            </Field>
            <Field label="Password">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} disabled={security === 'none'} />
            </Field>
            <Field label="Security">
              <Select value={security} onChange={(e) => setSecurity(e.target.value)} options={[{ value: 'WPA', label: 'WPA2 / WPA3' }, { value: 'WEP', label: 'WEP (old)' }, { value: 'none', label: 'Open (no password)' }]} />
            </Field>
          </div>
          <div className="fx-actions">
            <Toggle checked={hidden} onChange={setHidden} label="Hidden network" />
            <Button size="sm" variant="ghost" icon="wifi" onClick={() => void call('net.wifi').then((w) => w.connection && setSsid(w.connection.ssid), () => undefined)}>
              Use the network I'm on
            </Button>
          </div>
        </>
      ) : (
        <TextArea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="https://… or any text" />
      )}
      {img ? (
        <div className="qr-out">
          <img src={img} alt="QR code" width={220} height={220} />
          <div className="fx-actions">
            <Button size="sm" icon="download" onClick={() => Object.assign(document.createElement('a'), { href: img, download: mode === 'wifi' ? `wifi-${ssid || 'network'}.png` : 'qr-code.png' }).click()}>
              Save as image
            </Button>
            <span className="fx-muted" style={{ fontSize: 12.5 }}>{mode === 'wifi' ? 'Print it for guests: their phone camera joins the network.' : 'Point a phone camera at it.'}</span>
          </div>
        </div>
      ) : (
        <div className="fx-muted" style={{ fontSize: 12.5 }}>{mode === 'wifi' ? 'Enter the network name to make a code.' : 'Type something to make a code.'}</div>
      )}
    </>
  );
}

/** Counts coin flips across visits (reset after an edge). */
function bumpFlips(reset = false): number {
  try {
    const n = reset ? 0 : Number(localStorage.getItem('fbrx.coinFlips') ?? 0) + 1;
    localStorage.setItem('fbrx.coinFlips', String(n));
    return n;
  } catch {
    return 0;
  }
}

const GOOSE_ANSWERS = ['Honk.', 'Absolutely. Honk.', 'Ask again after a nap.', 'The goose says no.', 'Signs point to honk.', 'Without a doubt.', 'Very doubtful.', 'Outlook good, if you back up first.', 'The goose is busy. Try later.', 'Yes, but wear safety goggles.'];

function DecideTool({ seed, fun }: { seed: Example | null; fun: boolean }) {
  const [list, setList] = useState(seed?.input ?? '');
  const [q, setQ] = useState('');
  const [out, setOut] = useState<{ big: string; small?: string } | null>(null);
  const rnd = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  return (
    <>
      <div className="fx-actions">
        <Button
          variant="primary"
          icon="dice"
          onClick={() => {
            // About one coin in a hundred lands on its edge, and a patient flipper always gets there by flip 150.
            const flips = fun ? bumpFlips() : 0;
            if (fun && (rnd(100) === 0 || flips >= 150)) {
              bumpFlips(true);
              unlockTrophy('edge');
              setOut({ big: 'Edge!', small: 'It landed on its edge. Take the rest of the day off.' });
            } else setOut({ big: rnd(2) ? 'Heads' : 'Tails', small: fun && flips > 1 ? `Flip ${flips}` : undefined });
          }}
        >
          Flip a coin
        </Button>
        <Button
          icon="dice"
          onClick={() => {
            const n = rnd(6) + 1;
            setOut({ big: String(n), small: 'Six-sided die' });
          }}
        >
          Roll a die
        </Button>
        <Button
          icon="dice"
          onClick={() => {
            const n = rnd(20) + 1;
            if (n === 20 && fun) unlockTrophy('nat20');
            setOut({ big: String(n), small: n === 20 ? 'Natural 20! Critical success.' : n === 1 ? 'Natural 1. Oof.' : 'Twenty-sided die' });
          }}
        >
          Roll a d20
        </Button>
      </div>
      <Field label="Or pick from a list (one per line)">
        <TextArea rows={4} value={list} onChange={(e) => setList(e.target.value)} placeholder={'Option A\nOption B'} />
      </Field>
      <div className="fx-actions">
        <Button
          disabled={list.split('\n').filter((l) => l.trim()).length < 2}
          onClick={() => {
            const items = list.split('\n').map((l) => l.trim()).filter(Boolean);
            setOut({ big: items[rnd(items.length)], small: `Picked from ${items.length}` });
          }}
        >
          Pick one
        </Button>
        {fun && (
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the goose a yes-or-no question" style={{ maxWidth: 320 }} />
            <Button icon="feather" disabled={!q.trim()} onClick={() => setOut({ big: GOOSE_ANSWERS[rnd(GOOSE_ANSWERS.length)], small: `"${q.trim()}"` })}>
              Ask the goose
            </Button>
          </>
        )}
      </div>
      {out && (
        <div className="decide-out" key={`${out.big}${Math.random()}`}>
          <div className="decide-big">{out.big}</div>
          {out.small && <div className="fx-muted">{out.small}</div>}
        </div>
      )}
    </>
  );
}

const UNITS: Record<string, number> = { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5 };

function SizesTool({ seed }: { seed: Example | null }) {
  const [v, setV] = useState(seed?.input ?? '');
  const out = useMemo(() => {
    const t = v.trim().replace(/,/g, '');
    if (!t) return null;
    const num = t.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i);
    if (num) {
      const n = BigInt(num[1]);
      return [`Decimal  ${n.toString(10)}`, `Hex      0x${n.toString(16).toUpperCase()}`, `Binary   0b${n.toString(2)}`, `Octal    0o${n.toString(8)}`, ...(n < 1n << 53n ? [`As bytes ${formatSize(Number(n))}`] : [])].join('\n');
    }
    const m = t.match(/^([\d.]+)\s*([a-z]+)$/i);
    if (!m || !(m[2].toLowerCase() in UNITS)) return 'Type a size such as "1 TB", "512 MiB" or "4.7 GB", or a number such as 255, 0xFF or 0b1010.';
    const bytes = Number(m[1]) * UNITS[m[2].toLowerCase()];
    const dec = ['KB', 'MB', 'GB', 'TB'].map((u, i) => `${(bytes / 1000 ** (i + 1)).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${u}`);
    const bin = ['KiB', 'MiB', 'GiB', 'TiB'].map((u, i) => `${(bytes / 1024 ** (i + 1)).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${u}`);
    const note = /^(kb|mb|gb|tb|pb)$/i.test(m[2]) ? `\n\nWindows shows ${m[1]} ${m[2].toUpperCase()} as ${(bytes / 1024 ** (['kb', 'mb', 'gb', 'tb', 'pb'].indexOf(m[2].toLowerCase()) + 1)).toFixed(2)} ${m[2].toUpperCase()}: drive makers count in thousands, Windows in 1024s (and still writes "GB").` : '';
    return `Bytes    ${bytes.toLocaleString()}\nDecimal  ${dec.join(' · ')}\nBinary   ${bin.join(' · ')}${note}`;
  }, [v]);
  return (
    <>
      <Input className="mono" value={v} onChange={(e) => setV(e.target.value)} placeholder="1 TB, 512 MiB, 255, 0xFF…" />
      {out && <Out value={out} />}
    </>
  );
}

function formatSize(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${u[i]}`;
}

/** Line diff by longest common subsequence. */
function lineDiff(a: string[], b: string[]): Array<[' ' | '-' | '+', string]> {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: Array<[' ' | '-' | '+', string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([' ', a[i++]]);
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

function DiffTool({ seed }: { seed: Example | null }) {
  const [a, setA] = useState(seed?.input ?? '');
  const [b, setB] = useState(seed?.extra ?? '');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const rows = useMemo(() => {
    if (!a && !b) return null;
    const norm = (t: string) => t.split('\n').map((l) => (ignoreCase ? l.trim().toLowerCase() : l.replace(/\s+$/, '')));
    const A = norm(a).slice(0, 3000);
    const B = norm(b).slice(0, 3000);
    return lineDiff(A, B);
  }, [a, b, ignoreCase]);
  const added = rows?.filter((r) => r[0] === '+').length ?? 0;
  const removed = rows?.filter((r) => r[0] === '-').length ?? 0;
  return (
    <>
      <div className="fx-row">
        <Field label="Before">
          <TextArea code rows={8} value={a} onChange={(e) => setA(e.target.value)} />
        </Field>
        <Field label="After">
          <TextArea code rows={8} value={b} onChange={(e) => setB(e.target.value)} />
        </Field>
      </div>
      <Toggle checked={ignoreCase} onChange={setIgnoreCase} label="Ignore capitals and extra spaces" />
      {rows && (
        <>
          <div className="fx-muted" style={{ fontSize: 12.5 }}>
            {added} added · {removed} removed · {rows.length - added - removed} the same
          </div>
          <pre className="fx-code diff-out">
            {rows.map(([k, l], i) => (
              <div key={i} className={k === '+' ? 'diff-add' : k === '-' ? 'diff-del' : undefined}>
                {k} {l}
              </div>
            ))}
          </pre>
        </>
      )}
    </>
  );
}

function MacTool({ seed }: { seed: Example | null }) {
  const info = useCore('net.vendorInfo');
  const [v, setV] = useState(seed?.input ?? '');
  const [rows, setRows] = useState<MacLookup[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const macs = v.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
    let alive = true;
    void Promise.all(macs.map((mac) => call('net.macLookup', { mac }))).then((r) => alive && setRows(r), () => undefined);
    return () => {
      alive = false;
    };
  }, [v]);
  return (
    <>
      <TextArea code rows={4} value={v} onChange={(e) => setV(e.target.value)} placeholder={'One MAC address per line, e.g. F0:9F:C2:12:34:56'} />
      {rows.length > 0 && (
        <table className="fx-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.mac}</td>
                <td>{r.kind === 'invalid' ? <span className="fx-muted">Not a MAC address</span> : r.kind === 'multicast' ? 'Multicast (a group address, not a device)' : r.vendor ?? <span className="fx-muted">Not in the registry</span>}</td>
                <td className="fx-muted" style={{ fontSize: 12 }}>{r.block ? `${r.block} ${r.prefix}` : r.kind === 'private' ? 'Randomized by a phone or laptop for privacy' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="fx-actions" style={{ fontSize: 12.5 }}>
        <span className="fx-muted">
          {info.data ? (info.data.entries ? `IEEE registry: ${info.data.entries.toLocaleString()} maker blocks (${info.data.source}${info.data.updatedAt ? `, ${info.data.updatedAt}` : ''})` : 'No vendor list yet') : '…'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void call('net.vendorUpdate')
              .then((r) => {
                info.reload();
                toast.success('Vendor list updated', `${r.entries.toLocaleString()} maker blocks from the IEEE`);
              })
              .catch((e: Error) => toast.error('Could not update', e.message))
              .finally(() => setBusy(false));
          }}
        >
          Update from the IEEE
        </Button>
      </div>
    </>
  );
}

const PORTS: Array<[number | string, string, string, ('ok' | 'care' | 'risk')?]> = [
  [20, 'FTP data', 'File transfer (old, unencrypted)', 'risk'],
  [21, 'FTP', 'File transfer login (unencrypted)', 'risk'],
  [22, 'SSH', 'Secure command line and file copy (SFTP)', 'care'],
  [23, 'Telnet', 'Unencrypted command line: turn it off where you can', 'risk'],
  [25, 'SMTP', 'Mail between servers'],
  [53, 'DNS', 'Name lookups'],
  ['67/68', 'DHCP', 'Hands out IP addresses (UDP)'],
  [69, 'TFTP', 'Firmware and phone provisioning (UDP, no login)', 'care'],
  [80, 'HTTP', 'Web pages and device admin pages (unencrypted)', 'care'],
  [110, 'POP3', 'Mail download (old)'],
  [123, 'NTP', 'Clock sync (UDP)'],
  [135, 'RPC', 'Windows remote procedure calls', 'care'],
  ['137-139', 'NetBIOS', 'Old Windows file sharing and names', 'risk'],
  [143, 'IMAP', 'Mail'],
  [161, 'SNMP', 'Device monitoring (UDP); change the default community "public"', 'care'],
  [389, 'LDAP', 'Directory (Active Directory) lookups', 'care'],
  [443, 'HTTPS', 'Secure web pages and admin pages'],
  [445, 'SMB', 'Windows file sharing; never expose to the internet', 'risk'],
  [465, 'SMTPS', 'Mail submission over TLS'],
  [514, 'Syslog', 'Device logs (UDP)'],
  [515, 'LPD', 'Printing (old)'],
  [548, 'AFP', 'Apple file sharing (old)'],
  [554, 'RTSP', 'Camera video streams', 'care'],
  [587, 'SMTP submission', 'Sending mail from apps'],
  [631, 'IPP', 'Printing'],
  [636, 'LDAPS', 'Directory lookups over TLS'],
  [993, 'IMAPS', 'Mail over TLS'],
  [1433, 'SQL Server', 'Database', 'care'],
  [1883, 'MQTT', 'Smart-home and IoT messages', 'care'],
  [1900, 'SSDP / UPnP', 'Device discovery (UDP); UPnP on the router can open ports by itself', 'care'],
  [3306, 'MySQL', 'Database', 'care'],
  [3389, 'Remote Desktop', 'Windows remote control; never expose to the internet without a VPN', 'risk'],
  [4444, 'Sophos admin', 'Sophos Firewall web admin', 'care'],
  [5000, 'UPnP / Synology', 'Synology DSM (HTTP), AirPlay on Macs'],
  [5001, 'Synology', 'Synology DSM (HTTPS)'],
  [5353, 'mDNS', 'Bonjour discovery (UDP)'],
  [5432, 'PostgreSQL', 'Database', 'care'],
  [5900, 'VNC', 'Remote screen; often weakly protected', 'risk'],
  [8006, 'Proxmox', 'Proxmox VE web admin'],
  [8080, 'HTTP alt', 'Web admin pages, proxies', 'care'],
  [8291, 'Winbox', 'MikroTik management', 'care'],
  [8443, 'HTTPS alt', 'UniFi controller and other admin pages'],
  [9100, 'JetDirect', 'Raw printing'],
  [47800, 'FBRX Mesh', 'FBRX computers and phones talking to each other (encrypted)'],
  [51820, 'WireGuard', 'VPN (UDP)'],
];

function PortsTool({ seed }: { seed: Example | null }) {
  const [q, setQ] = useState(seed?.input ?? '');
  const s = q.trim().toLowerCase();
  const rows = PORTS.filter(([p, n, d]) => !s || String(p).includes(s) || `${n} ${d}`.toLowerCase().includes(s));
  return (
    <>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Port number or name (3389, printer, database…)" />
      <table className="fx-table">
        <tbody>
          {rows.map(([p, n, d, risk]) => (
            <tr key={`${p}${n}`}>
              <td className="mono" style={{ width: 80 }}>{p}</td>
              <td style={{ width: 150, fontWeight: 550 }}>{n}</td>
              <td>{d}</td>
              <td style={{ width: 90 }}>{risk === 'risk' ? <span className="port-risk">Risky</span> : risk === 'care' ? <span className="port-care">Careful</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function CommandsTool() {
  const [group, setGroup] = useState(COMMAND_GROUPS[0].id);
  const toast = useToast();
  const items = COMMAND_GROUPS.find((g) => g.id === group)?.items ?? [];
  return (
    <>
      <div className="chips">
        {COMMAND_GROUPS.map((g) => (
          <button key={g.id} className={`chip${group === g.id ? ' on' : ''}`} onClick={() => setGroup(g.id)}>
            {g.name}
          </button>
        ))}
      </div>
      {items.map((c) => (
        <div key={c.cmd} className="cmdlib-item">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 550 }}>
              {c.title} {c.admin && <span className="fx-badge">admin</span>}
            </div>
            <div className="fx-muted" style={{ fontSize: 12.5 }}>{c.what}</div>
            <code className="cmdlib-code">{c.cmd}</code>
          </div>
          <div className="fx-actions" style={{ flexWrap: 'nowrap' }}>
            <Button size="sm" variant="ghost" icon="copy" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(c.cmd).then(() => toast.success('Copied'))} />
            <Button size="sm" icon="terminal" onClick={() => navigate(`terminal/cmd/${encodeURIComponent(c.cmd)}`)}>
              Terminal
            </Button>
            <AskButton iconOnly label="Explain this command" prompt={`Explain this PowerShell command line by line in plain language: what it does, whether it changes anything, and anything to watch out for.\n\n${c.cmd}`} />
          </div>
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------------------------------- page

const RECOMMENDED: Array<{ label: string; tool: string; example?: number; advanced?: boolean; fun?: boolean }> = [
  { label: 'Make a guest Wi-Fi QR code', tool: 'qr', example: 0 },
  { label: 'Generate a strong password', tool: 'password' },
  { label: 'Compare two lists', tool: 'diff', example: 0 },
  { label: 'Why does my 1 TB drive say 931 GB?', tool: 'sizes', example: 0 },
  { label: 'Who made this device? (MAC lookup)', tool: 'mac', example: 0, advanced: true },
  { label: 'Is port 3389 risky?', tool: 'ports', example: 0, advanced: true },
  { label: 'Ready-made Windows commands', tool: 'commands', advanced: true },
  { label: 'Settle an argument (coin flip)', tool: 'decide', fun: true },
];

/** Offline developer and everyday utilities. Nothing typed here leaves this computer. */
export function ToolboxPage({ advanced, easterEggs }: { advanced: boolean; easterEggs: boolean }) {
  const tools = TOOLS.filter((t) => advanced || !t.advanced);
  const [picked, setActive] = useState('password');
  const [seed, setSeed] = useState<{ ex: Example | null; n: number }>({ ex: null, n: 0 });
  const active = tools.some((t) => t.id === picked) ? picked : tools[0].id;
  const tool = tools.find((t) => t.id === active)!;
  const choose = (id: string, ex: Example | null = null) => {
    setActive(id);
    setSeed((s) => ({ ex, n: s.n + 1 }));
  };
  return (
    <Page title="Toolbox" description={advanced ? 'Handy utilities that run entirely on this computer.' : 'Quick helpers for everyday jobs. Nothing you type here leaves this computer.'}>
      <div className="chips recommended">
        <span className="fx-muted" style={{ fontSize: 12.5, alignSelf: 'center' }}>Try:</span>
        {RECOMMENDED.filter((r) => (advanced || !r.advanced) && (easterEggs || !r.fun)).map((r) => (
          <button key={r.label} className="chip" onClick={() => choose(r.tool, r.example !== undefined ? (TOOLS.find((t) => t.id === r.tool)?.examples?.[r.example] ?? null) : null)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="toolbox">
        <Card className="toolbox-list" flush>
          {tools.map((t) => (
            <button key={t.id} className={`agent-conv${active === t.id ? ' active' : ''}`} onClick={() => choose(t.id)}>
              <div className="agent-conv-title">
                {t.name}
                {t.advanced && <AdvancedTag />}
              </div>
              <div className="agent-conv-sub">{t.hint}</div>
            </button>
          ))}
          {!advanced && (
            <div style={{ padding: '10px 12px' }}>
              <UltraHint>Developer and network tools (JSON, hashes, subnets, ports) come with Endpoint Ultra.</UltraHint>
            </div>
          )}
        </Card>
        <Card
          title={tool.name}
          subtitle={tool.hint}
          actions={
            tool.examples?.length ? (
              <div className="chips" style={{ margin: 0 }}>
                {tool.examples.map((ex) => (
                  <button key={ex.label} className="chip" onClick={() => choose(tool.id, ex)} title="Fill in an example">
                    {ex.label}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          <div className="fx-grid" style={{ gap: 12 }} key={`${active}-${seed.n}`}>
            <Pane id={active} seed={seed.ex} fun={easterEggs} />
          </div>
        </Card>
      </div>
    </Page>
  );
}
