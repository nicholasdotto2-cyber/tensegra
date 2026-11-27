-- Il flag viene congelato alla raccolta. Le righe precedenti restano null e seguono lo studio.
alter table public.consent_records add column demo boolean;

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

  -- Anche il flag della demo appartiene alla fotografia immutabile del consenso.
  if new.demo is distinct from old.demo
     or (to_jsonb(new) - array['demo', 'status', 'revoked_on', 'revocation_mode', 'revocation_note', 'updated_at',
                               'document_file_id'])
        is distinct from
        (to_jsonb(old) - array['demo', 'status', 'revoked_on', 'revocation_mode', 'revocation_note', 'updated_at',
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
