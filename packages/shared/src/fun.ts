/**
 * The trophy case: one trophy per easter egg. Found ones show their badge in color with how they were earned;
 * the rest stay greyed out with a hint. Finding them all unlocks the Golden Goose (the goose then carries a golden
 * egg with a #1 ribbon on every visit).
 */
export interface TrophyInfo {
  id: string;
  name: string;
  /** Shown while locked. */
  hint: string;
  /** Shown once found. */
  how: string;
}

export const TROPHIES: TrophyInfo[] = [
  { id: 'goose', name: 'Goose Wrangler', hint: 'Something honks in Spotlight.', how: 'Released the Silly Goose.' },
  { id: 'shoo', name: 'Shoo!', hint: 'Even geese have limits.', how: 'Clicked the goose three times until it gave up and went home.' },
  { id: 'konami', name: 'Cheat Code', hint: 'Up, up, down, down…', how: 'Typed the classic cheat code: ↑ ↑ ↓ ↓ ← → ← → B A.' },
  { id: 'loom', name: 'Master Weaver', hint: 'The logo likes attention.', how: 'Clicked the FBRX logo seven times in a row.' },
  { id: 'goggles', name: 'Safety First', hint: 'Advanced mode has a lab with a dress code.', how: 'Opened The Lab in the Library (safety goggles sold separately).' },
  { id: 'stories', name: 'Storyteller', hint: 'Ask the Library for a story.', how: 'Searched the Library for "tell me a story" and found Story time.' },
  { id: 'matrix', name: 'Digital Rain', hint: 'Some say the Terminal is made of falling green letters.', how: 'Typed matrix in the Terminal and watched the code rain.' },
  { id: 'sandwich', name: 'Sandwich Artist', hint: 'Ask the Terminal nicely. With authority.', how: 'Typed sudo make me a sandwich.' },
  { id: 'teapot', name: 'I\'m a Teapot', hint: 'The Terminal is not a barista.', how: 'Asked the Terminal for coffee and got HTTP 418.' },
  { id: 'edge', name: 'On the Edge', hint: 'Keep flipping.', how: 'Flipped a coin in the Decision maker and it landed on its edge.' },
  { id: 'nat20', name: 'Natural 20', hint: 'Roll for initiative.', how: 'Rolled a 20 on the Decision maker\'s d20.' },
  { id: 'jigowatts', name: 'Time Traveler', hint: 'Impatient with the speed test?', how: 'Clicked the speed test eight times and hit 88 miles per hour.' },
  { id: 'stapler', name: 'My Stapler', hint: 'Fabrix knows where the office supplies went.', how: 'Asked Fabrix where your stapler is.' },
  { id: 'loose', name: 'Loose Screw', hint: 'One dashboard panel rattles.', how: 'Clicked the loose dashboard panel until it fell off.' },
  { id: 'flaps', name: 'Flap Happy', hint: 'The board on the dashboard is touchy.', how: 'Ran your mouse across twenty split-flap letters.' },
  { id: 'chicken', name: 'Nobody Calls Me Chicken', hint: 'Choose a braver name for yourself in Settings. Or a less brave one.', how: 'Asked FBRX to call you "chicken". Bawk.' },
  { id: 'pcload', name: 'PC Load Letter', hint: 'The printer\'s most confusing error message, said to Fabrix.', how: 'Told Fabrix "PC load letter" (what does that even mean?).' },
  { id: 'chewie', name: 'Home Sweet Ship', hint: 'Tell Fabrix you made it back to the ship (call your co-pilot by name).', how: 'Told your furry co-pilot you were home, and Fabrix answered in growls.' },
  { id: 'fuzzball', name: 'Laugh It Up', hint: 'Your furry co-pilot answers to one insult only.', how: 'Called your co-pilot a fuzzball and got plain English back.' },
  { id: 'father', name: 'Plot Twist', hint: 'Say no to your furry co-pilot. Loudly. With extra o\'s.', how: 'Said "Nooo" and learned a family secret.' },
  { id: 'mirror', name: "Who's Who?", hint: 'On the Mesh page, ping a computer three times in a row. No other computer? Ping yourself (your own address).', how: 'Two computers pinged each other and started pointing fingers.' },
  { id: 'wookiee', name: 'Growl Whisperer', hint: 'Keep your furry co-pilot talking.', how: 'Kept a conversation going in growls for five messages.' },
];

/** Unlocked by itself once every other trophy is found. */
export const GOLDEN_TROPHY: TrophyInfo = { id: 'golden', name: 'Golden Goose', hint: 'Find every other trophy.', how: 'Found every easter egg. The goose now wears a golden egg with a #1 ribbon.' };

export const TROPHY_IDS = [...TROPHIES.map((t) => t.id), GOLDEN_TROPHY.id];

export interface TrophyState {
  /** Trophy id → when it was found. */
  unlocked: Record<string, string>;
}
