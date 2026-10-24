\set ON_ERROR_STOP on
\echo '20. a bill forgotten earlier this month can be added with its date; numbers are per year'
select set_config('t.last_before', coalesce((select last from public.counters where month_key = to_char(now() at time zone 'Asia/Kolkata', 'YYYY')), 0)::text, false) \g :devnull
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
do $$
declare
  y text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY');
  m text := to_char(now() at time zone 'Asia/Kolkata', 'YYYYMM');
  -- 1 am on the 1st of this month (India time); on the 1st itself, a minute ago
  month_start bigint := floor(extract(epoch from ((date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 hour') at time zone 'Asia/Kolkata')) * 1000)::bigint;
  at_ms bigint := least(month_start, public.now_ms() - 60000);
  price int := (select price_paise from public.menu where id = 2);
  last_before int := current_setting('t.last_before')::int;
  body jsonb := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('menuId', 2, 'qty', 1, 'unitPaise', price)),
    'orderType', 'takeaway', 'paymentMode', 'cash', 'discount', jsonb_build_object('kind', 'flat', 'paise', 0),
    'roundOffPaise', 0, 'totalPaise', price, 'cheesyLine', '');
  b jsonb;
begin
  b := public.save_bill(body || jsonb_build_object('billedAt', at_ms));
  assert (b ->> 'createdAt')::bigint = at_ms and b ->> 'monthKey' = m, 'saved under the chosen date: ' || (b ->> 'createdAt');
  assert (b ->> 'hour')::int = extract(hour from to_timestamp(at_ms / 1000.0) at time zone 'Asia/Kolkata')::int, 'hour of the chosen time';
  assert (b ->> 'enteredAt')::bigint between public.now_ms() - 60000 and public.now_ms() + 1000, 'when it was typed in is kept';
  assert b ->> 'billNo' = 'RCPT-' || y || '-' || lpad((last_before + 1)::text, greatest(4, char_length((last_before + 1)::text)), '0'), 'the next number of the year: ' || (b ->> 'billNo');
  assert (select created_at from public.bills where bill_no = b ->> 'billNo') = at_ms, 'the date column too (reports, clean-up)';
  b := public.save_bill(body);
  assert not (b ? 'enteredAt'), 'a normal bill has no enteredAt';
end $$;
-- Only this month, never the future, always today's prices.
select t.expect_error(format($q$select public.save_bill('{"billedAt":%s,"items":[{"menuId":2,"qty":1,"unitPaise":%s}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":%s,"cheesyLine":""}')$q$,
  floor(extract(epoch from ((date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 hour') at time zone 'Asia/Kolkata')) * 1000)::bigint,
  (select price_paise from public.menu where id = 2), (select price_paise from public.menu where id = 2)), 'only be added for this month');
select t.expect_error(format($q$select public.save_bill('{"billedAt":%s,"items":[{"menuId":2,"qty":1,"unitPaise":%s}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":%s,"cheesyLine":""}')$q$,
  public.now_ms() + 3600000, (select price_paise from public.menu where id = 2), (select price_paise from public.menu where id = 2)), 'can''t be in the future');
select t.expect_error($q$select public.save_bill('{"billedAt":"yesterday","items":[{"menuId":2,"qty":1,"unitPaise":1}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":1,"cheesyLine":""}')$q$, 'Invalid bill date');
select t.expect_error(format($q$select public.save_bill('{"billedAt":%s,"items":[{"menuId":2,"qty":1,"unitPaise":1}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":1,"cheesyLine":""}')$q$,
  public.now_ms() - 60000), 'was changed on another device'); -- an old price is refused, like any online bill
reset role;
do $$ begin
  assert not exists (select 1 from public.bills where bill_no !~ '^(RCPT-[0-9]{4}|(RCPT|INV)-[0-9]{6})-[0-9]{4,}$'), 'every number is a valid format';
  assert exists (select 1 from public.counters where month_key = to_char(now() at time zone 'Asia/Kolkata', 'YYYY')), 'a counter per year';
end $$;
select t.expect_error($q$insert into public.bills (bill_no, created_at, month_key, status, data) values ('RCPT-26-0001', 0, '202610', 'paid', '{}')$q$, 'bills_bill_no_check');
select set_config('request.jwt.claims', '', false) \g :devnull
