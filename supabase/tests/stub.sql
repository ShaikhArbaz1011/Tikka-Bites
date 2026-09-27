-- Imitates the parts of Supabase that schema.sql relies on, so it can be tested on a
-- plain local PostgreSQL: the anon / authenticated roles, auth.uid(), and Supabase's
-- default grants (which give anon and authenticated everything in public, so
-- schema.sql must really take away what they shouldn't have).
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
-- Supabase keeps accounts in auth.users; allow_staff() looks them up there.
create table if not exists auth.users (id uuid primary key, email text, is_anonymous boolean not null default false);
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@tikka.test'),
  ('22222222-2222-2222-2222-222222222222', 'counter1@tikka.test'),
  ('33333333-3333-3333-3333-333333333333', 'counter2@tikka.test'),
  ('44444444-4444-4444-4444-444444444444', 'stranger@example.com')
on conflict (id) do nothing;
-- An "anonymous sign-in" account: Supabase gives these the authenticated role too.
insert into auth.users (id, email, is_anonymous) values ('55555555-5555-5555-5555-555555555555', null, true)
on conflict (id) do nothing;
grant usage on schema auth, public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;

-- Test helper (not part of the real schema): run SQL, expect an error containing `needle`.
create schema if not exists t;
grant usage on schema t to anon, authenticated;
create or replace function t.expect_error(q text, needle text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    if position(needle in sqlerrm) = 0 then raise exception 'expected an error containing "%", got: %', needle, sqlerrm; end if;
    return;
  end;
  raise exception 'expected an error containing "%", but it worked: %', needle, q;
end $$;
create or replace function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'check failed: %', msg; end if;
end $$;
