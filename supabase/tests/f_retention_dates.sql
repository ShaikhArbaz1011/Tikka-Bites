\set ON_ERROR_STOP on
-- 3-month limit, tested at many different moments (runs on its own fresh database).
-- keep_from_month_at(time) = the oldest month kept at that time (India time).
-- purge_months_before(month) = what the nightly job / app does with that month.

\echo 'R1. which months are kept, at different moments'
do $$
declare
  cases text[][] := array[
    -- moment (with its time zone)          oldest kept month
    array['2026-09-15 12:00:00+05:30',       '202607'],  -- mid September: Jul, Aug, Sep
    array['2026-09-01 00:00:00+05:30',       '202607'],  -- first second of September
    array['2026-09-30 23:59:59.999+05:30',   '202607'],  -- last moment of September: July still kept
    array['2026-10-01 00:00:00+05:30',       '202608'],  -- 1 October, midnight in India: July goes
    array['2026-09-30 18:29:59+00',          '202607'],  -- = 23:59:59 in India on 30 Sep
    array['2026-09-30 18:30:00+00',          '202608'],  -- = 00:00 in India on 1 Oct (UTC is still 30 Sep!)
    array['2026-10-01 00:00:00+00',          '202608'],  -- UTC midnight is already 05:30 in India
    array['2026-12-31 23:59:00+05:30',       '202610'],  -- New Year's Eve: Oct, Nov, Dec
    array['2027-01-01 00:00:00+05:30',       '202611'],  -- New Year: Nov, Dec, Jan (October goes)
    array['2027-02-01 00:00:00+05:30',       '202612'],  -- February: Dec, Jan, Feb
    array['2028-02-29 12:00:00+05:30',       '202712'],  -- leap day
    array['2028-03-01 00:00:00+05:30',       '202801'],  -- after a leap February
    array['2026-03-31 23:59:59+05:30',       '202601'],  -- end of a 31-day month
    array['2026-05-01 00:00:00+05:30',       '202603']   -- 1 May: March, April, May
  ];
  c text[];
begin
  foreach c slice 1 in array cases loop
    assert public.keep_from_month_at(c[1]::timestamptz) = c[2],
      format('at %s expected %s, got %s', c[1], c[2], public.keep_from_month_at(c[1]::timestamptz));
  end loop;
  assert public.keep_from_month() = public.keep_from_month_at(now()), 'the live rule uses now()';
end $$;

\echo 'R2. data for six months: May–October 2026 (paid, voided, old INV- numbers, counters)'
insert into public.menu (id, name, category, price_paise, is_veg) values (1, 'Full Chicken', 'Grill Gali', 45000, false);
insert into public.settings (id, data) values (1, '{"name":"Tikka Bites","currencySymbol":"₹","receiptWidth":"80","roundOff":true}');
insert into public.cheesy_lines (text) values ('Keep me');
-- n bills per month; bill k of month m is RCPT-m-000k (the 3rd of July is voided, one June bill is an old INV-)
insert into public.bills (bill_no, created_at, month_key, status, data)
select case when m = '202606' and k = 1 then 'INV-' else 'RCPT-' end || m || '-' || lpad(k::text, 4, '0'),
       1, m, case when m = '202607' and k = 3 then 'void' else 'paid' end, jsonb_build_object('totalPaise', 45000)
  from (values ('202605', 2), ('202606', 3), ('202607', 4), ('202608', 5), ('202609', 6), ('202610', 1)) as months(m, n),
       generate_series(1, n) as k;
insert into public.counters (month_key, last) values ('202605', 2), ('202606', 3), ('202607', 4), ('202608', 5), ('202609', 6), ('202610', 1);

-- A bill made at 00:10 on 1 August India time is an AUGUST bill (UTC is still 31 July).
select public.allow_staff('owner@tikka.test', 'owner') \g :devnull
do $$ begin
  assert to_char(timestamptz '2026-07-31 18:40:00+00' at time zone 'Asia/Kolkata', 'YYYYMM') = '202608', 'IST month of 00:10 on 1 Aug';
end $$;

\echo 'R3. a mid-September clean-up deletes May and June only'
do $$
declare n int;
begin
  n := public.purge_months_before(public.keep_from_month_at('2026-09-15 12:00+05:30'));
  assert n = 5, 'May (2) + June (3) = 5 bills deleted, got ' || n;
  assert not exists (select 1 from public.bills where month_key in ('202605', '202606')), 'May and June are gone';
  assert not exists (select 1 from public.bills where bill_no like 'INV-202606-%'), 'old INV- numbers go too';
  assert not exists (select 1 from public.counters where month_key in ('202605', '202606')), 'their counters are gone';
  -- July–October untouched, bill for bill.
  assert (select array_agg(month_key || ':' || cnt order by month_key) from (select month_key, count(*) cnt from public.bills group by 1) x)
       = array['202607:4', '202608:5', '202609:6', '202610:1'], 'other months untouched';
  assert (select count(*) from public.bills where status = 'void' and month_key = '202607') = 1, 'the voided July bill is still there';
end $$;

\echo 'R4. on 1 October exactly ONE month (July) is deleted — voided bill included'
do $$
declare n int; july int := (select count(*) from public.bills where month_key = '202607');
begin
  -- One second before midnight in India: nothing new goes.
  n := public.purge_months_before(public.keep_from_month_at('2026-09-30 23:59:59+05:30'));
  assert n = 0, 'one second early: nothing deleted, got ' || n;
  -- Midnight in India (still 30 Sep in UTC): July goes, all of it.
  n := public.purge_months_before(public.keep_from_month_at('2026-09-30 18:30:00+00'));
  assert n = july and july = 4, format('exactly July''s %s bills deleted, got %s', july, n);
  assert not exists (select 1 from public.bills where month_key = '202607'), 'July is gone (paid and void)';
  assert (select array_agg(month_key || ':' || cnt order by month_key) from (select month_key, count(*) cnt from public.bills group by 1) x)
       = array['202608:5', '202609:6', '202610:1'], 'August, September, October untouched';
  assert not exists (select 1 from public.counters where month_key = '202607'), 'July counter gone';
  assert (select array_agg(month_key || ':' || last order by month_key) from public.counters where month_key between '202608' and '202610')
       = array['202608:5', '202609:6', '202610:1'], 'kept months keep their counters (numbering continues)';
end $$;

\echo 'R5. running it again changes nothing; menu, settings and lines are never touched'
do $$ begin
  assert public.purge_months_before(public.keep_from_month_at('2026-10-01 09:00+05:30')) = 0, 'second run deletes nothing';
  assert public.purge_months_before(public.keep_from_month_at('2026-10-31 23:59+05:30')) = 0, 'the rest of October deletes nothing';
  assert (select count(*) from public.menu) = 1 and (select count(*) from public.settings) = 1 and (select count(*) from public.cheesy_lines) >= 1,
    'menu, settings and receipt lines are kept';
end $$;

\echo 'R6. on 1 November August goes; on 1 January the old year is cleared up to October'
do $$
declare n int;
begin
  n := public.purge_months_before(public.keep_from_month_at('2026-11-01 00:00+05:30'));
  assert n = 5, 'August''s 5 bills deleted, got ' || n;
  assert (select array_agg(distinct month_key order by month_key) from public.bills where month_key between '202601' and '202612') = array['202609', '202610'], 'Sep, Oct left';
  n := public.purge_months_before(public.keep_from_month_at('2027-01-01 00:00+05:30'));
  assert n = 7, 'September (6) + October (1) deleted by 1 Jan 2027, got ' || n;
end $$;

\echo 'R7. safety: bad months refused; staff cannot choose a date; only the live rule is theirs'
select t.expect_error($q$select public.purge_months_before('2026-07')$q$, 'needs a month like 202607');
select t.expect_error($q$select public.purge_months_before('202613')$q$, 'needs a month like 202607');
select t.expect_error($q$select public.purge_months_before(null)$q$, 'needs a month like 202607');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
select t.expect_error($q$select public.purge_months_before('209912')$q$, 'permission denied'); -- would wipe everything
do $$ begin
  assert public.keep_from_month_at('2026-09-15 12:00+05:30') = '202607', 'staff may ask which month is kept';
  assert public.keep_from_month() ~ '^[0-9]{6}$', 'and the live answer';
  perform public.purge_old_months(); -- staff may run the normal rule
end $$;
reset role;
set role anon;
select t.expect_error($q$select public.purge_old_months()$q$, 'permission denied');
select t.expect_error($q$select public.purge_months_before('209912')$q$, 'permission denied');
select t.expect_error($q$select public.keep_from_month_at(now())$q$, 'permission denied');
reset role;
