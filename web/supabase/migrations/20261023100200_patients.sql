-- Pazienti: la rubrica dei medici, l'anagrafica, i genitori, l'anamnesi remota e per
-- apparati, lo stile di vita e la storia perinatale. Le regole che guardano altre righe sono trigger
-- (qui: al massimo due genitori); i codici di controllo, il Latin-1 e le date rispetto a oggi
-- restano all'app, perché un check non vede altre tabelle e deve restare immutabile.

-- Un solo elenco per tutti i check di regione. -----------------------------------

create or replace function app.region_codes() returns text[]
language sql immutable parallel safe
as $$ select array['head','cervical','thoracic','lumbar','sacral','pelvic','lower_extremity','upper_extremity','rib_cage','abdomen_other'] $$;
revoke all on function app.region_codes() from public;
grant execute on function app.region_codes() to authenticated, service_role;

-- Ricerca senza maiuscole e accenti. unaccent è stable; con il dizionario scritto per
-- esteso il risultato non cambia, quindi l'involucro immutable può stare in un indice.
create or replace function app.search_text(p text) returns text
language sql immutable parallel safe strict
as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, p)) $$;
revoke all on function app.search_text(text) from public;
grant execute on function app.search_text(text) to authenticated, service_role;

-- physicians (C). Policy S, I, U. La rubrica: lo stesso medico vale per più pazienti. -------------

create table public.physicians (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  full_name text not null check (char_length(trim(full_name)) between 2 and 120), -- "Dott.ssa Anna Verdi"
  role text not null check (role in ('mmg', 'pediatra', 'specialista', 'altro')),
  specialty text,
  organization text,
  phone text,
  email text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notes text check (char_length(notes) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id)
);
alter table public.physicians enable row level security;
grant select, insert, update, delete on public.physicians to authenticated, service_role;
create policy physicians_select on public.physicians
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy physicians_insert on public.physicians
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy physicians_update on public.physicians
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger physicians_set_updated_at before update on public.physicians
  for each row execute function app.set_updated_at();
create trigger physicians_set_created_by before insert on public.physicians
  for each row execute function app.set_created_by();

-- patients (C). Policy S, I, U, D: la delete passa solo se nessuna tabella punta il paziente, ----
-- tranne i genitori che spariscono con lui.

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- Latin-1 (testi che finiscono nell'XML): lo controlla l'app.
  first_name text not null check (char_length(trim(first_name)) between 1 and 60),
  last_name text not null check (char_length(trim(last_name)) between 1 and 60),
  -- Non futura e non oltre 120 anni: regola dell'app, un check non può leggere la data di oggi.
  birth_date date not null,
  sex text not null default 'nd' check (sex in ('f', 'm', 'nd')),
  birth_place text,
  -- La cifra di controllo e le omocodie le verifica l'app; serve per emettere fattura, non per salvare.
  tax_code text check (tax_code ~ '^[A-Z0-9]{16}$'),
  -- Un fisso italiano (+39 0...) disattiva WhatsApp: lo decide l'app.
  phone text check (phone ~ '^\+[1-9]\d{6,14}$'),
  email text,
  address_line text,
  postal_code text,
  city text,
  province text,
  country text not null default 'IT',
  gp_physician_id uuid,
  default_referring_physician_id uuid,
  preferred_channel text not null default 'whatsapp' check (preferred_channel in ('whatsapp', 'telefono', 'nessuno')),
  -- Il valore proposto viene dallo studio (default_addressing): lo mette l'app.
  addressing text not null check (addressing in ('tu', 'lei')),
  recall_interval_weeks smallint check (recall_interval_weeks between 2 and 52),
  recall_paused boolean not null default false,
  clinical_alert text check (char_length(clinical_alert) <= 200),
  admin_notes text check (char_length(admin_notes) <= 500),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  -- Il CAP di cinque cifre vale in Italia.
  check (postal_code is null or country <> 'IT' or postal_code ~ '^\d{5}$'),
  foreign key (practice_id, gp_physician_id) references public.physicians (practice_id, id) on delete restrict,
  foreign key (practice_id, default_referring_physician_id) references public.physicians (practice_id, id) on delete restrict
);
create index patients_practice_id_last_name_first_name_idx on public.patients (practice_id, last_name, first_name);
-- "nome cognome" e "cognome nome" stanno entrambi nel testo "nome cognome nome": una ricerca per
-- sottostringa trova i due ordini con un solo indice. La query deve riscrivere questa
-- espressione identica, perché il planner usi l'indice:
--   app.search_text(first_name || ' ' || last_name || ' ' || first_name) like '%' || app.search_text($1) || '%'
-- Nel testo cercato % _ e \ sono jolly di like: chi costruisce la query li protegge con la barra.
create index patients_search_trgm_idx on public.patients
  using gin (app.search_text(first_name || ' ' || last_name || ' ' || first_name) extensions.gin_trgm_ops);
alter table public.patients enable row level security;
grant select, insert, update, delete on public.patients to authenticated, service_role;
create policy patients_select on public.patients
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patients_insert on public.patients
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patients_update on public.patients
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy patients_delete on public.patients
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger patients_set_updated_at before update on public.patients
  for each row execute function app.set_updated_at();
create trigger patients_set_created_by before insert on public.patients
  for each row execute function app.set_created_by();

-- patient_guardians (C). Policy S, I, U, D. Al massimo due righe per paziente. -------------------

create table public.patient_guardians (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  relationship text not null check (relationship in ('madre', 'padre', 'tutore', 'altro')),
  first_name text not null check (char_length(trim(first_name)) between 1 and 60),
  last_name text not null check (char_length(trim(last_name)) between 1 and 60),
  tax_code text check (tax_code ~ '^[A-Z0-9]{16}$'),
  -- Finisce negli stessi link WhatsApp del telefono del paziente: stesso E.164.
  phone text check (phone ~ '^\+[1-9]\d{6,14}$'),
  email text,
  -- Indirizzo come sul paziente; richiesto se il genitore è l'intestatario della fattura (lo verifica l'app).
  address_line text,
  postal_code text,
  city text,
  province text,
  country text not null default 'IT',
  has_parental_authority boolean not null default true,
  -- Un minore ha esattamente un contatto: l'indice vieta il secondo, "almeno uno" è una regola dell'app.
  is_contact boolean not null default false,
  is_payer boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check (postal_code is null or country <> 'IT' or postal_code ~ '^\d{5}$'),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete cascade
);
-- Gli indici sono immediati, non rinviabili: per cambiare il contatto si toglie il flag al primo e poi
-- lo si mette al secondo, in due update (nella stessa transazione, in quest'ordine).
create unique index patient_guardians_one_contact_idx on public.patient_guardians (practice_id, patient_id) where is_contact;
create unique index patient_guardians_one_payer_idx on public.patient_guardians (practice_id, patient_id) where is_payer;
alter table public.patient_guardians enable row level security;
grant select, insert, update, delete on public.patient_guardians to authenticated, service_role;
create policy patient_guardians_select on public.patient_guardians
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patient_guardians_insert on public.patient_guardians
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patient_guardians_update on public.patient_guardians
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy patient_guardians_delete on public.patient_guardians
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger patient_guardians_set_updated_at before update on public.patient_guardians
  for each row execute function app.set_updated_at();
create trigger patient_guardians_set_created_by before insert on public.patient_guardians
  for each row execute function app.set_created_by();

-- Il limite di due: conta le altre righe dello stesso paziente, escluso chi si sta scrivendo (un update
-- che riscrive patient_id su se stesso non lo supera). Gira come chi scrive, quindi sotto RLS: vede le righe del suo studio.
create or replace function app.patient_guardians_limit() returns trigger
language plpgsql
as $$
begin
  if (select count(*)
        from public.patient_guardians g
       where g.practice_id = new.practice_id and g.patient_id = new.patient_id and g.id <> new.id) >= 2 then
    raise exception 'Un paziente ha al massimo due genitori o tutori' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.patient_guardians_limit() from public;
grant execute on function app.patient_guardians_limit() to authenticated, service_role;
create trigger patient_guardians_limit before insert or update of patient_id on public.patient_guardians
  for each row execute function app.patient_guardians_limit();

-- patient_history_items (C). Policy S, I, U. Anamnesi remota, una riga per voce. ------------------

create table public.patient_history_items (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  kind text not null check (kind in ('patologia', 'farmaco', 'intervento', 'trauma', 'allergia', 'esame')),
  label text not null check (char_length(label) <= 200), -- "Warfarin 5 mg", "Artrodesi L4-L5"
  region text check (region = any (app.region_codes())),
  occurred_on date,
  -- Quando il giorno non è noto.
  occurred_year smallint,
  ongoing boolean not null default true,
  -- Gli elementi stanno nel vocabolario dei rischi: lo controlla l'app, che lo accende da sola dal farmaco scelto.
  risk_tags text[] not null default '{}',
  note text check (char_length(note) <= 500),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict
);
alter table public.patient_history_items enable row level security;
grant select, insert, update, delete on public.patient_history_items to authenticated, service_role;
create policy patient_history_items_select on public.patient_history_items
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patient_history_items_insert on public.patient_history_items
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patient_history_items_update on public.patient_history_items
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger patient_history_items_set_updated_at before update on public.patient_history_items
  for each row execute function app.set_updated_at();
create trigger patient_history_items_set_created_by before insert on public.patient_history_items
  for each row execute function app.set_created_by();

-- patient_systems_review (C). Policy S, I, U. Anamnesi per apparati. ------------------------------

create table public.patient_systems_review (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  system text not null check (
    system in ('digerente', 'urogenitale', 'respiratorio', 'cardiocircolatorio', 'orl_vista', 'stomatognatico', 'sonno', 'stress_umore')
  ),
  -- "Niente da segnalare" già scelto.
  status text not null default 'nulla' check (status in ('nulla', 'da_segnalare')),
  note text check (char_length(note) <= 300),
  reviewed_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, patient_id, system),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict
);
alter table public.patient_systems_review enable row level security;
grant select, insert, update, delete on public.patient_systems_review to authenticated, service_role;
create policy patient_systems_review_select on public.patient_systems_review
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patient_systems_review_insert on public.patient_systems_review
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patient_systems_review_update on public.patient_systems_review
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger patient_systems_review_set_updated_at before update on public.patient_systems_review
  for each row execute function app.set_updated_at();
create trigger patient_systems_review_set_created_by before insert on public.patient_systems_review
  for each row execute function app.set_created_by();

-- patient_lifestyle (C, 1:1 facoltativa). Policy S, I, U. -----------------------------------------

create table public.patient_lifestyle (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  occupation text,
  sport text,
  -- Il sonno sta in patient_systems_review.
  family_history text,
  pregnancy_status text check (pregnancy_status in ('no', 'in_corso', 'post_partum')),
  pregnancy_weeks smallint check (pregnancy_weeks between 1 and 42),
  last_reviewed_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, patient_id),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict
);
alter table public.patient_lifestyle enable row level security;
grant select, insert, update, delete on public.patient_lifestyle to authenticated, service_role;
create policy patient_lifestyle_select on public.patient_lifestyle
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patient_lifestyle_insert on public.patient_lifestyle
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patient_lifestyle_update on public.patient_lifestyle
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger patient_lifestyle_set_updated_at before update on public.patient_lifestyle
  for each row execute function app.set_updated_at();
create trigger patient_lifestyle_set_created_by before insert on public.patient_lifestyle
  for each row execute function app.set_created_by();

-- perinatal_histories (C, 1:1 per lattanti e bambini piccoli). Policy S, I, U. --------------------
-- Il blocco compare da solo sotto i 24 mesi, sopra si apre a mano: lo decide l'app.

create table public.perinatal_histories (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  gestational_age_weeks smallint check (gestational_age_weeks between 22 and 44),
  birth_weight_g smallint check (birth_weight_g between 300 and 6500),
  delivery_mode text check (
    delivery_mode in ('spontaneo', 'operativo_ventosa', 'operativo_forcipe', 'cesareo_programmato', 'cesareo_urgente')
  ),
  presentation text check (presentation in ('cefalica', 'podalica', 'trasversa', 'altro')),
  labour_hours numeric(4, 1) check (labour_hours between 0 and 72),
  apgar_1 smallint check (apgar_1 between 0 and 10),
  apgar_5 smallint check (apgar_5 between 0 and 10),
  nicu_stay boolean,
  suction_difficulty boolean,
  plagiocephaly_noted boolean,
  torticollis_noted boolean,
  colic boolean,
  reflux boolean,
  feeding text check (feeding in ('seno', 'artificiale', 'misto')),
  preferred_head_side text check (preferred_head_side in ('dx', 'sx', 'nessuna')),
  notes text check (char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, patient_id),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict
);
alter table public.perinatal_histories enable row level security;
grant select, insert, update, delete on public.perinatal_histories to authenticated, service_role;
create policy perinatal_histories_select on public.perinatal_histories
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy perinatal_histories_insert on public.perinatal_histories
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy perinatal_histories_update on public.perinatal_histories
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger perinatal_histories_set_updated_at before update on public.perinatal_histories
  for each row execute function app.set_updated_at();
create trigger perinatal_histories_set_created_by before insert on public.perinatal_histories
  for each row execute function app.set_created_by();
