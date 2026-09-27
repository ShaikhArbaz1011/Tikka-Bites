\set ON_ERROR_STOP on
\echo '11. pull_changes: every change exactly once, page by page, and nothing after the clock'
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false) \g /dev/null
do $$
declare
  since bigint := 0; page jsonb; pages int := 0; first_db text;
  bills text[] := '{}'; menu_rows int := 0; lines_rows int := 0;
begin
  loop
    page := public.pull_changes(since, 7);
    pages := pages + 1;
    first_db := coalesce(first_db, page ->> 'dbId');
    assert page ->> 'dbId' = first_db, 'database id is stable';
    assert (page ->> 'rev')::bigint >= since, 'cursor never goes back';
    bills := bills || array(select b ->> 'billNo' from jsonb_array_elements(page -> 'bills') b);
    menu_rows := menu_rows + jsonb_array_length(page -> 'menu');
    lines_rows := lines_rows + jsonb_array_length(page -> 'lines');
    assert jsonb_array_length(page -> 'bills') + jsonb_array_length(page -> 'menu') + jsonb_array_length(page -> 'lines') <= 7, 'page size respected';
    since := (page ->> 'rev')::bigint;
    exit when not (page ->> 'more')::boolean;
    assert pages < 100, 'paging ends';
  end loop;
  assert cardinality(bills) = (select count(*) from public.bills), 'every bill: ' || cardinality(bills);
  assert (select count(distinct x) from unnest(bills) x) = cardinality(bills), 'no bill twice';
  assert menu_rows = (select count(*) from public.menu) and lines_rows = (select count(*) from public.cheesy_lines), 'every dish and line';
  assert since = (select rev from public.sync_clock), 'up to date = the clock';
  assert pages > 10, 'really paged: ' || pages;
  assert not (page ->> 'ready')::boolean and page -> 'settings' = 'null'::jsonb, 'not set up: no settings yet';

  -- One more change: the next pull returns exactly that change.
  update public.menu set active = false where id = 2;
  page := public.pull_changes(since, 500);
  assert jsonb_array_length(page -> 'menu') = 1 and page -> 'menu' -> 0 ->> 'id' = '2' and page -> 'menu' -> 0 ->> 'active' = 'false', 'only the change';
  assert jsonb_array_length(page -> 'bills') = 0 and not (page ->> 'more')::boolean, 'nothing else';
  assert (page ->> 'rev')::bigint = (select rev from public.sync_clock), 'caught up';
  since := (page ->> 'rev')::bigint;
  page := public.pull_changes(since, 500);
  assert (page ->> 'rev')::bigint = since and jsonb_array_length(page -> 'menu') = 0, 'no change, no rows';
  page := public.pull_changes(since + 1000, 500);
  assert (page ->> 'rev')::bigint = since + 1000, 'a cursor from the future is returned unchanged (the app checks dbId)';
end $$;
