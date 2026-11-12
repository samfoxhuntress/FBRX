/**
 * Story time: how-tos nobody needed, unlocked by searching the Library for "tell me a story". Each one retells a tale
 * that belongs to everyone (Aesop's fables, old fairy and folk tales, classic books long in the public domain) in our
 * own words, with a hint at the end, and most lead to the FBRX page that really helps. Never a film's, a show's or a
 * game's characters, lines or look: those belong to someone. Family friendly.
 */
export interface Story {
  id: string;
  t: string;
  s: string;
  steps: string[];
  /** "Inspired by…", shown under the steps. */
  ref: string;
  /** An FBRX page the story leads to, if any. */
  go?: string;
}

export const STORY_TRIGGER = /^(tell me a (bed ?time )?story|tell me a tale|story ?time|read me a story|once upon a time)\W*$/i;

export const STORIES: Story[] = [
  {
    id: 'porridge',
    t: 'How to find the setting that is just right',
    s: 'Not too hot, not too cold.',
    steps: [
      'Try the first bowl. Too hot. Try the second. Too cold.',
      'Try the third. Just right. Eat all of it, then feel slightly guilty.',
      'Your AI has bowls too: in Settings → Agent, Light, Balanced and Full speed decide how hard a model on this computer may work. Balanced is just right for most.',
    ],
    ref: 'Inspired by an old tale about a curious girl and three bears.',
    go: 'agentSettings',
  },
  {
    id: 'bricks',
    t: 'How to build a house the wolf cannot blow down',
    s: 'Straw is cheap for a reason.',
    steps: [
      'Skip the straw. Skip the sticks. Bricks take longer, and that is the point.',
      'Check the chimney as well: wolves come in through whatever you leave open.',
      'For a computer the bricks are updates, a firewall and a virus scan. Security shows which ones are in place.',
    ],
    ref: 'Inspired by an old folk tale about three little pigs and a very windy wolf.',
    go: 'security',
  },
  {
    id: 'tortoise',
    t: 'How to win a race by going slowly',
    s: 'Slow and steady, every single day.',
    steps: [
      'Start right away. Do not stop for a nap halfway, however far ahead you think you are.',
      'Small steps every day beat one big sprint once a year.',
      'Backups win the same way: turn on scheduled backups in Backup & restore and let them plod along.',
    ],
    ref: 'Inspired by one of Aesop’s fables, about a tortoise and a hare.',
    go: 'backup',
  },
  {
    id: 'wolf',
    t: 'How not to cry wolf',
    s: 'Shout less. Mean it more.',
    steps: [
      'Shout only when there really is a wolf. Otherwise nobody comes when there is one.',
      'If everything is an alarm, nothing is.',
      'In Alerts each kind has its own switch, and quiet hours hold back the rest, so the ones that matter still make you look up.',
    ],
    ref: 'Inspired by one of Aesop’s fables, about a shepherd boy who was bored.',
    go: 'alerts',
  },
  {
    id: 'nap',
    t: 'How to take a twenty-year nap',
    s: 'You wake up to a lot of updates.',
    steps: [
      'Wander up into the hills. Accept a drink from strangers playing a very loud game.',
      'Wake up with a long beard. Notice that everyone has new opinions.',
      'A computer that sleeps for months wakes up the same way: open Updates and catch up before you go anywhere.',
    ],
    ref: 'Inspired by an old American story about a man who slept for twenty years.',
    go: 'updates',
  },
  {
    id: 'pebbles',
    t: 'How to find your way back',
    s: 'Birds love breadcrumbs.',
    steps: [
      'Leave a trail of breadcrumbs. Watch the birds eat every last one.',
      'Next time use white pebbles: they shine in the moonlight and nobody eats them.',
      'Your pebbles are backups: Backup & restore keeps a way back to how things were.',
    ],
    ref: 'Inspired by an old fairy tale about a brother, a sister and a house made of sweets.',
    go: 'backup',
  },
  {
    id: 'beanstalk',
    t: 'How to deal with something that grew overnight',
    s: 'Magic beans are rarely a bargain.',
    steps: [
      'Trade the cow for a handful of beans. Regret it, briefly.',
      'Wake up to a stalk taller than the house. Climb it, carefully.',
      'When a drive fills up overnight, the rule is the same: find what grew. Storage maps what takes the room.',
    ],
    ref: 'Inspired by an old English tale about a boy, a cow and some beans.',
    go: 'storage',
  },
  {
    id: 'clothes',
    t: 'How to tell the emperor about his new clothes',
    s: 'Somebody has to say it.',
    steps: [
      'Admire the clothes everyone else is admiring. Then look closer.',
      'Notice there are no clothes. Say so, politely but clearly.',
      'Fabrix works the same way: it says something is done only when it can show it, and says so plainly when it is not sure.',
    ],
    ref: 'Inspired by an old fairy tale about a vain emperor and two clever tailors.',
    go: 'agent',
  },
  {
    id: 'world',
    t: 'How to go around the world in eighty milliseconds',
    s: 'No balloon needed.',
    steps: [
      'Pack a single bag and bring a very punctual friend.',
      'Pick a website on the other side of the world.',
      'In the Network Center, trace the route: every stop on the way and how long each hop took. Faster than any steamship.',
    ],
    ref: 'Inspired by an old adventure novel about a bet and a trip around the world.',
    go: 'network',
  },
  {
    id: 'name',
    t: 'How to keep a name nobody can guess',
    s: 'Some names are best kept secret.',
    steps: [
      'Sing your secret name loudly around a campfire. Find out why that was a mistake.',
      'Pick a name nobody could guess, and never say it out loud.',
      'Passwords are the same: long, odd and never said out loud. The Vault keeps them for you.',
    ],
    ref: 'Inspired by an old fairy tale about a little man who spun straw into gold.',
    go: 'vault',
  },
  {
    id: 'heels',
    t: 'How to get home in three clicks',
    s: 'Home is 127.0.0.1.',
    steps: [
      'Put on your sparkliest shoes.',
      'Click your heels together three times.',
      'Say that there is no place like home. For computers home is 127.0.0.1, so you are already there.',
      'If that doesn’t work, follow the yellow road. Watch out for winged monkeys and pop-up ads.',
    ],
    ref: 'Inspired by a girl from Kansas and her little dog (a book from 1900).',
  },
];
