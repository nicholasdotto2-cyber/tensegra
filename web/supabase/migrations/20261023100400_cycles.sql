-- Cicli: il ciclo di trattamento di un paziente e le sue attività PSFS. Un paziente ha
-- al massimo un ciclo aperto; un ciclo chiuso non si riapre, il suo esito non cambia e le sue
-- attività PSFS non si scrivono più (trigger). Il paziente di un ciclo con appuntamenti o visite non
-- cambia, e l'apertura non va oltre la prima visita (trigger). Qui nasce anche app.purging(),
-- l'uscita di purga di ogni trigger di immutabilità. Le regole della chiusura della prima
-- visita (motivo, obiettivo, piano) restano all'app.

-- "Ricrea i dati di prova" apre i trigger di immutabilità di un solo studio, e mai
-- per authenticated. Non è security definer: current_user è chi scrive. Un update esce dal trigger
-- solo se la riga resta nello studio della purga (old e new): la purga di A non scrive dentro le
-- righe congelate di B.
create or replace function app.purging(p_practice_id uuid) returns boolean
language sql stable
as $$
  select coalesce(current_user <> 'authenticated'
                  and current_setting('app.purge_practice', true) = p_practice_id::text, false)
$$;
revoke all on function app.purging(uuid) from public;
grant execute on function app.purging(uuid) to authenticated, service_role;

-- treatment_cycles (C). Policy S, I, U, D: la delete passa solo per un ciclo aperto senza appuntamenti, --
-- visite, consensi e rinvii (chiavi restrict delle migrazioni dopo); le attività PSFS spariscono con lui.

create table public.treatment_cycles (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  kind text not null default 'trattamento' check (kind in ('trattamento', 'mantenimento')),
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_on date not null,
  -- Proposto da regione e mese ("Lombalgia, ottobre 2026"); dall'agenda "Nuovo ciclo, ottobre 2026".
  title text not null check (char_length(title) <= 80),
  -- Motivo del consulto con le parole del paziente; obbligatorio alla chiusura della prima visita (app).
  chief_complaint text check (char_length(chief_complaint) <= 500),
  main_region text check (main_region = any (app.region_codes())),
  onset_on date,
  onset_mode text check (onset_mode in ('acuto', 'graduale', 'post_traumatico', 'ricorrente')),
  -- Diagnosi medica di riferimento.
  medical_diagnosis_text text check (char_length(medical_diagnosis_text) <= 300),
  medical_diagnosis_source text not null default 'assente'
    check (medical_diagnosis_source in ('referto_allegato', 'riferita_dal_paziente', 'assente')),
  -- Medico inviante del ciclo; senza, accesso diretto.
  referring_physician_id uuid,
  self_referred boolean not null default true,
  -- Obiettivo concordato; obbligatorio alla chiusura della prima visita per i cicli di trattamento (app).
  goal text check (char_length(goal) <= 300),
  -- I "tempi previsti" del DPR; il default lo propone l'app da clinical_settings.
  expected_sessions smallint check (expected_sessions between 1 and 20),
  plan_note text check (char_length(plan_note) <= 1000),
  -- Casella "Piano spiegato e accettato dal paziente" nella chiusura della prima visita.
  plan_agreed_on date,
  closed_on date,
  outcome text check (
    outcome in ('raggiunto', 'parzialmente_raggiunto', 'non_raggiunto', 'interrotto_dal_paziente', 'rinviato_al_medico')
  ),
  outcome_note text check (char_length(outcome_note) <= 1000),
  -- Ricaduta dello stesso problema.
  previous_cycle_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check (kind = 'mantenimento' or expected_sessions is not null),
  check (closed_on is null or closed_on >= opened_on),
  check (status = 'open' or (closed_on is not null and outcome is not null)),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, referring_physician_id) references public.physicians (practice_id, id) on delete restrict,
  foreign key (practice_id, previous_cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict
);
-- Un solo ciclo aperto per paziente: per aprirne un altro si chiude prima quello in corso.
create unique index treatment_cycles_one_open_idx on public.treatment_cycles (practice_id, patient_id) where status = 'open';
alter table public.treatment_cycles enable row level security;
grant select, insert, update, delete on public.treatment_cycles to authenticated, service_role;
create policy treatment_cycles_select on public.treatment_cycles
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy treatment_cycles_insert on public.treatment_cycles
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy treatment_cycles_update on public.treatment_cycles
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy treatment_cycles_delete on public.treatment_cycles
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger treatment_cycles_set_updated_at before update on public.treatment_cycles
  for each row execute function app.set_updated_at();
create trigger treatment_cycles_set_created_by before insert on public.treatment_cycles
  for each row execute function app.set_created_by();

-- Un ciclo chiuso non si riapre (una ricaduta apre un ciclo nuovo con previous_cycle_id) e il suo
-- esito resta un dato fermo: stato, esito, nota dell'esito, data di chiusura, tipo, paziente e apertura non
-- cambiano più, e il ciclo non si cancella. Riaprirlo toglierebbe anche il blocco delle sue attività PSFS
-- (psfs_items_guard). Titolo, motivo, obiettivo e note restano modificabili. Esce subito sotto purga dello
-- studio.
create or replace function app.treatment_cycles_immutable() returns trigger
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

  if old.status = 'closed' then
    if tg_op = 'DELETE' then
      raise exception 'Un ciclo chiuso non si cancella' using errcode = '42501';
    end if;
    if (new.status, new.outcome, new.outcome_note, new.closed_on, new.kind, new.patient_id, new.opened_on)
       is distinct from
       (old.status, old.outcome, old.outcome_note, old.closed_on, old.kind, old.patient_id, old.opened_on) then
      raise exception 'Un ciclo chiuso non si riapre e il suo esito non cambia' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.treatment_cycles_immutable() from public;
grant execute on function app.treatment_cycles_immutable() to authenticated, service_role;
create trigger treatment_cycles_immutable before update or delete on public.treatment_cycles
  for each row execute function app.treatment_cycles_immutable();

-- Le regole della visita (lo stesso paziente del ciclo, mai prima dell'apertura del ciclo) valgono
-- anche dal lato del ciclo, aperto o chiuso: il paziente non cambia finché un appuntamento o una visita usano il
-- ciclo, e l'apertura non va oltre la sua prima visita. Appuntamenti e visite nascono nelle migrazioni dopo:
-- plpgsql risolve i nomi quando esegue. Si cercano con la chiave composta del ciclo; gira come chi scrive,
-- quindi sotto RLS. Esce subito sotto purga dello studio.
create or replace function app.treatment_cycles_rules() returns trigger
language plpgsql
as $$
begin
  if app.purging(old.practice_id) and app.purging(new.practice_id) then
    return new;
  end if;
  if new.patient_id is distinct from old.patient_id
     and (exists (select 1 from public.appointments a where a.practice_id = old.practice_id and a.cycle_id = old.id)
          or exists (select 1 from public.visits v where v.practice_id = old.practice_id and v.cycle_id = old.id)) then
    raise exception 'Il paziente di un ciclo con appuntamenti o visite non cambia' using errcode = '23514';
  end if;
  -- Solo quando l'apertura va avanti: indietro non supera nessuna visita.
  if new.opened_on > old.opened_on
     and new.opened_on > (select min(v.visit_date) from public.visits v
                           where v.practice_id = old.practice_id and v.cycle_id = old.id) then
    raise exception 'L''apertura del ciclo non può seguire la sua prima visita' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.treatment_cycles_rules() from public;
grant execute on function app.treatment_cycles_rules() to authenticated, service_role;
create trigger treatment_cycles_rules before update on public.treatment_cycles
  for each row execute function app.treatment_cycles_rules();

-- psfs_items (C). Policy S, I, U, D, solo a ciclo aperto (trigger). Da 0 a 3 attività per ciclo: ----
-- il PSFS non blocca la chiusura della prima visita.

create table public.psfs_items (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  cycle_id uuid not null,
  position smallint not null check (position between 1 and 3),
  activity text not null check (char_length(activity) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, cycle_id, position),
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete cascade
);
alter table public.psfs_items enable row level security;
grant select, insert, update, delete on public.psfs_items to authenticated, service_role;
create policy psfs_items_select on public.psfs_items
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy psfs_items_insert on public.psfs_items
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy psfs_items_update on public.psfs_items
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy psfs_items_delete on public.psfs_items
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger psfs_items_set_updated_at before update on public.psfs_items
  for each row execute function app.set_updated_at();
create trigger psfs_items_set_created_by before insert on public.psfs_items
  for each row execute function app.set_created_by();

-- Le attività di un ciclo chiuso sono congelate: né insert, né update, né delete, e nessun
-- trasferimento da o verso un ciclo chiuso. Il ciclo si cerca con la chiave composta; se non c'è
-- (studio sbagliato, o già cancellato dalla delete in cascata) si lascia passare, e risponde la
-- chiave esterna. Un'attività con punteggi (psfs_scores, migrazione clinica: plpgsql risolve i nomi
-- quando esegue) non si rinomina e non cambia posizione nemmeno a ciclo aperto: cambierebbe ciò che
-- una visita ha registrato, e un'attività diversa è un'attività nuova. Gira come chi
-- scrive, quindi sotto RLS: vede i cicli e i punteggi del suo studio.
create or replace function app.psfs_items_guard() returns trigger
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
    if exists (select 1
                 from public.treatment_cycles c
                where c.practice_id = old.practice_id and c.id = old.cycle_id and c.status = 'closed') then
      raise exception 'Le attività PSFS di un ciclo chiuso non si modificano' using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if exists (select 1
                 from public.treatment_cycles c
                where c.practice_id = new.practice_id and c.id = new.cycle_id and c.status = 'closed') then
      raise exception 'Le attività PSFS di un ciclo chiuso non si modificano' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.activity, new.position) is distinct from (old.activity, old.position)
       and exists (select 1 from public.psfs_scores s where s.practice_id = old.practice_id and s.item_id = old.id) then
      raise exception 'Un''attività PSFS con punteggi non si rinomina e non cambia posizione: se cambia, è un''attività nuova'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.psfs_items_guard() from public;
grant execute on function app.psfs_items_guard() to authenticated, service_role;
create trigger psfs_items_guard before insert or update or delete on public.psfs_items
  for each row execute function app.psfs_items_guard();
