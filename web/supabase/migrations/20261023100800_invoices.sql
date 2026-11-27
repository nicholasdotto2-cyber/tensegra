-- Fatture: i committenti che non sono pazienti, le fatture con le loro righe, la
-- cronologia di ogni fattura e il registro degli export. Il numero arriva solo all'emissione, da
-- app.next_number, una serie per tipo e per anno; i totali si controllano qui. Dopo l'emissione cambiano solo
-- incasso, annullamento, PDF e note interne (trigger invoices_immutable), e le righe restano quelle della
-- fattura, salvo il legame con l'appuntamento (trigger invoice_lines_guard). Un appuntamento si fattura una
-- volta, finché la sua fattura non viene annullata. Calcolo, controlli SdI, Latin-1 e l'issued_at che non
-- torna indietro restano all'app.

-- Il trigger scrive anche invoice_events.user_id. Le altre tabelle non hanno la
-- colonna, e plpgsql risolve new.user_id solo quando esegue il ramo.
create or replace function app.set_created_by() returns trigger
language plpgsql
as $$
begin
  new.created_by := auth.uid();
  if tg_table_name = 'invoice_events' then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

-- billing_parties (C). Policy S, I, U: un committente si archivia con archived_at. ---------------------
-- Per esempio una società sportiva che paga le sedute dei suoi atleti.

create table public.billing_parties (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- XML Denominazione; Latin-1 lo controlla l'app.
  name text not null check (char_length(name) <= 80),
  vat_number text check (vat_number ~ '^\d{11}$'),
  tax_code text,
  -- La sede, come il domicilio fiscale di fiscal_settings.
  address_line text not null check (char_length(address_line) <= 60),
  postal_code text not null check (postal_code ~ '^\d{5}$'),
  city text not null check (char_length(city) <= 60),
  province text not null check (province ~ '^[A-Z]{2}$'),
  country text not null default 'IT',
  recipient_code text not null default '0000000' check (recipient_code ~ '^[A-Z0-9]{7}$'),
  pec text,
  -- Sostituto d'imposta: la fattura applica la ritenuta.
  is_withholding_agent boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check (vat_number is not null or tax_code is not null)
);
alter table public.billing_parties enable row level security;
grant select, insert, update, delete on public.billing_parties to authenticated, service_role;
create policy billing_parties_select on public.billing_parties
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy billing_parties_insert on public.billing_parties
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy billing_parties_update on public.billing_parties
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger billing_parties_set_updated_at before update on public.billing_parties
  for each row execute function app.set_updated_at();
create trigger billing_parties_set_created_by before insert on public.billing_parties
  for each row execute function app.set_created_by();

-- invoices (C). Policy S, I, U, D; la delete solo per una bozza. ---------------------------------------
-- TD01 è la fattura, TD04 la nota di credito che annulla una fattura emessa.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  doc_type text not null default 'TD01' check (doc_type in ('TD01', 'TD04')),
  status text not null default 'bozza' check (status in ('bozza', 'emessa', 'pagata', 'annullata')),
  -- L'anno del numero è l'anno della data del documento.
  year integer check (year is null or year = extract(year from issue_date)::int),
  -- Da app.next_number all'emissione: le bozze cancellate non lasciano buchi.
  number integer check (number > 0),
  -- 14/2026 per TD01, NC-1/2026 per TD04: al massimo 20 caratteri e almeno una cifra (errore SdI 00425).
  number_label text,
  -- La data del documento: quella dell'incasso se lo precede, altrimenti quella dell'emissione.
  issue_date date,
  -- Ricopiato a ogni ricalcolo della bozza, congelato all'emissione.
  regime text not null check (regime in ('ordinario', 'forfettario', 'esente_sanitario')),
  -- tutore = "Genitore o tutore".
  recipient_kind text not null check (recipient_kind in ('paziente', 'tutore', 'committente')),
  patient_id uuid,
  guardian_id uuid,
  billing_party_id uuid,
  -- Copiato dal committente, falso per paziente e tutore.
  withholding_agent boolean not null default false,
  -- Esiti del calcolo.
  surcharge_applied boolean not null default false,
  withholding_applied boolean not null default false,
  stamp_due boolean not null default false,
  stamp_charged boolean not null default false,
  fees_cents integer not null default 0 check (fees_cents >= 0),
  surcharge_cents integer not null default 0 check (surcharge_cents >= 0),
  taxable_cents integer not null default 0 check (taxable_cents >= 0),
  vat_cents integer not null default 0 check (vat_cents >= 0),
  stamp_charged_cents integer not null default 0 check (stamp_charged_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  withholding_cents integer not null default 0 check (withholding_cents >= 0),
  net_cents integer not null default 0 check (net_cents >= 0),
  payment_method text not null check (payment_method in ('contanti', 'carta', 'bonifico')),
  -- Per il bonifico.
  due_date date,
  -- Libero anche in bozza: l'incasso può precedere l'emissione.
  paid_on date,
  -- La fattura che la nota di credito annulla.
  credited_invoice_id uuid,
  -- La nota di credito, scritta quando la fattura è annullata.
  credit_note_id uuid,
  -- Il progressivo dell'invio.
  transmission_id text check (transmission_id ~ '^[A-Za-z0-9]{1,5}$'),
  -- IT<CF trasmittente>_<progressivo>.xml
  xml_file_name text,
  -- La fotografia di cedente, destinatario e testi: PDF e XML leggono solo lei e le righe.
  snapshot jsonb,
  -- Null anche quando l'XML non si genera (esente verso persona fisica).
  xml text,
  xml_sha256 text check (xml_sha256 ~ '^[0-9a-f]{64}$'),
  -- Il PDF (invoice_pdf), generato alla prima richiesta: cambia solo da null a un file.
  pdf_file_id uuid,
  -- Il contrassegno del bollo sull'originale cartaceo, solo in esente verso persona fisica.
  stamp_mark_code text check (char_length(stamp_mark_code) <= 30),
  -- Mai stampate, mai nell'XML, mai nell'export.
  internal_notes text,
  -- Scritti dal comando con il suo Clock: issued_at è l'istante dell'emissione.
  issued_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  -- Stesso numero ammesso fra TD01 e TD04 (controllo SdI 00404).
  unique (practice_id, doc_type, year, number),
  check ((status = 'bozza') = (number is null)),
  -- Ciò che scrive l'emissione è null in bozza.
  check (status <> 'bozza' or (year is null and number_label is null and issue_date is null and transmission_id is null
                               and xml_file_name is null and snapshot is null and xml is null and xml_sha256 is null)),
  -- Fuori dalla bozza c'è ciò che l'emissione scrive sempre: numero, anno, Data, etichetta e fotografia.
  -- Senza l'anno la unique del numero non varrebbe (null è sempre diverso). XML, progressivo, nome del file e
  -- incasso restano liberi: l'XML manca nell'esente verso persona fisica.
  check (status = 'bozza' or (year is not null and number is not null and issue_date is not null
                               and number_label is not null and snapshot is not null)),
  check (number_label is null or (char_length(number_label) <= 20 and number_label ~ '[0-9]')),
  check (status <> 'pagata' or paid_on is not null),
  check (doc_type <> 'TD04' or credited_invoice_id is not null),
  check (total_cents = taxable_cents + vat_cents + stamp_charged_cents),
  check (net_cents = total_cents - withholding_cents),
  check (recipient_kind <> 'committente' or billing_party_id is not null),
  check (recipient_kind = 'committente' or patient_id is not null),
  check (recipient_kind <> 'tutore' or guardian_id is not null),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, guardian_id) references public.patient_guardians (practice_id, id) on delete restrict,
  foreign key (practice_id, billing_party_id) references public.billing_parties (practice_id, id) on delete restrict,
  foreign key (practice_id, credited_invoice_id) references public.invoices (practice_id, id) on delete restrict,
  foreign key (practice_id, credit_note_id) references public.invoices (practice_id, id) on delete restrict,
  foreign key (practice_id, pdf_file_id) references public.files (practice_id, id) on delete restrict
);
alter table public.invoices enable row level security;
grant select, insert, update, delete on public.invoices to authenticated, service_role;
create policy invoices_select on public.invoices
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy invoices_insert on public.invoices
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy invoices_update on public.invoices
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy invoices_delete on public.invoices
  for delete to authenticated
  using (practice_id in (select app.my_practice_ids()) and status = 'bozza');
create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function app.set_updated_at();
create trigger invoices_set_created_by before insert on public.invoices
  for each row execute function app.set_created_by();

-- Una bozza si modifica e si cancella; una fattura emessa no. Transizioni: bozza → emessa o
-- pagata; emessa → pagata o annullata; pagata → emessa (incasso annullato) o annullata; da annullata nessun
-- ritorno. Fuori dalla bozza cambiano solo incasso, annullamento, note interne e il PDF, quest'ultimo solo da
-- null a un file. Esce subito sotto purga dello studio: è l'unico modo di cancellare una fattura
-- emessa, e vale solo per "Ricrea i dati di prova". Un update esce solo se la fattura resta nello studio della purga.
create or replace function app.invoices_immutable() returns trigger
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
    if old.status <> 'bozza' then
      raise exception 'Una fattura emessa non si cancella: si annulla con una nota di credito' using errcode = '42501';
    end if;
    return old;
  end if;

  if not (new.status = any (case old.status
                              when 'bozza' then array['bozza', 'emessa', 'pagata']
                              when 'emessa' then array['emessa', 'pagata', 'annullata']
                              when 'pagata' then array['pagata', 'emessa', 'annullata']
                              else array['annullata']
                            end)) then
    raise exception 'Questo cambio di stato della fattura non è ammesso' using errcode = '42501';
  end if;

  if old.status <> 'bozza' then
    if (to_jsonb(new) - array['status', 'paid_on', 'payment_method', 'paid_at', 'credit_note_id', 'cancelled_at',
                              'pdf_file_id', 'internal_notes', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'paid_on', 'payment_method', 'paid_at', 'credit_note_id', 'cancelled_at',
                              'pdf_file_id', 'internal_notes', 'updated_at']) then
      raise exception 'Una fattura emessa non si modifica: cambiano solo incasso, annullamento, PDF e note interne'
        using errcode = '42501';
    end if;
    if old.pdf_file_id is not null and new.pdf_file_id is distinct from old.pdf_file_id then
      raise exception 'Il PDF di una fattura emessa non cambia dopo il salvataggio' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.invoices_immutable() from public;
grant execute on function app.invoices_immutable() to authenticated, service_role;
create trigger invoices_immutable before update or delete on public.invoices
  for each row execute function app.invoices_immutable();

-- invoice_lines (C). Policy S, I, U, D, solo per le righe di una bozza (trigger). ------------------------

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- Le righe spariscono con la loro fattura: si cancellano solo le bozze.
  invoice_id uuid not null,
  line_number integer not null check (line_number between 1 and 9999),
  -- La riga del bollo la crea solo il calcolo, con la natura della prestazione.
  line_kind text not null check (line_kind in ('prestazione', 'rimborso_bollo')),
  service_id uuid,
  appointment_id uuid,
  -- Falso quando la fattura è annullata: l'appuntamento torna fatturabile.
  link_active boolean not null default true,
  -- Latin-1 e niente dati clinici: regole dell'app.
  description text not null check (char_length(trim(description)) between 1 and 1000),
  -- Stampata sul PDF.
  service_date date,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  -- Errore SdI 00423.
  line_total_cents integer not null,
  vat_rate_bp integer not null check (vat_rate_bp between 0 and 10000),
  nature text check (nature in ('N2.2', 'N4')),
  subject_to_withholding boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  unique (practice_id, invoice_id, line_number),
  check (line_total_cents = quantity * unit_price_cents),
  -- Errori SdI 00400 e 00401: la natura c'è se e solo se l'aliquota è zero.
  check ((vat_rate_bp = 0) = (nature is not null)),
  foreign key (practice_id, invoice_id) references public.invoices (practice_id, id) on delete cascade,
  foreign key (practice_id, service_id) references public.services (practice_id, id) on delete restrict,
  foreign key (practice_id, appointment_id) references public.appointments (practice_id, id) on delete restrict
);
-- Un appuntamento si fattura una volta, e torna fatturabile dopo un annullamento.
create unique index invoice_lines_appointment_once_idx on public.invoice_lines (practice_id, appointment_id)
  where appointment_id is not null and link_active;
alter table public.invoice_lines enable row level security;
grant select, insert, update, delete on public.invoice_lines to authenticated, service_role;
create policy invoice_lines_select on public.invoice_lines
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy invoice_lines_insert on public.invoice_lines
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy invoice_lines_update on public.invoice_lines
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create policy invoice_lines_delete on public.invoice_lines
  for delete to authenticated using (practice_id in (select app.my_practice_ids()));
create trigger invoice_lines_set_updated_at before update on public.invoice_lines
  for each row execute function app.set_updated_at();
create trigger invoice_lines_set_created_by before insert on public.invoice_lines
  for each row execute function app.set_created_by();

-- Le righe di una fattura fuori dalla bozza sono congelate: né insert (la TD04 riceve le righe
-- da bozza), né delete, né update, salvo link_active, e nessun trasferimento da o verso una fattura emessa. La
-- fattura si cerca con la chiave composta; se non c'è (studio sbagliato, o già cancellata dalla delete in
-- cascata) si lascia passare, e risponde la chiave esterna. Gira come chi scrive, quindi sotto RLS: vede le
-- fatture del suo studio. Esce subito sotto purga dello studio; un update solo se la riga resta
-- nello studio della purga, così non entra in una fattura emessa di un altro studio.
create or replace function app.invoice_lines_guard() returns trigger
language plpgsql
as $$
declare
  v_issued boolean := false;
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
    v_issued := exists (select 1
                          from public.invoices i
                         where i.practice_id = old.practice_id and i.id = old.invoice_id and i.status <> 'bozza');
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not v_issued then
    v_issued := exists (select 1
                          from public.invoices i
                         where i.practice_id = new.practice_id and i.id = new.invoice_id and i.status <> 'bozza');
  end if;

  if v_issued then
    if tg_op <> 'UPDATE' then
      raise exception 'Le righe di una fattura emessa non si aggiungono e non si cancellano' using errcode = '42501';
    end if;
    if (to_jsonb(new) - array['link_active', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['link_active', 'updated_at']) then
      raise exception 'Le righe di una fattura emessa non si modificano: cambia solo il legame con l''appuntamento'
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.invoice_lines_guard() from public;
grant execute on function app.invoice_lines_guard() to authenticated, service_role;
create trigger invoice_lines_guard before insert or update or delete on public.invoice_lines
  for each row execute function app.invoice_lines_guard();

-- invoice_events (C senza updated_at). Policy S, I: la cronologia nel dettaglio della fattura. -----------

create table public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  -- Gli eventi spariscono con la loro fattura, come le righe: una bozza ha già la sua cronologia (creata,
  -- modificata) e resta cancellabile, e uA non ha la policy D sugli eventi. Una fattura emessa la
  -- ferma invoices_immutable prima della cascata, salvo purga dello studio.
  invoice_id uuid not null,
  event_type text not null check (
    event_type in ('creata', 'modificata', 'emessa', 'pagamento_registrato', 'pagamento_annullato', 'annullata',
                   'pdf_scaricato', 'xml_scaricato', 'export_ese')
  ),
  -- Dal Clock del comando.
  at timestamptz not null,
  -- Lo scrive app.set_created_by, come created_by: un valore passato non conta.
  user_id uuid,
  details jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, invoice_id) references public.invoices (practice_id, id) on delete cascade
);
alter table public.invoice_events enable row level security;
grant select, insert, update, delete on public.invoice_events to authenticated, service_role;
create policy invoice_events_select on public.invoice_events
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy invoice_events_insert on public.invoice_events
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create trigger invoice_events_set_created_by before insert on public.invoice_events
  for each row execute function app.set_created_by();

-- fiscal_exports (C senza updated_at). Policy S, I: il registro degli export, senza il file. ------------

create table public.fiscal_exports (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  period_from date not null,
  period_to date not null,
  documents_count integer not null,
  zip_sha256 text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id)
);
alter table public.fiscal_exports enable row level security;
grant select, insert, update, delete on public.fiscal_exports to authenticated, service_role;
create policy fiscal_exports_select on public.fiscal_exports
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy fiscal_exports_insert on public.fiscal_exports
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create trigger fiscal_exports_set_created_by before insert on public.fiscal_exports
  for each row execute function app.set_created_by();
