import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENE_BACKDROPS, SCENE_CHARACTERS, SCENE_HOLD, SCENE_SCENERY, SCENE_WEAR, renderScene } from '../src/docs/scene';
import { cleanSvg } from '../src/tools/builtin/create-tools';
import { makeKernel } from './helpers';

describe('scenes from FBRX art (image.compose)', () => {
  it('draws every backdrop, character, hat, held thing and piece of scenery as clean SVG', () => {
    for (const backdrop of SCENE_BACKDROPS) {
      const svg = renderScene({
        backdrop,
        title: 'A & B <test>',
        caption: 'Every piece',
        items: [
          ...SCENE_CHARACTERS.map((part, i) => ({ part, x: 5 + i * 12, wear: SCENE_WEAR[i % SCENE_WEAR.length], hold: [SCENE_HOLD[i % SCENE_HOLD.length], SCENE_HOLD[(i + 1) % SCENE_HOLD.length]], label: part, flip: i % 2 === 1 })),
          ...SCENE_SCENERY.map((part, i) => ({ part, x: 4 + i * 4.5, color: i % 2 ? 'navy' : '#c0ffee' })),
        ],
      });
      // Nothing the tool's own cleaning would strip, and text is escaped.
      expect(cleanSvg(svg)).toBe(svg);
      expect(svg).toContain('A &amp; B &lt;test&gt;');
      expect(svg).not.toMatch(/NaN|undefined/);
    }
  });

  it('says which pieces there are when one is not', () => {
    expect(() => renderScene({ backdrop: 'day', items: [{ part: 'unicorn', x: 50 }] })).toThrow(/No part is called "unicorn"\. Characters: person, giant, mouse/);
    expect(() => renderScene({ backdrop: 'day', items: [{ part: 'mouse', x: 50, wear: 'tiara' }] })).toThrow(/helmet, crown/);
    expect(() => renderScene({ backdrop: 'day', items: [{ part: 'mouse', x: 50, hold: ['bow'] }] })).toThrow(/sword, shield/);
  });

  it('is saved in the FBRX folder like any drawing', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { outputFolder: join(sandbox, 'Made') } });
      const tool = kernel.registry.get('image.compose')!;
      const r = await tool.run(
        { title: 'Mouse Knight vs. the Mud-Cloaked Giant', backdrop: 'day', items: [{ part: 'mouse', x: 30, wear: 'helmet', hold: ['sword', 'shield'], label: 'Mouse Knight' }, { part: 'giant', x: 70, flip: true, color: 'mud', wear: 'hood', hold: ['club'] }, { part: 'castle', x: 10, y: 80 }] },
        {} as never,
      );
      const file = (r.data as { files: Array<{ name: string; path: string }> }).files[0];
      expect(file.name).toBe('Mouse Knight vs. the Mud-Cloaked Giant.svg');
      expect(readFileSync(file.path, 'utf8')).toContain('Mouse Knight</text>');
    } finally {
      await cleanup();
    }
  });
});
