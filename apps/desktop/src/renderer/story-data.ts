/**
 * Story time: how-tos nobody needed, unlocked by searching the Library for "tell me a story". Each one winks at a
 * film or game; the reference is revealed at the end. Family friendly, and a few even point at a real FBRX feature.
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
    t: 'How to fly with style',
    s: 'Technically falling. Stylishly.',
    steps: [
      'Climb onto something tall. A bed is fine. A bunk bed is ambitious.',
      'Point at the horizon with great confidence. Announce your destination loudly.',
      'Bounce off a ball, ride a toy car down a ramp and loop once around the ceiling fan.',
      'Land on your feet. If someone says that was not flying, agree: it was falling, with style.',
    ],
    ref: 'Inspired by a certain space ranger and his cowboy friend (Toy Story).',
  },
  {
    id: 'swim',
    t: 'How to wait for a download that is stuck at 99%',
    s: 'A technique borrowed from a very optimistic fish.',
    steps: [
      'Look at the progress bar. Notice it has not moved.',
      'Just keep swimming. Just keep swimming.',
      'Forget what you were waiting for. Remember again. Keep swimming.',
      'Still stuck? Open the Network Center and run a speed test. The fish would want you to.',
    ],
    ref: 'Inspired by a forgetful blue tang (Finding Nemo).',
    go: 'speed',
  },
  {
    id: 'home',
    t: 'How to phone home',
    s: 'Long distance, very long distance.',
    steps: [
      'Point one glowing finger at the sky.',
      'Build a communicator from a toy keyboard and an umbrella. Ask a grown-up before borrowing the umbrella.',
      'Or skip all that: open Mesh & phone, scan the pairing code with your phone and you are connected. No flying bicycles required.',
    ],
    ref: 'Inspired by a homesick visitor who liked candy (E.T. the Extra-Terrestrial).',
    go: 'mesh',
  },
  {
    id: 'towel',
    t: 'How not to panic',
    s: 'Printed in large, friendly letters on the cover.',
    steps: [
      'Locate your towel. A hoopy person always knows where their towel is.',
      'Breathe. Remember the answer is 42. The question is still loading.',
      'Make a nice cup of tea. If the computer tries to make it instead, it will be almost, but not quite, entirely unlike tea.',
    ],
    ref: 'Inspired by a very useful guide for galactic hitchhikers (The Hitchhiker\'s Guide to the Galaxy).',
  },
  {
    id: '1985',
    t: 'How to get back to 1985',
    s: 'Roads? Where we\'re going, we don\'t need roads.',
    steps: [
      'Find a stainless-steel sports car with gull-wing doors. Install a flux capacitor (it\'s what makes time travel possible).',
      'Generate 1.21 jigowatts. A clock tower struck by lightning works in a pinch.',
      'Reach exactly 88 miles per hour.',
      'Tip: the speed test in the Network Center seems to know something about this. Impatient people find out first.',
    ],
    ref: 'Inspired by a teenager, a scientist and a very fast car (Back to the Future).',
    go: 'speed',
  },
  {
    id: 'snowman',
    t: 'How to build a snowman',
    s: 'Do you want to? It doesn\'t have to be a snowman.',
    steps: [
      'Knock on a closed door. Ask nicely. Wait several years.',
      'Roll three snowballs: big, medium, small. Add a carrot. Add a warm hug (he likes those).',
      'Let it go. Then go to Storage and let go of a few gigabytes of temporary files too.',
    ],
    ref: 'Inspired by two royal sisters and a cheerful snowman (Frozen).',
    go: 'storage',
  },
  {
    id: 'heels',
    t: 'How to get home in three clicks',
    s: 'There\'s no place like 127.0.0.1.',
    steps: [
      'Put on your sparkliest shoes.',
      'Click your heels together three times.',
      'Say "There\'s no place like home." For computers it is 127.0.0.1, which is also home.',
      'Follow the yellow brick road if that doesn\'t work. Watch out for flying monkeys and pop-up ads.',
    ],
    ref: 'Inspired by a girl from Kansas and her little dog (The Wizard of Oz).',
  },
  {
    id: 'force',
    t: 'How to fix a printer with the Force',
    s: 'These aren\'t the drivers you\'re looking for.',
    steps: [
      'Close your eyes. Reach out with your feelings toward the printer.',
      'Wave your hand gently. Say: "You will print my document."',
      'If it still says "paper jam", it may be strong with the dark side. Open the Network Center\'s Printers tab instead. Use the Settings, Luke.',
    ],
    ref: 'Inspired by a galaxy far, far away (Star Wars).',
    go: 'printers',
  },
  {
    id: 'ghosts',
    t: 'How to deal with a haunted computer',
    s: 'Something strange in your neighborhood?',
    steps: [
      'Listen for strange noises. Fans count.',
      'Do not cross the streams. (Do not plug the power strip into itself, either.)',
      'Who you gonna call? Fabrix. Open the Bug catcher and let it look for the ghost.',
    ],
    ref: 'Inspired by four scientists with proton packs (Ghostbusters).',
    go: 'bugs',
  },
  {
    id: 'walk',
    t: 'How to take a very long walk to return some jewelry',
    s: 'One does not simply walk there.',
    steps: [
      'Pack light: a cloak, rope, and second breakfast. Also elevenses.',
      'Bring a loyal friend who carries the pans and says encouraging things.',
      'Do not put it on. Not even to try it. Especially not to try it.',
      'When it gets hard, remember: even the smallest person can change the course of the future.',
    ],
    ref: 'Inspired by a hobbit and his gardener (The Lord of the Rings).',
  },
  {
    id: 'capes',
    t: 'How to design a superhero outfit',
    s: 'Darling, listen carefully.',
    steps: [
      'Choose a fabric that is bulletproof, machine washable and fashionable.',
      'Pick a bold color. Red is classic.',
      'No capes! (They catch on things. Jet turbines. Elevator doors. Revolving doors.)',
    ],
    ref: 'Inspired by a tiny, brilliant costume designer (The Incredibles).',
  },
  {
    id: 'worries',
    t: 'How to stop worrying about your computer',
    s: 'It means no worries, for the rest of your days.',
    steps: [
      'Find a meerkat and a warthog with a good attitude.',
      'Sing loudly. Eat bugs (optional, discouraged).',
      'Turn on scheduled backups in Backup & restore. Then it really is a problem-free philosophy.',
    ],
    ref: 'Inspired by a lion cub and his two carefree friends (The Lion King).',
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
    ref: 'Inspired by an inventor dad and a very large backyard (Honey, I Shrunk the Kids).',
    go: 'storage',
  },
  {
    id: 'castle',
    t: 'How to find what you are looking for',
    s: 'Thank you! But your file is in another folder.',
    steps: [
      'Jump on the first thing that looks suspicious. Mushrooms are fine.',
      'Go down every green pipe. Look behind the waterfall.',
      'Or press Ctrl+K and type its name: Spotlight finds files, settings and apps in one go. Much less jumping.',
    ],
    ref: 'Inspired by a plumber who keeps checking the wrong castle (Super Mario Bros.).',
  },
  {
    id: 'groundhog',
    t: 'How to fix the same problem every single day',
    s: 'Okay campers, rise and shine!',
    steps: [
      'Wake up. Hear the same song on the radio. Find the same error message.',
      'Learn something new each day: the piano, ice sculpture, reading the event log.',
      'Finally fix the root cause (it was the driver). Tomorrow is, at last, tomorrow.',
    ],
    ref: 'Inspired by a weatherman stuck in a small town (Groundhog Day).',
    go: 'bugs',
  },
  {
    id: 'dragon',
    t: 'How to befriend a dragon',
    s: 'Everything we know about them is wrong.',
    steps: [
      'Put down the shield. Slowly. Look away and hold out your hand.',
      'Offer a fish. Not eel. Never eel.',
      'Scratch under the chin. If it falls over purring, congratulations, you have a dragon.',
    ],
    ref: 'Inspired by a Viking and his night-black dragon (How to Train Your Dragon).',
  },
];
