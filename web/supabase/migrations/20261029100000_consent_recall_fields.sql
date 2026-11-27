-- Firme congelate, rinvio del richiamo e ordine stabile degli eventi.
-- Le policy e i grant delle tabelle esistenti restano invariati, compresi gli UPDATE
-- limitati di message_log. Il trigger JSON dei consensi protegge anche le nuove firme.
alter table public.patients add column recall_snoozed_until date;

alter table public.consent_records
  add column signed_at timestamptz,
  add column second_signature_file_id uuid,
  add column practitioner_signature_file_id uuid,
  add column record_order bigint generated always as identity,
  add foreign key (practice_id, second_signature_file_id)
    references public.files (practice_id, id) on delete restrict,
  add foreign key (practice_id, practitioner_signature_file_id)
    references public.files (practice_id, id) on delete restrict,
  add check (second_signature_file_id is null or second_guardian_name is not null);

-- I pareggi storici ricevono l'ordine della migrazione, senza inventare firme o istanti.
-- Per le nuove righe l'identità cresce anche quando Clock e UUID non distinguono gli eventi.
alter table public.consent_choices add column record_order bigint generated always as identity;
alter table public.message_log add column record_order bigint generated always as identity;

drop index public.consent_choices_latest_idx;
create index consent_choices_latest_idx on public.consent_choices
  (practice_id, patient_id, choice, decided_on desc, created_at desc, record_order desc);
create index message_log_latest_idx on public.message_log
  (practice_id, patient_id, created_at desc, record_order desc);
