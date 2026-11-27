import type { AppointmentStatus } from "@/lib/agenda/status";
import { STATUS_LABEL } from "@/lib/agenda/status";
import { FAMILIES, type Family, type Outcome } from "@/lib/clinical/catalog";
import { RISK_BADGE } from "@/lib/clinical/labels";
import { outcomeRank, type ScreeningAnswer, suggestOutcomes } from "@/lib/clinical/rules";
import { NO_CYCLE, NO_GUARDIAN } from "@/lib/consents/messages";
import { MODULE_LABEL, type ModuleKey } from "@/lib/consents/required";
import { age, datetimeAttr, dayField, dayShort, firstLast, isMinor, timeOf } from "@/lib/format";
import { phoneDisplay } from "@/lib/phone";
import { type Clock, romeDayBounds, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { consentTarget, getChannelConsent, loadConsentGuardians, targetProblem } from "@/server/domain/consents/queries";
import type { ConsentTarget } from "@/server/domain/consents/schemas";
import { activeRiskTags, pregnancyInProgress } from "@/server/domain/history/queries";
import { listPatientMessages, type MessageLogRow } from "@/server/domain/messages/queries";
import { getMessageRecipient, type MessageRecipient } from "@/server/domain/messages/recipient";
import { archiveBlockText, deleteBlockers, futureCount } from "./commands";
import { ageDay, consentCell, cycleCell, loadPatientFacts, type ModuleState, recallDueDay } from "./list";
import { incompleteRecordSql } from "./queries";
import { recallDueText } from "./recall";

// Le letture della scheda del paziente: la testata con etichette,
// avvisi e blocchi del menu, e le tab Riepilogo, Appuntamenti, Consensi e Anagrafica. Celle e stati
// dei consensi sono quelli della lista (`list.ts`), così scheda e lista dicono la stessa cosa. Ogni
// lettura filtra lo studio anche oltre la RLS; un paziente che non c'è o di un altro studio è null.

export interface PatientHeader {
  id: string;
  firstName: string;
  lastName: string;
  /** "Nome Cognome". */
  name: string;
  /** "AAAA-MM-GG". */
  birthDate: string;
  ageText: string;
  /** L'E.164 salvato, "+393200000004": è quello che copia "Copia". */
  phone: string | null;
  messageRecipient: MessageRecipient | null;
  /** "+39 320 000 0004". */
  phoneText: string | null;
  archived: boolean;
  /** Ciclo e consensi (le celle della lista), "Minore" o "Lattante", "Anagrafica da completare", «Maggiorenne dal 03/11/2026». */
  labels: string[];
  clinicalAlert: string | null;
  /** "TAO", "NAO", «Storia di tumore», «Osteoporosi», «Gravidanza in corso». */
  badges: string[];
  /** "Rinviato al medico il 01/10". */
  referralText: string | null;
  /** «Controindicato: terapia anticoagulante», «Con cautela: gravidanza». */
  screeningText: string | null;
  /** La gravità di `screeningText`, per scegliere come mostrarlo; null senza riassunto. */
  screeningSeverity: Exclude<Outcome, "indicated"> | null;
  /** "Prima annulla i 2 appuntamenti futuri."; null se si archivia. */
  archiveBlock: string | null;
  /** Nessun dato collegato oltre ai genitori: "Elimina definitivamente" c'è. */
  canDelete: boolean;
  openCycleId: string | null;
  hasAnyCycle: boolean;
}

// "Lattante" sotto 12 mesi, minore fino al diciottesimo compleanno.
const INFANT_YEARS = 1;
const ADULT_YEARS = 18;

/** Il giorno dell'n-esimo compleanno; chi nasce il 29 febbraio lo compie il 1 marzo negli anni non bisestili (come `age`). */
function birthday(birthDate: string, years: number): string {
  const [y, m, d] = birthDate.split("-") as [string, string, string];
  const year = Number(y) + years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (m === "02" && d === "29" && !leap) return `${year}-03-01`;
  return `${year}-${m}-${d}`;
}

/** L'avviso clinico scritto dall'osteopata; vuoto o di soli spazi vale nessun avviso. */
export function clinicalAlertText(text: string | null): string | null {
  return text === null || text.trim() === "" ? null : text;
}

/**
 * I badge della testata: "TAO", "NAO", «Storia di tumore», «Osteoporosi» dalle etichette
 * di rischio dell'anamnesi attiva, poi «Gravidanza in corso». Li mostrano la scheda, la Cartella e l'editor.
 */
export async function patientBadges(tx: Tx, practiceId: string, patientId: string): Promise<string[]> {
  const badges = (await activeRiskTags(tx, practiceId, patientId)).flatMap((tag) => {
    const badge = RISK_BADGE[tag];
    return badge === undefined ? [] : [badge];
  });
  if (await pregnancyInProgress(tx, practiceId, patientId)) badges.push("Gravidanza in corso");
  return badges;
}

/** Il rinvio più recente non in bozza: la data della consegna, altrimenti quella della lettera (gg/mm). */
async function referralText(tx: Tx, practiceId: string, patientId: string): Promise<string | null> {
  const [row] = await tx.query<{ day: string }>(
    `select coalesce(delivered_on, created_on) as day
       from public.referrals
      where practice_id = $1 and patient_id = $2 and status <> 'bozza'
      order by coalesce(delivered_on, created_on) desc, created_at desc, id desc
      limit 1`,
    [practiceId, patientId],
  );
  // "01/10" da "01/10/2026".
  return row ? `Rinviato al medico il ${dayField(row.day).slice(0, 5)}` : null;
}

const SCREENING_FALLBACK = "esito dello screening";
const SCREENING_PREFIX: Record<Exclude<Outcome, "indicated">, string> = {
  contraindicated: "Controindicato",
  caution: "Con cautela",
};

/**
 * Il riassunto dello screening: la visita più recente con esiti salvati (per
 * `visit_date`, poi `created_at`, poi `id`, bozza compresa); l'esito più severo diverso da `indicated`
 * fra le tre famiglie (a parità, nell'ordine thrust, dirette, indirette) con il motivo che
 * `suggestOutcomes` dà a quella famiglia sulle risposte salvate. Nessun riassunto senza esiti o con
 * tutte le famiglie indicate.
 */
async function screeningSummary(
  tx: Tx,
  practiceId: string,
  patientId: string,
): Promise<{ text: string; severity: Exclude<Outcome, "indicated"> } | null> {
  const [visit] = await tx.query<{ id: string }>(
    `select v.id
       from public.visits v
      where v.practice_id = $1 and v.patient_id = $2
        and exists (select 1 from public.visit_screening_outcomes o
                     where o.practice_id = v.practice_id and o.visit_id = v.id)
      order by v.visit_date desc, v.created_at desc, v.id desc
      limit 1`,
    [practiceId, patientId],
  );
  if (!visit) return null;
  const outcomes = await tx.query<{ family: Family; outcome: Outcome }>(
    `select family, outcome from public.visit_screening_outcomes where practice_id = $1 and visit_id = $2`,
    [practiceId, visit.id],
  );
  let worst: { family: Family; outcome: Exclude<Outcome, "indicated"> } | null = null;
  for (const family of FAMILIES) {
    const outcome = outcomes.find((o) => o.family === family)?.outcome;
    if (outcome === undefined || outcome === "indicated") continue;
    if (worst === null || outcomeRank(outcome) > outcomeRank(worst.outcome)) worst = { family, outcome };
  }
  if (worst === null) return null;

  const answers = await tx.query<ScreeningAnswer>(
    `select item_code as "itemCode",
            answer,
            regions,
            sub_answers as "subAnswers",
            from_history as "fromHistory",
            note
       from public.visit_screening_answers
      where practice_id = $1 and visit_id = $2`,
    [practiceId, visit.id],
  );
  const reason = suggestOutcomes(answers)[worst.family].reason;
  return { text: `${SCREENING_PREFIX[worst.outcome]}: ${reason ?? SCREENING_FALLBACK}`, severity: worst.outcome };
}

export async function getPatientHeader(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patientId: string,
): Promise<PatientHeader | null> {
  const [p] = await tx.query<{
    id: string;
    firstName: string;
    lastName: string;
    birthDate: string;
    phone: string | null;
    archived: boolean;
    clinicalAlert: string | null;
    incompleteRecord: boolean;
  }>(
    `select p.id,
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            p.phone,
            p.archived_at is not null as archived,
            p.clinical_alert as "clinicalAlert",
            ${incompleteRecordSql("p")} as "incompleteRecord"
       from public.patients p
      where p.practice_id = $1 and p.id = $2`,
    [practiceId, patientId],
  );
  if (!p) return null;

  const screening = await screeningSummary(tx, practiceId, p.id);
  const today = clock.today();
  const day = ageDay(p.birthDate, today);
  const facts = (await loadPatientFacts(tx, practiceId, clock, [p])).get(p.id);
  if (!facts) return null;

  const minor = isMinor(p.birthDate, day);
  const labels = [cycleCell(facts.cycles), consentCell(facts.consents)];
  if (minor) labels.push(day < birthday(p.birthDate, INFANT_YEARS) ? "Lattante" : "Minore");
  if (p.incompleteRecord) labels.push("Anagrafica da completare");
  // I consensi del genitore valgono per il ciclo aperto da minore.
  if (!minor && facts.minorAtOpening) {
    labels.push(`Maggiorenne dal ${dayField(birthday(p.birthDate, ADULT_YEARS))}`);
  }

  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    name: firstLast(p),
    birthDate: p.birthDate,
    ageText: age(p.birthDate, day),
    phone: p.phone,
    messageRecipient: await getMessageRecipient(tx, practiceId, clock, p.id),
    phoneText: p.phone === null ? null : phoneDisplay(p.phone),
    archived: p.archived,
    labels,
    clinicalAlert: clinicalAlertText(p.clinicalAlert),
    badges: await patientBadges(tx, practiceId, p.id),
    referralText: await referralText(tx, practiceId, p.id),
    screeningText: screening?.text ?? null,
    screeningSeverity: screening?.severity ?? null,
    archiveBlock: archiveBlockText(await futureCount(tx, practiceId, clock, p.id)),
    canDelete: !(await deleteBlockers(tx, practiceId, p.id)),
    openCycleId: facts.openCycle?.id ?? null,
    hasAnyCycle: facts.cycles.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------------
// Riepilogo.

export interface SummaryTab {
  messages: MessageLogRow[];
  /** `at` è il `datetime` di `<time>`; `text` "mar 10 nov alle 09:00". */
  next: { at: string; text: string } | null;
  /** Il ciclo aperto; `pain` è il dolore 0-10 a inizio seduta delle sue visite, in ordine (null = non scritto). */
  cycle: { title: string; goal: string | null; doneText: string; pain: (number | null)[] } | null;
  /** `dueText` è la scadenza del richiamo ("Scaduto da 10 giorni"), null senza una data o durante un rinvio. */
  recall: { weeks: number | null; paused: boolean; dueText: string | null };
  /** L'informativa e il consenso del ciclo aperto: «Firmato il 20/10/2026», «Manca», «Revocato il 01/11/2026», «Rifiutato». */
  consents: { label: string; state: string }[];
  /** I nomi dalla rubrica: medico curante e medico inviante abituale. */
  gp: string | null;
  referring: string | null;
}

function moduleStateText(m: ModuleState): string {
  if (m.state === "valid") return `Firmato il ${dayField(m.signedOn)}`;
  // Uno stato "revoked" senza data è un rifiuto: lo stesso «Rifiutato» della tab Consensi.
  if (m.state === "revoked") return m.revokedOn === null ? "Rifiutato" : `Revocato il ${dayField(m.revokedOn)}`;
  return "Manca";
}

/** «2 di 4 sedute fatte»; senza sedute previste «2 sedute fatte», «1 seduta fatta». */
function doneText(done: number, expected: number | null): string {
  if (expected !== null) return `${done} di ${expected} sedute fatte`;
  return done === 1 ? "1 seduta fatta" : `${done} sedute fatte`;
}

export async function getSummaryTab(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patientId: string,
): Promise<SummaryTab | null> {
  const [p] = await tx.query<{
    id: string;
    birthDate: string;
    recallWeeks: number | null;
    recallPaused: boolean;
    recallSnoozedUntil: string | null;
    gp: string | null;
    referring: string | null;
  }>(
    `select p.id,
            p.birth_date as "birthDate",
            p.recall_interval_weeks as "recallWeeks",
            p.recall_paused as "recallPaused",
            p.recall_snoozed_until as "recallSnoozedUntil",
            gp.full_name as gp,
            rp.full_name as referring
       from public.patients p
       left join public.physicians gp on gp.practice_id = p.practice_id and gp.id = p.gp_physician_id
       left join public.physicians rp on rp.practice_id = p.practice_id and rp.id = p.default_referring_physician_id
      where p.practice_id = $1 and p.id = $2`,
    [practiceId, patientId],
  );
  if (!p) return null;
  const facts = (await loadPatientFacts(tx, practiceId, clock, [p])).get(p.id);
  if (!facts) return null;

  const open = facts.openCycle;
  let cycle: SummaryTab["cycle"] = null;
  if (open) {
    const pain = await tx.query<{ value: number | null }>(
      `select nprs_pre as value
         from public.visits
        where practice_id = $1 and cycle_id = $2
        order by visit_date, created_at, id`,
      [practiceId, open.id],
    );
    cycle = {
      title: open.title,
      goal: open.goal,
      doneText: doneText(open.doneCount, open.expectedSessions),
      pain: pain.map((v) => v.value),
    };
  }

  // Un rinvio in corso nasconde la scadenza come in Oggi e in Pazienti.
  const due = recallDueDay(p, facts, clock.today());
  return {
    next:
      facts.nextAt === null
        ? null
        : {
            at: datetimeAttr(facts.nextAt),
            text: `${dayShort(todayRome(facts.nextAt))} alle ${timeOf(facts.nextAt)}`,
          },
    cycle,
    recall: {
      weeks: p.recallWeeks,
      paused: p.recallPaused,
      dueText: due === null ? null : recallDueText(due, clock.today()),
    },
    consents: facts.consents.map((m) => ({ label: MODULE_LABEL[m.key], state: moduleStateText(m) })),
    gp: p.gp,
    referring: p.referring,
    messages: await listPatientMessages(tx, practiceId, p.id, 3),
  };
}

// ---------------------------------------------------------------------------------------------------
// Appuntamenti.

export interface AppointmentLine {
  id: string;
  /** Lo stato, per decidere cosa offrire; `statusLabel` è solo il testo. */
  status: AppointmentStatus;
  /** Il `datetime` di `<time>`, "2026-11-06T09:00". */
  at: string;
  /** "ven 6 nov". */
  dayText: string;
  /** "09:00". */
  timeText: string;
  serviceName: string;
  statusLabel: string;
  /** Annullati e saltati, attenuati al loro posto. */
  muted: boolean;
  visit: { id: string; status: "draft" | "closed" } | null;
  /** La fattura della seduta, solo fuori dalla bozza: il link «Fattura 273/2026». */
  invoice: { id: string; numberLabel: string } | null;
}

export interface PatientAppointments {
  /** Prenotati, confermati e annullati dalle 00:00 di oggi, dal più vicino. */
  future: AppointmentLine[];
  /** Il resto, dal più recente. */
  past: AppointmentLine[];
  /** «3 fatti, 1 saltato, 0 annullati». */
  countsText: string;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Gli appuntamenti del paziente. Un fatto o un saltato è passato anche se è di oggi; un
 * annullato resta al suo posto fra i futuri o fra i passati.
 */
export async function listPatientAppointments(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patientId: string,
): Promise<PatientAppointments> {
  const rows = await tx.query<{
    id: string;
    startsAt: Date;
    status: AppointmentStatus;
    serviceName: string;
    visitId: string | null;
    visitStatus: "draft" | "closed" | null;
    invoice: { id: string; numberLabel: string } | null;
  }>(
    `select a.id,
            a.starts_at as "startsAt",
            a.status,
            s.name as "serviceName",
            v.id as "visitId",
            v.status as "visitStatus",
            -- Una sola riga attiva per appuntamento (invoice_lines_appointment_once_idx); una bozza non ha numero.
            (select jsonb_build_object('id', i.id, 'numberLabel', i.number_label)
               from public.invoice_lines l
               join public.invoices i on i.practice_id = l.practice_id and i.id = l.invoice_id
              where l.practice_id = a.practice_id and l.appointment_id = a.id and l.link_active
                and i.status <> 'bozza'
              limit 1) as invoice
       from public.appointments a
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
       left join public.visits v on v.practice_id = a.practice_id and v.appointment_id = a.id
      where a.practice_id = $1 and a.patient_id = $2
      order by a.starts_at, a.id`,
    [practiceId, patientId],
  );
  const { start } = romeDayBounds(clock.today());
  const line = (r: (typeof rows)[number]): AppointmentLine => ({
    id: r.id,
    status: r.status,
    at: datetimeAttr(r.startsAt),
    dayText: dayShort(todayRome(r.startsAt)),
    timeText: timeOf(r.startsAt),
    serviceName: r.serviceName,
    statusLabel: STATUS_LABEL[r.status],
    muted: r.status === "annullato" || r.status === "saltato",
    visit: r.visitId === null || r.visitStatus === null ? null : { id: r.visitId, status: r.visitStatus },
    invoice: r.invoice,
  });
  const isFuture = (r: (typeof rows)[number]) =>
    r.startsAt.getTime() >= start.getTime() && r.status !== "fatto" && r.status !== "saltato";
  const count = (s: AppointmentStatus) => rows.filter((r) => r.status === s).length;
  return {
    future: rows.filter(isFuture).map(line),
    past: rows
      .filter((r) => !isFuture(r))
      .reverse()
      .map(line),
    countsText: [
      counted(count("fatto"), "fatto", "fatti"),
      counted(count("saltato"), "saltato", "saltati"),
      counted(count("annullato"), "annullato", "annullati"),
    ].join(", "),
  };
}

// ---------------------------------------------------------------------------------------------------
// Consensi: lo storico dei documenti con le loro azioni, le scelte dell'informativa
// e i bersagli dei due pulsanti di raccolta.

export interface ConsentLine {
  id: string;
  moduleKey: ModuleKey;
  moduleLabel: string;
  /** "2026.1": la versione del modulo firmato. */
  moduleVersion: string;
  /** Il ciclo dei moduli al trattamento; null per l'informativa. */
  cycleTitle: string | null;
  /** "20/10/2026". */
  signedOnText: string;
  /** «Valido», «Rifiutato», «Revocato il 01/11/2026», «Sostituito». */
  statusLabel: string;
  method: "tela" | "pdf_caricato";
  /** Il documento già creato o caricato; null per una firma sulla tela il cui PDF nasce al primo «Scarica PDF». */
  documentFileId: string | null;
  /** Il tipo del modulo caricato ("application/pdf", "image/jpeg", "image/png"); null senza documento. */
  documentMime: string | null;
  /** «Registra revoca»: un documento valido e accettato. */
  canRevoke: boolean;
  /** I segnaposto vuoti alla firma: «Firmato con dati mancanti». */
  missingFields: string[];
  /**
   * «Raccogli di nuovo»: lo stesso modulo e lo stesso ciclo. Sull'ultimo documento del modulo, con i bersagli di oggi
   * (`getCollectTargets`): la chiave dell'età di oggi e chi può firmare oggi. Il server ricontrolla tutto.
   */
  target: ConsentTarget;
  /** L'ultimo documento del suo modulo (l'informativa, o il trattamento di quel ciclo): solo lui offre «Raccogli di nuovo». */
  current: boolean;
  /** Perché «Raccogli di nuovo» non si può usare (ciclo chiuso, minore senza chi firmi); null se si può. */
  targetProblem: string | null;
}

/**
 * Le righe di consenso del paziente, tutte, anche sostituite e revocate (niente si cancella): per modulo
 * (informativa, trattamento, del genitore), poi dalla più recente. Con `collect` (i bersagli di oggi) l'ultimo
 * documento di ogni modulo prende il bersaglio attuale: chi ha compiuto 18 anni firma da sé, un genitore senza più
 * la responsabilità non firma. Senza, il bersaglio ripete modulo, ciclo e firmatario della riga.
 */
export async function listPatientConsents(
  tx: Tx,
  practiceId: string,
  patientId: string,
  collect?: CollectTargets,
): Promise<ConsentLine[]> {
  const rows = await tx.query<{
    id: string;
    moduleKey: ModuleKey;
    moduleVersion: string;
    cycleId: string | null;
    cycleTitle: string | null;
    cycleOpen: boolean | null;
    signedOn: string;
    status: "valido" | "revocato" | "sostituito";
    outcome: "accetta" | "rifiuta";
    revokedOn: string | null;
    method: "tela" | "pdf_caricato";
    documentFileId: string | null;
    documentMime: string | null;
    missingFields: string[];
    guardianId: string | null;
    current: boolean;
  }>(
    `select r.id,
            r.module_key as "moduleKey",
            r.module_version as "moduleVersion",
            r.cycle_id as "cycleId",
            c.title as "cycleTitle",
            c.status = 'open' as "cycleOpen",
            r.signed_on as "signedOn",
            r.status,
            r.outcome,
            r.revoked_on as "revokedOn",
            r.method,
            r.document_file_id as "documentFileId",
            f.mime_type as "documentMime",
            r.missing_fields as "missingFields",
            r.guardian_id as "guardianId",
            -- Le due chiavi del trattamento di un ciclo sono un gruppo, come in loadValidConsents.
            row_number() over (
              partition by (r.module_key = 'informativa'), r.cycle_id
              order by r.signed_on desc, r.record_order desc
            ) = 1 as current
       from public.consent_records r
       left join public.treatment_cycles c on c.practice_id = r.practice_id and c.id = r.cycle_id
       left join public.files f on f.practice_id = r.practice_id and f.id = r.document_file_id
      where r.practice_id = $1 and r.patient_id = $2
      order by array_position(array['informativa', 'trattamento', 'trattamento_minore'], r.module_key),
               r.signed_on desc, r.record_order desc`,
    [practiceId, patientId],
  );
  return rows.map((r) => {
    const fromRow: ConsentTarget =
      r.moduleKey === "informativa" || r.cycleId === null
        ? { patientId, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: r.guardianId }
        : { patientId, moduleKey: r.moduleKey, cycleId: r.cycleId, appointmentId: null, guardianId: r.guardianId };
    const rowProblem = r.cycleId !== null && r.cycleOpen !== true ? NO_CYCLE : null;
    const today = collect === undefined || !r.current ? null : currentTarget(collect, r.cycleId);
    return {
      id: r.id,
      moduleKey: r.moduleKey,
      moduleLabel: MODULE_LABEL[r.moduleKey],
      moduleVersion: r.moduleVersion,
      cycleTitle: r.cycleTitle,
      signedOnText: dayField(r.signedOn),
      statusLabel:
        r.status === "revocato"
          ? r.revokedOn === null
            ? "Revocato"
            : `Revocato il ${dayField(r.revokedOn)}`
          : r.status === "sostituito"
            ? "Sostituito"
            : r.outcome === "rifiuta"
              ? "Rifiutato"
              : "Valido",
      method: r.method,
      documentFileId: r.documentFileId,
      documentMime: r.documentMime,
      canRevoke: r.status === "valido" && r.outcome === "accetta",
      missingFields: r.missingFields,
      target: today?.target ?? fromRow,
      current: r.current,
      targetProblem: today === null ? rowProblem : today.problem,
    };
  });
}

/**
 * Il bersaglio di oggi per l'ultimo documento di un modulo: l'informativa, o il trattamento se il ciclo della riga è
 * quello aperto. Senza bersaglio, il motivo: nessuno può firmare per il minore, o il ciclo è chiuso.
 */
function currentTarget(
  collect: CollectTargets,
  cycleId: string | null,
): { target: ConsentTarget | null; problem: string | null } {
  if (collect.noGuardian) return { target: null, problem: NO_GUARDIAN };
  if (cycleId === null) return { target: collect.informativa, problem: null };
  return collect.treatment?.cycleId === cycleId ? { target: collect.treatment, problem: null } : { target: null, problem: NO_CYCLE };
}

/** Una scelta dell'informativa: WhatsApp o richiami, come la rispettano messaggi e liste. */
export interface ChoiceLine {
  choice: "whatsapp" | "richiami";
  label: string;
  /** La scelta che vale oggi: l'ultima riga e un'informativa valida (`getChannelConsents`). */
  value: boolean;
  /** «Sì, dal 15/10/2026», «No, dal 20/10/2026», «No». */
  stateText: string;
}

const CHOICE_LABEL: Record<ChoiceLine["choice"], string> = {
  whatsapp: "Promemoria e comunicazioni su WhatsApp",
  richiami: "Ricontatto per i controlli periodici",
};

/**
 * Le due scelte dell'informativa: si revocano una per volta, separate dalla revoca del documento. Il
 * giorno è quello dell'ultima riga della scelta, con l'ordine di `getChannelConsents`.
 */
export async function listPatientChoices(tx: Tx, practiceId: string, patientId: string): Promise<ChoiceLine[]> {
  const latest = await tx.query<{ choice: ChoiceLine["choice"]; value: boolean; decidedOn: string }>(
    `select distinct on (choice) choice, value, decided_on as "decidedOn"
       from public.consent_choices
      where practice_id = $1 and patient_id = $2
      order by choice, decided_on desc, created_at desc, record_order desc`,
    [practiceId, patientId],
  );
  const lines: ChoiceLine[] = [];
  for (const choice of ["whatsapp", "richiami"] as const) {
    const value = await getChannelConsent(tx, practiceId, patientId, choice);
    const row = latest.find((r) => r.choice === choice);
    // Un sì vale solo con l'ultima riga a sì; un no ha la sua data, anche con un'informativa che non vale più.
    const stateText = row === undefined ? "No" : value ? `Sì, dal ${dayField(row.decidedOn)}` : row.value ? "No" : `No, dal ${dayField(row.decidedOn)}`;
    lines.push({ choice, label: CHOICE_LABEL[choice], value, stateText });
  }
  return lines;
}

/** I bersagli dei due pulsanti di raccolta della tab Consensi. */
export interface CollectTargets {
  informativa: ConsentTarget | null;
  /** Il consenso al trattamento del ciclo aperto; null senza ciclo aperto. */
  treatment: ConsentTarget | null;
  /** Un minore senza un genitore o tutore che possa firmare: i due pulsanti sono spenti. */
  noGuardian: boolean;
}

/**
 * «Raccogli l'informativa» e «Raccogli il consenso al trattamento»: per un minore firma il genitore o il
 * tutore di contatto (`loadConsentGuardians`); il trattamento va sul ciclo aperto, con la chiave dell'età di oggi
 * (`consentTarget`). Null se il paziente non c'è o è di un altro studio.
 */
export async function getCollectTargets(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patientId: string,
): Promise<CollectTargets | null> {
  const [p] = await tx.query<{ id: string; birthDate: string; openCycleId: string | null }>(
    `select p.id,
            p.birth_date as "birthDate",
            (select c.id from public.treatment_cycles c
              where c.practice_id = p.practice_id and c.patient_id = p.id and c.status = 'open'
              order by c.opened_on desc, c.id
              limit 1) as "openCycleId"
       from public.patients p
      where p.practice_id = $1 and p.id = $2`,
    [practiceId, patientId],
  );
  if (!p) return null;
  const today = clock.today();
  const guardianId = (await loadConsentGuardians(tx, practiceId, [p.id])).get(p.id) ?? null;
  if (targetProblem(p, today, guardianId, null) !== null) return { informativa: null, treatment: null, noGuardian: true };
  return {
    noGuardian: false,
    informativa: consentTarget(p, today, guardianId, { kind: "informativa" }),
    treatment:
      p.openCycleId === null ? null : consentTarget(p, today, guardianId, { kind: "trattamento", cycleId: p.openCycleId }),
  };
}

// ---------------------------------------------------------------------------------------------------
// Anagrafica: i valori dei gruppi di `updatePatientGroup` e i genitori di `saveGuardian`, "" per i vuoti.

export interface RegistryGuardian {
  id: string;
  relationship: "madre" | "padre" | "tutore" | "altro";
  firstName: string;
  lastName: string;
  taxCode: string;
  /** L'E.164 salvato o "". */
  phone: string;
  email: string;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
  hasParentalAuthority: boolean;
  isContact: boolean;
  isPayer: boolean;
}

export interface RegistryView {
  patientId: string;
  personali: {
    firstName: string;
    lastName: string;
    /** "AAAA-MM-GG". */
    birthDate: string;
    sex: "f" | "m" | "nd";
    birthPlace: string;
    taxCode: string;
  };
  contatti: {
    /** L'E.164 salvato o "". */
    phone: string;
    email: string;
    preferredChannel: "whatsapp" | "telefono" | "nessuno";
    addressing: "tu" | "lei";
  };
  indirizzo: { addressLine: string; postalCode: string; city: string; province: string; country: string };
  medici: { gpPhysicianId: string; defaultReferringPhysicianId: string };
  note: { adminNotes: string };
  /** Dal primo registrato. */
  guardians: RegistryGuardian[];
}

export async function getRegistry(tx: Tx, practiceId: string, patientId: string): Promise<RegistryView | null> {
  const [p] = await tx.query<{
    firstName: string;
    lastName: string;
    birthDate: string;
    sex: "f" | "m" | "nd";
    birthPlace: string;
    taxCode: string;
    phone: string;
    email: string;
    preferredChannel: "whatsapp" | "telefono" | "nessuno";
    addressing: "tu" | "lei";
    addressLine: string;
    postalCode: string;
    city: string;
    province: string;
    country: string;
    gpPhysicianId: string;
    defaultReferringPhysicianId: string;
    adminNotes: string;
  }>(
    `select first_name as "firstName",
            last_name as "lastName",
            birth_date as "birthDate",
            sex,
            coalesce(birth_place, '') as "birthPlace",
            coalesce(tax_code, '') as "taxCode",
            coalesce(phone, '') as phone,
            coalesce(email, '') as email,
            preferred_channel as "preferredChannel",
            addressing,
            coalesce(address_line, '') as "addressLine",
            coalesce(postal_code, '') as "postalCode",
            coalesce(city, '') as city,
            coalesce(province, '') as province,
            country,
            coalesce(gp_physician_id::text, '') as "gpPhysicianId",
            coalesce(default_referring_physician_id::text, '') as "defaultReferringPhysicianId",
            coalesce(admin_notes, '') as "adminNotes"
       from public.patients
      where practice_id = $1 and id = $2`,
    [practiceId, patientId],
  );
  if (!p) return null;
  const guardians = await tx.query<RegistryGuardian>(
    `select id,
            relationship,
            first_name as "firstName",
            last_name as "lastName",
            coalesce(tax_code, '') as "taxCode",
            coalesce(phone, '') as phone,
            coalesce(email, '') as email,
            coalesce(address_line, '') as "addressLine",
            coalesce(postal_code, '') as "postalCode",
            coalesce(city, '') as city,
            coalesce(province, '') as province,
            country,
            has_parental_authority as "hasParentalAuthority",
            is_contact as "isContact",
            is_payer as "isPayer"
       from public.patient_guardians
      where practice_id = $1 and patient_id = $2
      order by created_at, id`,
    [practiceId, patientId],
  );
  return {
    patientId,
    personali: {
      firstName: p.firstName,
      lastName: p.lastName,
      birthDate: p.birthDate,
      sex: p.sex,
      birthPlace: p.birthPlace,
      taxCode: p.taxCode,
    },
    contatti: { phone: p.phone, email: p.email, preferredChannel: p.preferredChannel, addressing: p.addressing },
    indirizzo: {
      addressLine: p.addressLine,
      postalCode: p.postalCode,
      city: p.city,
      province: p.province,
      country: p.country,
    },
    medici: { gpPhysicianId: p.gpPhysicianId, defaultReferringPhysicianId: p.defaultReferringPhysicianId },
    note: { adminNotes: p.adminNotes },
    guardians,
  };
}
