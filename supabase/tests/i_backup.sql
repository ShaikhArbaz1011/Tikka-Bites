\set ON_ERROR_STOP on
\echo '19. backup_pull(): the nightly Google Sheet copy reads everything with the backup key, and nothing without it'
-- No key set yet: nobody gets in.
set role anon;
select t.expect_error($q$select public.backup_pull('test-backup-key-0123456789abcdef0123456789abcdef', 0)$q$, 'Wrong backup key');
-- Only the owner (SQL Editor) may set the key, and only as a 64-character hash.
select t.expect_error($q$select public.set_backup_key(repeat('a', 64))$q$, 'permission denied');
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
select t.expect_error($q$select public.set_backup_key(repeat('a', 64))$q$, 'permission denied'); -- not even the super admin in the app
select t.expect_error($q$select public.backup_pull('test-backup-key-0123456789abcdef0123456789abcdef', 0)$q$, 'permission denied'); -- the app never uses it
reset role;
select set_config('request.jwt.claims', '', false) \g :devnull
select t.expect_error($q$select public.set_backup_key('not-a-hash')$q$, '64-character code');
select public.set_backup_key(encode(sha256(convert_to('test-backup-key-0123456789abcdef0123456789abcdef', 'UTF8')), 'hex')) \g :devnull

set role anon;
select t.expect_error($q$select public.backup_pull('wrong-backup-key-0123456789abcdef0123456789abcdef', 0)$q$, 'Wrong backup key');
select t.expect_error($q$select public.backup_pull('short', 0)$q$, 'Wrong backup key');
select t.expect_error($q$select public.backup_pull(null, 0)$q$, 'Wrong backup key');
select t.expect_error('select * from public.backup_access', 'permission denied');
select t.expect_error('select public.pull_changes(0)', 'permission denied'); -- the public key alone still reads nothing
do $$
declare
  k constant text := 'test-backup-key-0123456789abcdef0123456789abcdef';
  p jsonb;
  since bigint := 0;
  pages integer := 0;
  nos text[] := '{}';
  last_counts jsonb;
begin
  -- Page through everything, 7 changes at a time, like the script does with 500.
  loop
    p := public.backup_pull(k, since, 7);
    pages := pages + 1;
    assert p ? 'dbId' and p ? 'rev' and p ? 'more', 'page shape';
    assert (p ->> 'rev')::bigint >= since, 'rev never goes back';
    nos := nos || array(select b ->> 'no' from jsonb_array_elements(p -> 'bills') b);
    assert not exists (select 1 from jsonb_array_elements(p -> 'bills') b where not (b ? 'no' and b ? 'bill' and b ? 'rev' and b ? 'by')), 'each bill comes with its rev and who saved it';
    assert not exists (select 1 from jsonb_array_elements(p -> 'menu') m where not (m ? 'rev' and m ? 'price_paise')), 'dishes come as rows with their rev';
    since := (p ->> 'rev')::bigint;
    if not (p ->> 'more')::boolean then last_counts := p -> 'counts'; exit; end if;
    assert p -> 'counts' = 'null'::jsonb, 'counts only on the last page';
    assert pages < 1000, 'paging ends';
  end loop;
  assert pages > 1, 'more than one page was needed';
  set local role postgres;
  assert cardinality(nos) = (select count(*) from public.bills), 'every bill once: ' || cardinality(nos);
  assert cardinality(nos) = (select count(distinct x) from unnest(nos) x), 'no bill twice';
  assert last_counts = (select jsonb_object_agg(month_key, n) from (select month_key, count(*) as n from public.bills group by month_key) c), 'counts per month';
  assert since = (select rev from public.sync_clock), 'ends at the clock';
  assert (select count(*) from public.bills b where b.created_by is not null) = 0
      or exists (select 1 from jsonb_array_elements(public.backup_pull(k, 0, 1000) -> 'bills') b where b ->> 'by' is not null), 'saved-by names come along';
end $$;
-- Nothing new: an empty page at the clock.
do $$
declare p jsonb; c bigint;
begin
  set local role postgres;
  select rev into c from public.sync_clock;
  set local role anon;
  p := public.backup_pull('test-backup-key-0123456789abcdef0123456789abcdef', c);
  assert jsonb_array_length(p -> 'bills') = 0 and not (p ->> 'more')::boolean and (p ->> 'rev')::bigint = c, 'nothing new';
end $$;
reset role;
-- Read only: a STABLE function can't change anything, and the key can be changed (old one stops working).
do $$ begin
  assert (select provolatile from pg_proc where proname = 'backup_pull') = 's', 'backup_pull is read only (STABLE)';
  assert not exists (select 1 from information_schema.routine_privileges where routine_name = 'set_backup_key' and grantee in ('anon', 'authenticated', 'PUBLIC')), 'set_backup_key is owner only';
end $$;
select public.set_backup_key(encode(sha256(convert_to('new-backup-key-0123456789abcdef0123456789abcdef', 'UTF8')), 'hex')) \g :devnull
set role anon;
select t.expect_error($q$select public.backup_pull('test-backup-key-0123456789abcdef0123456789abcdef', 0)$q$, 'Wrong backup key');
select (public.backup_pull('new-backup-key-0123456789abcdef0123456789abcdef', 0) ? 'dbId') as new_key_works \g :devnull
reset role;
