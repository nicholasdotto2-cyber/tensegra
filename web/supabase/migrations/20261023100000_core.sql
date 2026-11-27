-- Nucleo: studi, appartenenze, file e numerazioni senza buchi, con
-- gli helper RLS dello schema app. Ogni tabella di public ha la RLS attiva e i suoi grant;
-- anon non riceve niente, quindi ogni sua lettura fallisce con 42501.

-- Estensioni (solo quelle di EXTENSIONS): unaccent e pg_trgm servono alla ricerca dei pazienti.
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- Trigger comuni ----------------------------------------------------------------------------

create or replace function app.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function app.set_updated_at() from public;
grant execute on function app.set_updated_at() to authenticated, service_role;

-- Il valore passato si ignora sempre: un default si può falsificare. Come servizio auth.uid()
-- è null, e la colonna resta null.
create or replace function app.set_created_by() returns trigger
language plpgsql
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;
revoke all on function app.set_created_by() from public;
grant execute on function app.set_created_by() to authenticated, service_role;

-- practices: lo studio. Lo crea il seed come servizio, l'utente lo legge e lo rinomina. ------

create table public.practices (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.practices enable row level security;
grant select, insert, update, delete on public.practices to authenticated, service_role;
create trigger practices_set_updated_at before update on public.practices
  for each row execute function app.set_updated_at();
-- Le policy di practices usano app.my_practice_ids(), che legge memberships: stanno più sotto.

-- memberships: chi lavora in quale studio. Nessuna scrittura per authenticated. ------------

create table public.memberships (
  practice_id uuid not null references public.practices (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (practice_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);
alter table public.memberships enable row level security;
grant select, insert, update, delete on public.memberships to authenticated, service_role;
create policy memberships_select on public.memberships
  for select to authenticated using (user_id = (select auth.uid()));

-- Helper RLS: gli studi dell'utente corrente. security definer, così legge memberships senza
-- passare dalla sua policy.
create or replace function app.my_practice_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$ select m.practice_id from public.memberships m where m.user_id = (select auth.uid()) $$;
revoke all on function app.my_practice_ids() from public;
grant execute on function app.my_practice_ids() to authenticated, service_role;

create policy practices_select on public.practices
  for select to authenticated using (id in (select app.my_practice_ids()));
create policy practices_update on public.practices
  for update to authenticated
  using (id in (select app.my_practice_ids()))
  with check (id in (select app.my_practice_ids()));

-- files: i metadati dei file su disco. Si inseriscono e si leggono, non si modificano. -----

create table public.files (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  kind text not null check (
    kind in ('posture_photo','clinical_doc','signature','consent_pdf','consent_upload','invoice_pdf','referral_pdf')
  ),
  -- La chiave sta nella cartella dello studio e del tipo: niente .., niente percorsi di altri studi.
  storage_key text not null unique check (
    storage_key ~ ('^' || practice_id::text || '/' || kind || '/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$')
  ),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  original_name text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id)
);
-- Per scoprire le foto doppie dello stesso studio.
create index files_practice_id_sha256_idx on public.files (practice_id, sha256);
alter table public.files enable row level security;
grant select, insert, update, delete on public.files to authenticated, service_role;
create policy files_select on public.files
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy files_insert on public.files
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create trigger files_set_created_by before insert on public.files
  for each row execute function app.set_created_by();

-- number_series: contatori senza buchi. authenticated li legge e basta: il numero passa solo
-- da app.next_number, così nessuno può abbassare last_number. --------------------------------

create table public.number_series (
  practice_id uuid not null references public.practices (id) on delete restrict,
  series text not null check (series in ('TD01','TD04','INVIO')),
  -- TD01 e TD04 vanno per anno; INVIO è il contatore unico dei file XML, con anno 0.
  year integer not null check ((series = 'INVIO') = (year = 0)) check (year = 0 or year between 2000 and 2100),
  last_number integer not null check (last_number >= 0),
  primary key (practice_id, series, year)
);
alter table public.number_series enable row level security;
grant select on public.number_series to authenticated;
grant select, insert, update, delete on public.number_series to service_role;
create policy number_series_select on public.number_series
  for select to authenticated using (practice_id in (select app.my_practice_ids()));

-- Il prossimo numero di una serie, nella transazione di chi lo usa: se quella fallisce, il
-- rollback riporta indietro anche il contatore. Rifiuta uno studio di cui l'utente non fa parte.
create or replace function app.next_number(p_practice_id uuid, p_series text, p_year integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number integer;
begin
  if (p_practice_id in (select app.my_practice_ids())) is not true then
    raise exception 'Operazione non permessa' using errcode = '42501';
  end if;
  insert into public.number_series (practice_id, series, year, last_number) values (p_practice_id, p_series, p_year, 1)
  on conflict (practice_id, series, year) do update set last_number = public.number_series.last_number + 1
  returning last_number into v_number;
  return v_number;
end;
$$;
revoke all on function app.next_number(uuid, text, integer) from public;
grant execute on function app.next_number(uuid, text, integer) to authenticated, service_role;
