-- Visita e cartella: la visita, le sue sette tabelle figlie (PSFS, screening,
-- disfunzioni TART, test, trattamenti, consigli), le rettifiche, i rinvii al medico e gli allegati del
-- paziente. Una visita chiusa, e con lei le figlie, cambia solo con una rettifica scritta nella stessa
-- transazione (app.visit_locked); non torna in bozza e non si cancella. La lettera di un rinvio, una
-- volta salvata, non cambia più. Le regole che guardano il catalogo clinico (codici di screening e di
-- test, campo del valore giusto per il tipo di test, nota obbligatoria alla chiusura) restano all'app.

-- visits (C). Policy S, I, U: nessuna D, la visita non si cancella. ----------------------------------

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- Lo stesso paziente del ciclo e dell'appuntamento (trigger visits_rules).
  patient_id uuid not null,
  cycle_id uuid not null,
  -- Una visita per appuntamento; un appuntamento con la visita non si cancella.
  appointment_id uuid not null,
  -- Non prima dell'apertura del ciclo (trigger visits_rules).
  visit_date date not null,
  -- Proposto dalla voce di listino.
  kind text not null check (kind in ('prima_visita', 'seduta', 'controllo')),
  status text not null default 'draft' check (status in ('draft', 'closed')),
  closed_at timestamptz,
  location text not null default 'studio' check (location in ('studio', 'domicilio', 'altro')), -- GOsC C2.1.13
  -- "madre", "tirocinante" (GOsC C2.1.14).
  others_present text check (char_length(others_present) <= 200),
  -- Obbligatorio alla chiusura se others_present non è vuoto (app).
  others_present_consented boolean,
  -- "Dolore 0-10 (NRS)" a inizio e a fine seduta.
  nprs_pre smallint check (nprs_pre between 0 and 10),
  nprs_post smallint check (nprs_post between 0 and 10),
  -- Come sta dall'ultima volta.
  subjective_update text check (char_length(subjective_update) <= 1000),
  -- "Irradiazione": vuoto = no; apre il blocco "Esame neurologico".
  radiation_sites text[] not null default '{}'
    check (radiation_sites <@ array['gluteo', 'coscia', 'sotto_ginocchio', 'braccio', 'mano']),
  -- Obbligatorio se radiation_sites non è vuoto (app).
  radiation_side text check (radiation_side in ('dx', 'sx', 'bilaterale')),
  -- "Risposta al trattamento", campo unico per la visita.
  treatment_response text check (treatment_response in ('migliorato', 'invariato', 'peggiorato')),
  -- Reazioni dopo la visita precedente (GOsC C1.7); la nota è obbligatoria alla chiusura se non 'nessuna' (app).
  adverse_reaction text check (adverse_reaction in ('nessuna', 'lieve', 'moderata', 'grave')),
  adverse_reaction_note text check (char_length(adverse_reaction_note) <= 500),
  -- Osservazione posturale.
  observation_note text check (char_length(observation_note) <= 1000),
  -- "Ipotesi di lavoro osteopatica".
  working_hypothesis text check (char_length(working_hypothesis) <= 1000),
  plan_next text check (char_length(plan_next) <= 500),
  -- Facoltativa, proposta quando lo screening cervicale è aperto.
  bp_systolic smallint check (bp_systolic between 50 and 260),
  bp_diastolic smallint check (bp_diastolic between 30 and 160),
  -- La versione del catalogo di screening usata.
  screening_catalog_version smallint not null,
  -- Conferma esplicita dello screening.
  screening_reviewed_at timestamptz,
  -- Traccia della copia dalla visita precedente.
  copied_from_visit_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, appointment_id),
  check (status = 'draft' or closed_at is not null),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict,
  foreign key (practice_id, appointment_id) references public.appointments (practice_id, id) on delete restrict,
  foreign key (practice_id, copied_from_visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.visits enable row level security;
grant select, insert, update, delete on public.visits to authenticated, service_role;
create policy visits_select on public.visits
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visits_insert on public.visits
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visits_update on public.visits
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger visits_set_updated_at before update on public.visits
  for each row execute function app.set_updated_at();
create trigger visits_set_created_by before insert on public.visits
  for each row execute function app.set_created_by();

-- Le sette figlie della visita: policy S, I, U, D, così in bozza togliere una disfunzione o un test ----
-- cancella la riga. A visita chiusa le scritture passano solo con una rettifica (trigger <figlia>_guard).

-- psfs_scores (C): il punteggio di un'attività PSFS del ciclo in una visita.
create table public.psfs_scores (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  item_id uuid not null,
  visit_id uuid not null,
  score smallint not null check (score between 0 and 10),
  phase text not null check (phase in ('iniziale', 'intermedia', 'finale')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, item_id, visit_id),
  foreign key (practice_id, item_id) references public.psfs_items (practice_id, id) on delete restrict,
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.psfs_scores enable row level security;
grant select, insert, update, delete on public.psfs_scores to authenticated, service_role;
create policy psfs_scores_select on public.psfs_scores
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy psfs_scores_insert on public.psfs_scores
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy psfs_scores_update on public.psfs_scores
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy psfs_scores_delete on public.psfs_scores
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger psfs_scores_set_updated_at before update on public.psfs_scores
  for each row execute function app.set_updated_at();
create trigger psfs_scores_set_created_by before insert on public.psfs_scores
  for each row execute function app.set_created_by();

-- visit_screening_answers (C): una risposta per voce del catalogo di screening.
create table public.visit_screening_answers (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  -- Codice del catalogo (controllo nell'app).
  item_code text not null check (item_code ~ '^[a-z0-9_]{2,40}$'),
  answer text not null check (answer in ('no', 'si', 'non_so')),
  -- Regioni di app.region_codes(); non vuoto se 'si' e la voce è locale (app).
  regions text[] not null default '{}' check (regions <@ app.region_codes()),
  -- I codici delle sottovoci vere.
  sub_answers text[] not null default '{}',
  -- Risposta proposta dall'anamnesi.
  from_history boolean not null default false,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, visit_id, item_code),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.visit_screening_answers enable row level security;
grant select, insert, update, delete on public.visit_screening_answers to authenticated, service_role;
create policy visit_screening_answers_select on public.visit_screening_answers
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_screening_answers_insert on public.visit_screening_answers
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_screening_answers_update on public.visit_screening_answers
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_screening_answers_delete on public.visit_screening_answers
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_screening_answers_set_updated_at before update on public.visit_screening_answers
  for each row execute function app.set_updated_at();
create trigger visit_screening_answers_set_created_by before insert on public.visit_screening_answers
  for each row execute function app.set_created_by();

-- visit_screening_outcomes (C): l'esito dello screening per famiglia di tecniche.
create table public.visit_screening_outcomes (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  family text not null check (family in ('thrust', 'direct', 'indirect')),
  -- Calcolato dall'app.
  suggested text not null check (suggested in ('indicated', 'caution', 'contraindicated')),
  -- Scelto dall'osteopata.
  outcome text not null check (outcome in ('indicated', 'caution', 'contraindicated')),
  -- Regioni di app.region_codes().
  local_contraindicated_regions text[] not null default '{}' check (local_contraindicated_regions <@ app.region_codes()),
  -- Obbligatoria (minimo 10 caratteri) se outcome è meno severo di suggested (app).
  override_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, visit_id, family),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.visit_screening_outcomes enable row level security;
grant select, insert, update, delete on public.visit_screening_outcomes to authenticated, service_role;
create policy visit_screening_outcomes_select on public.visit_screening_outcomes
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_screening_outcomes_insert on public.visit_screening_outcomes
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_screening_outcomes_update on public.visit_screening_outcomes
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_screening_outcomes_delete on public.visit_screening_outcomes
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_screening_outcomes_set_updated_at before update on public.visit_screening_outcomes
  for each row execute function app.set_updated_at();
create trigger visit_screening_outcomes_set_created_by before insert on public.visit_screening_outcomes
  for each row execute function app.set_created_by();

-- visit_region_findings (C): "Disfunzioni somatiche (TART)", una riga per regione.
-- "Nessuna disfunzione" è l'assenza della riga.
create table public.visit_region_findings (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  region text not null check (region = any (app.region_codes())),
  -- Scala ACOI.
  severity smallint not null check (severity between 0 and 3),
  -- T, A, R, T.
  tissue_texture boolean not null default false,
  asymmetry boolean not null default false,
  restriction boolean not null default false,
  tenderness boolean not null default false,
  side text check (side in ('dx', 'sx', 'bilaterale', 'centrale')),
  -- "C2 FRS dx", "D5".
  segment_note text check (char_length(segment_note) <= 200),
  -- Interruttore "Primaria" (disfunzione primaria).
  is_primary boolean not null default false,
  -- Riga copiata dalla visita precedente e non ancora confermata.
  copied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, visit_id, region),
  check (severity > 0 or tissue_texture or asymmetry or restriction or tenderness),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
-- Una sola regione primaria per visita.
create unique index visit_region_findings_one_primary_idx on public.visit_region_findings (practice_id, visit_id)
  where is_primary;
alter table public.visit_region_findings enable row level security;
grant select, insert, update, delete on public.visit_region_findings to authenticated, service_role;
create policy visit_region_findings_select on public.visit_region_findings
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_region_findings_insert on public.visit_region_findings
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_region_findings_update on public.visit_region_findings
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_region_findings_delete on public.visit_region_findings
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_region_findings_set_updated_at before update on public.visit_region_findings
  for each row execute function app.set_updated_at();
create trigger visit_region_findings_set_created_by before insert on public.visit_region_findings
  for each row execute function app.set_created_by();

-- visit_test_results (C): i test della visita, anche quelli del blocco "Esame neurologico".
-- Che il valore scritto sia quello del tipo del test lo controlla l'app con il catalogo; il
-- test libero usa value_bool o value_numeric.
create table public.visit_test_results (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  -- Codice del catalogo (app), oppure 'libero'.
  test_code text not null check (test_code ~ '^[a-z0-9_]{2,40}$'),
  -- Il nome scritto dall'osteopata per il "Test libero", e solo per lui.
  custom_label text check (char_length(custom_label) <= 60),
  -- L'unità del test libero numerico ("cm", "°").
  custom_unit text check (char_length(custom_unit) <= 10),
  -- Obbligatorio se il test è per lato (app).
  side text check (side in ('dx', 'sx')),
  -- Per i binari: vero = positivo.
  value_bool boolean,
  value_lateral text check (value_lateral in ('neg', 'dx', 'sx', 'bil')),
  -- Per i numerici, nel range del test (app).
  value_numeric numeric(6, 2),
  -- Per gli ordinali.
  value_ordinal smallint,
  pain_provoked boolean,
  note text check (char_length(note) <= 200),
  copied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check ((test_code = 'libero') = (custom_label is not null)),
  check (num_nonnulls(value_bool, value_lateral, value_numeric, value_ordinal) <= 1),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
-- Un test per lato e per visita; i test liberi si distinguono per nome, senza maiuscole.
create unique index visit_test_results_test_side_key on public.visit_test_results
  (practice_id, visit_id, test_code, coalesce(lower(custom_label), ''), coalesce(side, '-'));
alter table public.visit_test_results enable row level security;
grant select, insert, update, delete on public.visit_test_results to authenticated, service_role;
create policy visit_test_results_select on public.visit_test_results
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_test_results_insert on public.visit_test_results
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_test_results_update on public.visit_test_results
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_test_results_delete on public.visit_test_results
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_test_results_set_updated_at before update on public.visit_test_results
  for each row execute function app.set_updated_at();
create trigger visit_test_results_set_created_by before insert on public.visit_test_results
  for each row execute function app.set_created_by();

-- visit_treatments (C): una riga per tecnica in una regione (i chip dell'editor), così lo
-- screening continua a valere per tecnica.
create table public.visit_treatments (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  region text not null check (region = any (app.region_codes())),
  technique_code text not null check (
    technique_code in ('tessuti_molli', 'articolatoria', 'hvla', 'energia_muscolare', 'got', 'inibizione', 'fasciale',
                       'craniale', 'viscerale', 'still', 'funzionale', 'counterstrain', 'blt', 'linfatica', 'riflessi',
                       'altra')
  ),
  -- Il nome libero di "Altra tecnica", e solo per lei.
  custom_technique text check (char_length(custom_technique) <= 60),
  -- Obbligatorio per fasciale, craniale, viscerale, still e altra (app).
  approach text check (approach in ('direct', 'indirect')),
  -- Calcolata da tecnica e approccio, e salvata per lo storico.
  family text not null check (family in ('thrust', 'direct', 'indirect')),
  -- Facoltativa per riga: c'è visits.treatment_response.
  response text check (response in ('migliorato', 'invariato', 'peggiorato')),
  tolerance text not null default 'buona' check (tolerance in ('buona', 'fastidio', 'interrotta')),
  note text check (char_length(note) <= 300),
  copied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check ((technique_code = 'altra') = (custom_technique is not null)),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
-- Una tecnica per regione e per visita; le "Altra tecnica" si distinguono per nome, senza maiuscole.
create unique index visit_treatments_region_technique_key on public.visit_treatments
  (practice_id, visit_id, region, technique_code, coalesce(lower(custom_technique), ''));
alter table public.visit_treatments enable row level security;
grant select, insert, update, delete on public.visit_treatments to authenticated, service_role;
create policy visit_treatments_select on public.visit_treatments
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_treatments_insert on public.visit_treatments
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_treatments_update on public.visit_treatments
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_treatments_delete on public.visit_treatments
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_treatments_set_updated_at before update on public.visit_treatments
  for each row execute function app.set_updated_at();
create trigger visit_treatments_set_created_by before insert on public.visit_treatments
  for each row execute function app.set_created_by();

-- visit_advice (C): i consigli dati, con il testo copiato al momento e non un riferimento al modello.
-- communicated_via: GOsC C2.1.6 chiede di registrare "how this is communicated".
create table public.visit_advice (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  -- Il codice del modello di catalogo.
  template_code text,
  text text not null check (char_length(text) <= 1000),
  -- "A voce" già scelto.
  communicated_via text[] not null default '{a_voce}' check (
    cardinality(communicated_via) >= 1
    and communicated_via <@ array['a_voce', 'foglio_stampato', 'messaggio_copiato']
  ),
  copied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.visit_advice enable row level security;
grant select, insert, update, delete on public.visit_advice to authenticated, service_role;
create policy visit_advice_select on public.visit_advice
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_advice_insert on public.visit_advice
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy visit_advice_update on public.visit_advice
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy visit_advice_delete on public.visit_advice
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger visit_advice_set_updated_at before update on public.visit_advice
  for each row execute function app.set_updated_at();
create trigger visit_advice_set_created_by before insert on public.visit_advice
  for each row execute function app.set_created_by();

-- visit_amendments (C senza updated_at). Policy S, I: la rettifica di una visita chiusa, scritta ------
-- nella stessa transazione della modifica, prima di lei e senza savepoint in mezzo.

create table public.visit_amendments (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  visit_id uuid not null,
  -- Dal Clock del comando.
  amended_at timestamptz not null,
  -- Motivo obbligatorio: "10-500" come ogni testo a intervallo, quindi senza contare gli spazi ai lati.
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  -- Prima e dopo per campo.
  changes jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.visit_amendments enable row level security;
grant select, insert, update, delete on public.visit_amendments to authenticated, service_role;
create policy visit_amendments_select on public.visit_amendments
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy visit_amendments_insert on public.visit_amendments
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create trigger visit_amendments_set_created_by before insert on public.visit_amendments
  for each row execute function app.set_created_by();

-- Una visita chiusa cambia solo con una rettifica scritta nella stessa transazione.
-- xmin = transazione che ha scritto la riga: una rettifica di ieri non apre la visita oggi.
create or replace function app.visit_locked(p_practice_id uuid, p_visit_id uuid) returns boolean
language sql stable
as $$
  select exists (select 1 from public.visits v
                  where v.practice_id = p_practice_id and v.id = p_visit_id and v.status = 'closed')
     and not exists (select 1 from public.visit_amendments a
                      where a.practice_id = p_practice_id and a.visit_id = p_visit_id
                        and a.xmin = pg_current_xact_id()::xid)
$$;
revoke all on function app.visit_locked(uuid, uuid) from public;
grant execute on function app.visit_locked(uuid, uuid) to authenticated, service_role;

-- Trigger della visita e delle figlie --------------------------------------------------------------

-- Il paziente della visita è quello del ciclo e dell'appuntamento, e la visita non precede l'apertura
-- del ciclo. Ciclo e appuntamento si cercano con la chiave composta: se non ci sono (studio sbagliato)
-- si lascia passare, e risponde la chiave esterna. Gira come chi scrive, quindi sotto RLS: vede le
-- righe del suo studio.
create or replace function app.visits_rules() returns trigger
language plpgsql
as $$
begin
  if exists (select 1
               from public.treatment_cycles c
              where c.practice_id = new.practice_id and c.id = new.cycle_id and c.patient_id <> new.patient_id) then
    raise exception 'Il ciclo della visita è di un altro paziente' using errcode = '23514';
  end if;
  if exists (select 1
               from public.treatment_cycles c
              where c.practice_id = new.practice_id and c.id = new.cycle_id and new.visit_date < c.opened_on) then
    raise exception 'La visita non può precedere l''apertura del ciclo' using errcode = '23514';
  end if;
  if exists (select 1
               from public.appointments a
              where a.practice_id = new.practice_id and a.id = new.appointment_id and a.patient_id <> new.patient_id) then
    raise exception 'L''appuntamento della visita è di un altro paziente' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.visits_rules() from public;
grant execute on function app.visits_rules() to authenticated, service_role;
create trigger visits_rules before insert or update on public.visits
  for each row execute function app.visits_rules();

-- Una visita chiusa non si cancella (niente cancellazione fisica dei dati clinici), non
-- torna in bozza nemmeno con una rettifica, e cambia solo con una rettifica della stessa transazione.
-- Esce subito sotto purga dello studio; un update solo se la visita resta
-- nello studio della purga.
create or replace function app.visits_immutable() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if app.purging(old.practice_id) then
      return old;
    end if;
  elsif app.purging(old.practice_id) and app.purging(new.practice_id) then
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'closed' then
      raise exception 'Una visita chiusa non si cancella' using errcode = '42501';
    end if;
    return old;
  end if;

  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'Una visita chiusa non torna in bozza' using errcode = '42501';
  end if;
  if app.visit_locked(old.practice_id, old.id) then
    raise exception 'Una visita chiusa si modifica solo con una rettifica' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.visits_immutable() from public;
grant execute on function app.visits_immutable() to authenticated, service_role;
create trigger visits_immutable before update or delete on public.visits
  for each row execute function app.visits_immutable();

-- Le figlie di una visita chiusa non si scrivono senza una rettifica della stessa transazione: né
-- insert, né update, né delete, e nessun trasferimento da o verso una visita chiusa. Una funzione per
-- le sette tabelle, che hanno tutte practice_id e visit_id. Se la visita non c'è (studio sbagliato)
-- app.visit_locked dà false e risponde la chiave esterna. Esce subito sotto purga; un update
-- solo se la riga resta nello studio della purga, così non entra in una visita chiusa di un altro studio.
create or replace function app.visit_children_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if app.purging(new.practice_id) then
      return new;
    end if;
  elsif tg_op = 'DELETE' then
    if app.purging(old.practice_id) then
      return old;
    end if;
  elsif app.purging(old.practice_id) and app.purging(new.practice_id) then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    if app.visit_locked(old.practice_id, old.visit_id) then
      raise exception 'I dati di una visita chiusa si modificano solo con una rettifica' using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if app.visit_locked(new.practice_id, new.visit_id) then
      raise exception 'I dati di una visita chiusa si modificano solo con una rettifica' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.visit_children_guard() from public;
grant execute on function app.visit_children_guard() to authenticated, service_role;
create trigger psfs_scores_guard before insert or update or delete on public.psfs_scores
  for each row execute function app.visit_children_guard();
create trigger visit_screening_answers_guard before insert or update or delete on public.visit_screening_answers
  for each row execute function app.visit_children_guard();
create trigger visit_screening_outcomes_guard before insert or update or delete on public.visit_screening_outcomes
  for each row execute function app.visit_children_guard();
create trigger visit_region_findings_guard before insert or update or delete on public.visit_region_findings
  for each row execute function app.visit_children_guard();
create trigger visit_test_results_guard before insert or update or delete on public.visit_test_results
  for each row execute function app.visit_children_guard();
create trigger visit_treatments_guard before insert or update or delete on public.visit_treatments
  for each row execute function app.visit_children_guard();
create trigger visit_advice_guard before insert or update or delete on public.visit_advice
  for each row execute function app.visit_children_guard();

-- referrals (C). Policy S, I, U. Il rinvio al medico e la sua lettera. ------------------------------
-- Il consenso a condividere: GOsC A4.21.

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  cycle_id uuid not null,
  visit_id uuid,
  created_on date not null,
  recipient_kind text not null
    check (recipient_kind in ('medico_curante', 'medico_inviante', 'specialista', 'pronto_soccorso', 'altro')),
  physician_id uuid,
  -- Se il medico non è in rubrica.
  recipient_free text,
  reason text not null check (
    reason in ('red_flag', 'sintomi_persistenti', 'peggioramento', 'fuori_competenza', 'richiesta_paziente', 'altro')
  ),
  urgency text not null check (urgency in ('emergenza', 'urgente', 'programmato')),
  -- Generato e poi modificabile.
  summary_text text not null check (char_length(summary_text) <= 3000),
  request_text text not null check (char_length(request_text) <= 1000),
  patient_agreed_to_share boolean not null default false,
  status text not null default 'bozza' check (status in ('bozza', 'stampata', 'consegnata_al_paziente', 'inviata')),
  delivered_on date,
  physician_reply_note text check (char_length(physician_reply_note) <= 1000),
  -- Il PDF della lettera (referral_pdf), congelato: cambia solo da null a un file (trigger referrals_letter_guard).
  letter_file_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check (status = 'bozza' or patient_agreed_to_share),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict,
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict,
  foreign key (practice_id, physician_id) references public.physicians (practice_id, id) on delete restrict,
  foreign key (practice_id, letter_file_id) references public.files (practice_id, id) on delete restrict
);
alter table public.referrals enable row level security;
grant select, insert, update, delete on public.referrals to authenticated, service_role;
create policy referrals_select on public.referrals
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy referrals_insert on public.referrals
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy referrals_update on public.referrals
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger referrals_set_updated_at before update on public.referrals
  for each row execute function app.set_updated_at();
create trigger referrals_set_created_by before insert on public.referrals
  for each row execute function app.set_created_by();

-- La lettera salvata non torna a null e non passa a un altro file; gli altri campi del rinvio restano
-- modificabili. Esce subito sotto purga dello studio, se il rinvio resta nello studio della purga.
create or replace function app.referrals_letter_guard() returns trigger
language plpgsql
as $$
begin
  if app.purging(old.practice_id) and app.purging(new.practice_id) then
    return new;
  end if;
  if old.letter_file_id is not null and new.letter_file_id is distinct from old.letter_file_id then
    raise exception 'La lettera di un rinvio non cambia dopo il salvataggio' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.referrals_letter_guard() from public;
grant execute on function app.referrals_letter_guard() to authenticated, service_role;
create trigger referrals_letter_guard before update on public.referrals
  for each row execute function app.referrals_letter_guard();

-- patient_attachments (C). Policy S, I, U: nessuna D, si archivia con deleted_at. ------------------
-- Foto posturali, referti e lettere ricevute; i consensi stanno in consent_records.

create table public.patient_attachments (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  visit_id uuid,
  cycle_id uuid,
  -- Un file sta in un solo allegato.
  file_id uuid not null,
  kind text not null check (kind in ('foto_posturale', 'referto', 'lettera', 'altro')),
  view text check (view in ('anteriore', 'posteriore', 'laterale_dx', 'laterale_sx', 'altro')),
  taken_on date not null,
  width_px integer,
  height_px integer,
  caption text check (char_length(caption) <= 200),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, file_id),
  check (kind <> 'foto_posturale' or view is not null),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict,
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict,
  foreign key (practice_id, file_id) references public.files (practice_id, id) on delete restrict
);
alter table public.patient_attachments enable row level security;
grant select, insert, update, delete on public.patient_attachments to authenticated, service_role;
create policy patient_attachments_select on public.patient_attachments
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy patient_attachments_insert on public.patient_attachments
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy patient_attachments_update on public.patient_attachments
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger patient_attachments_set_updated_at before update on public.patient_attachments
  for each row execute function app.set_updated_at();
create trigger patient_attachments_set_created_by before insert on public.patient_attachments
  for each row execute function app.set_created_by();
