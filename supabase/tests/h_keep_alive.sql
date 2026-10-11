\set ON_ERROR_STOP on
\echo '15. keep_alive(): one random 6-digit number saved and deleted, nothing left; separate from the app'
set role anon;
do $$
declare r1 jsonb; r2 jsonb;
begin
  r1 := public.keep_alive();
  r2 := public.keep_alive();
  assert (r1 ->> 'saved')::int between 100000 and 999999, 'a 6-digit number: ' || (r1 ->> 'saved');
  assert (r1 ->> 'deleted')::boolean and (r1 ->> 'rowsLeft')::int = 0 and (r2 ->> 'rowsLeft')::int = 0, 'deleted again, table empty';
end $$;
select t.expect_error('select * from public.dummy', 'permission denied');
select t.expect_error('insert into public.dummy (dummy_data) values (123456)', 'permission denied');
select t.expect_error('select public.pull_changes(0)', 'permission denied'); -- the public key still can't read the shop's data
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false) \g :devnull
select t.expect_error('select public.keep_alive()', 'permission denied'); -- signed-in staff (the app) don't use it
reset role;
do $$ begin
  assert (select count(*) from public.dummy) = 0, 'no rows kept';
  assert (select count(*) from generate_series(1, 200) where public.keep_alive() ->> 'rowsLeft' = '0') = 200, '200 runs, never a row left';
  assert (select count(*) from public.dummy) = 0, 'still empty';
  assert not exists (select 1 from information_schema.routine_table_usage where table_name = 'dummy' and routine_name <> 'keep_alive'), 'only keep_alive uses the dummy table';
end $$;
select set_config('request.jwt.claims', '', false) \g :devnull
