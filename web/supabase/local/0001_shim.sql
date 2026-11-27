-- Shim locale: gira solo su PGlite, prima delle migrazioni.
-- Dà al database locale gli stessi ruoli e le stesse funzioni auth.* di Supabase, così le
-- migrazioni e le policy RLS sono identiche nei due posti. Ogni istruzione è idempotente.
-- Non concede nessun privilegio di default su tabelle, sequenze o funzioni: ogni migrazione
-- scrive i suoi grant, e se ne dimentica uno l'errore esce già in locale.

-- 1. Ruoli
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- 2. Schemi
create schema if not exists auth;
create schema if not exists extensions;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- 3. Fuso del database
alter database postgres set timezone to 'UTC';

-- 4. Utenti finti (su Supabase li crea l'Auth; l'utente demo lo inserisce il seed)
create table if not exists auth.users (
  id uuid primary key,
  email text unique not null,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 5. Funzioni auth.* con il corpo di Supabase: leggono request.jwt.claim.<chiave> e, se è
-- vuoto, la stessa chiave dentro request.jwt.claims.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
