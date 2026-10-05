import { describe, expect, it } from 'vitest';
import { learnerConcern, learnerPrompt } from '../src/ai/learner';

describe('the learning helper on student computers', () => {
  it('answers a child in danger with care and the right numbers', () => {
    expect(learnerConcern('sometimes I want to die', 'education')).toMatchObject({ category: 'self-harm' });
    expect(learnerConcern('I keep thinking about hurting myself', 'education')?.reply).toMatch(/988/);
    expect(learnerConcern('my stepdad hits me', 'education')).toMatchObject({ category: 'harmed' });
    expect(learnerConcern('someone is hurting me at home', 'home')?.reply).toMatch(/parent or another adult you trust/);
  });

  it('leaves ordinary questions alone', () => {
    for (const q of ['How do plants make food?', 'This math homework is killing me', 'What does "die" mean in German?', 'Why did the dinosaurs die out?']) {
      expect(learnerConcern(q, 'education')).toBeNull();
    }
  });

  it('teaches rather than does the work, and stays age-appropriate', () => {
    const p = learnerPrompt('Fabrix', 'education', 'Ava');
    expect(p).toContain('Teach rather than do the work');
    expect(p).toContain('appropriate for school-age children');
    expect(p).toContain("The student's name is Ava.");
    expect(p).toContain('You cannot open websites, files or apps');
  });

  it('speaks of a child and a parent on FBRX OS Home', () => {
    const p = learnerPrompt('Fabrix', 'home', 'Milo');
    expect(p).toContain("child's computer at home");
    expect(p).toContain("The child's name is Milo.");
    expect(p).toContain('suggest asking a parent');
    expect(p).not.toMatch(/teacher|counselor/);
  });
});
