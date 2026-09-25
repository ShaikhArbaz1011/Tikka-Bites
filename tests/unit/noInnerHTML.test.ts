import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('security: no HTML-string sinks in src/', () => {
  it('never uses innerHTML / outerHTML / insertAdjacentHTML / document.write / eval', () => {
    const bad = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/;
    const offenders = files('src').filter((f) => bad.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
