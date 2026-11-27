-- Il PDF della fattura mostra data e metodo dell'incasso,
-- quindi registrare o annullare un incasso deve poter azzerare pdf_file_id perché la richiesta
-- dopo generi di nuovo il PDF. La riga `files` vecchia resta.
-- Il trigger precedente lascia cambiare pdf_file_id solo da null. Ora lo lascia tornare a null, e
-- soltanto su una TD01 emessa o pagata che resta emessa o pagata, nello stesso update che cambia lo stato o
-- paid_on o payment_method. Una fattura annullata tiene la regola di prima (pdf_file_id solo da null).
-- Si sostituisce solo la funzione: trigger e privilegi restano quelli della migrazione 8.

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

  if (old.doc_type = 'TD04' and old.status = 'emessa' and new.status <> 'emessa')
     or (new.doc_type = 'TD04' and new.status not in ('bozza', 'emessa')) then
    raise exception 'Una nota di credito resta emessa' using errcode = '42501';
  end if;

  if new.doc_type = 'TD04' and new.doc_type is distinct from old.doc_type
     and exists (select 1 from public.invoice_lines l
                  where l.practice_id = new.practice_id and l.invoice_id = new.id and l.link_active) then
    raise exception 'Una riga di una nota di credito non tiene l''appuntamento' using errcode = '23514';
  end if;

  if old.credit_note_id is not null and new.credit_note_id is distinct from old.credit_note_id then
    raise exception 'La nota di credito collegata non cambia' using errcode = '42501';
  end if;
  if new.status = 'annullata' and new.credit_note_id is null then
    raise exception 'Una fattura annullata vuole la sua nota di credito' using errcode = '42501';
  end if;
  if new.credit_note_id is not null then
    if not exists (select 1 from public.invoices i
                    where i.practice_id = new.practice_id and i.id = new.credit_note_id
                      and i.doc_type = 'TD04' and i.status = 'emessa' and i.credited_invoice_id = new.id) then
      raise exception 'La nota di credito collegata deve stornare questa fattura' using errcode = '23514';
    end if;
    -- Il legame si scrive insieme al passaggio ad annullata, mai in anticipo.
    if new.status <> 'annullata' then
      raise exception 'La nota di credito collegata non cambia' using errcode = '42501';
    end if;
  end if;

  if old.status = 'annullata' then
    if (to_jsonb(new) - array['pdf_file_id', 'internal_notes', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['pdf_file_id', 'internal_notes', 'updated_at'])
       or (old.pdf_file_id is not null and new.pdf_file_id is distinct from old.pdf_file_id) then
      raise exception 'Una fattura annullata non cambia più' using errcode = '42501';
    end if;
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
      -- Solo il ritorno a null insieme a un cambio d'incasso: il PDF si rifà con il pagamento nuovo.
      if not (new.pdf_file_id is null
              and old.doc_type = 'TD01' and new.doc_type = 'TD01'
              and old.status in ('emessa', 'pagata') and new.status in ('emessa', 'pagata')
              and (new.status is distinct from old.status
                   or new.paid_on is distinct from old.paid_on
                   or new.payment_method is distinct from old.payment_method)) then
        raise exception 'Il PDF di una fattura emessa non cambia dopo il salvataggio' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;
