/**
 * supabase/schema.sql rules that the local PostgreSQL tests cannot catch.
 * Supabase loads the safeupdate guard for app requests: any DELETE or UPDATE without
 * a WHERE clause fails with "DELETE requires a WHERE clause", even inside our
 * functions. Local PostgreSQL has no such guard, so this checks the text instead.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');

/** DELETE / UPDATE statements with no WHERE clause (comments ignored). */
function unguarded(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, '');
  const found: string[] = [];
  for (const m of code.matchAll(/\b(delete\s+from\s+\S+|update\s+\S+\s+set)\b[^;]*;/gi)) {
    if (!/\bwhere\b/i.test(m[0])) found.push(m[0].replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('schema.sql works with Supabase safeupdate', () => {
  it('every DELETE and UPDATE has a WHERE clause', () => {
    expect(unguarded(schema)).toEqual([]);
  });

  it('the check itself spots a missing WHERE (and ignores upserts and row locks)', () => {
    expect(unguarded('delete from public.menu;\nupdate public.x\n  set a = 1;')).toEqual(['delete from public.menu;', 'update public.x set a = 1;']);
    expect(unguarded('delete from t where true; -- delete from t;\nupdate t set a = 1 where id = 1;')).toEqual([]);
    expect(unguarded('insert into c values (1) on conflict (k) do update set last = 2; select 1 from s for update;')).toEqual([]);
  });
});
