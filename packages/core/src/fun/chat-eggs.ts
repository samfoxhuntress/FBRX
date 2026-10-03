/**
 * Easter eggs in the chat. They answer without a model and can give a conversation a persona that lasts until it is
 * switched off. In every persona the answers are made up on the spot and have little to do with what you said:
 *
 * - "Have you seen my stapler?" (also "Where is my stapler?", "Has anyone seen my stapler?"): the stapler's
 *   whereabouts, then nothing but corporate jargon, each answer ending in "That would be great.", until
 *   "PC load letter" (or "better"), "I quit", "normal mode" or "no more jargon".
 * - "Talk to me, Goose": your wingman answers in radio chatter from the back seat until "wheels down",
 *   "return to base", "land the plane" or "normal mode".
 * - Telling your furry co-pilot you're home: every answer is growls until "Laugh it up, fuzzball". "Nooo" gets a
 *   family secret.
 */

/**
 * Stored per conversation: `jargon:<n>` (the jargon manager), `wingman:<n>` (the radio chatter) or `wookiee:<n>`
 * (the growling co-pilot), where n counts the messages so far. Older conversations may hold `lumbergh` (jargon).
 */
export type PersonaValue = string | null;

export interface ChatEgg {
  reply: string;
  /** The conversation's persona afterwards (undefined leaves it as it was). */
  persona?: PersonaValue;
  trophies: string[];
}

type Rand = () => number;
const pickFrom = <T>(list: readonly T[], rand: Rand): T => list[Math.floor(rand() * list.length) % list.length];

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

/** A co-pilot answer: two or three growls with a stage direction now and then. */
export function wookieeReply(rand: Rand = Math.random): string {
  const pick = () => pickFrom(WOOKIEE, rand);
  const parts = [pick(), pick()];
  if (rand() < 0.5) parts.push(pick());
  const action = pickFrom(['*shrugs*', '*waves a furry arm at the screen*', '*adjusts bandolier*', '*pats you on the head*', '*points at the engine light*'], rand);
  return rand() < 0.45 ? `${parts.join(' ')} ${action}` : parts.join(' ');
}

// ------------------------------------------------------------------------------- the jargon manager

const JARGON_OPEN = ['Mmm, yeah.', 'Yeahhh.', "Hey. What's happening.", 'Okay, so, um.', 'Mmm-kay.', 'So, real quick.', 'Yeah, hi.', 'Uh, yeah.'];
const JARGON = [
  "I'm gonna need you to circle back on the Q3 deliverables and leverage some cross-functional synergy.",
  "let's take this offline and put a pin in it until we have more bandwidth.",
  'did you see the memo about the new cover sheets? Every report gets one now. Every report.',
  'we really need to move the needle on our core competencies and grab that low-hanging fruit.',
  "going forward, let's socialize this with the stakeholders and get some alignment on the alignment.",
  "let's double-click on that and unpack the paradigm shift. At a high level. In the weeds.",
  'we have to right-size the ideation pipeline before end of day. End of day Saturday, ideally.',
  "I'll loop in the tiger team so we can ideate around the learnings from the last sync about syncing.",
  'can you put together a quick deck about the deck we talked about? Twelve slides. Fifteen, tops.',
  "let's run it up the flagpole and see who salutes. Then let's run it back down. For visibility.",
  'per my last email, the action items are still in the parking lot. They have been there since March.',
  "we're pivoting to a holistic, best-in-class, value-add mindset. Effective immediately-ish.",
  'the cake in the break room is for the synergy celebration, so maybe hold off on taking a piece.',
  "your desk is being moved a little to the left. Then a little more. Then down to the basement.",
  "we're gonna boil the ocean on this one, so let's make sure we have the right swim lanes.",
  "I'm hearing a lot of noise and not a lot of signal. Let's get granular at the 30,000-foot level.",
  'the printer is on our radar. The printer has been on our radar for a while.',
  "we're having a meeting to plan the pre-meeting for the kickoff. Your attendance is optional. Mandatory-optional.",
  "let's touch base offline about what we touched on online, so we're all on the same page of the playbook.",
  "I'm gonna need those reports by Monday, and if you could make them a little more… proactive.",
  'we found your stapler. Then we lost it again. We are calling that a learning opportunity.',
  'think outside the box, but please keep it inside the budget. And inside the cubicle.',
];
const JARGON_ACTION = ['*sips from a company coffee mug*', '*leans on your cubicle wall*', '*adjusts suspenders*', '*nods slowly for a long time*', '*points at a whiteboard covered in arrows*', '*walks away mid-sentence, then comes back*'];
const STAPLER = [
  "I believe we moved your stapler down to storage. The basement. Next to the box of old fax toner.",
  "It's likely downstairs in storage, filed under 'misc. office assets'.",
  "We had to reallocate your stapler to a more strategic initiative. It's in the basement now.",
];

/** A manager answer: unrelated to what you asked, full of jargon, and it always ends the same way. */
export function jargonReply(rand: Rand = Math.random): string {
  const a = pickFrom(JARGON, rand);
  let b = pickFrom(JARGON, rand);
  if (b === a) b = JARGON[(JARGON.indexOf(a) + 1) % JARGON.length];
  const lines = [`${pickFrom(JARGON_OPEN, rand)} ${a.charAt(0).toUpperCase()}${a.slice(1)}`];
  if (rand() < 0.6) lines.push(`Also, ${b}`);
  if (rand() < 0.35) lines.push(pickFrom(JARGON_ACTION, rand));
  lines.push(rand() < 0.75 ? 'That would be great.' : 'Mmkay? That would be great.');
  return lines.join('\n\n');
}

// ------------------------------------------------------------------------------------- the wingman

const WINGMAN_OPEN = ['Copy that.', 'Roger.', 'Loud and clear.', 'Ten-four, hotshot.', 'Reading you five by five.', 'Wingman here.', 'Go ahead, ace.'];
const WINGMAN = [
  "Two bogeys at your six, closing fast. Recommend we… keep chatting and act natural.",
  'Radar shows nothing but clouds and one very confused seagull.',
  "We are definitely flying lower than the brochure said we would.",
  "Fuel's at bingo, coffee's at zero, morale is sky-high.",
  'The tower says no flybys today. I say we ask nicely. Twice.',
  'Check six! …false alarm. That was my own reflection in the canopy.',
  "Lock tone! Wait, no. That's the microwave in the break room.",
  'Goggles up, visor down, sunglasses on. Looking good, partner.',
  'Beach volleyball at 1600 hours. Bring sunscreen. And a better serve.',
  "Somebody tell the tower I'm singing again. They love it. They told me so. Twice.",
  'Bandit on the scope. Bandit is… a cloud shaped like a duck. Disregard.',
  "Throttle up. Your wingman's got you, today and every day.",
  'Your wingman never leaves. Even when you ask nicely. Especially then.',
  'Pulling some serious G\'s back here. My lunch has opinions.',
  "Bogey's gone vertical. I'd follow, but I just got comfortable.",
  'We are cleared for takeoff. Also cleared for snacks. Mostly snacks.',
  "Visual on the target. It's a parking spot. Right by the door. Going in.",
  "Altitude good, airspeed good, hair… well, I'm wearing goggles, so, fine.",
  "Copy your last. Didn't understand a word of it, but I'm with you 100%.",
  'Instructor says we flew that one by the book. Which book, he did not say.',
];
const WINGMAN_ACTION = ['*taps the radar screen*', '*adjusts aviator goggles*', '*thumbs-up from the back seat*', '*hums a big, sappy power ballad*', '*radio static crackles*', '*honks over the intercom*'];

/** A wingman answer: radio chatter from the back seat, mostly unrelated to what you said. */
export function wingmanReply(rand: Rand = Math.random): string {
  const a = pickFrom(WINGMAN, rand);
  const parts = [`${pickFrom(WINGMAN_OPEN, rand)} ${a}`];
  if (rand() < 0.4) {
    const b = pickFrom(WINGMAN, rand);
    if (b !== a) parts.push(b);
  }
  if (rand() < 0.4) parts.push(pickFrom(WINGMAN_ACTION, rand));
  return `📻 ${parts.join(' ')} Over.`;
}

// ------------------------------------------------------------------------------------------ eggs

const norm = (t: string) => t.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const count = (persona: string) => Number(persona.split(':')[1] ?? 0) + 1;

/** The stapler sayings: "Have you seen my stapler?", "Where is my stapler?", "Has anyone seen my stapler?" and kin. */
export const STAPLER_QUESTION =
  /^(?:(?:um+|excuse me|sorry|hey|so),?\s+)*(?:(?:have|has|did)\s+(?:you|anyone|anybody|someone|somebody|y'?all)\s+(?:seen|got|taken|moved|borrowed)|where(?:'?s|\s+is|\s+did\s+\S+\s+put|\s+has\s+\S+\s+put)|who\s+(?:has|took|moved|borrowed)|i\s+(?:can'?t|cannot)\s+find|i\s+lost)\s+my\s+(?:\w+\s+){0,2}stapler\W*$/i;
const BARE_STAPLER = /^(?:my\s+)?stapler\W*$/i;

export function chatEgg(raw: string, persona: PersonaValue, rand: Rand = Math.random): ChatEgg | null {
  const text = norm(raw);
  const wookiee = persona?.startsWith('wookiee') ?? false;
  const wingman = persona?.startsWith('wingman') ?? false;
  const jargon = persona === 'lumbergh' || (persona?.startsWith('jargon') ?? false);

  // Back on the ship.
  if (/^chewie,?\s+we'?re\s+home\W*$/i.test(text)) {
    return { reply: `Rrrrrrr-ghghghghgh! ${wookieeReply(rand)}`, persona: 'wookiee:0', trophies: ['chewie'] };
  }
  // On the radio with your wingman.
  if (/^talk\s+to\s+me,?\s+goose\W*$/i.test(text)) {
    return {
      reply: `📻 *static crackles* Wingman on the radio, goggles on, radar warm. You lead, I'll follow. Say "wheels down" when you want to land. Over.`,
      persona: 'wingman:0',
      trophies: ['wingman'],
    };
  }
  const stapler = STAPLER_QUESTION.test(text) || BARE_STAPLER.test(text);

  if (wookiee) {
    if (/laugh it up,?\s*fuzz\s*ball/i.test(text)) {
      return { reply: 'Rrrgh… *grumbles, hands back the controls*\n\nFine. Plain English again. What do you need?', persona: null, trophies: ['fuzzball'] };
    }
    const n = count(persona!);
    if (/^no{3,}[!.]*$/i.test(text)) return { reply: 'No, I am your father.', persona: `wookiee:${n}`, trophies: ['father'] };
    // A stapler question still switches over to the manager, growls or not.
    if (!stapler) return { reply: wookieeReply(rand), persona: `wookiee:${n}`, trophies: n >= 5 ? ['wookiee'] : [] };
  }
  if (wingman) {
    if (/^(wheels\s+down|return(ing)?\s+to\s+base|rtb|land\s+(the|this)\s+plane|normal\s+mode|over\s+and\s+out)\b/i.test(text)) {
      return { reply: '📻 Wheels down, canopy up. Nice flying, partner. Back to plain English: what do you need?', persona: null, trophies: [] };
    }
    const n = count(persona!);
    if (!stapler) return { reply: wingmanReply(rand), persona: `wingman:${n}`, trophies: n >= 5 ? ['topwing'] : [] };
  }

  // The stapler: its whereabouts, then jargon mode.
  if (stapler) {
    return { reply: `${pickFrom(STAPLER, rand)}\n\n${jargonReply(rand)}`, persona: 'jargon:0', trophies: ['stapler'] };
  }
  if (/^pc load (letter|better)\b/i.test(text)) {
    return {
      reply: jargon
        ? "PC load letter? What does that even mean?\n\n…Fine. The stapler stays in storage, and I'm back to talking like a normal assistant. What do you need?"
        : 'PC load letter?! What the heck does that mean? *eyes the printer suspiciously*',
      persona: jargon ? null : undefined,
      trophies: ['pcload'],
    };
  }
  if (jargon) {
    if (/^(i quit|normal mode|stop (the )?jargon|no more jargon)\b/i.test(text)) {
      return { reply: "Yeah… I'm gonna need you to go ahead and… fine. Back to normal. What do you need?", persona: null, trophies: [] };
    }
    const n = persona === 'lumbergh' ? 1 : count(persona!);
    return { reply: jargonReply(rand), persona: `jargon:${n}`, trophies: n >= 5 ? ['synergy'] : [] };
  }
  return null;
}
