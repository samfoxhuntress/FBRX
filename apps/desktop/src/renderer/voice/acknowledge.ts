import { NATURAL_PREFIX } from '@fbrx/shared';

/** What the agent says right after you speak, so you know it heard you before it goes quiet to work. */

const LINES = [
  'Got it. Let me look into that.',
  'I hear you. Give me a moment to dig in.',
  'On it. Let me check a few things first.',
  'Sure. Let me take a look.',
  'Good question. Let me find out.',
  'Okay. Give me a second to work on that.',
];

/** For the British gentlemen among the natural voices. */
const BUTLER = [
  'Very good. Allow me a moment to look into it.',
  'Certainly. One moment while I see to it.',
  'Right away. I shall look into it at once.',
  'Of course. Let me attend to that.',
  'Indeed. Give me a moment, if you would.',
];

const BUTLER_VOICES = ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable'].map((v) => `${NATURAL_PREFIX}${v}`);

let last = '';

export function acknowledgement(voiceName: string, name: string | null): string {
  const pool = BUTLER_VOICES.includes(voiceName) ? BUTLER : LINES;
  let line = pool[Math.floor(Math.random() * pool.length)];
  if (line === last) line = pool[(pool.indexOf(line) + 1) % pool.length];
  last = line;
  // Now and then with their name: "Very good, Sam. Allow me…"
  if (name && Math.random() < 0.35) line = line.replace(/^([^.]+)\./, `$1, ${name}.`);
  return line;
}
