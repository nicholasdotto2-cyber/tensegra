import { firstLast, isMinor } from "@/lib/format";
import { escapeLike } from "@/lib/like";
import { type Clock, daysBetween, romeDayBounds, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { getChannelConsents } from "@/server/domain/consents/queries";
import { getOpenCycle, type OpenCycle } from "@/server/domain/cycles/queries";
import { prepareMessage, type PreparedMessage } from "@/server/domain/messages/queries";
import {
  type GuardianRelationship,
  recallDay,
  recallDueText,
  recallRevokedText,
  recallVisible,
  recallWait,
} from "./recall";

// Letture dei pazienti per l'agenda: il selettore del dialogo "Nuovo appuntamento" e i
// default del paziente scelto; per Oggi i richiami. Ogni lettura filtra lo studio anche oltre
// la RLS.

/** Un paziente come lo mostra il selettore. */
export interface PatientHit {
  id: string;
  firstName: string;
  lastName: string;
  /** "AAAA-MM-GG". */
  birthDate: string;
  /** E.164, "+393330000012": a schermo con `phoneDisplay`. */
  phone: string | null;
  archived: boolean;
}

/**
 * Il testo del nome come lo indicizza il trigram di `patients`, `nome cognome nome`: contiene sia "nome
 * cognome" sia "cognome nome". Va scritto identico perché il planner usi l'indice, quindi ogni ricerca
 * sui pazienti (il selettore dell'agenda e la lista) lo prende da qui, su `public.patients` senza alias.
 */
export const PATIENT_TEXT_MATCH = "app.search_text(first_name || ' ' || last_name || ' ' || first_name)";

/**
 * "Anagrafica da completare": manca il codice fiscale, o l'indirizzo, il CAP o
 * la città. Un'espressione booleana sulle colonne di `public.patients` con l'alias dato: il segnale di
 * Oggi e l'etichetta della scheda la leggono da qui, così dicono la stessa cosa.
 */
export function incompleteRecordSql(alias: string): string {
  return `(${alias}.tax_code is null
             or coalesce(btrim(${alias}.address_line), '') = ''
             or coalesce(btrim(${alias}.postal_code), '') = ''
             or coalesce(btrim(${alias}.city), '') = '')`;
}

const SEARCH_MIN_CHARS = 3;
const SEARCH_LIMIT = 8;

/**
 * Cerca per nome, cognome o telefono dalla terza lettera, senza maiuscole e accenti.
 * Il testo del nome è `PATIENT_TEXT_MATCH`. `%`, `_` e `\` del testo sono
 * protetti con `escapeLike` e con l'escape predefinito di LIKE: nessuna clausola `escape`. Il telefono
 * si cerca per cifre, e solo se il testo ne ha almeno tre. Gli archiviati escono dopo gli attivi.
 */
export function searchPatients(tx: Tx, practiceId: string, text: string, limit = SEARCH_LIMIT): Promise<PatientHit[]> {
  const needle = text.trim();
  if (needle.length < SEARCH_MIN_CHARS) return Promise.resolve([]);
  const digits = needle.replace(/\D/g, "");
  const byPhone = digits.length >= SEARCH_MIN_CHARS;
  const params: (string | number)[] = [practiceId, escapeLike(needle), limit];
  if (byPhone) params.push(digits);
  return tx.query<PatientHit>(
    `select id,
            first_name as "firstName",
            last_name as "lastName",
            birth_date as "birthDate",
            phone,
            archived_at is not null as archived
       from public.patients
      where practice_id = $1
        and (${PATIENT_TEXT_MATCH} like '%' || app.search_text($2) || '%'
             ${byPhone ? "or replace(phone, '+', '') like '%' || $4 || '%'" : ""})
      order by (archived_at is not null), lower(last_name), lower(first_name), id
      limit $3`,
    params,
  );
}

/** Il paziente scelto nel dialogo, con ciò che serve ai default della prestazione e del ciclo. */
export interface BookingPatient extends PatientHit {
  /** Almeno un appuntamento `fatto`: senza, la prestazione proposta è la prima visita. */
  hasDoneAppointment: boolean;
  openCycle: OpenCycle | null;
  hasClosedCycle: boolean;
}

export async function getPatientForBooking(
  tx: Tx,
  practiceId: string,
  patientId: string,
): Promise<BookingPatient | null> {
  const [row] = await tx.query<PatientHit & { hasDoneAppointment: boolean; hasClosedCycle: boolean }>(
    `select p.id,
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            p.phone,
            p.archived_at is not null as archived,
            exists (select 1
                      from public.appointments a
                     where a.practice_id = p.practice_id and a.patient_id = p.id and a.status = 'fatto')
              as "hasDoneAppointment",
            exists (select 1
                      from public.treatment_cycles c
                     where c.practice_id = p.practice_id and c.patient_id = p.id and c.status = 'closed')
              as "hasClosedCycle"
       from public.patients p
      where p.practice_id = $1 and p.id = $2`,
    [practiceId, patientId],
  );
  if (!row) return null;
  return { ...row, openCycle: await getOpenCycle(tx, practiceId, patientId) };
}

/** Una riga di "Da richiamare". */
export interface RecallRow {
  patientId: string;
  /** "Nome Cognome". */
  name: string;
  /** Il giorno del richiamo, "AAAA-MM-GG": calcolato, mai salvato; il rinvio non lo cambia. */
  dueDay: string;
  /** "Scaduto da 10 giorni", "Fra 3 giorni". */
  dueText: string;
  /** Il giorno di Roma dell'ultimo appuntamento fatto. */
  lastDoneDay: string;
  cadenceWeeks: number;
  /** Il richiamo preparato per «Apri WhatsApp» e «Copia»; null nel gruppo senza consenso. */
  contact: PreparedMessage | null;
  /** L'ultimo giorno di «In attesa di risposta», compreso; null fuori dall'attesa. */
  waitingUntil: string | null;
  /** Il giorno di Roma dell'ultimo richiamo dichiarato inviato dopo l'ultimo fatto; null senza. */
  lastSentOn: string | null;
  /** «In attesa di risposta» o «Richiamato il 22/10, nessuna risposta»; null senza un richiamo inviato. */
  waitingText: string | null;
  /** Nel gruppo senza consenso: «Consenso ai richiami revocato dalla madre il 15/09», «Manca il consenso ai richiami». */
  withoutConsentReason: string | null;
}

export interface RecallBlock {
  /** In regola e con il consenso ai richiami: scaduti dal più vecchio, poi in scadenza, quelli in attesa in fondo. */
  rows: RecallRow[];
  /** In regola per data, ma senza consenso ai richiami: il gruppo chiuso, senza azioni di messaggio. */
  withoutConsent: RecallRow[];
}

/** Lo stesso testo dell'anteprima del messaggio quando manca il consenso (`messages/queries.ts`). */
const NO_RECALL_CONSENT = "Manca il consenso ai richiami";

/**
 * Perché un paziente sta nel gruppo senza consenso: l'ultima scelta `richiami` a falso è una revoca, detta con
 * il genitore di contatto se alla sua data il paziente era minore; altrimenti (nessuna scelta, o un sì senza
 * informativa valida) manca il consenso. L'ordine delle scelte è quello di `getChannelConsents`.
 */
async function withoutConsentReasons(tx: Tx, practiceId: string, patientIds: readonly string[]): Promise<Map<string, string>> {
  const reasons = new Map(patientIds.map((id) => [id, NO_RECALL_CONSENT]));
  if (patientIds.length === 0) return reasons;
  const rows = await tx.query<{
    patientId: string;
    value: boolean;
    decidedOn: string;
    birthDate: string;
    relationship: GuardianRelationship | null;
  }>(
    `select distinct on (c.patient_id) c.patient_id as "patientId", c.value, c.decided_on as "decidedOn",
            p.birth_date as "birthDate", g.relationship
       from public.consent_choices c
       join public.patients p on p.practice_id = c.practice_id and p.id = c.patient_id
       left join public.patient_guardians g on g.practice_id = c.practice_id and g.patient_id = c.patient_id and g.is_contact
      where c.practice_id = $1 and c.patient_id = any($2::uuid[]) and c.choice = 'richiami'
      order by c.patient_id, c.decided_on desc, c.created_at desc, c.record_order desc`,
    [practiceId, [...patientIds]],
  );
  for (const row of rows) {
    if (row.value) continue;
    const minor = row.decidedOn >= row.birthDate && isMinor(row.birthDate, row.decidedOn);
    reasons.set(row.patientId, recallRevokedText(row.decidedOn, minor ? row.relationship : null));
  }
  return reasons;
}

const byDueThenName = (
  a: { recall: RecallRow; lastName: string; firstName: string },
  b: { recall: RecallRow; lastName: string; firstName: string },
): number =>
  a.recall.dueDay.localeCompare(b.recall.dueDay) ||
  a.lastName.localeCompare(b.lastName, "it") ||
  a.firstName.localeCompare(b.firstName, "it") ||
  a.recall.patientId.localeCompare(b.recall.patientId);

/**
 * I richiami che scadono entro oggi + `withinDays` compreso (7 in Oggi, 30 in Pazienti):
 * paziente non archiviato, cadenza impostata, richiami non sospesi, almeno un fatto e nessun appuntamento
 * futuro (prenotato o confermato dalle 00:00 di oggi: un controllo di stamattina non ancora segnato conta,
 * così la lista non cambia con l'ora). La data è l'ultimo fatto più la cadenza. Un rinvio toglie
 * la riga fino al suo giorno, poi torna con il ritardo vero. Il consenso ai richiami è quello di
 * `getChannelConsents` (ultima scelta e informativa valida, con versione e `record_order`); senza, il
 * paziente va in `withoutConsent` con la sua ragione e senza messaggio. Le righe in regola hanno il richiamo
 * preparato e l'attesa: il giorno di Roma di `created_at` dell'ultimo `richiamo` con esito
 * attuale `inviato`, scritto dopo l'ultimo fatto (`outcome_at` non conta). L'attesa resta nel conteggio ma va in
 * fondo. Ordine per scadenza, poi per nome. Il messaggio (`contact`) costa alcune letture per riga: si prepara solo
 * per le prime `prepared` righe in regola, quelle che si mostrano con le azioni (tutte se non è detto); le altre
 * hanno `contact` null, e il conteggio non ne prepara nessuno.
 */
export async function listRecalls(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  withinDays: number,
  options: { prepared?: number } = {},
): Promise<RecallBlock> {
  const today = clock.today();
  const rows = await tx.query<{
    patientId: string;
    firstName: string;
    lastName: string;
    cadenceWeeks: number;
    snoozedUntil: string | null;
    lastDoneAt: Date;
    lastSentAt: Date | null;
  }>(
    `select p.id as "patientId",
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.recall_interval_weeks as "cadenceWeeks",
            p.recall_snoozed_until as "snoozedUntil",
            done.last_done_at as "lastDoneAt",
            (select m.created_at
               from public.message_log m
              where m.practice_id = p.practice_id and m.patient_id = p.id
                and m.template_key = 'richiamo' and m.outcome = 'inviato' and m.created_at > done.last_done_at
              order by m.created_at desc, m.record_order desc
              limit 1) as "lastSentAt"
       from public.patients p
       join (select a.patient_id, max(a.starts_at) as last_done_at
               from public.appointments a
              where a.practice_id = $1 and a.status = 'fatto'
              group by a.patient_id) done on done.patient_id = p.id
      where p.practice_id = $1
        and p.archived_at is null
        and p.recall_interval_weeks is not null
        and not p.recall_paused
        and not exists (select 1
                          from public.appointments f
                         where f.practice_id = p.practice_id and f.patient_id = p.id
                           and f.status in ('prenotato', 'confermato') and f.starts_at >= $2)`,
    [practiceId, romeDayBounds(today).start],
  );

  // Il rinvio vale prima della scadenza: un richiamo rinviato non c'è, né in regola né senza consenso.
  const due = rows
    .filter((row) => recallVisible(row.snoozedUntil, today))
    .map((row) => {
      const lastDoneDay = todayRome(row.lastDoneAt);
      const dueDay = recallDay(lastDoneDay, row.cadenceWeeks);
      const recall: RecallRow = {
        patientId: row.patientId,
        name: firstLast(row),
        dueDay,
        dueText: recallDueText(dueDay, today),
        lastDoneDay,
        cadenceWeeks: row.cadenceWeeks,
        contact: null,
        waitingUntil: null,
        lastSentOn: null,
        waitingText: null,
        withoutConsentReason: null,
      };
      return { recall, firstName: row.firstName, lastName: row.lastName, lastSentAt: row.lastSentAt };
    })
    .filter(({ recall }) => daysBetween(today, recall.dueDay) <= withinDays);

  const consent = await getChannelConsents(
    tx,
    practiceId,
    due.map(({ recall }) => recall.patientId),
    "richiami",
  );
  const allowed = due.filter(({ recall }) => consent.get(recall.patientId) === true);
  const refused = due.filter(({ recall }) => consent.get(recall.patientId) !== true);

  for (const item of allowed) {
    const lastSentOn = item.lastSentAt === null ? null : todayRome(item.lastSentAt);
    item.recall = { ...item.recall, ...recallWait(lastSentOn, today), lastSentOn };
  }
  const reasons = await withoutConsentReasons(
    tx,
    practiceId,
    refused.map(({ recall }) => recall.patientId),
  );

  const waiting = (item: (typeof allowed)[number]) => item.recall.waitingUntil !== null;
  const ordered = [...allowed.filter((item) => !waiting(item)).sort(byDueThenName), ...allowed.filter(waiting).sort(byDueThenName)];
  // Dopo l'ordine: le righe mostrate sono le prime.
  const prepared = options.prepared ?? ordered.length;
  const rowsInOrder = ordered.map(({ recall }) => recall);
  return {
    rows: [
      ...(await withRecallContacts(tx, practiceId, clock, rowsInOrder.slice(0, prepared))),
      ...rowsInOrder.slice(prepared),
    ],
    withoutConsent: refused
      .sort(byDueThenName)
      .map(({ recall }) => ({ ...recall, withoutConsentReason: reasons.get(recall.patientId) ?? NO_RECALL_CONSENT })),
  };
}

/**
 * Le righe date con il richiamo preparato (`contact`), una `prepareMessage` per riga: solo per le righe che si
 * mostrano con le azioni, mai per un conteggio.
 */
export async function withRecallContacts(tx: Tx, practiceId: string, clock: Clock, rows: readonly RecallRow[]): Promise<RecallRow[]> {
  const out: RecallRow[] = [];
  for (const row of rows) {
    const source = { kind: "recall", patientId: row.patientId, templateKey: "richiamo" } as const;
    out.push({ ...row, contact: await prepareMessage(tx, practiceId, clock, source) });
  }
  return out;
}

/** Le righe che Oggi mostra con le azioni: le altre stanno in Pazienti, «Vedi tutti». */
export const TODAY_RECALL_ROWS = 5;

/** Il blocco «Da richiamare» di Oggi: entro 7 giorni, con il messaggio preparato solo per le righe mostrate. */
export function listTodayRecalls(tx: Tx, practiceId: string, clock: Clock): Promise<RecallBlock> {
  return listRecalls(tx, practiceId, clock, 7, { prepared: TODAY_RECALL_ROWS });
}
