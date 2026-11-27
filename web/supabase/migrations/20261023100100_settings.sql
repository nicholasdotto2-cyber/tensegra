-- Impostazioni: i dati dello studio, gli orari di apertura, la parte fiscale e quella
-- clinica. Le tre tabelle 1:1 hanno practice_id come chiave primaria: uno studio, una riga.
-- Le validazioni fiscali non bloccano il salvataggio ma l'emissione: qui stanno solo
-- i vincoli di forma, le cifre di controllo e i codici di catalogo restano all'app.

-- practice_settings (1:1). Policy S, I, U. -----------------------------------------------------

create table public.practice_settings (
  practice_id uuid primary key references public.practices (id) on delete restrict,
  practitioner_first_name text not null check (char_length(trim(practitioner_first_name)) between 1 and 60),
  practitioner_last_name text not null check (char_length(trim(practitioner_last_name)) between 1 and 60),
  practitioner_title text not null default 'Osteopata',
  -- La sede dello studio: moduli, messaggi, lettere.
  address_line text,
  postal_code text check (postal_code ~ '^\d{5}$'),
  city text,
  province text check (province ~ '^[A-Z]{2}$'),
  phone text check (phone ~ '^\+[1-9]\d{6,14}$'),
  email text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  pec text check (pec ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- in_attesa = domanda presentata. Nei campi XML dell'albo va solo albo.
  registration_kind text not null default 'nessuna' check (registration_kind in ('nessuna', 'in_attesa', 'ese', 'albo')),
  registration_order text check (char_length(registration_order) <= 60),
  registration_province text check (registration_province ~ '^[A-Z]{2}$'),
  registration_number text check (char_length(registration_number) <= 60),
  registration_date date,
  insurance_company text,
  insurance_policy_number text,
  -- Il massimale in centesimi: 5.000.000 euro sono 500.000.000, entro integer.
  insurance_limit_cents integer check (insurance_limit_cents > 0),
  insurance_expires_on date,
  retention_years smallint not null default 10 check (retention_years between 1 and 30),
  default_addressing text not null default 'lei' check (default_addressing in ('tu', 'lei')),
  -- La firma disegnata una volta, stampata su moduli e lettere.
  practitioner_signature_file_id uuid,
  -- Il default è false e true lo scrive solo il seed: con default true uno studio reale,
  -- creato su Supabase senza un valore esplicito, sarebbe "demo", e "Ricrea i dati di prova"
  -- cancellerebbe tutto.
  is_demo boolean not null default false,
  demo_seeded_at timestamptz,
  demo_seed_version smallint,
  -- Il numero di prova per i link WhatsApp in demo.
  demo_test_phone text check (demo_test_phone ~ '^\+[1-9]\d{6,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  foreign key (practice_id, practitioner_signature_file_id) references public.files (practice_id, id) on delete restrict
);
alter table public.practice_settings enable row level security;
grant select, insert, update, delete on public.practice_settings to authenticated, service_role;
create policy practice_settings_select on public.practice_settings
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy practice_settings_insert on public.practice_settings
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy practice_settings_update on public.practice_settings
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger practice_settings_set_updated_at before update on public.practice_settings
  for each row execute function app.set_updated_at();
create trigger practice_settings_set_created_by before insert on public.practice_settings
  for each row execute function app.set_created_by();

-- opening_hours (C). Policy S, I, U, D. Un giorno senza righe è chiuso. -------------------------

create table public.opening_hours (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  weekday smallint not null check (weekday between 1 and 7), -- 1 = lunedì (ISO)
  slot smallint not null check (slot in (1, 2)), -- 1 = mattina, 2 = pomeriggio
  opens_at time not null check (extract(minute from opens_at) in (0, 15, 30, 45) and extract(second from opens_at) = 0),
  closes_at time not null check (extract(minute from closes_at) in (0, 15, 30, 45) and extract(second from closes_at) = 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  -- Che la fascia 2 inizi dopo la fine della fascia 1 è una regola dell'app: un check non vede le altre righe.
  unique (practice_id, weekday, slot),
  check (opens_at < closes_at)
);
alter table public.opening_hours enable row level security;
grant select, insert, update, delete on public.opening_hours to authenticated, service_role;
create policy opening_hours_select on public.opening_hours
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy opening_hours_insert on public.opening_hours
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy opening_hours_update on public.opening_hours
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy opening_hours_delete on public.opening_hours
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger opening_hours_set_updated_at before update on public.opening_hours
  for each row execute function app.set_updated_at();
create trigger opening_hours_set_created_by before insert on public.opening_hours
  for each row execute function app.set_created_by();

-- fiscal_settings (1:1). Policy S, I, U. ---------------------------------------------------------

create table public.fiscal_settings (
  practice_id uuid primary key references public.practices (id) on delete restrict,
  regime text not null default 'forfettario' check (regime in ('ordinario', 'forfettario', 'esente_sanitario')),
  -- Le cifre di controllo (partita IVA, IBAN mod 97) le verifica l'app.
  vat_number text check (vat_number ~ '^\d{11}$'),
  tax_code text check (tax_code ~ '^([A-Z0-9]{16}|\d{11})$'),
  ateco_code text check (ateco_code ~ '^\d{2}\.\d{2}\.\d{2}$'),
  -- Il domicilio fiscale, che può differire dalla sede dello studio: XML CedentePrestatore/Sede.
  fiscal_address_line text check (char_length(fiscal_address_line) <= 60),
  fiscal_postal_code text check (fiscal_postal_code ~ '^\d{5}$'),
  fiscal_city text check (char_length(fiscal_city) <= 60),
  fiscal_province text check (fiscal_province ~ '^[A-Z]{2}$'),
  fiscal_country text not null default 'IT' check (fiscal_country ~ '^[A-Z]{2}$'),
  inps_surcharge_enabled boolean not null default false,
  inps_surcharge_bp integer not null default 400 check (inps_surcharge_bp between 0 and 400),
  withholding_bp integer not null default 2000 check (withholding_bp between 0 and 10000),
  vat_rate_bp integer not null default 2200 check (vat_rate_bp between 0 and 10000),
  stamp_charged_to_client boolean not null default true,
  -- Gli estremi dell'autorizzazione al bollo virtuale per i documenti cartacei (art. 15 DPR 642/1972).
  paper_stamp_authorization text check (char_length(paper_stamp_authorization) <= 60),
  iban text check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  iban_holder text check (char_length(iban_holder) <= 200),
  default_payment_method text not null default 'carta' check (default_payment_method in ('contanti', 'carta', 'bonifico')),
  bank_transfer_due_days integer not null default 15 check (bank_transfer_due_days between 0 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
alter table public.fiscal_settings enable row level security;
grant select, insert, update, delete on public.fiscal_settings to authenticated, service_role;
create policy fiscal_settings_select on public.fiscal_settings
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy fiscal_settings_insert on public.fiscal_settings
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy fiscal_settings_update on public.fiscal_settings
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger fiscal_settings_set_updated_at before update on public.fiscal_settings
  for each row execute function app.set_updated_at();
create trigger fiscal_settings_set_created_by before insert on public.fiscal_settings
  for each row execute function app.set_created_by();

-- clinical_settings (1:1). Policy S, I, U. -------------------------------------------------------

create table public.clinical_settings (
  practice_id uuid primary key references public.practices (id) on delete restrict,
  default_recall_weeks smallint not null default 6 check (default_recall_weeks between 2 and 52),
  default_expected_sessions smallint not null default 4 check (default_expected_sessions between 1 and 20),
  default_session_interval_weeks smallint not null default 2 check (default_session_interval_weeks between 1 and 4),
  -- Senza default: i codici dei test attivi li scrive il seed (24 di default) e ognuno deve esistere
  -- nel catalogo, che un check non vede (controllo nell'app).
  active_test_codes text[] not null,
  referral_prompts text[] not null default '{R1,R2,R3}' check (referral_prompts <@ array['R1', 'R2', 'R3']),
  -- Si accende solo dopo una rilettura clinica.
  pediatric_red_flags_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);
alter table public.clinical_settings enable row level security;
grant select, insert, update, delete on public.clinical_settings to authenticated, service_role;
create policy clinical_settings_select on public.clinical_settings
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy clinical_settings_insert on public.clinical_settings
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy clinical_settings_update on public.clinical_settings
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger clinical_settings_set_updated_at before update on public.clinical_settings
  for each row execute function app.set_updated_at();
create trigger clinical_settings_set_created_by before insert on public.clinical_settings
  for each row execute function app.set_created_by();
