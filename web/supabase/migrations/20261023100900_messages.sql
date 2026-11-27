-- Messaggi: i dieci testi dei modelli, uno per chiave e variante, e il registro di ciò che
-- il programma ha copiato o aperto su WhatsApp. Il programma non invia niente: l'osteopata invia a mano,
-- e poi dichiara l'esito. Il testo registrato resta quello copiato o messo nel link, quindi del registro
-- si aggiorna solo l'esito, e lo dicono i privilegi di colonna, non un trigger. I segnaposto ammessi per
-- ogni modello e il consenso al canale restano all'app.

-- message_templates (C). Policy S, I, U: nessuna D, un modello si personalizza e non si cancella. -----
-- Il seed inserisce i 10 testi di fabbrica.

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  key text not null check (key in ('conferma', 'promemoria', 'spostamento', 'richiamo', 'consigli')),
  variant text not null check (variant in ('tu', 'lei')),
  -- Solo i segnaposto ammessi per quel modello (app).
  body text not null check (char_length(trim(body)) between 1 and 700),
  is_customized boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, key, variant)
);
alter table public.message_templates enable row level security;
grant select, insert, update, delete on public.message_templates to authenticated, service_role;
create policy message_templates_select on public.message_templates
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy message_templates_insert on public.message_templates
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy message_templates_update on public.message_templates
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger message_templates_set_updated_at before update on public.message_templates
  for each row execute function app.set_updated_at();
create trigger message_templates_set_created_by before insert on public.message_templates
  for each row execute function app.set_created_by();

-- message_log (C). Policy S, I, U; nessuna D. Una riga per ogni copia o apertura di WhatsApp, anche ---
-- per i consigli di una visita (visit_id). L'esito lo dichiara l'osteopata dopo l'invio a mano.

create table public.message_log (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  -- Conferma, promemoria, spostamento.
  appointment_id uuid,
  -- Consigli.
  visit_id uuid,
  -- Le chiavi di message_templates.key.
  template_key text not null check (template_key in ('conferma', 'promemoria', 'spostamento', 'richiamo', 'consigli')),
  recipient_kind text not null check (recipient_kind in ('paziente', 'genitore', 'tutore')),
  -- Copia al momento: il nome non cambia se l'anagrafica cambia dopo.
  recipient_name text not null,
  -- Null se il link è stato aperto senza numero.
  recipient_phone text,
  -- Il testo esatto copiato o messo nel link.
  body text not null,
  -- Cosa ha fatto il programma.
  action text not null check (action in ('copiato', 'whatsapp_aperto')),
  -- Cosa dichiara l'osteopata.
  outcome text not null default 'da_confermare' check (outcome in ('da_confermare', 'inviato', 'non_inviato')),
  -- Lo scrive il comando che registra l'esito, con il suo Clock.
  outcome_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, appointment_id) references public.appointments (practice_id, id) on delete restrict,
  foreign key (practice_id, visit_id) references public.visits (practice_id, id) on delete restrict
);
alter table public.message_log enable row level security;
-- La RLS filtra righe, non colonne; l'esito è l'unica cosa che si aggiorna.
grant select, insert, delete on public.message_log to authenticated;
grant update (outcome, outcome_at, updated_at) on public.message_log to authenticated;
grant select, insert, update, delete on public.message_log to service_role;
create policy message_log_select on public.message_log
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy message_log_insert on public.message_log
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy message_log_update on public.message_log
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger message_log_set_updated_at before update on public.message_log
  for each row execute function app.set_updated_at();
create trigger message_log_set_created_by before insert on public.message_log
  for each row execute function app.set_created_by();
