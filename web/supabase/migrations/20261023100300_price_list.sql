-- Listino: le prestazioni che lo studio offre. Una voce archiviata esce dall'agenda ma
-- resta negli appuntamenti che l'hanno usata. Si cancella solo una voce mai usata: le chiavi
-- esterne delle tabelle che la puntano sono restrict. Il Latin-1 del testo di fattura e l'assenza
-- di dati clinici restano all'app, perché quel testo finisce nell'XML.

-- services (C). Policy S, I, U, D. -------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- Guida i default dell'agenda: durata e colore proposti per tipo.
  kind text not null check (kind in ('prima_visita', 'seduta', 'controllo', 'altro')),
  -- "Prima visita osteopatica". Il nome è unico fra le voci attive (indice sotto).
  name text not null check (char_length(trim(name)) between 1 and 60),
  -- Il testo della riga in fattura.
  invoice_description text not null check (char_length(trim(invoice_description)) between 1 and 200),
  duration_min smallint not null check (duration_min in (15, 30, 45, 60, 75, 90, 105, 120)),
  -- Il prezzo finale al paziente, IVA compresa in ordinario; l'IVA la scorpora il calcolo della
  -- fattura. Importo in centesimi: al massimo 9.999,99 euro.
  price_cents integer not null check (price_cents between 0 and 999999),
  color text not null check (color in ('petrolio', 'salvia', 'oceano', 'ocra', 'corallo', 'ardesia')),
  sort_order smallint not null default 0,
  -- null = attiva.
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id)
);
-- Il nome vale senza maiuscole ("Seduta" e "seduta" sono la stessa voce) e solo fra le attive:
-- archiviare libera il nome, e riattivare una voce il cui nome è già preso dà 23505.
create unique index services_active_name_key on public.services (practice_id, lower(name)) where archived_at is null;
alter table public.services enable row level security;
grant select, insert, update, delete on public.services to authenticated, service_role;
create policy services_select on public.services
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy services_insert on public.services
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy services_update on public.services
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy services_delete on public.services
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger services_set_updated_at before update on public.services
  for each row execute function app.set_updated_at();
create trigger services_set_created_by before insert on public.services
  for each row execute function app.set_created_by();
