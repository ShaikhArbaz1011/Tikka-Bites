\set ON_ERROR_STOP on
\echo '21. receipt numbers follow the date: a bill for an earlier time takes its place, later numbers move up'
select set_config('t.renum_before', (select renumber_rev::text from public.sync_clock), false) \g :devnull
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false) \g :devnull
do $$
declare
  y text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY');
  price int := (select price_paise from public.menu where id = 2);
  body jsonb := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('menuId', 2, 'qty', 1, 'unitPaise', price)),
    'orderType', 'takeaway', 'paymentMode', 'cash', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', price, 'cheesyLine', '');
  a jsonb;
  b jsonb;
  c jsonb;
  a_no text;
  seq int;
  rev_a bigint;
  no_at text;
  ref uuid := gen_random_uuid();
begin
  a := public.save_bill(body); -- now: the newest bill
  a_no := a ->> 'billNo';
  seq := substring(a_no from 11)::int;
  rev_a := (select rev from public.bills where bill_no = a_no);

  -- Forgotten bill B, a moment before A: it takes A's number and A moves up by one.
  b := public.save_bill(body || jsonb_build_object('billedAt', (a ->> 'createdAt')::bigint - 1));
  assert b ->> 'billNo' = a_no, 'the earlier bill takes the number of the first later one: ' || (b ->> 'billNo');
  assert not (b ? 'oldNo'), 'a new bill has no old number';
  select data into a from public.bills where created_at = (a ->> 'createdAt')::bigint;
  assert a ->> 'billNo' like 'RCPT-' || y || '-%' and substring(a ->> 'billNo' from 11)::int = seq + 1, 'the later bill moved up by one: ' || (a ->> 'billNo');
  assert a ->> 'oldNo' = a_no, 'and keeps the number on its paper receipt';
  assert (select rev from public.bills where bill_no = a ->> 'billNo') > rev_a, 'the move is a change the phones download';

  -- An offline bill from just before both: B and A move up again; each keeps its first number.
  c := public.save_bill(body || jsonb_build_object('offline', true, 'clientRef', ref, 'printedAs', 'OFF-TST-0001',
    'createdAt', (b ->> 'createdAt')::bigint - 1));
  assert c ->> 'billNo' = a_no, 'an offline bill also takes its place by date: ' || (c ->> 'billNo');
  select data into b from public.bills where created_at = (b ->> 'createdAt')::bigint;
  select data into a from public.bills where created_at = (a ->> 'createdAt')::bigint;
  assert substring(b ->> 'billNo' from 11)::int = seq + 1 and b ->> 'oldNo' = a_no, 'B moved up: ' || b::text;
  assert substring(a ->> 'billNo' from 11)::int = seq + 2 and a ->> 'oldNo' = a_no, 'A moved up again, still showing its first number: ' || a::text;
  assert (public.pull_changes(0, 1) ->> 'renumberRev')::bigint = current_setting('t.renum_before')::bigint,
    'moves inside one month: phones follow them bill by bill';

  -- A retry of the offline upload (lost reply) gets the same bill back, not a second shift.
  assert public.save_bill(body || jsonb_build_object('offline', true, 'clientRef', ref, 'printedAs', 'OFF-TST-0001',
    'createdAt', (c ->> 'createdAt')::bigint)) ->> 'billNo' = c ->> 'billNo', 'retry';
  assert (select billno from (select data ->> 'billNo' as billno from public.bills where created_at = (b ->> 'createdAt')::bigint) q) = b ->> 'billNo', 'nothing moved';

  perform set_config('t.a_no', a ->> 'billNo', false);
  perform set_config('t.a_at', a ->> 'createdAt', false);
  perform set_config('t.b_at', b ->> 'createdAt', false);
  perform set_config('t.seq', seq::text, false);

  -- An offline bill from the end of last month (same year): numbers move across months, so
  -- the phones and the backup are told to copy everything again.
  if extract(month from now() at time zone 'Asia/Kolkata') > 1 then
    c := body || jsonb_build_object('offline', true, 'clientRef', gen_random_uuid(),
      'createdAt', floor(extract(epoch from ((date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 hour') at time zone 'Asia/Kolkata')) * 1000)::bigint);
    if (c ->> 'createdAt')::bigint > public.now_ms() - 34::bigint * 86400000 then
      no_at := (select min(substring(bill_no from 11)::int)::text from public.bills
                 where created_at > (c ->> 'createdAt')::bigint and bill_no like 'RCPT-' || y || '-%');
      c := public.save_bill(c);
      assert substring(c ->> 'billNo' from 11) = lpad(no_at, 4, '0'), 'last month''s bill takes its place: ' || (c ->> 'billNo') || ' expected ' || no_at;
      assert (public.pull_changes(0, 1) ->> 'renumberRev')::bigint = current_setting('t.renum_before')::bigint + 1, 'a move across months is announced';
      perform set_config('t.a_no', (select bill_no from public.bills where created_at = (a ->> 'createdAt')::bigint), false);
      assert substring(current_setting('t.a_no') from 11)::int = seq + 3, 'A moved up once more';
    end if;
  end if;
end $$;

-- Cancelling checks it is still the same bill (a phone may not have the new numbers yet).
select t.expect_error(format('select public.void_bill(%L, %L, %s)', current_setting('t.a_no'), 'wrong one', current_setting('t.b_at')), 'receipt numbers have changed');
do $$ begin
  assert (public.void_bill(current_setting('t.a_no'), 'right one', current_setting('t.a_at')::bigint) ->> 'status') = 'void', 'the right bill is voided';
  assert (select data ->> 'voidReason' from public.bills where created_at = current_setting('t.a_at')::bigint) = 'right one', 'A itself';
end $$;
-- Only the server moves numbers, and only the owner (SQL Editor) renumbers a year.
select t.expect_error($q$select public.shift_bill_numbers('2026', 1)$q$, 'permission denied');
select t.expect_error($q$select public.renumber_year_by_date('2026')$q$, 'permission denied');
reset role;

do $$
declare y text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY');
begin
  assert not exists (select 1 from public.bills x join public.bills z
                       on public.yearly_seq(x.bill_no, y) < public.yearly_seq(z.bill_no, y) and x.created_at > z.created_at),
    'every number of the year is in date order (also the 100 bills two phones saved at the same time)';
  assert (select max(public.yearly_seq(bill_no, y)) from public.bills) = (select last from public.counters where month_key = y), 'counter = highest number';
end $$;

\echo '22. renumber_year_by_date: one series in date order for the whole year (the one-time clean-up)'
select set_config('t.renum_before', (select renumber_rev::text from public.sync_clock), false) \g :devnull
-- Old monthly numbers of this year (as before 24 Oct 2026), one older than every other bill.
insert into public.bills (bill_no, created_at, month_key, status, data)
select no, at, y || '01', 'paid', jsonb_build_object('billNo', no, 'createdAt', at, 'monthKey', y || '01', 'status', 'paid')
  from (select to_char(now() at time zone 'Asia/Kolkata', 'YYYY') as y) x,
       lateral (values ('RCPT-' || y || '01-0001', floor(extract(epoch from (make_timestamp(y::int, 1, 1, 10, 0, 0) at time zone 'Asia/Kolkata')) * 1000)::bigint),
                       ('INV-' || y || '01-0001', floor(extract(epoch from (make_timestamp(y::int, 1, 1, 9, 0, 0) at time zone 'Asia/Kolkata')) * 1000)::bigint)) v(no, at);
do $$
declare
  y text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY');
  n int := (select count(*) from public.bills where month_key like y || '%');
  msg text;
  a_first text := (select data ->> 'oldNo' from public.bills where created_at = current_setting('t.a_at')::bigint);
begin
  msg := public.renumber_year_by_date(y);
  assert msg like n || ' bills of ' || y || ' are now RCPT-' || y || '-0001 … %', msg;
  assert (select count(*) from public.bills where month_key like y || '%' and public.yearly_seq(bill_no, y) is null) = 0, 'no old numbers left in the year';
  assert (select count(distinct bill_no) from public.bills where public.yearly_seq(bill_no, y) between 1 and n) = n, 'exactly 1 … n';
  -- (Bills test 14 stored with the time 1 ms after 1970 come first.)
  assert (select public.yearly_seq(bill_no, y) from public.bills where data ->> 'oldNo' = 'INV-' || y || '01-0001')
       = 1 + (select count(*) from public.bills where month_key like y || '%' and created_at < 1000000000000), 'the oldest real bill comes first';
  assert (select public.yearly_seq(bill_no, y) from public.bills where data ->> 'oldNo' = 'RCPT-' || y || '01-0001')
       = (select public.yearly_seq(bill_no, y) from public.bills where data ->> 'oldNo' = 'INV-' || y || '01-0001') + 1, 'then the next';
  assert not exists (select 1 from public.bills where data ->> 'billNo' <> bill_no), 'data.billNo too';
  assert (select data ->> 'oldNo' from public.bills where created_at = current_setting('t.a_at')::bigint) = a_first, 'the first number is kept: ' || a_first;
  assert not exists (select 1 from public.bills x join public.bills z
                       on public.yearly_seq(x.bill_no, y) < public.yearly_seq(z.bill_no, y) and x.created_at > z.created_at), 'date order';
  assert (select last from public.counters where month_key = y) = n, 'the next bill is n + 1';
  assert (select renumber_rev from public.sync_clock) = current_setting('t.renum_before')::bigint + 1, 'phones and the backup copy everything again';
  assert public.renumber_year_by_date(y) like '%(0 got a new number%', 'a second run changes nothing';
  assert public.renumber_year_by_date('1999') = 'No bills in 1999: nothing changed.', 'a year without bills';
end $$;
select t.expect_error($q$select public.renumber_year_by_date('26')$q$, 'Give the year');
