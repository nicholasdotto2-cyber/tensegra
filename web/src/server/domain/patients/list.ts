import type { CycleKind } from "@/lib/agenda/defaults";
import { isCurrentVersion } from "@/lib/consents/modules";
import { consentFitsAge, type ModuleKey, missingModules, type ValidConsents } from "@/lib/consents/required";
import { age, datetimeAttr, dayField, dayShort, isMinor, lastFirst } from "@/lib/format";
import { escapeLike } from "@/lib/like";
import type { PatientFilter, PatientListParams } from "@/lib/patients/params";
import { phoneDisplay } from "@/lib/phone";
import { addDaysRome, type Clock, romeDayBounds, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { loadValidConsents } from "@/server/domain/consents/queries";
import { listRecalls, PATIENT_TEXT_MATCH, type RecallRow, withRecallContacts } from "./queries";
import { recallDay, recallDueText, recallVisible } from "./recall";

// La lista dei pazienti: ricerca, sei filtri con il loro
// conteggio, celle e ordinamento. I pazienti si leggono una volta, poi cicli, appuntamenti e consensi
// in blocco per gli id letti, e filtri e celle si calcolano qui: nessuna query per riga. Le stesse
// letture e le stesse celle servono alla testata della scheda (`card.ts`). Ogni lettura filtra lo
// studio anche oltre la RLS.

export interface PatientListRow {
  id: string;
  /** "Cognome Nome". */
  name: string;
  /** "47 anni", "5 mesi". */
  ageText: string;
  /** "+39 320 000 0004"; null senza telefono. */
  phoneText: string | null;
  /** "In corso, seduta 2 di 4", «In corso», "Mantenimento", "Chiuso il 12/08", "Nessuno". */
  cycleText: string;
  /** Il `datetime` di `<time>`, "2026-11-06T09:00" (ora di Roma); null senza appuntamenti futuri. */
  nextAt: string | null;
  /** "ven 6 nov". */
  nextText: string | null;
  /** "Scaduto da 10 giorni", "Fra 3 giorni", «Sospeso», «Nessuno», «Ogni 8 settimane». */
  recallText: string;
  /** "In regola", "Manca 1", «Manca 2», "Revocato", "Rifiutato". */
  consentText: string;
  /** Nel filtro «Da richiamare» la riga del richiamo con le sue azioni (come in Oggi); altrimenti null. */
  recall: RecallRow | null;
}

export interface PatientList {
  rows: PatientListRow[];
  /** Ogni filtro con il numero dei suoi pazienti, sulla stessa ricerca. */
  counts: Record<PatientFilter, number>;
  /** Nel filtro «Da richiamare» il gruppo chiuso senza consenso ai richiami, sulla stessa ricerca; altrimenti vuoto. */
  withoutConsent: RecallRow[];
}

/** Un ciclo del paziente con i suoi appuntamenti fatti. */
export interface CycleFacts {
  id: string;
  kind: CycleKind;
  status: "open" | "closed";
  title: string;
  goal: string | null;
  expectedSessions: number | null;
  /** "AAAA-MM-GG". */
  openedOn: string;
  closedOn: string | null;
  doneCount: number;
}

/** Lo stato di un modulo: valido (con la firma), revocato (con data), rifiutato (revoked senza data) o mancante. */
export type ModuleState =
  | { key: ModuleKey; state: "valid"; signedOn: string }
  | { key: ModuleKey; state: "revoked"; revokedOn: string | null }
  | { key: ModuleKey; state: "missing" };

/** Ciò che lista e testata sanno di un paziente oltre la sua riga. */
export interface PatientFacts {
  cycles: CycleFacts[];
  openCycle: CycleFacts | null;
  /** Il primo appuntamento futuro: prenotato o confermato dalle 00:00 di oggi. */
  nextAt: Date | null;
  /** L'ultimo appuntamento fatto. */
  lastDoneAt: Date | null;
  /** Minore all'apertura del ciclo aperto: il consenso genitoriale può continuare a valere. */
  minorAtOpening: boolean;
  /** L'informativa e, con un ciclo aperto, il consenso al trattamento di quel ciclo, in quest'ordine. */
  consents: ModuleState[];
}

/** Il paziente come lo leggono lista e testata. */
export interface FactsPatient {
  id: string;
  birthDate: string;
}

/** Il giorno a cui si conta l'età: un giorno prima della nascita conta come la nascita, l'età non è mai negativa. */
export function ageDay(birthDate: string, day: string): string {
  return day < birthDate ? birthDate : day;
}

interface ConsentRow {
  patientId: string;
  moduleKey: ModuleKey;
  version: string;
  cycleId: string | null;
  status: "valido" | "revocato" | "sostituito";
  outcome: "accetta" | "rifiuta";
  signedOn: string;
  revokedOn: string | null;
}

/**
 * Lo stato di un modulo: valido se c'è una riga `valido` accettata (`loadValidConsents`);
 * revocato se l'ultima riga è revocata o rifiuta il trattamento, senza consenso valido;
 * altrimenti mancante.
 * `rows` sono le righe del paziente dalla più recente.
 */
function moduleState(
  key: ModuleKey,
  cycleId: string | null,
  valid: boolean,
  rows: readonly ConsentRow[],
  keys: readonly ModuleKey[] = [key],
): ModuleState {
  const own = rows.filter((r) => keys.includes(r.moduleKey) && r.cycleId === cycleId);
  if (valid) {
    const signed = own.find((r) => r.status === "valido" && r.outcome === "accetta" && isCurrentVersion(r.moduleKey, r.version));
    if (signed) return { key, state: "valid", signedOn: signed.signedOn };
  }
  const last = own.find((r) => r.status !== "sostituito");
  if (last?.status === "revocato" || (key !== "informativa" && last?.status === "valido" && last.outcome === "rifiuta")) {
    return { key, state: "revoked", revokedOn: last.revokedOn };
  }
  return { key, state: "missing" };
}

function consentStates(
  valid: ValidConsents | undefined,
  rows: readonly ConsentRow[],
  open: CycleFacts | null,
  minorToday: boolean,
  minorAtOpening: boolean,
): ModuleState[] {
  const informativa = moduleState("informativa", null, valid?.informativa ?? false, rows);
  if (!open) return [informativa];
  const key = minorToday ? "trattamento_minore" : "trattamento";
  const missing = missingModules(valid, open.id, minorToday, minorAtOpening);
  // L'ultima decisione del gruppo trattamento vale per tutto il ciclo,
  // conservando la chiave richiesta oggi.
  const keys: ModuleKey[] = ["trattamento", "trattamento_minore"];
  return [informativa, moduleState(key, open.id, !missing.includes(key), rows, keys)];
}

/** Le righe per chiave, nell'ordine in cui arrivano. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

/**
 * Cicli, primo futuro, ultimo fatto e consensi dei pazienti dati, in tre letture in blocco
 * (più quella di `loadValidConsents`). Ogni paziente chiesto ha la sua voce.
 */
export async function loadPatientFacts(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patients: readonly FactsPatient[],
): Promise<Map<string, PatientFacts>> {
  const ids = [...new Set(patients.map((p) => p.id))];
  if (ids.length === 0) return new Map();

  const cycles = await tx.query<CycleFacts & { patientId: string }>(
    `select c.id,
            c.patient_id as "patientId",
            c.kind,
            c.status,
            c.title,
            c.goal,
            c.expected_sessions as "expectedSessions",
            c.opened_on as "openedOn",
            c.closed_on as "closedOn",
            (select count(*)::int
               from public.appointments a
              where a.practice_id = c.practice_id and a.cycle_id = c.id and a.status = 'fatto') as "doneCount"
       from public.treatment_cycles c
      where c.practice_id = $1 and c.patient_id = any($2::uuid[])
      order by c.opened_on desc, c.id`,
    [practiceId, ids],
  );
  const appointments = await tx.query<{ patientId: string; nextAt: Date | null; lastDoneAt: Date | null }>(
    `select patient_id as "patientId",
            min(starts_at) filter (where status in ('prenotato', 'confermato') and starts_at >= $3) as "nextAt",
            max(starts_at) filter (where status = 'fatto') as "lastDoneAt"
       from public.appointments
      where practice_id = $1 and patient_id = any($2::uuid[])
      group by patient_id`,
    [practiceId, ids, romeDayBounds(clock.today()).start],
  );
  const consentRows = await tx.query<ConsentRow>(
    `select patient_id as "patientId",
            module_key as "moduleKey",
            module_version as version,
            cycle_id as "cycleId",
            status,
            outcome,
            signed_on as "signedOn",
            revoked_on as "revokedOn"
       from public.consent_records
      where practice_id = $1 and patient_id = any($2::uuid[])
      order by signed_on desc, record_order desc`,
    [practiceId, ids],
  );
  const valid = await loadValidConsents(tx, practiceId, ids);

  const cyclesOf = groupBy(cycles, (c) => c.patientId);
  const consentsOf = groupBy(consentRows, (r) => r.patientId);
  const timesOf = new Map(appointments.map((a) => [a.patientId, a]));
  const facts = new Map<string, PatientFacts>();
  for (const p of patients) {
    const own: CycleFacts[] = cyclesOf.get(p.id) ?? [];
    const openCycle = own.find((c) => c.status === "open") ?? null;
    const minorAtOpening = openCycle !== null && isMinor(p.birthDate, ageDay(p.birthDate, openCycle.openedOn));
    const times = timesOf.get(p.id);
    facts.set(p.id, {
      cycles: own,
      openCycle,
      nextAt: times?.nextAt ?? null,
      lastDoneAt: times?.lastDoneAt ?? null,
      minorAtOpening,
      consents: consentStates(valid.get(p.id), (consentsOf.get(p.id) ?? []).filter((r) => consentFitsAge(r.moduleKey, p.birthDate, r.signedOn)), openCycle, isMinor(p.birthDate, ageDay(p.birthDate, clock.today())), minorAtOpening),
    });
  }
  return facts;
}

/**
 * La cella Ciclo: il ciclo aperto ("In corso, seduta 2 di 4" con i fatti su previste,
 * «In corso» senza fatti, "Mantenimento"), altrimenti l'ultimo chiuso ("Chiuso il 12/08"), altrimenti
 * "Nessuno".
 */
export function cycleCell(cycles: readonly CycleFacts[]): string {
  const open = cycles.find((c) => c.status === "open");
  if (open) {
    if (open.kind === "mantenimento") return "Mantenimento";
    if (open.doneCount === 0) return "In corso";
    return open.expectedSessions === null
      ? `In corso, seduta ${open.doneCount}`
      : `In corso, seduta ${open.doneCount} di ${open.expectedSessions}`;
  }
  const lastClosed = cycles
    .filter((c): c is CycleFacts & { closedOn: string } => c.status === "closed" && c.closedOn !== null)
    .sort((a, b) => b.closedOn.localeCompare(a.closedOn) || b.openedOn.localeCompare(a.openedOn) || a.id.localeCompare(b.id))[0];
  // "12/08" da "12/08/2026".
  if (lastClosed) return `Chiuso il ${dayField(lastClosed.closedOn).slice(0, 5)}`;
  return "Nessuno";
}

/** Il rifiuto del trattamento prevale anche sulla revoca di un altro modulo; poi revoche, rifiuti e mancanti. */
export function consentCell(modules: readonly ModuleState[]): string {
  if (modules.some((m) => m.key !== "informativa" && m.state === "revoked" && m.revokedOn === null)) return "Rifiutato";
  if (modules.some((m) => m.state === "revoked" && m.revokedOn !== null)) return "Revocato";
  if (modules.some((m) => m.state === "revoked")) return "Rifiutato";
  const missing = modules.filter((m) => m.state === "missing").length;
  return missing === 0 ? "In regola" : `Manca ${missing}`;
}

/** Il paziente con la sua cadenza del richiamo. */
export interface RecallPatient {
  recallWeeks: number | null;
  recallPaused: boolean;
  /** «Non mostrare prima di» del rinvio; assente vale nessun rinvio. */
  recallSnoozedUntil?: string | null;
}

/**
 * Il giorno del richiamo, senza il limite dei giorni e senza il consenso: cadenza
 * impostata, richiami non sospesi, almeno un fatto, nessun appuntamento futuro e nessun rinvio ancora in
 * corso a `today` (la stessa regola di `listRecalls`). Altrimenti null. Il giorno resta quello clinico.
 */
export function recallDueDay(p: RecallPatient, f: PatientFacts, today: string): string | null {
  if (p.recallWeeks === null || p.recallPaused || f.lastDoneAt === null || f.nextAt !== null) return null;
  if (!recallVisible(p.recallSnoozedUntil ?? null, today)) return null;
  return recallDay(todayRome(f.lastDoneAt), p.recallWeeks);
}

/**
 * La cella Richiamo: «Nessuno» senza cadenza, «Sospeso» in pausa, la scadenza se la regola del richiamo
 * dà una data; una cadenza attiva senza data (un futuro, o nessun fatto ancora) mostra «Ogni 8 settimane».
 */
export function recallCell(p: RecallPatient, f: PatientFacts, today: string): string {
  if (p.recallWeeks === null) return "Nessuno";
  if (p.recallPaused) return "Sospeso";
  const due = recallDueDay(p, f, today);
  if (due !== null) return recallDueText(due, today);
  return p.recallWeeks === 1 ? "Ogni 1 settimana" : `Ogni ${p.recallWeeks} settimane`;
}

interface ListPatient extends FactsPatient, RecallPatient {
  firstName: string;
  lastName: string;
  phone: string | null;
  archived: boolean;
}

const SEARCH_PHONE_MIN_DIGITS = 3;
const NO_NEXT_STEP_DAYS = 365;

/**
 * I pazienti dello studio che rispondono alla ricerca: dalla prima lettera sul testo di
 * `PATIENT_TEXT_MATCH`, senza maiuscole e accenti, e sul telefono per cifre da tre cifre in su. `%`,
 * `_` e `\` sono protetti con `escapeLike` e con l'escape predefinito di LIKE: nessuna clausola `escape`.
 */
function matchingPatients(tx: Tx, practiceId: string, q: string): Promise<ListPatient[]> {
  const needle = q.trim();
  const params: string[] = [practiceId];
  let search = "";
  if (needle !== "") {
    params.push(escapeLike(needle));
    const digits = needle.replace(/\D/g, "");
    const byPhone = digits.length >= SEARCH_PHONE_MIN_DIGITS;
    if (byPhone) params.push(digits);
    search = `and (${PATIENT_TEXT_MATCH} like '%' || app.search_text($2) || '%'
                   ${byPhone ? "or replace(phone, '+', '') like '%' || $3 || '%'" : ""})`;
  }
  return tx.query<ListPatient>(
    `select id,
            first_name as "firstName",
            last_name as "lastName",
            birth_date as "birthDate",
            phone,
            archived_at is not null as archived,
            recall_interval_weeks as "recallWeeks",
            recall_paused as "recallPaused",
            recall_snoozed_until as "recallSnoozedUntil"
       from public.patients
      where practice_id = $1
        ${search}`,
    params,
  );
}

const byName = (a: ListPatient, b: ListPatient): number =>
  a.lastName.localeCompare(b.lastName, "it") || a.firstName.localeCompare(b.firstName, "it") || a.id.localeCompare(b.id);

/**
 * La lista. "Tutti" sono i non archiviati; gli archiviati stanno solo in "Archiviati". I
 * conteggi seguono la ricerca. Filtri: "In ciclo" = ciclo di trattamento aperto;
 * "Da richiamare" = le righe di `listRecalls(…, 30)`; "Consensi mancanti" = un futuro o un ciclo aperto
 * e un modulo della cella Consensi mancante o revocato; "Senza prossimo passo" = nessun futuro, nessun
 * ciclo aperto, nessuna cadenza attiva e l'ultimo fatto da oggi meno 365 giorni. Ordine per cognome
 * (poi nome, poi id) o per prossimo appuntamento, con i vuoti sempre in fondo; in «Da richiamare» vale l'ordine
 * dei richiami (scaduti dal più vecchio, l'attesa in fondo). Il richiamo da copiare o aprire si prepara solo per
 * le righe di «Da richiamare» mostrate: gli altri filtri e i conteggi non preparano nessun messaggio.
 */
export async function listPatients(tx: Tx, practiceId: string, clock: Clock, p: PatientListParams): Promise<PatientList> {
  const today = clock.today();
  const patients = await matchingPatients(tx, practiceId, p.q);
  const active = patients.filter((x) => !x.archived);
  const archived = patients.filter((x) => x.archived);
  // Le righe degli archiviati servono solo al loro filtro; il loro conteggio no.
  const facts = await loadPatientFacts(tx, practiceId, clock, p.filtro === "archiviati" ? patients : active);
  const recalls = await listRecalls(tx, practiceId, clock, 30, { prepared: 0 });
  const toRecall = new Map(recalls.rows.map((r) => [r.patientId, r]));
  const recallOrder = new Map(recalls.rows.map((r, i) => [r.patientId, i]));
  const oldestDone = addDaysRome(today, -NO_NEXT_STEP_DAYS);

  const factsOf = (x: ListPatient): PatientFacts => {
    const f = facts.get(x.id);
    if (!f) throw new Error("Paziente senza dati della lista.");
    return f;
  };
  const inFilter: Record<Exclude<PatientFilter, "archiviati">, (x: ListPatient, f: PatientFacts) => boolean> = {
    tutti: () => true,
    in_ciclo: (_, f) => f.openCycle?.kind === "trattamento",
    da_richiamare: (x) => toRecall.has(x.id),
    consensi_mancanti: (_, f) => (f.nextAt !== null || f.openCycle !== null) && consentCell(f.consents) !== "In regola",
    senza_prossimo_passo: (x, f) =>
      f.nextAt === null &&
      f.openCycle === null &&
      (x.recallWeeks === null || x.recallPaused) &&
      f.lastDoneAt !== null &&
      todayRome(f.lastDoneAt) >= oldestDone,
  };

  const members = (filtro: PatientFilter): ListPatient[] =>
    filtro === "archiviati" ? archived : active.filter((x) => inFilter[filtro](x, factsOf(x)));
  const counts = {
    tutti: members("tutti").length,
    in_ciclo: members("in_ciclo").length,
    da_richiamare: members("da_richiamare").length,
    consensi_mancanti: members("consensi_mancanti").length,
    senza_prossimo_passo: members("senza_prossimo_passo").length,
    archiviati: archived.length,
  } satisfies Record<PatientFilter, number>;

  const sign = p.verso === "asc" ? 1 : -1;
  const compare =
    p.ordina === "paziente"
      ? (a: ListPatient, b: ListPatient) => sign * byName(a, b)
      : (a: ListPatient, b: ListPatient) => {
          const [na, nb] = [factsOf(a).nextAt, factsOf(b).nextAt];
          if (na === null || nb === null) return na === nb ? byName(a, b) : na === null ? 1 : -1;
          return sign * (na.getTime() - nb.getTime()) || byName(a, b);
        };

  const recallRows = p.filtro === "da_richiamare";
  const shown = members(p.filtro).sort(
    recallRows ? (a, b) => (recallOrder.get(a.id) ?? 0) - (recallOrder.get(b.id) ?? 0) : compare,
  );
  const contacts = recallRows
    ? new Map(
        (await withRecallContacts(tx, practiceId, clock, shown.flatMap((x) => toRecall.get(x.id) ?? []))).map((r) => [r.patientId, r]),
      )
    : new Map<string, RecallRow>();
  const rows = shown
    .map((x): PatientListRow => {
      const f = factsOf(x);
      return {
        id: x.id,
        name: lastFirst(x),
        ageText: age(x.birthDate, ageDay(x.birthDate, today)),
        phoneText: x.phone === null ? null : phoneDisplay(x.phone),
        cycleText: cycleCell(f.cycles),
        nextAt: f.nextAt === null ? null : datetimeAttr(f.nextAt),
        nextText: f.nextAt === null ? null : dayShort(todayRome(f.nextAt)),
        recallText: recallCell(x, f, today),
        consentText: consentCell(f.consents),
        recall: contacts.get(x.id) ?? null,
      };
    });
  // Il gruppo senza consenso segue la ricerca: solo i pazienti attivi che la ricerca ha trovato.
  const found = new Set(active.map((x) => x.id));
  const withoutConsent = recallRows ? recalls.withoutConsent.filter((r) => found.has(r.patientId)) : [];
  return { rows, counts, withoutConsent };
}
