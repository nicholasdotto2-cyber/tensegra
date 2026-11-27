import { type CycleAppointment, sessionPosition } from "@/lib/agenda/session-label";
import { REGION_LABEL, type RegionCode, SCREENING_ITEMS, screeningItem, technique, testDefinition } from "@/lib/clinical/catalog";
import { formatValue, type Measure, testsOverTime } from "@/lib/clinical/compare";
import { RADIATION_LABEL, REFERRAL_STATUS_LABEL, RECIPIENT_KIND_LABEL, SIDE_LABEL } from "@/lib/clinical/labels";
import type { ReferralFacts, ReferralReason } from "@/lib/clinical/referral-summary";
import { type PromptCode, type ReferralPrompt, referralPrompts } from "@/lib/clinical/rules";
import { dayField, firstLast } from "@/lib/format";
import type { Tx } from "@/server/db/db";
import { cycleMeasures, cycleVisitsInOrder } from "@/server/domain/cartella/queries";
import { listCycleAppointments } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getClinicalSettings, getPracticeSettings } from "@/server/domain/settings/queries";
import { loadAnswers } from "@/server/domain/visits/ops/screening";

// Letture del rinvio al medico: la lettera come la mostrano
// la pagina e il PDF, i fatti della sintesi generata e il motivo e l'urgenza proposti dai promemoria
// R1-R3. Ogni SQL filtra lo studio anche oltre la RLS; un rinvio di un altro studio è null. Le date della
// lettera vengono dai dati (`created_on`, `delivered_on`), mai dall'orologio.

export type Urgency = "emergenza" | "urgente" | "programmato";

export interface ReferralLetter {
  id: string;
  patientId: string;
  status: string;
  statusLabel: string;
  /** In bozza e senza PDF: dopo il PDF o la consegna il contenuto non cambia. */
  editable: boolean;
  agreed: boolean;
  letterFileId: string | null;
  /** "lettera-medico-AAAA-MM-GG.pdf" col `created_on`, mai il nome del paziente. */
  fileName: string;
  /** Il nome dello studio e le righe sotto: indirizzo, iscrizione con numero e Ordine se c'è. */
  studio: { name: string; lines: string[] };
  recipient: { kind: string; physicianId: string | null; free: string | null; text: string };
  reason: string;
  urgency: string;
  /** "{Città della sede}, 04/11/2026", o la data sola senza città. */
  dayText: string;
  /** `birthDateText` = "nato il 12/03/1971" ("nata" con `sex = 'f'`). */
  patient: { name: string; birthDateText: string };
  summaryText: string;
  requestText: string;
  /** "{Nome Cognome dell'osteopata}, Osteopata". */
  signature: string;
  /** In demo il PDF porta "DATI DI PROVA" su ogni pagina. */
  demo: boolean;
  deliveredOn: string | null;
}

interface LetterRow {
  id: string;
  patientId: string;
  status: keyof typeof REFERRAL_STATUS_LABEL;
  letterFileId: string | null;
  createdOn: string;
  recipientKind: keyof typeof RECIPIENT_KIND_LABEL;
  physicianId: string | null;
  physicianName: string | null;
  recipientFree: string | null;
  reason: string;
  urgency: string;
  summaryText: string;
  requestText: string;
  agreed: boolean;
  deliveredOn: string | null;
  firstName: string;
  lastName: string;
  birthDate: string;
  sex: "f" | "m" | "nd";
}

/** Il nome del PDF scaricato, come `downloadName` della route dei file per `referral_pdf`. */
export function letterFileName(createdOn: string): string {
  return `lettera-medico-${createdOn}.pdf`;
}

/** "Via dei Mille 12, 40121 Bologna (BO)": le parti scritte, nessuna riga se non ce n'è nessuna. */
function addressLine(s: { addressLine: string | null; postalCode: string | null; city: string | null; province: string | null }): string | null {
  const place = [s.postalCode, s.city].filter((p): p is string => p !== null && p !== "").join(" ");
  const placeWithProvince = s.province ? `${place} (${s.province})`.trim() : place;
  const parts = [s.addressLine, placeWithProvince].filter((p): p is string => p !== null && p !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/** La lettera del rinvio; null se non c'è, è di un altro studio o lo studio non ha impostazioni. */
export async function getReferralLetter(tx: Tx, practiceId: string, referralId: string): Promise<ReferralLetter | null> {
  const [r] = await tx.query<LetterRow>(
    `select r.id,
            r.patient_id as "patientId",
            r.status,
            r.letter_file_id as "letterFileId",
            r.created_on as "createdOn",
            r.recipient_kind as "recipientKind",
            r.physician_id as "physicianId",
            ph.full_name as "physicianName",
            r.recipient_free as "recipientFree",
            r.reason,
            r.urgency,
            r.summary_text as "summaryText",
            r.request_text as "requestText",
            r.patient_agreed_to_share as agreed,
            r.delivered_on as "deliveredOn",
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            p.sex
       from public.referrals r
       join public.patients p on p.practice_id = r.practice_id and p.id = r.patient_id
       left join public.physicians ph on ph.practice_id = r.practice_id and ph.id = r.physician_id
      where r.practice_id = $1 and r.id = $2`,
    [practiceId, referralId],
  );
  if (!r) return null;
  const s = await getPracticeSettings(tx, practiceId);
  if (!s) return null;

  const lines: string[] = [];
  const address = addressLine(s);
  if (address !== null) lines.push(address);
  // Iscrizione dello studio mancante: la riga non c'è.
  if (s.registrationNumber) {
    lines.push(`Iscrizione n. ${s.registrationNumber}${s.registrationOrder ? `, ${s.registrationOrder}` : ""}`);
  }
  const day = dayField(r.createdOn);

  return {
    id: r.id,
    patientId: r.patientId,
    status: r.status,
    statusLabel: REFERRAL_STATUS_LABEL[r.status],
    editable: r.status === "bozza" && r.letterFileId === null,
    agreed: r.agreed,
    letterFileId: r.letterFileId,
    fileName: letterFileName(r.createdOn),
    studio: { name: s.practiceName, lines },
    recipient: {
      kind: r.recipientKind,
      physicianId: r.physicianId,
      free: r.recipientFree,
      text: r.physicianName ?? r.recipientFree ?? RECIPIENT_KIND_LABEL[r.recipientKind],
    },
    reason: r.reason,
    urgency: r.urgency,
    dayText: s.city ? `${s.city}, ${day}` : day,
    patient: {
      name: firstLast(r),
      birthDateText: `${r.sex === "f" ? "nata" : "nato"} il ${dayField(r.birthDate)}`,
    },
    summaryText: r.summaryText,
    requestText: r.requestText,
    signature: `${firstLast({ firstName: s.practitionerFirstName, lastName: s.practitionerLastName })}, Osteopata`,
    demo: s.isDemo,
    deliveredOn: r.deliveredOn,
  };
}

// Motivo e urgenza proposti ----------------------------------------------------------------------------

const DEFAULT_PROMPTS: readonly PromptCode[] = ["R1", "R2", "R3"];
const URGENCY_RANK: Record<Urgency, number> = { programmato: 0, urgente: 1, emergenza: 2 };

export interface ReferralSuggestion {
  reason: ReferralReason;
  urgency: Urgency;
}

/**
 * Il motivo e l'urgenza della voce più grave fra i promemoria della visita: un red flag
 * (R1) con l'urgenza più alta fra quelle segnate, poi il peggioramento (R2), poi la persistenza (R3);
 * senza promemoria "altro" e "programmato".
 */
export function suggestionFromPrompts(prompts: readonly ReferralPrompt[]): ReferralSuggestion {
  const urgencies = prompts.flatMap((p) => (p.code === "R1" && p.urgency !== null ? [p.urgency] : []));
  if (urgencies.length > 0) {
    const urgency = urgencies.reduce((a, b) => (URGENCY_RANK[b] > URGENCY_RANK[a] ? b : a));
    return { reason: "red_flag", urgency };
  }
  if (prompts.some((p) => p.code === "R2")) return { reason: "peggioramento", urgency: "programmato" };
  if (prompts.some((p) => p.code === "R3")) return { reason: "sintomi_persistenti", urgency: "programmato" };
  return { reason: "altro", urgency: "programmato" };
}

interface CycleVisitRow {
  id: string;
  appointmentId: string;
  nprsPre: number | null;
}

/** I promemoria R1-R3 della visita, con gli stessi dati dell'editor (`getVisitEditor`). */
async function visitPrompts(
  tx: Tx,
  practiceId: string,
  cycle: { id: string; kind: "trattamento" | "mantenimento"; expectedSessions: number | null },
  first: CycleVisitRow,
  visit: CycleVisitRow,
): Promise<ReferralPrompt[]> {
  const settings = await getClinicalSettings(tx, practiceId);
  const appointments: CycleAppointment[] = await listCycleAppointments(tx, practiceId, cycle.id);
  return referralPrompts({
    enabled: settings?.referralPrompts ?? DEFAULT_PROMPTS,
    answers: await loadAnswers(tx, practiceId, visit.id),
    cycleKind: cycle.kind,
    expectedSessions: cycle.expectedSessions,
    sessionNumber: sessionPosition(visit.appointmentId, appointments),
    firstNprsPre: first.nprsPre,
    todayNprsPre: visit.nprsPre,
    isFirstVisitOfCycle: first.id === visit.id,
  });
}

interface CycleRow {
  id: string;
  patientId: string;
  kind: "trattamento" | "mantenimento";
  expectedSessions: number | null;
  openedOn: string;
  chiefComplaint: string | null;
  diagnosisText: string | null;
  diagnosisSource: "referto_allegato" | "riferita_dal_paziente" | "assente";
  firstName: string;
  lastName: string;
}

async function loadCycle(tx: Tx, practiceId: string, cycleId: string): Promise<CycleRow> {
  const [row] = await tx.query<CycleRow>(
    `select c.id,
            c.patient_id as "patientId",
            c.kind,
            c.expected_sessions as "expectedSessions",
            c.opened_on as "openedOn",
            c.chief_complaint as "chiefComplaint",
            c.medical_diagnosis_text as "diagnosisText",
            c.medical_diagnosis_source as "diagnosisSource",
            p.first_name as "firstName",
            p.last_name as "lastName"
       from public.treatment_cycles c
       join public.patients p on p.practice_id = c.practice_id and p.id = c.patient_id
      where c.practice_id = $1 and c.id = $2`,
    [practiceId, cycleId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

/** Le visite del ciclo in ordine (giorno, orario, id), fino a `visitId` compresa se è data. */
async function visitsUpTo(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  visitId: string | null,
): Promise<{ all: { id: string; visitDate: string }[]; upTo: { id: string; visitDate: string }[] }> {
  const all = await cycleVisitsInOrder(tx, practiceId, cycleId);
  if (visitId === null) return { all, upTo: all };
  const index = all.findIndex((v) => v.id === visitId);
  // Una visita di un altro ciclo, paziente o studio.
  if (index === -1) throw new DomainError(NOT_ALLOWED);
  return { all, upTo: all.slice(0, index + 1) };
}

function cycleVisitRows(tx: Tx, practiceId: string, ids: readonly string[]) {
  return tx.query<CycleVisitRow & { radiationSites: string[]; radiationSide: keyof typeof SIDE_LABEL | null }>(
    `select id,
            appointment_id as "appointmentId",
            nprs_pre as "nprsPre",
            radiation_sites as "radiationSites",
            radiation_side as "radiationSide"
       from public.visits
      where practice_id = $1 and id = any($2::uuid[])`,
    [practiceId, [...ids]],
  );
}

/**
 * Motivo e urgenza proposti per un rinvio sul ciclo: i promemoria della visita `visitId`, o senza visita
 * dell'ultima visita del ciclo; un ciclo senza visite propone "altro" e "programmato".
 */
export async function referralSuggestion(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  visitId: string | null,
): Promise<ReferralSuggestion> {
  const cycle = await loadCycle(tx, practiceId, cycleId);
  const { all, upTo } = await visitsUpTo(tx, practiceId, cycleId, visitId);
  const firstId = all[0]?.id;
  const referenceId = upTo[upTo.length - 1]?.id;
  if (firstId === undefined || referenceId === undefined) return suggestionFromPrompts([]);
  const rows = new Map((await cycleVisitRows(tx, practiceId, [firstId, referenceId])).map((v) => [v.id, v]));
  const first = rows.get(firstId);
  const reference = rows.get(referenceId);
  if (!first || !reference) return suggestionFromPrompts([]);
  return suggestionFromPrompts(await visitPrompts(tx, practiceId, cycle, first, reference));
}

// I fatti della sintesi ----------------------------------------------------------------------------------

const DIAGNOSIS_SOURCE_LABEL: Record<CycleRow["diagnosisSource"], string> = {
  referto_allegato: "Referto allegato",
  riferita_dal_paziente: "Riferita dal paziente",
  assente: "",
};

const CATALOG_ORDER = new Map(SCREENING_ITEMS.map((item, i) => [item.code, i]));

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

interface RedFlagAnswer {
  visitId: string;
  itemCode: string;
  subAnswers: string[];
}

/**
 * I red flag (voci con un rinvio, come R1) segnati "si" nelle visite, in ordine di visita e di catalogo;
 * una voce compare una volta, alla prima visita che la segna. Con sottovoci scelte la voce si chiama col
 * suo motivo breve ("Sospetta frattura") e le sottovoci la spiegano; senza, con la sua etichetta.
 */
function redFlagsOf(answers: readonly RedFlagAnswer[], visits: readonly { id: string; visitDate: string }[]): ReferralFacts["redFlags"] {
  const position = new Map(visits.map((v, i) => [v.id, i]));
  const sorted = answers
    .filter((a) => position.has(a.visitId))
    .sort(
      (a, b) =>
        (position.get(a.visitId) ?? 0) - (position.get(b.visitId) ?? 0) ||
        (CATALOG_ORDER.get(a.itemCode) ?? 0) - (CATALOG_ORDER.get(b.itemCode) ?? 0),
    );
  const seen = new Set<string>();
  const flags: ReferralFacts["redFlags"] = [];
  for (const a of sorted) {
    const item = screeningItem(a.itemCode);
    if (!item || item.referral === "none" || seen.has(item.code)) continue;
    seen.add(item.code);
    const subItems = item.subItems.filter((s) => a.subAnswers.includes(s.code)).map((s) => s.label);
    flags.push({
      label: subItems.length > 0 ? upperFirst(item.short) : item.label,
      subItems,
      visitDay: visits[position.get(a.visitId) ?? 0]?.visitDate ?? "",
    });
  }
  return flags;
}

/** "Riflesso achilleo dx ridotto", "Forza L5 dx 4": l'ultima visita con l'esame neurologico registrato. */
function neuroOf(measures: readonly Measure[], visits: readonly { id: string }[]): string[] | null {
  for (let i = visits.length - 1; i >= 0; i -= 1) {
    const visitId = visits[i]?.id;
    const items = measures.flatMap((m) => {
      const def = testDefinition(m.testCode);
      if (m.visitId !== visitId || def?.category !== "neurologico") return [];
      const value = m.valueOrdinal !== null ? (def.ordinalLabels?.[m.valueOrdinal] ?? formatValue(m)) : formatValue(m);
      if (value === null) return [];
      return [{ sort: def.sort, side: m.side ?? "", text: `${def.name}${m.side ? ` ${m.side}` : ""} ${value}` }];
    });
    if (items.length > 0) {
      return items.sort((a, b) => a.sort - b.sort || a.side.localeCompare(b.side)).map((x) => x.text);
    }
  }
  return null;
}

/** I test con un valore diverso dalla prima misura del ciclo (`changeFromFirst` dentro `testsOverTime`). */
function changedTestsOf(visits: readonly { id: string; visitDate: string }[], measures: readonly Measure[]): ReferralFacts["changedTests"] {
  return testsOverTime(visits, measures).flatMap((row) => {
    const values = row.values.filter((v): v is string => v !== null);
    const first = values[0];
    const last = values[values.length - 1];
    if (row.change === null || first === undefined || last === undefined || first === last) return [];
    return [{ label: row.label, change: `${first} → ${last}` }];
  });
}

/**
 * I fatti della sintesi del rinvio sul ciclo: il paziente, l'apertura del ciclo col motivo e la
 * diagnosi medica di riferimento, e dalle visite del ciclo (fino a `visitId` compresa, se data) red flag,
 * irradiazione ed esame neurologico dell'ultima visita che li registra, regioni e tecniche, dolore 0-10 a
 * inizio seduta e test variati. Il motivo è quello proposto da `referralSuggestion`. Un ciclo o una
 * visita che non è dello studio (o del ciclo) risponde "Operazione non permessa".
 */
export async function referralFacts(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  visitId: string | null,
): Promise<ReferralFacts> {
  const cycle = await loadCycle(tx, practiceId, cycleId);
  const { upTo: visits } = await visitsUpTo(tx, practiceId, cycleId, visitId);
  const ids = visits.map((v) => v.id);
  const idSet = new Set(ids);

  const rows = new Map((await cycleVisitRows(tx, practiceId, ids)).map((v) => [v.id, v]));
  const answers = await tx.query<RedFlagAnswer>(
    `select visit_id as "visitId", item_code as "itemCode", sub_answers as "subAnswers"
       from public.visit_screening_answers
      where practice_id = $1 and visit_id = any($2::uuid[]) and answer = 'si'`,
    [practiceId, ids],
  );
  const treatments = await tx.query<{ visitId: string; region: RegionCode; techniqueCode: string; customTechnique: string | null }>(
    `select visit_id as "visitId", region, technique_code as "techniqueCode", custom_technique as "customTechnique"
       from public.visit_treatments
      where practice_id = $1 and visit_id = any($2::uuid[])
      order by array_position(app.region_codes(), region), technique_code, id`,
    [practiceId, ids],
  );
  const measures = (await cycleMeasures(tx, practiceId, cycleId)).filter((m) => idSet.has(m.visitId));

  let radiation: ReferralFacts["radiation"] = null;
  for (const v of visits) {
    const row = rows.get(v.id);
    if (row && row.radiationSites.length > 0) {
      radiation = {
        sites: row.radiationSites.map((s) => RADIATION_LABEL[s as keyof typeof RADIATION_LABEL] ?? s),
        side: row.radiationSide === null ? "" : SIDE_LABEL[row.radiationSide],
      };
    }
  }

  const diagnosisText = cycle.diagnosisText?.trim() ?? "";
  return {
    patientName: firstLast(cycle),
    reason: (await referralSuggestion(tx, practiceId, cycleId, visitId)).reason,
    startDay: cycle.openedOn,
    chiefComplaint: cycle.chiefComplaint,
    diagnosis: diagnosisText === "" ? null : { text: diagnosisText, sourceLabel: DIAGNOSIS_SOURCE_LABEL[cycle.diagnosisSource] },
    redFlags: redFlagsOf(answers, visits),
    radiation,
    neuro: neuroOf(measures, visits),
    visits: visits.map((v) => {
      const own = treatments.filter((t) => t.visitId === v.id);
      const regions = [...new Set(own.map((t) => REGION_LABEL[t.region]))];
      const techniques = [
        ...new Set(own.map((t) => (t.techniqueCode === "altra" ? (t.customTechnique ?? "") : (technique(t.techniqueCode)?.label ?? "")))),
      ].filter((name) => name !== "");
      return { day: v.visitDate, regions, techniques };
    }),
    pain: visits.map((v) => rows.get(v.id)?.nprsPre ?? null),
    changedTests: changedTestsOf(visits, measures),
  };
}
