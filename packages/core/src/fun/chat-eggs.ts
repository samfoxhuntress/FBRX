/**
 * Easter eggs in the chat. They answer without a model and can give a conversation a persona that lasts until it is
 * switched off:
 *
 * - "Where's my stapler?" (or just "stapler"): an instant answer, then middle-manager jargon ending in "That would
 *   be great." until "PC load letter" (or "better"), "I quit", "normal mode" or "no more jargon".
 * - "Chewie, we're home": every answer is Wookiee until "Laugh it up, fuzzball". "Nooo" gets the famous reply.
 */

/** Stored per conversation: `lumbergh`, or `wookiee:<messages so far>`. */
export type PersonaValue = string | null;

export interface ChatEgg {
  reply: string;
  /** The conversation's persona afterwards (undefined leaves it as it was). */
  persona?: PersonaValue;
  trophies: string[];
}

const WOOKIEE = [
  'Rrrrrrr-ghghghghgh!',
  'Aaaaahnr. Wyaaaaaa.',
  'Uuuuuuuurr ahr muf.',
  'Rrraaaaaaaaarrrrgh! Grrrrr.',
  'Hnnnngh. Rwwwwr?',
  'Wrrrrrrhn. Aaarrrgh!',
  'Grrrraaaaah. Hrrrrn, hrrrrn.',
  'RWWWAAARRGH!',
];

/** A Wookiee answer: two or three growls with a stage direction now and then. */
export function wookieeReply(rand: () => number = Math.random): string {
  const pick = () => WOOKIEE[Math.floor(rand() * WOOKIEE.length)];
  const parts = [pick(), pick()];
  if (rand() < 0.5) parts.push(pick());
  const action = ['*shrugs*', '*waves a furry arm at the screen*', '*adjusts bandolier*', '*pats you on the head*', '*points at the hyperdrive*'][Math.floor(rand() * 5)];
  return rand() < 0.45 ? `${parts.join(' ')} ${action}` : parts.join(' ');
}

const norm = (t: string) => t.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

export function chatEgg(raw: string, persona: PersonaValue, rand: () => number = Math.random): ChatEgg | null {
  const text = norm(raw);
  const wookiee = persona?.startsWith('wookiee') ?? false;

  // Back on the ship.
  if (/^chewie,?\s+we'?re\s+home\W*$/i.test(text)) {
    return { reply: `Rrrrrrr-ghghghghgh! ${wookieeReply(rand)}`, persona: 'wookiee:0', trophies: ['chewie'] };
  }
  if (wookiee) {
    if (/laugh it up,?\s*fuzz\s*ball/i.test(text)) {
      return { reply: 'Rrrgh… *grumbles, hands back the controls*\n\nFine. Plain English again. What do you need?', persona: null, trophies: ['fuzzball'] };
    }
    const count = Number(persona!.split(':')[1] ?? 0) + 1;
    if (/^no{3,}[!.]*$/i.test(text)) return { reply: 'No, I am your father.', persona: `wookiee:${count}`, trophies: ['father'] };
    // A stapler question still gets its answer, Wookiee or not.
    if (!/\bstapler\b/i.test(text)) return { reply: wookieeReply(rand), persona: `wookiee:${count}`, trophies: count >= 5 ? ['wookiee'] : [] };
  }

  // The stapler, however it is asked.
  if (/\bstapler\b/i.test(text) && text.length <= 100) {
    return {
      reply: "It's likely downstairs, in storage building B.\n\nMmm, yeah. And going forward, I'm gonna need you to go ahead and route all of your requests through the proper synergy channels. That would be great.",
      persona: 'lumbergh',
      trophies: ['stapler'],
    };
  }
  if (/^pc load (letter|better)\b/i.test(text)) {
    return {
      reply:
        persona === 'lumbergh'
          ? "PC load letter? What does that even mean?\n\n…Fine. The stapler stays in storage building B, and I'm back to talking like a normal assistant. What do you need?"
          : 'PC load letter?! What the heck does that mean? *eyes the printer suspiciously*',
      persona: persona === 'lumbergh' ? null : undefined,
      trophies: ['pcload'],
    };
  }
  if (persona === 'lumbergh' && /^(i quit|normal mode|stop (the )?jargon|no more jargon)\b/i.test(text)) {
    return { reply: "Yeah… I'm gonna need you to go ahead and… fine. Back to normal. What do you need?", persona: null, trophies: [] };
  }
  return null;
}
