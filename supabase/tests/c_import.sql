\set ON_ERROR_STOP on
select to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM') as m \gset
\echo '9. moving the first phone''s data in: ids kept, numbering continues after old INV- bills'
select public.allow_staff('owner@tikka.test') \g :devnull
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
select t.expect_error($q$select public.patch_settings('{"phone":"1"}')$q$, 'not set up yet');
select t.expect_error($q$select public.import_device_data('[]', '[]', '{"name":"","currencySymbol":"₹","receiptWidth":"80","roundOff":true}', '[]')$q$, 'Invalid settings');
do $$ begin assert not exists (select 1 from public.settings), 'a refused import writes nothing'; end $$;
select public.import_device_data(
  '[{"id":5,"name":"Full Chicken","nameLower":"full chicken","category":"Grill Gali","pricePaise":45000,"isVeg":false,"active":true,"deleted":false,"usedInBills":true,"createdAt":1,"updatedAt":2},
    {"id":9,"name":"Water","nameLower":"water","category":"Thanda Matter","pricePaise":1000,"isVeg":true,"active":true,"deleted":false,"createdAt":1,"updatedAt":2}]',
  '[{"id":1,"text":"Thank you for being the naan to our curry 🫓","builtIn":true,"active":true},{"id":4,"text":"Mine","active":false}]',
  '{"name":"Tikka Bites","address":"","phone":"9137582060","currencySymbol":"₹","receiptWidth":"80","roundOff":true,"printLogo":true,"lastBackupAt":1700000000000}',
  jsonb_build_array(jsonb_build_object('monthKey', :'m', 'last', 18), jsonb_build_object('monthKey', '202401', 'last', 7))) \g :devnull
do $$
declare m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM'); b jsonb;
begin
  -- The upload of old bills has not even started, but billing can go on safely.
  b := public.save_bill('{"items":[{"menuId":5,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":45000,"cheesyLine":""}');
  assert b ->> 'billNo' = 'RCPT-' || m || '-0019', 'continues after the phone''s counter: ' || (b ->> 'billNo');
  assert (select used_in_bills from public.menu where id = 9) = false, 'missing flag defaults to false';
  assert (select active from public.cheesy_lines where id = 4) = false and not (select built_in from public.cheesy_lines where id = 4), 'lines imported';
end $$;
select public.import_bills(jsonb_build_array(
  jsonb_build_object('billNo', 'INV-' || :'m' || '-0017', 'createdAt', 1, 'monthKey', :'m', 'status', 'paid'),
  jsonb_build_object('billNo', 'RCPT-' || :'m' || '-0018', 'createdAt', 2, 'monthKey', :'m', 'status', 'void'))) as added \gset
select public.import_bills(jsonb_build_array(
  jsonb_build_object('billNo', 'RCPT-' || :'m' || '-0018', 'createdAt', 2, 'monthKey', :'m', 'status', 'void'))) as again \gset
select t.ok(:added = 2 and :again = 0, 'uploading the same bills twice is harmless') \g :devnull
select public.import_bills(jsonb_build_array(jsonb_build_object('billNo', 'INV-202001-0001', 'createdAt', 1, 'monthKey', '202001', 'status', 'paid'))) as old_month \gset
select t.ok(:old_month = 0, 'bills older than the 3 kept months are not imported') \g :devnull
select public.finish_import() \g :devnull
do $$
declare m text := to_char(clock_timestamp() at time zone 'Asia/Kolkata', 'YYYYMM'); b jsonb; new_id bigint; line_id bigint;
begin
  b := public.save_bill('{"items":[{"menuId":5,"qty":1,"unitPaise":45000}],"orderType":"takeaway","paymentMode":"cash","discount":{"kind":"flat","paise":0},"roundOffPaise":0,"totalPaise":45000,"cheesyLine":""}');
  assert b ->> 'billNo' = 'RCPT-' || m || '-0020', 'got ' || (b ->> 'billNo');
  insert into public.menu (name, category, price_paise, is_veg) values ('Soft Drink', 'Thanda Matter', 2000, true) returning id into new_id;
  assert new_id = 10, 'new dishes continue after imported ids, got ' || new_id;
  insert into public.cheesy_lines (text) values ('New line') returning id into line_id;
  assert line_id = 5, 'new lines continue after imported ids, got ' || line_id;
  assert (select count(*) from public.bills) = 4, 'imported + new bills visible to staff';
  assert (select data ->> 'phone' from public.settings) = '9137582060', 'settings imported';
end $$;
select t.expect_error($q$select public.import_bills('[]')$q$, 'only allowed while setting up');
select t.expect_error($q$select public.import_device_data('[]', '[]', '{"name":"x","currencySymbol":"₹","receiptWidth":"80","roundOff":true}', '[]')$q$, 'already set up');
\echo '10. settings are merged on the server and checked'
do $$
declare s jsonb;
begin
  s := public.patch_settings('{"phone":"1234567890"}');
  assert s ->> 'phone' = '1234567890' and s ->> 'name' = 'Tikka Bites' and (s ->> 'lastBackupAt')::bigint = 1700000000000, 'other settings kept';
  s := public.patch_settings('{"logoDataUrl":"data:image/webp;base64,UklGRg=="}');
  assert s ? 'logoDataUrl', 'logo set';
  s := public.patch_settings('{"roundOff":false}', '{logoDataUrl}');
  assert not (s ? 'logoDataUrl') and (s ->> 'roundOff')::boolean = false, 'logo removed and round-off changed in one step';
end $$;
select t.expect_error($q$select public.patch_settings('{"receiptWidth":"100"}')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{"name":""}')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{"roundOff":"yes"}')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{"logoDataUrl":"javascript:alert(1)"}')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{"logoDataUrl":"data:image/svg+xml;base64,PHN2Zz4="}')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{"isAdmin":true}')$q$, 'Invalid settings'); -- unknown fields are refused
select t.expect_error(format($q$select public.patch_settings('{"logoDataUrl":"data:image/png;base64,%s"}')$q$, repeat('A', 700001)), 'Invalid settings'); -- same 700 KB limit as the app
select t.expect_error($q$select public.patch_settings('[]')$q$, 'Invalid settings');
select t.expect_error($q$select public.patch_settings('{}', '{name}')$q$, 'Invalid settings');
