import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * React keeps whatever an effect returns as its cleanup, and calls it before the effect runs again. An effect written as
 * an expression (`useEffect(() => x.scrollIntoView(…), …)`) returns that call's value: a scroll method returns a promise
 * in newer browsers, an animation frame or a timer a number, a request a promise. React then calls it, and the page
 * stops with "… is not a function". Such effects take a block body.
 */
const ROOT = join(__dirname, '..', '..', '..');
const RETURNS_A_VALUE = /\.(scrollIntoView|scrollTo|scrollBy|scroll|play)\(|\b(requestAnimationFrame|setTimeout|setInterval|fetch|call|api|coreCall)\(/;
const EXPRESSION_EFFECT = /use(?:Layout)?Effect\(\s*\(\)\s*=>\s*(?![{(\s])([^\n]*)/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.generated.ts')) out.push(path);
  }
  return out;
}

describe('React effects', () => {
  it('never return a call React would take for their cleanup', () => {
    const found: string[] = [];
    for (const top of ['apps', 'packages']) {
      for (const pkg of readdirSync(join(ROOT, top))) {
        const src = join(ROOT, top, pkg, 'src');
        if (!statSync(join(ROOT, top, pkg)).isDirectory() || !readdirSync(join(ROOT, top, pkg)).includes('src')) continue;
        for (const file of sources(src)) {
          const text = readFileSync(file, 'utf8');
          for (const m of text.matchAll(EXPRESSION_EFFECT)) {
            if (RETURNS_A_VALUE.test(m[1]!)) found.push(`${relative(ROOT, file)}: ${m[0].slice(0, 100)}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
