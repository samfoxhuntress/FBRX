/**
 * Story time: how-tos nobody needed, unlocked by searching the Library for "tell me a story". Each one winks at a
 * film, book or game with a riddle-like hint at the end, in our own words: never a title, a character's name, a
 * trademark or a famous line. Guessing is the fun. Family friendly, and a few even point at a real FBRX feature.
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
    id: 'fly',
    t: 'How to fly (sort of)',
    s: 'Gravity is more of a suggestion.',
    steps: [
      'Climb onto something tall. A bed is fine. A bunk bed is ambitious.',
      'Point at the horizon with great confidence. Announce your destination loudly.',
      'Bounce off a ball, ride a toy car down a ramp and loop once around the ceiling fan.',
      'Land on your feet. If anyone says that was not really flying, smile and agree that it was very stylish falling.',
    ],
    ref: 'Inspired by a very confident toy astronaut and his cowboy friend.',
  },
  {
    id: 'swim',
    t: 'How to wait for a download that is stuck at 99%',
    s: 'A technique borrowed from a very optimistic fish.',
    steps: [
      'Look at the progress bar. Notice it has not moved.',
      'Keep going. Then keep going a little more.',
      'Forget what you were waiting for. Remember again. Keep going.',
      'Still stuck? Open the Network Center and run a speed test. The fish would want you to.',
    ],
    ref: 'Inspired by a cheerful little fish with a very short memory.',
    go: 'speed',
  },
  {
    id: 'home',
    t: 'How to call home from very far away',
    s: 'Long distance. Very long distance.',
    steps: [
      'Point one glowing finger at the sky.',
      'Build a communicator from a toy keyboard and an umbrella. Ask a grown-up before borrowing the umbrella.',
      'Or skip all that: open Mesh & phone, scan the pairing code with your phone and you are connected. No flying bicycles required.',
    ],
    ref: 'Inspired by a homesick visitor who liked candy.',
    go: 'mesh',
  },
  {
    id: 'towel',
    t: 'How not to panic',
    s: 'Best read with a cup of tea nearby.',
    steps: [
      'Find your towel. Every seasoned space traveler knows exactly where theirs is.',
      'Breathe. The answer is a surprisingly small number; the question is still loading.',
      'Make a cup of tea yourself. Computers are terrible at tea.',
    ],
    ref: 'Inspired by a very useful guidebook for hitchhiking across the galaxy.',
  },
  {
    id: '1985',
    t: 'How to get back to the eighties',
    s: 'Bring a very fast car and a spare lightning bolt.',
    steps: [
      'Find a shiny stainless-steel car whose doors open upward.',
      'Collect an absurd amount of electricity. A lightning bolt at exactly the right moment helps.',
      'Reach exactly 88 miles per hour.',
      'Tip: the speed test in the Network Center seems to know something about this. Impatient people find out first.',
    ],
    ref: 'Inspired by a teenager, an inventor and a very fast car.',
    go: 'speed',
  },
  {
    id: 'snowman',
    t: 'How to build a snowman',
    s: 'Best built with a sibling.',
    steps: [
      'Knock on your sibling\'s door and ask nicely. Be patient: it can take years.',
      'Roll three snowballs: big, medium, small. Add a carrot nose and stick arms. This one likes warm hugs, oddly.',
      'Then go to Storage and clear out a few gigabytes of temporary files: fresh snow for your drive.',
    ],
    ref: 'Inspired by two royal sisters and a snowman who dreams of summer.',
    go: 'storage',
  },
  {
    id: 'heels',
    t: 'How to get home in three clicks',
    s: 'Home is 127.0.0.1.',
    steps: [
      'Put on your sparkliest shoes.',
      'Click your heels together three times.',
      'Say that there is no place like home. For computers home is 127.0.0.1, so you are already there.',
      'If that doesn\'t work, follow the yellow road. Watch out for flying monkeys and pop-up ads.',
    ],
    ref: 'Inspired by a girl from Kansas and her little dog (a very old book).',
  },
  {
    id: 'force',
    t: 'How to fix a printer with a mind trick',
    s: 'Calm minds print faster.',
    steps: [
      'Close your eyes and breathe slowly, like a wise old mentor in a desert.',
      'Wave your hand gently. Say: "You will print my document."',
      'If it still says "paper jam", printers are stubborn. Open the Network Center\'s Printers tab instead.',
    ],
    ref: 'Inspired by a farm kid from a desert planet and a wise old teacher.',
    go: 'printers',
  },
  {
    id: 'ghosts',
    t: 'How to deal with a haunted computer',
    s: 'Strange noises after midnight?',
    steps: [
      'Listen for strange noises. Fans count.',
      'Never point two vacuum cleaners at each other. (And never plug a power strip into itself.)',
      'When in doubt, call in the professionals: open the Bug catcher and let Fabrix look for the ghost.',
    ],
    ref: 'Inspired by four scientists with homemade ghost-catching gear.',
    go: 'bugs',
  },
  {
    id: 'walk',
    t: 'How to take a very long walk to return some jewelry',
    s: 'Long walks need good snacks.',
    steps: [
      'Pack light: a cloak, some rope and more breakfasts than seem reasonable.',
      'Bring a loyal friend who carries the pots and pans and says encouraging things.',
      'Do not try the jewelry on. Not even once. Especially not once.',
      'When it gets hard, remember that small folks can change big things.',
    ],
    ref: 'Inspired by a small traveler with very hairy feet and his faithful gardener.',
  },
  {
    id: 'capes',
    t: 'How to design a superhero outfit',
    s: 'Fashion first. Function always.',
    steps: [
      'Choose a fabric that is bulletproof, machine washable and fashionable.',
      'Pick a bold color. Red is classic.',
      'Skip the cape. Capes catch on things: jet engines, elevator doors, revolving doors.',
    ],
    ref: 'Inspired by a tiny, brilliant designer who dresses heroes.',
  },
  {
    id: 'worries',
    t: 'How to stop worrying about your computer',
    s: 'Two friends, zero worries.',
    steps: [
      'Find a meerkat and a warthog with a good attitude.',
      'Sing loudly. Snacks are optional.',
      'Turn on scheduled backups in Backup & restore. Then you really can stop worrying.',
    ],
    ref: 'Inspired by a lion cub and his two carefree friends.',
    go: 'backup',
  },
  {
    id: 'shrink',
    t: 'How to shrink things without shrinking the kids',
    s: 'Point the shrink ray away from the backyard.',
    steps: [
      'Aim the shrink ray only at files. Never at children, pets or the lawn.',
      'Right-click a big folder and compress it to a .zip. It gets smaller and nobody has to ride an ant home.',
      'For bigger savings, open Storage and see what is taking all the room.',
    ],
    ref: 'Inspired by an inventor dad and a very large backyard.',
    go: 'storage',
  },
  {
    id: 'castle',
    t: 'How to find what you are looking for',
    s: 'Wrong castle again?',
    steps: [
      'Jump on the first thing that looks suspicious. Mushrooms are fine.',
      'Go down every green pipe. Look behind the waterfall.',
      'Or press Ctrl+K and type its name: Spotlight finds files, settings and apps in one go. Much less jumping.',
    ],
    ref: 'Inspired by a plumber who keeps checking the wrong castle.',
  },
  {
    id: 'groundhog',
    t: 'How to fix the same problem every single day',
    s: 'Same alarm. Same song. Same day.',
    steps: [
      'Wake up. Hear the same song on the radio. Find the same error message.',
      'Learn something new each day: the piano, ice sculpture, reading the event log.',
      'Finally fix the root cause (it was the driver). Tomorrow is, at last, tomorrow.',
    ],
    ref: 'Inspired by a weatherman stuck in a small town.',
    go: 'bugs',
  },
  {
    id: 'dragon',
    t: 'How to befriend a dragon',
    s: 'Dragons are misunderstood.',
    steps: [
      'Put down the shield. Slowly. Look away and hold out your hand.',
      'Offer a fish. Not an eel. Never an eel.',
      'Scratch under the chin. If it flops over happily, congratulations, you have a dragon.',
    ],
    ref: 'Inspired by a young inventor and a dragon who lost half a tail fin.',
  },
];
