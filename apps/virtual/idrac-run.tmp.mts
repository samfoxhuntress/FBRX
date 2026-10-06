import { startMockIdrac } from './test/idrac-mock.ts';
const m = await startMockIdrac();
console.log(JSON.stringify({ host: m.host, fingerprint: m.fingerprint }));
setInterval(() => undefined, 1 << 30);
