-- Consensi: i moduli firmati o caricati (informativa, consenso al trattamento, consenso per
-- un minore) e le scelte facoltative dell'informativa sui canali (WhatsApp, richiami). Un consenso è
-- firmato fin dall'insert: dopo cambiano solo lo stato (da valido a revocato o sostituito), la revoca (da
-- null a un valore) e il PDF, da null a un file, e non si cancella (trigger consent_records_immutable);
-- testo, hash, firma e data restano quelli firmati (L. 219/2017, GDPR art. 7 par. 1). Una scelta sul
-- canale non si modifica: la revoca è una riga nuova. La data di firma o di scelta non futura resta
-- all'app.

-- consent_records (C). Policy S, I, U: nessuna D, un consenso si revoca o si sostituisce, mai si ----
-- cancella. I testi dei moduli sono costanti nel codice con chiave e versione; ogni firma o
-- caricamento crea una riga.

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  -- Il trattamento si firma per ciclo, l'informativa per paziente.
  cycle_id uuid,
  module_key text not null check (module_key in ('trattamento', 'informativa', 'trattamento_minore')),
  -- "2026.1".
  module_version text not null,
  -- Il testo con i segnaposto compilati, congelato alla firma.
  rendered_text text not null,
  -- Lo sha256 di rendered_text in esadecimale minuscolo.
  rendered_hash text not null,
  -- I segnaposto vuoti alla firma ("Firmato con dati mancanti").
  missing_fields text[] not null default '{}',
  signer_kind text not null check (signer_kind in ('paziente', 'genitore', 'tutore')),
  signer_name text not null,
  -- Chi firma per il minore.
  guardian_id uuid,
  second_guardian_name text,
  method text not null check (method in ('tela', 'pdf_caricato')),
  -- Il PNG della firma.
  signature_file_id uuid,
  -- Il PDF generato dopo la firma (può mancare se la generazione fallisce) o il file caricato.
  -- Cambia solo da null a un file (trigger consent_records_immutable).
  document_file_id uuid,
  -- Per i caricati la inserisce l'osteopata.
  signed_on date not null,
  -- Anche il rifiuto si registra (L. 219/2017 art. 1 c. 5).
  outcome text not null default 'accetta' check (outcome in ('accetta', 'rifiuta')),
  refuses_information boolean not null default false,
  refusal_note text,
  -- Il fiduciario indicato dal paziente.
  trustee_name text,
  trustee_contact text,
  -- Solo per trattamento_minore (app).
  minor_opinion_note text,
  status text not null default 'valido' check (status in ('valido', 'revocato', 'sostituito')),
  revoked_on date,
  revocation_mode text check (revocation_mode in ('verbale', 'scritta', 'messaggio')),
  revocation_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  check ((module_key = 'informativa') = (cycle_id is null)),
  check (rendered_hash = encode(sha256(convert_to(rendered_text, 'UTF8')), 'hex')),
  check (method <> 'tela' or signature_file_id is not null),
  check (method <> 'pdf_caricato' or document_file_id is not null),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, cycle_id) references public.treatment_cycles (practice_id, id) on delete restrict,
  foreign key (practice_id, guardian_id) references public.patient_guardians (practice_id, id) on delete restrict,
  foreign key (practice_id, signature_file_id) references public.files (practice_id, id) on delete restrict,
  foreign key (practice_id, document_file_id) references public.files (practice_id, id) on delete restrict
);
alter table public.consent_records enable row level security;
grant select, insert, update, delete on public.consent_records to authenticated, service_role;
create policy consent_records_select on public.consent_records
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy consent_records_insert on public.consent_records
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create policy consent_records_update on public.consent_records
  for update to authenticated
  using (practice_id in (select app.my_practice_ids()))
  with check (practice_id in (select app.my_practice_ids()));
create trigger consent_records_set_updated_at before update on public.consent_records
  for each row execute function app.set_updated_at();
create trigger consent_records_set_created_by before insert on public.consent_records
  for each row execute function app.set_created_by();

-- Dopo l'insert cambiano solo status, revoked_on, revocation_mode, revocation_note, updated_at e
-- document_file_id, e quest'ultimo solo da null a un file: testo congelato, hash, firma, data e ogni
-- altro campo della firma non si riscrivono. La revoca registrata resta (L. 219/2017, "Niente
-- si cancella"): lo stato passa solo da valido a revocato o sostituito, revoked_on e revocation_mode solo
-- da null a un valore; una revoca sbagliata si corregge con un consenso nuovo. Un consenso firmato non si
-- cancella, nemmeno come servizio. Esce subito sotto purga dello studio; un update solo se il
-- consenso resta nello studio della purga.
create or replace function app.consent_records_immutable() returns trigger
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
    raise exception 'Un consenso firmato non si cancella: si revoca o si sostituisce' using errcode = '42501';
  end if;

  if (to_jsonb(new) - array['status', 'revoked_on', 'revocation_mode', 'revocation_note', 'updated_at',
                            'document_file_id'])
     is distinct from
     (to_jsonb(old) - array['status', 'revoked_on', 'revocation_mode', 'revocation_note', 'updated_at',
                            'document_file_id']) then
    raise exception 'Un consenso firmato non si modifica: cambiano solo lo stato e la revoca' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'valido' and new.status in ('revocato', 'sostituito')) then
    raise exception 'Un consenso revocato o sostituito non torna valido e non cambia stato' using errcode = '42501';
  end if;
  if (old.revoked_on is not null and new.revoked_on is distinct from old.revoked_on)
     or (old.revocation_mode is not null and new.revocation_mode is distinct from old.revocation_mode) then
    raise exception 'La revoca registrata non cambia' using errcode = '42501';
  end if;
  if old.document_file_id is not null and new.document_file_id is distinct from old.document_file_id then
    raise exception 'Il documento di un consenso non cambia dopo il salvataggio' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.consent_records_immutable() from public;
grant execute on function app.consent_records_immutable() to authenticated, service_role;
create trigger consent_records_immutable before update or delete on public.consent_records
  for each row execute function app.consent_records_immutable();

-- consent_choices (C senza updated_at). Policy S, I: le scelte facoltative dell'informativa ---------
-- (WhatsApp e richiami) si aggiungono e non si modificano, così una revoca non cancella la data del
-- consenso di prima (GDPR art. 7 par. 1). Vale l'ultima riga per paziente e scelta, e solo se c'è
-- un'informativa valida (app, getChannelConsent).

create table public.consent_choices (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid not null references public.practices (id) on delete restrict,
  patient_id uuid not null,
  -- L'informativa in cui la scelta è stata espressa; null per una revoca a voce o via messaggio.
  consent_record_id uuid,
  choice text not null check (choice in ('whatsapp', 'richiami')),
  -- true = consenso, false = no o revoca.
  value boolean not null,
  decided_on date not null,
  -- 'modulo' = dentro l'informativa firmata o caricata.
  mode text not null check (mode in ('modulo', 'verbale', 'scritta', 'messaggio')),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  unique (practice_id, id),
  foreign key (practice_id, patient_id) references public.patients (practice_id, id) on delete restrict,
  foreign key (practice_id, consent_record_id) references public.consent_records (practice_id, id) on delete restrict
);
-- L'ultima scelta per paziente e canale.
create index consent_choices_latest_idx on public.consent_choices
  (practice_id, patient_id, choice, decided_on desc, created_at desc);
alter table public.consent_choices enable row level security;
grant select, insert, update, delete on public.consent_choices to authenticated, service_role;
create policy consent_choices_select on public.consent_choices
  for select to authenticated using (practice_id in (select app.my_practice_ids()));
create policy consent_choices_insert on public.consent_choices
  for insert to authenticated with check (practice_id in (select app.my_practice_ids()));
create trigger consent_choices_set_created_by before insert on public.consent_choices
  for each row execute function app.set_created_by();
