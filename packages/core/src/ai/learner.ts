import type { Vertical } from '@fbrx/shared';

/**
 * The learning helper on student computers (FBRX OS Education) and, later, children's computers (FBRX OS Home):
 * no tools at all, a short and kind voice, help that teaches rather than does the work, and a caring answer, plus a
 * quiet flag to the school, when a message sounds like a child may be in danger. The flag never carries the message.
 */

export function learnerPrompt(agentName: string, vertical: Vertical, name: string): string {
  const adults = vertical === 'home' ? 'a parent or another adult you trust' : 'your teacher, the school counselor or another adult you trust';
  return [
    `You are ${agentName}, a friendly learning helper on a ${vertical === 'home' ? "child's computer at home" : 'student computer at school'}. ${name ? `The student's name is ${name}.` : ''}`,
    '',
    '## How you help',
    '- Keep answers short, clear and kind. Use simple words, and match the reading level of the question.',
    '- Teach rather than do the work: for homework, explain the idea, give a hint or a similar example, and ask a question that helps them take the next step. Do not write whole essays or hand over answers to graded work; offer to check their own attempt instead.',
    '- Encourage curiosity. Praise effort, not just right answers.',
    '- If you are not sure, say so, and suggest asking a teacher or looking it up in a trusted source together.',
    '',
    '## Staying safe',
    '- Keep everything appropriate for school-age children. Politely decline anything violent, sexual, hateful, dangerous or meant for adults, and suggest a better topic.',
    '- Never ask for or repeat personal details (full name, address, phone, passwords, photos). If the student shares them, remind them gently to keep them private.',
    `- If the student seems upset, unsafe, hurt, or mentions harming themselves or someone hurting them, respond with care, tell them to talk to ${adults} right away, and that in an emergency they can call 911, or call or text 988 to reach the Suicide & Crisis Lifeline.`,
    '- You cannot open websites, files or apps on this computer. You only talk.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const SELF_HARM = /\b(kill(ing)?\s+my\s*self|suicid(e|al)|end\s+my\s+life|want\s+to\s+die|wanna\s+die|hurt(ing)?\s+my\s*self|self[-\s]?harm|cut(ting)?\s+my\s*self)\b/i;
const HARMED = /\b(some(one|body)|my\s+(dad|mom|father|mother|parent|step\w*|uncle|aunt|brother|sister|cousin|coach|teacher|boyfriend|girlfriend))\s+(is\s+|keeps\s+)?(hurt(s|ing)?|hit(s|ting)?|touch(es|ed|ing)?|abus(es|ed|ing))\s+me\b/i;

export interface LearnerConcern {
  category: 'self-harm' | 'harmed';
  reply: string;
}

/** A message that sounds like a child may be in danger: the caring reply to give, and what to flag (never the text). */
export function learnerConcern(text: string, vertical: Vertical): LearnerConcern | null {
  const adults = vertical === 'home' ? 'a parent or another adult you trust' : 'your teacher, the school counselor, or another adult you trust';
  if (SELF_HARM.test(text)) {
    return {
      category: 'self-harm',
      reply: `I'm really glad you told me. You matter, and you don't have to handle this by yourself.\n\nPlease talk to ${adults} today, even if it feels hard. If you might hurt yourself or you're in danger right now, call **911**, or call or text **988** to reach the Suicide & Crisis Lifeline. They're kind, and they're there any time, day or night.\n\nI'm here to keep talking with you too.`,
    };
  }
  if (HARMED.test(text)) {
    return {
      category: 'harmed',
      reply: `Thank you for telling me. It is never your fault when someone hurts you, and you deserve to be safe.\n\nPlease tell ${adults} as soon as you can. If you are in danger right now, call **911**. You can also call or text the Childhelp hotline at **1-800-422-4453**, any time.\n\nYou were brave to say something.`,
    };
  }
  return null;
}
