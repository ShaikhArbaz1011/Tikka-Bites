\set ON_ERROR_STOP on
\echo '6. two devices billing at the same moment: every number exactly once, no gaps'
do $$ begin
  assert (select count(*) from public.bills) = 105, 'bills: ' || (select count(*) from public.bills);
  assert (select array_agg(n order by n) from (select substring(bill_no from '-([0-9]+)$')::int as n from public.bills) s)
       = (select array_agg(g order by g) from generate_series(1, 105) g), 'numbers 0001..0105 with no gaps or repeats';
  assert (select count(distinct rev) from public.bills) = 105, 'each change has its own rev';
  assert (select last from public.counters) = 105, 'counter at 105';
end $$;
\echo '7. revs follow commit order, so a device fetches exactly what changed'
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
update public.menu set price_paise = 46000 where id = 1;
do $$ begin assert (select rev from public.menu where id = 1) > (select max(rev) from public.bills), 'a later change gets a higher rev'; end $$;
reset role;
do $$ begin assert (select rev from public.sync_clock) = greatest((select max(rev) from public.bills), (select max(rev) from public.menu)), 'clock = latest rev'; end $$;
\echo '8. past 9999 the number widens instead of wrapping'
update public.counters set last = 9999;
set role authenticated;
do $$
declare m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM'); b jsonb;
begin
  b := public.save_bill('{"items":[{"menuId":2,"qty":1,"unitPaise":12050}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":12050,"cheesyLine":""}');
  assert b ->> 'billNo' = 'RCPT-' || m || '-10000', 'got ' || (b ->> 'billNo');
end $$;
