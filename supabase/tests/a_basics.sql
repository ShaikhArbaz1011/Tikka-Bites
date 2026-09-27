\set ON_ERROR_STOP on
select to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM') as m \gset
\echo '0. only accounts on the staff list get in'
select public.allow_staff(' Owner@Tikka.test ') \g /dev/null
select public.allow_staff('counter1@tikka.test') \g /dev/null
select public.allow_staff('counter2@tikka.test') \g /dev/null
select t.expect_error($q$select public.allow_staff('nobody@tikka.test')$q$, 'No account with email');
do $$ begin assert (select count(*) from public.staff) = 3 and exists (select 1 from public.staff where email = 'owner@tikka.test'), 'staff list'; end $$;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false) \g /dev/null
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":1}]}')$q$, 'not on the Tikka Bites staff list');
select t.expect_error($q$select public.pull_changes(0)$q$, 'not on the Tikka Bites staff list');
select t.expect_error($q$select public.patch_settings('{}')$q$, 'not on the Tikka Bites staff list');
select t.expect_error($q$select public.void_bill('RCPT-202609-0001', 'test')$q$, 'not on the Tikka Bites staff list');
select t.expect_error($q$select public.import_device_data('[]', '[]', '{}', '[]')$q$, 'not on the Tikka Bites staff list');
select t.expect_error($q$insert into public.menu (name, category, price_paise, is_veg) values ('x', 'y', 1, true)$q$, 'row-level security');
reset role;
select setval('public.menu_id_seq', 1, false) \g /dev/null -- the refused insert used up id 1 (harmless gap); keep ids simple below
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false) \g /dev/null
select t.expect_error($q$select public.allow_staff('stranger@example.com')$q$, 'permission denied');
select t.expect_error($q$select * from public.staff$q$, 'permission denied');
select t.expect_error($q$insert into public.staff (user_id, email) values (auth.uid(), 'me')$q$, 'permission denied');
select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","is_anonymous":true}', false) \g /dev/null
select t.expect_error($q$select public.pull_changes(0)$q$, 'not on the Tikka Bites staff list');
do $$ begin assert not public.is_staff(), 'anonymous sign-in is not staff'; end $$;
reset role;
\echo '1. staff add dishes; numbering starts at 0001; money math matches the app'
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g /dev/null
insert into public.menu (name, category, price_paise, is_veg) values ('Full Chicken', 'Grill Gali', 45000, false), ('Masala Fries', 'Aloo Ke Laloo', 12050, true);
do $$
declare m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM'); b jsonb;
begin
  -- 2 × 450 + 120.50 = 1020.50; −10% = 102.05 (half-up) → 918.45 → rounds to 918.00 (−0.45)
  b := public.save_bill('{"items":[{"menuId":1,"qty":2,"unitPaise":45000},{"menuId":2,"qty":1,"unitPaise":12050}],"orderType":"dine-in","tableNo":"4","customerName":"Asha","paymentMode":"upi","discount":{"kind":"pct","bp":1000},"roundOffPaise":-45,"totalPaise":91800,"cheesyLine":"Our food is like our bill — totally worth it 😋"}');
  assert b ->> 'billNo' = 'RCPT-' || m || '-0001', 'first number is 0001, got ' || (b ->> 'billNo');
  assert (b ->> 'subtotalPaise')::int = 102050 and (b ->> 'discountPaise')::int = 10205 and (b ->> 'roundOffPaise')::int = -45 and (b ->> 'totalPaise')::int = 91800, 'money math';
  assert b -> 'items' -> 0 = '{"menuId":1,"name":"Full Chicken","category":"Grill Gali","isVeg":false,"unitPaise":45000,"qty":2,"linePaise":90000}'::jsonb, 'item snapshot';
  assert b -> 'categories' = '["Grill Gali","Aloo Ke Laloo"]'::jsonb and (b ->> 'hasVeg')::boolean and (b ->> 'hasNonVeg')::boolean and (b ->> 'itemCount')::int = 3, 'derived fields';
  assert b ->> 'tableNo' = '4' and b ->> 'customerName' = 'Asha' and b ->> 'status' = 'paid' and b ->> 'monthKey' = m, 'fields';
  assert b ->> 'cheesyLine' = 'Our food is like our bill — totally worth it 😋', 'emoji kept';
  -- 120.50 rounds half-up to 121.00 (+0.50)
  b := public.save_bill('{"items":[{"menuId":2,"qty":1,"unitPaise":12050}],"orderType":"takeaway","tableNo":"9","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":50,"totalPaise":12100,"cheesyLine":""}');
  assert b ->> 'billNo' = 'RCPT-' || m || '-0002', 'second number is 0002';
  assert not (b ? 'tableNo'), 'table number is only kept for dine-in';
  assert (select bool_and(used_in_bills) from public.menu), 'dishes marked as used in bills';
end $$;
\echo '1b. a retry with the same clientRef returns the SAME bill (no second receipt)'
do $$
declare b1 jsonb; b2 jsonb; b3 jsonb; n_before int; n_after int;
  body text := '{"clientRef":"0f8fad5b-d9cb-469f-a165-70867728950e","items":[{"menuId":2,"qty":2,"unitPaise":12050}],"orderType":"takeaway","paymentMode":"upi","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":24100,"cheesyLine":""}';
begin
  select count(*) into n_before from public.bills;
  b1 := public.save_bill(body::jsonb);
  b2 := public.save_bill(body::jsonb);
  select count(*) into n_after from public.bills;
  assert b1 = b2 and n_after = n_before + 1, 'retry gave the same bill and saved only one';
  b3 := public.save_bill(replace(body, '0f8fad5b', '1f8fad5b')::jsonb);
  assert (substring(b3 ->> 'billNo' from '-([0-9]+)$'))::int = (substring(b1 ->> 'billNo' from '-([0-9]+)$'))::int + 1, 'a new reference is a new bill with the next number';
  assert not (b1 ? 'clientRef'), 'the reference is not part of the bill itself';
end $$;
select t.expect_error($q$select public.save_bill('{"clientRef":"not-a-uuid","items":[{"menuId":2,"qty":1,"unitPaise":12050}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":12050}')$q$, 'Invalid bill reference');
\echo '2. bad or tampered bills are refused'
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":44000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":44000}')$q$, 'price of Full Chicken was changed on another device');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":100}')$q$, 'Totals do not add up');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":7,"totalPaise":45007}')$q$, 'Totals do not add up');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1000,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":45000000}')$q$, 'Invalid item');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":99,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":45000}')$q$, 'no longer on the menu');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":45000},{"menuId":1,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":90000}')$q$, 'appears twice');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"card","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":45000}')$q$, 'Invalid payment mode');
select t.expect_error($q$select public.save_bill('{"items":[],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":0}')$q$, 'Add at least one item');
select t.expect_error($q$select public.save_bill('{"items":[{"menuId":1,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"pct","bp":10001},"roundOffPaise":0,"totalPaise":45000}')$q$, 'Invalid discount');
\echo '3. staff cannot write bills or counters directly, delete dishes, or re-run the import'
select t.expect_error($q$insert into public.bills (bill_no, created_at, month_key, status, data) values ('RCPT-202609-0999', 0, '202609', 'paid', '{}')$q$, 'permission denied');
select t.expect_error($q$update public.bills set status = 'void'$q$, 'permission denied');
select t.expect_error($q$delete from public.bills$q$, 'permission denied');
select t.expect_error($q$update public.counters set last = 0$q$, 'permission denied');
select t.expect_error($q$delete from public.menu$q$, 'permission denied');
select t.expect_error($q$select public.import_bills('[]')$q$, 'only allowed while setting up');
select t.expect_error($q$select public.import_device_data('[]', '[]', '{"name":"x","currencySymbol":"₹","receiptWidth":"80","roundOff":true}', '[]')$q$, 'already set up');
\echo '3b. staff cannot set internal columns, settings or counters directly'
select t.expect_error($q$insert into public.menu (name, category, price_paise, is_veg, used_in_bills) values ('x', 'y', 1, true, true)$q$, 'permission denied');
select t.expect_error($q$update public.menu set used_in_bills = false$q$, 'permission denied');
select t.expect_error($q$update public.menu set rev = 1$q$, 'permission denied');
select t.expect_error($q$update public.menu set created_at = 0$q$, 'permission denied');
select t.expect_error($q$update public.menu set id = 77 where id = 1$q$, 'permission denied');
select t.expect_error($q$update public.cheesy_lines set built_in = true$q$, 'permission denied');
select t.expect_error($q$insert into public.settings (id, data) values (1, '{}')$q$, 'permission denied');
select t.expect_error($q$update public.settings set data = '{}'$q$, 'permission denied');
select t.expect_error($q$select * from public.counters$q$, 'permission denied');
select t.expect_error($q$select * from public.sync_clock$q$, 'permission denied');
select t.expect_error($q$select public.check_settings('{}')$q$, 'permission denied');
select t.expect_error($q$select public.require_staff()$q$, 'permission denied');
\echo '3c. the server keeps the last-edited time; billing a dish does not count as an edit'
insert into public.menu (name, category, price_paise, is_veg, active) values ('Lassi', 'Thanda Matter', 6000, true, true);
do $$
declare u0 bigint; u1 bigint; m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM');
begin
  select updated_at into u0 from public.menu where id = 3;
  perform pg_sleep(0.01);
  perform public.save_bill('{"items":[{"menuId":3,"qty":1,"unitPaise":6000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":6000,"cheesyLine":""}');
  select updated_at into u1 from public.menu where id = 3;
  assert u1 = u0 and (select used_in_bills from public.menu where id = 3), 'billing does not touch updated_at';
  update public.menu set price_paise = 6500 where id = 3;
  assert (select updated_at from public.menu where id = 3) > u0, 'an edit moves updated_at';
end $$;
\echo '4. void keeps the bill (audit trail), once only, with a reason'
do $$
declare m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM'); v jsonb;
begin
  v := public.void_bill('RCPT-' || m || '-0001', '  Wrong table  ');
  assert v ->> 'status' = 'void' and v ->> 'voidReason' = 'Wrong table' and v ? 'voidedAt', 'void details';
  assert (select status from public.bills where bill_no = 'RCPT-' || m || '-0001') = 'void', 'status column updated';
end $$;
select t.expect_error(format('select public.void_bill(%L, %L)', 'RCPT-' || :'m' || '-0001', 'again'), 'already voided');
select t.expect_error(format('select public.void_bill(%L, %L)', 'RCPT-' || :'m' || '-0002', 'no'), 'at least 3 characters');
select t.expect_error($q$select public.void_bill('RCPT-190001-0001', 'nope')$q$, 'Bill not found');
\echo '5. the public anon key alone can read or change nothing'
reset role;
set role anon;
select t.expect_error('select count(*) from public.bills', 'permission denied');
select t.expect_error('select count(*) from public.menu', 'permission denied');
select t.expect_error('select count(*) from public.settings', 'permission denied');
select t.expect_error($q$insert into public.menu (name, category, price_paise, is_veg) values ('x', 'y', 1, true)$q$, 'permission denied');
select t.expect_error($q$select public.save_bill('{}')$q$, 'permission denied');
select t.expect_error($q$select public.void_bill('x', 'yyy')$q$, 'permission denied');
reset role;
do $$ begin assert (select last from public.counters) = 5, 'refused bills used up no numbers (0001–0005 were real saves)'; end $$;
