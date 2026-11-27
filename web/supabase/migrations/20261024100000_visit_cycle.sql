-- Il ciclo della visita è quello del suo appuntamento.
-- Si riscrive la funzione di `visits_rules` con le tre regole di prima e una nuova: la visita sta nel
-- ciclo del suo appuntamento. Il trigger resta quello della migrazione 6 e chiama la funzione nuova.
-- Come le altre regole, se il ciclo non è dello studio non risponde la regola: si lascia passare, e
-- risponde la chiave esterna (23503). Con il trigger dell'appuntamento, che già ferma il cambio di
-- ciclo di un appuntamento con visita, ciclo e appuntamento restano uniti.
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
  if exists (select 1
               from public.appointments a
              where a.practice_id = new.practice_id and a.id = new.appointment_id and a.cycle_id <> new.cycle_id)
     and exists (select 1
                   from public.treatment_cycles c
                  where c.practice_id = new.practice_id and c.id = new.cycle_id) then
    raise exception 'La visita sta nel ciclo del suo appuntamento' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.visits_rules() from public;
grant execute on function app.visits_rules() to authenticated, service_role;
