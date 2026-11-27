-- Agenda: le serie degli appuntamenti ricorrenti e gli appuntamenti. La fine la scrive un
-- trigger, perché una colonna generata non si può fare su PGlite 0.5.11; lo stesso trigger rifiuta
-- una fine nel giorno dopo a Roma, un ciclo di un altro paziente e, quando l'appuntamento ha la
-- visita, un paziente o un ciclo diversi da quelli della visita. Le sovrapposizioni sono ammesse:
-- nessun vincolo di esclusione. L'inizio a multipli di 15 minuti in ora locale e le
-- ricorrenze che ripetono l'ora di Roma restano all'app.

-- appointment_series (C). Policy S, I, U. La regola di "Ripeti ogni N settimane": gli ---------------
-- appuntamenti nati da una serie sono righe proprie e la puntano con series_id.

create table public.appointment_series (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  weekday smallint not null check (weekday between 1 and 7), -- 1 = lunedì (ISO)
  -- L'ora a muro di Roma che ogni appuntamento della serie ripete, non l'istante UTC.
  local_time time not null,
  -- Il default lo propone l'app da clinical_settings.default_session_interval_weeks.
  interval_weeks smallint not null check (interval_weeks between 1 and 4),
  -- Al massimo 12: un ciclo ha moda 4 e media 7 sedute.
  count smallint not null check (count between 2 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id)
);
alter table public.appointment_series enable row level security;
grant select, insert, update, delete on public.appointment_series to authenticated, service_role;
create policy appointment_series_select on public.appointment_series
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy appointment_series_insert on public.appointment_series
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy appointment_series_update on public.appointment_series
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger appointment_series_set_updated_at before update on public.appointment_series
  for each row execute function app.set_updated_at();
create trigger appointment_series_set_created_by before insert on public.appointment_series
  for each row execute function app.set_created_by();

-- appointments (C). Policy S, I, U, D; la delete solo per un appuntamento prenotato o confermato. ---
-- Gli altri stati li tengono anche le chiavi restrict di visite e righe di fattura (migrazioni dopo).

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  -- Resta anche se la voce di listino viene archiviata.
  service_id uuid not null,
  -- Ciclo dello stesso paziente (trigger appointments_rules).
  cycle_id uuid not null,
  series_id uuid,
  starts_at timestamptz not null,
  -- Il default lo propone l'app dalla voce di listino.
  duration_min smallint not null check (duration_min between 15 and 240 and duration_min % 15 = 0),
  -- starts_at + duration_min, scritto dal trigger appointments_rules: un valore passato non conta.
  ends_at timestamptz not null,
  status text not null default 'prenotato'
    check (status in ('prenotato', 'confermato', 'fatto', 'saltato', 'annullato')),
  -- Lo scrive il comando che cambia lo stato, con il suo Clock.
  status_changed_at timestamptz,
  cancel_reason text check (cancel_reason in ('paziente', 'studio', 'altro')),
  -- prezzo finale copiato dal listino, modificabile ("prezzo concordato"): come services.price_cents
  -- è IVA compresa in ordinario, e l'IVA la scorpora il calcolo della fattura.
  price_cents integer not null check (price_cents >= 0),
  -- Solo un suggerimento per la fattura, scelto nel pannello "Seduta fatta": l'incasso vero sta sulla fattura.
  payment_method text check (payment_method in ('contanti', 'carta', 'bonifico')),
  -- Toglie l'appuntamento da "Fatture da emettere".
  no_invoice_reason text check (no_invoice_reason in ('compresa_in_altra', 'gratuita', 'altro')),
  -- Note organizzative, mai cliniche.
  notes text check (char_length(notes) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check (status <> 'annullato' or cancel_reason is not null),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, service_id) references public.services (practice_id, id) on delete restrict,
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict,
  foreign key (practice_id, series_id) references public.appointment_series (practice_id, id) on delete restrict
);
create index appointments_practice_id_starts_at_idx on public.appointments (practice_id, starts_at);
alter table public.appointments enable row level security;
grant select, insert, update, delete on public.appointments to authenticated, service_role;
create policy appointments_select on public.appointments
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy appointments_insert on public.appointments
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy appointments_update on public.appointments
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy appointments_delete on public.appointments
  for delete to authenticated
  using (practice_id in (select app.my_practice_ids()) and status in ('prenotato', 'confermato'));
create trigger appointments_set_updated_at before update on public.appointments
  for each row execute function app.set_updated_at();
create trigger appointments_set_created_by before insert on public.appointments
  for each row execute function app.set_created_by();

-- La fine è starts_at + duration_min, e deve cadere nello stesso giorno di Roma dell'inizio: il
-- giorno si legge con at time zone 'Europe/Rome', così i giorni di 23 e 25 ore del cambio d'ora
-- valgono come gli altri. Il ciclo si cerca con la chiave composta: se non c'è (studio
-- sbagliato) si lascia passare, e risponde la chiave esterna. La visita (migrazione dopo: plpgsql
-- risolve i nomi quando esegue) si cerca con la chiave composta dell'appuntamento. Gira come chi
-- scrive, quindi sotto RLS: vede i cicli e le visite del suo studio.
create or replace function app.appointment_rules() returns trigger
language plpgsql
as $$
begin
  new.ends_at := new.starts_at + make_interval(mins => new.duration_min);
  if (new.starts_at at time zone 'Europe/Rome')::date <> (new.ends_at at time zone 'Europe/Rome')::date then
    raise exception 'L''appuntamento deve finire nello stesso giorno in cui comincia' using errcode = '23514';
  end if;
  if exists (select 1
               from public.treatment_cycles c
              where c.practice_id = new.practice_id and c.id = new.cycle_id and c.patient_id <> new.patient_id) then
    raise exception 'Il ciclo dell''appuntamento è di un altro paziente' using errcode = '23514';
  end if;
  -- Dal lato dell'appuntamento: con la visita, l'appuntamento non passa a un paziente o a un ciclo
  -- diversi da quelli della visita. Esce sotto purga dello studio.
  if tg_op = 'UPDATE' then
    if not (app.purging(old.practice_id) and app.purging(new.practice_id))
       and (new.patient_id, new.cycle_id) is distinct from (old.patient_id, old.cycle_id)
       and exists (select 1
                     from public.visits v
                    where v.practice_id = old.practice_id and v.appointment_id = old.id
                      and (v.patient_id <> new.patient_id or v.cycle_id <> new.cycle_id)) then
      raise exception 'L''appuntamento ha una visita: paziente e ciclo restano quelli della visita' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.appointment_rules() from public;
grant execute on function app.appointment_rules() to authenticated, service_role;
create trigger appointments_rules before insert or update on public.appointments
  for each row execute function app.appointment_rules();
