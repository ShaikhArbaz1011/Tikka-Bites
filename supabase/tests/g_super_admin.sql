\set ON_ERROR_STOP on
-- Runs after a–e on tb_test. The super admin manages users from the app (Settings → Users);
-- supabase/functions/staff-admin creates / deletes the sign-in accounts in between.

\echo '15. super admin: only they may add users, change passwords and remove users'
reset role;
select set_config('request.jwt.claims', '', false) \g :devnull
select public.allow_staff('owner@tikka.test', 'owner') \g :devnull
select public.allow_staff('counter1@tikka.test', 'counter1') \g :devnull
do $$ begin
  assert (select role from public.staff where username = 'counter1') = 'staff', 'people on the staff list are plain staff';
end $$;
select t.expect_error($q$select public.make_super_admin('nobody')$q$, 'Nobody called nobody');
select public.make_super_admin('OWNER') \g :devnull
select t.expect_error($q$update public.staff set role = 'boss' where username = 'counter1'$q$, 'staff_role_valid');

-- Plain staff (counter1): may ask their own role, nothing more.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false) \g :devnull
do $$ begin assert public.my_role() = 'staff', 'counter1 is staff'; end $$;
select t.expect_error($q$select public.list_staff()$q$, 'Only the super admin');
select t.expect_error($q$select public.staff_add_prepare('cashier3')$q$, 'Only the super admin');
select t.expect_error($q$select public.staff_add_finish('44444444-4444-4444-4444-444444444444', 'cashier3')$q$, 'Only the super admin');
select t.expect_error($q$select public.staff_remove('owner')$q$, 'Only the super admin');
select t.expect_error($q$select public.staff_user_id('owner')$q$, 'Only the super admin');
select t.expect_error($q$select public.make_super_admin('counter1')$q$, 'permission denied');
select t.expect_error($q$select public.require_super_admin()$q$, 'permission denied');
select t.expect_error($q$update public.staff set role = 'super_admin' where username = 'counter1'$q$, 'permission denied');
-- Signed in but not on the staff list (a stranger): told so.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false) \g :devnull
do $$ begin assert public.my_role() is null, 'a stranger has no role'; end $$;
select t.expect_error($q$select public.staff_add_prepare('cashier3')$q$, 'not on the Tikka Bites staff list');
reset role;
set role anon;
select t.expect_error($q$select public.my_role()$q$, 'permission denied');
select t.expect_error($q$select public.list_staff()$q$, 'permission denied');
select t.expect_error($q$select public.staff_add_prepare('cashier3')$q$, 'permission denied');
select t.expect_error($q$select public.staff_remove('counter1')$q$, 'permission denied');
reset role;

\echo '16. super admin adds cashier3: email from their own with a +label, checked twice'
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
do $$
declare l jsonb; p jsonb;
begin
  assert public.my_role() = 'super_admin', 'owner is the super admin';
  l := public.list_staff();
  assert l -> 0 ->> 'username' = 'owner' and l -> 0 ->> 'role' = 'super_admin' and (l -> 0 ->> 'me')::boolean, 'super admin first, marked as me';
  assert (select count(*) from jsonb_array_elements(l) e where e ->> 'username' = 'counter1' and e ->> 'role' = 'staff' and not (e ->> 'me')::boolean) = 1, 'counter1 listed';
  assert l::text not like '%@%', 'no emails in the list';
  p := public.staff_add_prepare(' Cashier3 ');
  assert p ->> 'email' = 'owner+cashier3@tikka.test', 'the super admin''s email + label: ' || (p ->> 'email');
  assert p -> 'userId' = 'null'::jsonb, 'no old account to reuse';
end $$;
select t.expect_error($q$select public.staff_add_prepare('counter1')$q$, 'already used');
select t.expect_error($q$select public.staff_add_prepare('Bad Name')$q$, 'User ID must be 2–30 characters');
select t.expect_error($q$select public.staff_add_prepare('<b>x</b>')$q$, 'User ID must be 2–30 characters');
select t.expect_error($q$select public.staff_add_prepare(null)$q$, 'User ID must be 2–30 characters');
-- Supabase Auth creates the account (the server function, with the secret key).
reset role;
insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'owner+cashier3@tikka.test');
set role authenticated;
-- Only the account made for that User ID can be attached: not a stranger's, not under another name.
select t.expect_error($q$select public.staff_add_finish('44444444-4444-4444-4444-444444444444', 'cashier3')$q$, 'does not belong');
select t.expect_error($q$select public.staff_add_finish('66666666-6666-6666-6666-666666666666', 'other')$q$, 'does not belong');
do $$ begin
  assert public.staff_add_finish('66666666-6666-6666-6666-666666666666', 'cashier3') = 'cashier3', 'added';
end $$;
select t.expect_error($q$select public.staff_add_finish('66666666-6666-6666-6666-666666666666', 'cashier3')$q$, 'already used');
reset role;
do $$ begin
  assert (select role from public.staff where username = 'cashier3') = 'staff', 'added as plain staff';
  assert public.login_email('cashier3') = 'owner+cashier3@tikka.test', 'signs in with the User ID';
end $$;
-- cashier3 can bill, but not manage users.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}', false) \g :devnull
do $$ begin assert public.is_staff() and public.my_role() = 'staff', 'cashier3 is staff'; end $$;
select t.expect_error($q$select public.staff_remove('counter1')$q$, 'Only the super admin');

\echo '17. change passwords and remove users; a removed User ID can be added again'
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false) \g :devnull
do $$ begin
  assert public.staff_user_id('cashier3') = '66666666-6666-6666-6666-666666666666', 'a staff member''s password';
  assert public.staff_user_id('owner') = '11111111-1111-1111-1111-111111111111', 'the super admin''s own';
end $$;
select t.expect_error($q$select public.staff_user_id('nobody')$q$, 'No user called nobody');
select t.expect_error($q$select public.staff_remove('owner')$q$, 'cannot remove yourself');
select t.expect_error($q$select public.staff_remove('nobody')$q$, 'No user called nobody');
do $$ begin
  assert public.staff_remove('Cashier3') = '66666666-6666-6666-6666-666666666666', 'returns the account to delete';
  assert not exists (select 1 from jsonb_array_elements(public.list_staff()) e where e ->> 'username' = 'cashier3'), 'off the staff list at once';
  assert public.login_email('cashier3') is null, 'can no longer sign in';
end $$;
-- If deleting the account failed, adding the same User ID again reuses it.
do $$
declare p jsonb;
begin
  p := public.staff_add_prepare('cashier3');
  assert p ->> 'userId' = '66666666-6666-6666-6666-666666666666', 'old account offered for reuse';
  assert public.staff_add_finish('66666666-6666-6666-6666-666666666666', 'cashier3') = 'cashier3', 'added again';
end $$;
-- Another super admin: only removable in the SQL Editor, only they change their password.
reset role;
select public.allow_staff('counter2@tikka.test', 'counter2') \g :devnull
select public.make_super_admin('counter2') \g :devnull
set role authenticated;
select t.expect_error($q$select public.staff_remove('counter2')$q$, 'only be removed in the SQL Editor');
select t.expect_error($q$select public.staff_user_id('counter2')$q$, 'Only that super admin');
reset role;
update public.staff set role = 'staff' where username = 'counter2';
delete from public.staff where username = 'cashier3';
delete from auth.users where id = '66666666-6666-6666-6666-666666666666';
select set_config('request.jwt.claims', '', false) \g :devnull
