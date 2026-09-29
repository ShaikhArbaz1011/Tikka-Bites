\set ON_ERROR_STOP on
-- Runs after a–d on tb_test. Months below are India time, like the server.
select to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 month', 'YYYYMM') as m1,
       to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '2 months', 'YYYYMM') as m2,
       to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '3 months', 'YYYYMM') as m3 \gset

\echo '12. User IDs: typed on the sign-in screen, turned into the account email'
reset role;
select set_config('request.jwt.claims', '', false) \g :devnull
select public.allow_staff('owner@tikka.test', 'Owner') \g :devnull
select public.allow_staff('counter1@tikka.test', 'counter1') \g :devnull
do $$ begin
  assert (select username from public.staff where email = 'owner@tikka.test') = 'owner', 'stored in small letters';
  -- Running allow_staff again without a User ID keeps the one already set.
  perform public.allow_staff('owner@tikka.test');
  assert (select username from public.staff where email = 'owner@tikka.test') = 'owner', 'User ID kept';
end $$;
select t.expect_error($q$select public.allow_staff('counter2@tikka.test', 'owner')$q$, 'already used by someone else');
select t.expect_error($q$select public.allow_staff('counter2@tikka.test', 'a')$q$, 'User ID must be 2–30 characters');
select t.expect_error($q$select public.allow_staff('counter2@tikka.test', 'bad name')$q$, 'User ID must be 2–30 characters');
select t.expect_error($q$select public.allow_staff('counter2@tikka.test', '<script>')$q$, 'User ID must be 2–30 characters');
set role anon;
do $$ begin
  assert public.login_email(' OWNER ') = 'owner@tikka.test', 'anyone can turn a User ID into the email (needed to sign in)';
  assert public.login_email('counter1') = 'counter1@tikka.test', 'counter1';
  assert public.login_email('nobody') is null, 'unknown User ID gives nothing';
end $$;
select t.expect_error('select * from public.staff', 'permission denied');
select t.expect_error('select public.purge_old_months()', 'permission denied');
reset role;
select public.remove_staff('counter1') \g :devnull
do $$ begin assert not exists (select 1 from public.staff where email = 'counter1@tikka.test'), 'removed by User ID'; end $$;
select public.allow_staff('counter1@tikka.test', 'counter1') \g :devnull

\echo '13. offline bills keep their sale time, month and price, and print number'
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
do $$
declare
  m text := to_char(now() at time zone 'Asia/Kolkata', 'YYYYMM');
  m1 text := to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 month', 'YYYYMM');
  -- 23:50 on the last day of last month, India time (at most ~31 days ago)
  at_ms bigint := floor(extract(epoch from ((date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '10 minutes') at time zone 'Asia/Kolkata')) * 1000)::bigint;
  price int := (select price_paise from public.menu where id = 3);
  b jsonb; b2 jsonb; n int;
begin
  -- The menu price changed after the sale; the offline bill keeps what was charged.
  update public.menu set price_paise = price + 500 where id = 3;
  b := public.save_bill(jsonb_build_object(
    'offline', true, 'createdAt', at_ms, 'printedAs', 'OFF-K7Q-0003', 'clientRef', '2a8fad5b-d9cb-469f-a165-70867728950e',
    'items', jsonb_build_array(jsonb_build_object('menuId', 3, 'qty', 2, 'unitPaise', price, 'name', 'Sweet Lassi', 'category', 'Thanda Matter', 'isVeg', true)),
    'orderType', 'takeaway', 'paymentMode', 'upi', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', 2 * price, 'cheesyLine', ''));
  assert b ->> 'billNo' = 'RCPT-' || m1 || '-0001', 'numbered in LAST month (the sale month): ' || (b ->> 'billNo');
  assert b ->> 'monthKey' = m1 and (b ->> 'createdAt')::bigint = at_ms, 'sale time kept';
  assert (b ->> 'hour')::int = 23, 'hour of the sale, India time';
  assert (b -> 'items' -> 0 ->> 'unitPaise')::int = price and b -> 'items' -> 0 ->> 'name' = 'Sweet Lassi', 'price and name as printed';
  assert b ->> 'printedAs' = 'OFF-K7Q-0003', 'printed temporary number kept';
  assert (select status from public.bills where bill_no = b ->> 'billNo') = 'paid', 'saved';
  -- A retry after a lost reply returns the same bill.
  b2 := public.save_bill(jsonb_build_object(
    'offline', true, 'createdAt', at_ms, 'printedAs', 'OFF-K7Q-0003', 'clientRef', '2a8fad5b-d9cb-469f-a165-70867728950e',
    'items', jsonb_build_array(jsonb_build_object('menuId', 3, 'qty', 2, 'unitPaise', price)),
    'orderType', 'takeaway', 'paymentMode', 'upi', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', 2 * price, 'cheesyLine', ''));
  assert b2 = b, 'retry gives the same bill';
  -- A dish deleted meanwhile still uploads offline (it was sold), but not online.
  update public.menu set deleted = true where id = 3;
  b := public.save_bill(jsonb_build_object(
    'offline', true, 'createdAt', public.now_ms() - 60000, 'printedAs', 'OFF-K7Q-0004',
    'items', jsonb_build_array(jsonb_build_object('menuId', 3, 'qty', 1, 'unitPaise', price)),
    'orderType', 'takeaway', 'paymentMode', 'cash', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', price, 'cheesyLine', ''));
  assert b ->> 'monthKey' = m, 'a recent offline bill lands in this month';
  update public.menu set deleted = false where id = 3;
end $$;
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"items":[{"menuId":3,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, (select public.now_ms() + 3600000)), 'time in the future');
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"items":[{"menuId":3,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, (select public.now_ms() - 40::bigint * 86400000)), 'more than 35 days old');
select t.expect_error($q$select public.save_bill('{"offline":true,"createdAt":"yesterday","items":[{"menuId":3,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, 'Invalid time');
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"printedAs":"RCPT-1","items":[{"menuId":3,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, (select public.now_ms())), 'Invalid offline bill number');
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"items":[{"menuId":3,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":999}')$q$, (select public.now_ms())), 'Totals do not add up');
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"items":[{"menuId":3,"qty":1,"unitPaise":0}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":0}')$q$, (select public.now_ms())), 'Invalid item');
select t.expect_error(format($q$select public.save_bill('{"offline":true,"createdAt":%s,"items":[{"menuId":999,"qty":1,"unitPaise":100}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, (select public.now_ms())), 'no longer on the menu');
-- An ONLINE bill cannot claim a time: the server's clock wins.
do $$
declare b jsonb;
begin
  b := public.save_bill(jsonb_build_object('createdAt', 1, 'items', jsonb_build_array(jsonb_build_object('menuId', 3, 'qty', 1, 'unitPaise', (select price_paise from public.menu where id = 3))),
    'orderType', 'takeaway', 'paymentMode', 'cash', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', (select price_paise from public.menu where id = 3), 'cheesyLine', ''));
  assert (b ->> 'createdAt')::bigint > public.now_ms() - 60000, 'server time used';
  assert not (b ? 'printedAs'), 'no printed temporary number';
end $$;

\echo '14. only this month and the 2 before it are kept'
reset role;
insert into public.bills (bill_no, created_at, month_key, status, data) values
  ('RCPT-' || :'m3' || '-0001', 1, :'m3', 'paid', '{}'),
  ('RCPT-' || :'m3' || '-0002', 1, :'m3', 'void', '{}'),
  ('RCPT-' || :'m2' || '-0001', 1, :'m2', 'paid', '{}'),
  ('INV-190001-0001', 1, '190001', 'paid', '{}');
insert into public.counters (month_key, last) values (:'m3', 2), (:'m2', 1) on conflict (month_key) do update set last = excluded.last;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false) \g :devnull
select t.expect_error('select public.purge_old_months()', 'not on the Tikka Bites staff list');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
do $$
declare
  m1 text := to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 month', 'YYYYMM');
  m2 text := to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '2 months', 'YYYYMM');
  n int; page jsonb;
begin
  assert public.keep_from_month() = m2, 'keeps from 2 months ago: ' || public.keep_from_month();
  page := public.pull_changes(0, 5);
  assert page ->> 'keepFrom' = m2, 'devices are told which months are kept';
  n := public.purge_old_months();
  assert n = 3, 'three old bills deleted (two from 3 months ago, one very old): ' || n;
  assert public.purge_old_months() = 0, 'running it again deletes nothing';
  assert exists (select 1 from public.bills where month_key = m2), '2 months ago is kept';
  assert exists (select 1 from public.bills where month_key = m1), 'last month is kept';
  assert not exists (select 1 from public.bills where month_key < m2), 'nothing older';
end $$;
reset role;
do $$ begin
  assert not exists (select 1 from public.counters where month_key < public.keep_from_month()), 'old counters removed';
  assert exists (select 1 from public.counters where month_key = public.keep_from_month()), 'kept month counter stays';
end $$;
-- The nightly job runs with no signed-in user: allowed.
select set_config('request.jwt.claims', '', false) \g :devnull
do $$ begin assert public.purge_old_months() = 0, 'runs without a user (pg_cron)'; end $$;
