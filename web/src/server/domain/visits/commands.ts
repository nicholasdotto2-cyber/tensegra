import type { ServiceKind } from "@/lib/agenda/defaults";
import { type AppointmentStatus, canOpenVisit } from "@/lib/agenda/status";
import { CATALOG_VERSION, type RegionCode, type TechniqueCode } from "@/lib/clinical/catalog";
import { COPY_NEEDS_SCREENING } from "@/lib/clinical/labels";
import { checkTreatment, historyAnswers, techniqueFamily } from "@/lib/clinical/rules";
import { type ClosingFacts, closingCheck, type CopySource, planCopy, skippedText } from "@/lib/clinical/visit-rules";
import { missingModules } from "@/lib/consents/required";
import { isMinor, romeDay } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { markDone } from "@/server/domain/appointments/commands";
import { loadValidConsents } from "@/server/domain/consents/queries";
import { moveCycleOpeningBack } from "@/server/domain/cycles/commands";
import { cycleVisitAt } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { activeRiskTags } from "@/server/domain/history/queries";
import {
  applyVisitOp,
  type Change,
  changesFor,
  COPIED_TABLES,
  copiedRowsCount,
  everyVisibleAnswered,
  loadScreeningState,
  loadVisit,
  requireUniqueTargets,
  saveAnswer,
  screeningSource,
  testActive,
  treatmentConsentRevoked,
  validateVisitOp,
  type VisitRow,
} from "./ops";
import { AmendVisitInput, CloseVisitInput, CopyVisitInput, EditVisitInput, StartVisitInput, type VisitOp } from "./schemas";
import { visitOpExists, visitWriteExists } from "./ops/record";

// I comandi della visita: la visita
// nasce dal suo appuntamento, cambia in bozza un'operazione alla volta, copia dalla visita precedente,
// si chiude con la colonna "Per chiudere" e dopo la chiusura cambia solo con una rettifica. Una visita
// chiusa non si scrive da `editVisit`: il comando risponde "Operazione non permessa" prima di arrivare
// al trigger. `amendVisit` scrive la riga di `visit_amendments` prima delle
// modifiche, nella stessa transazione e senza savepoint, come vuole `app.visit_locked`.

// La frase sta in `src/lib/clinical/labels.ts`: la barra dell'editor la mostra uguale.
export { COPY_NEEDS_SCREENING };
/** Una `risposta` o "Nessun'altra voce" toglie gli esiti: in rettifica dopo l'ultima viene un `esiti`. */
export const RECONFIRM_SCREENING = "Dopo aver cambiato le risposte conferma di nuovo lo screening.";
/**
 * Dopo le operazioni della rettifica lo screening non è confermato o ha voci visibili senza risposta:
 * una tecnica diretta o thrust sulla cervicale, o la regione principale, hanno aperto il gruppo
 * cervicale. Si risponde e si conferma nella stessa rettifica.
 */
export const SCREENING_REOPENED =
  "Dopo la rettifica lo screening ha voci senza risposta: rispondi e conferma di nuovo lo screening.";

/**
 * Un prenotato o un confermato del passato resta nel ciclo che si chiude (non è futuro): solo un ciclo aperto
 * riceve una visita nuova.
 */
const CYCLE_CLOSED = "Il ciclo di questo appuntamento è chiuso.";

/** Gli stati da cui la visita si apre: anche prima che l'appuntamento sia segnato fatto. */

/** Il tipo della visita dalla voce di listino: "altro" è una seduta. */
const VISIT_KIND: Record<ServiceKind, "prima_visita" | "seduta" | "controllo"> = {
  prima_visita: "prima_visita",
  seduta: "seduta",
  controllo: "controllo",
  altro: "seduta",
};

/**
 * Apre la visita di un appuntamento, o restituisce quella che c'è già (idempotente).
 * Nasce solo da un appuntamento prenotato, confermato o fatto il cui giorno di Roma non è dopo oggi,
 * con `visit_date` = quel giorno (mai l'orologio), il ciclo e il paziente dell'appuntamento, la
 * versione del catalogo e le risposte proposte dall'anamnesi. Un ciclo aperto dopo il
 * giorno della visita si apre quel giorno. Un ciclo chiuso non riceve visite nuove
 * (`CYCLE_CLOSED`); la visita che c'è già si riapre comunque.
 */
export async function startVisit(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ visitId: string; patientId: string }> {
  const { appointmentId } = StartVisitInput.parse(input);
  const [appointment] = await tx.query<{
    patientId: string;
    cycleId: string;
    startsAt: Date;
    status: AppointmentStatus;
    serviceKind: ServiceKind;
    visitId: string | null;
    cycleStatus: "open" | "closed";
  }>(
    `select a.patient_id as "patientId",
            a.cycle_id as "cycleId",
            a.starts_at as "startsAt",
            a.status,
            s.kind as "serviceKind",
            (select v.id from public.visits v where v.practice_id = a.practice_id and v.appointment_id = a.id) as "visitId",
            c.status as "cycleStatus"
       from public.appointments a
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
       join public.treatment_cycles c on c.practice_id = a.practice_id and c.id = a.cycle_id
      where a.practice_id = $1 and a.id = $2`,
    [practiceId, appointmentId],
  );
  if (!appointment) throw new DomainError(NOT_ALLOWED);
  if (appointment.visitId !== null) return { visitId: appointment.visitId, patientId: appointment.patientId };

  const visitDate = romeDay(appointment.startsAt);
  // La stessa regola che accende "Apri la visita" nell'interfaccia.
  if (!canOpenVisit(appointment.status, visitDate, clock.today())) throw new DomainError(NOT_ALLOWED);
  if (appointment.cycleStatus === "closed") throw new DomainError(CYCLE_CLOSED);

  await moveCycleOpeningBack(tx, practiceId, appointment.cycleId, visitDate);
  const [visit] = await tx.query<{ id: string }>(
    `insert into public.visits
       (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      practiceId,
      appointment.patientId,
      appointment.cycleId,
      appointmentId,
      visitDate,
      VISIT_KIND[appointment.serviceKind],
      CATALOG_VERSION,
    ],
  );
  if (!visit) throw new DomainError(NOT_ALLOWED);

  for (const answer of historyAnswers(await activeRiskTags(tx, practiceId, appointment.patientId))) {
    await saveAnswer(tx, practiceId, visit.id, answer);
  }
  return { visitId: visit.id, patientId: appointment.patientId };
}

/** Un'operazione su una visita in bozza; una visita chiusa passa da `amendVisit`. */
export async function editVisit(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { visitId, op } = EditVisitInput.parse(input);
  const visit = await loadVisit(tx, practiceId, visitId);
  if (!visit) throw new DomainError(NOT_ALLOWED);
  if (await visitOpExists(tx, practiceId, visitId, op)) return;
  if (visit?.status !== "draft") throw new DomainError(NOT_ALLOWED);
  await applyVisitOp(tx, practiceId, clock, visit, op, "bozza");
}

// Copia dalla visita precedente -------------------------------------------------

/** Disfunzioni, test, tecniche e modelli di consiglio della visita sorgente. */
async function loadCopySource(tx: Tx, practiceId: string, visitId: string): Promise<CopySource> {
  const params = [practiceId, visitId];
  return {
    findings: await tx.query(
      `select region, severity, tissue_texture as "tissueTexture", asymmetry, restriction, tenderness, side,
              segment_note as "segmentNote", is_primary as "isPrimary"
         from public.visit_region_findings where practice_id = $1 and visit_id = $2 order by region`,
      params,
    ),
    tests: await tx.query(
      `select test_code as "testCode", custom_label as "customLabel", custom_unit as "customUnit", side
         from public.visit_test_results where practice_id = $1 and visit_id = $2 order by test_code, side, id`,
      params,
    ),
    treatments: await tx.query(
      `select region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach
         from public.visit_treatments where practice_id = $1 and visit_id = $2 order by region, technique_code, id`,
      params,
    ),
    advice: await tx.query(
      `select template_code as "templateCode", text
         from public.visit_advice where practice_id = $1 and visit_id = $2 order by template_code, id`,
      params,
    ),
  };
}

/**
 * "Copia dalla visita precedente": con lo screening di oggi confermato (esiti e ogni voce visibile con
 * una risposta, come la chiusura e `VisitEditor.visit.screeningConfirmed`), dalla sorgente di
 * `screeningSource` copia come "da confermare" le disfunzioni, gli stessi test senza valori (solo quelli
 * attivi nello studio) e le tecniche che lo screening di oggi lascerebbe salvare; con il
 * consenso al trattamento revocato nessuna tecnica, contate nel testo delle non copiate. I
 * consigli non diventano righe; dolore, risposta, note, osservazione, reazioni,
 * irradiazione ed esiti restano quelli di oggi. Una riga che oggi c'è già non si tocca (una regione,
 * un test per lato, una tecnica per regione, una sola primaria). Premuta di nuovo con copiati non
 * confermati chiede di sostituirli (`needsReplace`) senza scrivere; con `replace` li toglie e ricopia.
 */
export async function copyFromPreviousVisit(
  tx: Tx,
  practiceId: string,
  _clock: Clock,
  input: unknown,
): Promise<{ needsReplace: boolean; skippedText: string | null }> {
  const { visitId, replace } = CopyVisitInput.parse(input);
  const visit = await loadVisit(tx, practiceId, visitId);
  if (visit?.status !== "draft") throw new DomainError(NOT_ALLOWED);
  const source = await screeningSource(tx, practiceId, visit);
  if (!source) throw new DomainError(NOT_ALLOWED);
  // Lo screening di oggi confermato come lo legge la chiusura: esiti salvati e ogni voce visibile con una
  // risposta, così un gruppo aperto dopo la conferma (una riga copiata, la regione principale) va risposto prima.
  const today = await loadScreeningState(tx, practiceId, visit.id);
  if (!today || !(await everyVisibleAnswered(tx, practiceId, visit, "bozza"))) throw new DomainError(COPY_NEEDS_SCREENING);

  if ((await copiedRowsCount(tx, practiceId, visit.id)) > 0) {
    if (!replace) return { needsReplace: true, skippedText: null };
    for (const table of COPIED_TABLES) {
      await tx.query(`delete from public.${table} where practice_id = $1 and visit_id = $2 and copied`, [practiceId, visit.id]);
    }
  }

  const sourceRows = await loadCopySource(tx, practiceId, source.visitId);
  const plan = planCopy(sourceRows, today);
  const revoked = await treatmentConsentRevoked(tx, practiceId, visit);
  for (const f of plan.findings) {
    await tx.query(
      `insert into public.visit_region_findings
         (practice_id, visit_id, region, severity, tissue_texture, asymmetry, restriction, tenderness, side,
          segment_note, is_primary, copied)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11 and not exists (select 1 from public.visit_region_findings p
                                    where p.practice_id = $1 and p.visit_id = $2 and p.is_primary),
               true)
       on conflict do nothing`,
      [practiceId, visit.id, f.region, f.severity, f.tissueTexture, f.asymmetry, f.restriction, f.tenderness, f.side, f.segmentNote, f.isPrimary],
    );
  }
  for (const t of plan.tests) {
    if (!(await testActive(tx, practiceId, t.testCode))) continue;
    await tx.query(
      `insert into public.visit_test_results (practice_id, visit_id, test_code, custom_label, custom_unit, side, copied)
       values ($1, $2, $3, $4, $5, $6, true)
       on conflict do nothing`,
      [practiceId, visit.id, t.testCode, t.customLabel, t.customUnit, t.side],
    );
  }
  for (const t of revoked ? [] : plan.treatments) {
    await tx.query(
      `insert into public.visit_treatments
         (practice_id, visit_id, region, technique_code, custom_technique, approach, family, copied)
       values ($1, $2, $3, $4, $5, $6, $7, true)
       on conflict do nothing`,
      [practiceId, visit.id, t.region, t.techniqueCode, t.customTechnique, t.approach, techniqueFamily(t.techniqueCode, t.approach)],
    );
  }
  await tx.query("update public.visits set copied_from_visit_id = $3 where practice_id = $1 and id = $2", [
    practiceId,
    visit.id,
    source.visitId,
  ]);
  return {
    needsReplace: false,
    skippedText: revoked ? skippedText(sourceRows.treatments.length, "consenso_revocato") : skippedText(plan.skipped),
  };
}

// Chiusura -----------------------------------------------------------------------------

/**
 * I fatti della colonna "Per chiudere" (`closingCheck`). Lo screening è confermato con
 * `screening_reviewed_at` e una risposta per ogni voce visibile oggi: un gruppo aperto dopo la conferma
 * (regione principale, riga copiata) va risposto e riconfermato. Il consenso
 * mancante è quello del modulo per l'età alla data della visita. In rettifica
 * (`mode`) i gruppi che si aprono dallo stato di oggi del paziente (gravidanza, pediatrico) contano
 * solo se la visita ha già risposte in quel gruppo.
 */
export async function closingFactsFor(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  mode: "bozza" | "rettifica" = "bozza",
): Promise<ClosingFacts> {
  const [row] = await tx.query<{
    othersPresent: string | null;
    othersPresentConsented: boolean | null;
    adverseReaction: string | null;
    adverseReactionNote: string | null;
    radiationSites: string[];
    radiationSide: string | null;
    nprsPre: number | null;
    cycleKind: string;
    chiefComplaint: string | null;
    mainRegion: RegionCode | null;
    goal: string | null;
    expectedSessions: number | null;
    planAgreed: boolean;
    birthDate: string;
    openedOn: string;
    adviceCount: number;
    psfsCount: number;
  }>(
    `select v.others_present as "othersPresent",
            v.others_present_consented as "othersPresentConsented",
            v.adverse_reaction as "adverseReaction",
            v.adverse_reaction_note as "adverseReactionNote",
            v.radiation_sites as "radiationSites",
            v.radiation_side as "radiationSide",
            v.nprs_pre as "nprsPre",
            c.kind as "cycleKind",
            c.chief_complaint as "chiefComplaint",
            c.main_region as "mainRegion",
            c.goal,
            c.expected_sessions as "expectedSessions",
            c.plan_agreed_on is not null as "planAgreed",
            p.birth_date as "birthDate",
            c.opened_on as "openedOn",
            (select count(*) from public.visit_advice a where a.practice_id = v.practice_id and a.visit_id = v.id)::int
              as "adviceCount",
            (select count(*) from public.psfs_items i where i.practice_id = c.practice_id and i.cycle_id = c.id)::int
              as "psfsCount"
       from public.visits v
       join public.treatment_cycles c on c.practice_id = v.practice_id and c.id = v.cycle_id
       join public.patients p on p.practice_id = v.practice_id and p.id = v.patient_id
      where v.practice_id = $1 and v.id = $2`,
    [practiceId, visit.id],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);

  const state = await loadScreeningState(tx, practiceId, visit.id);
  const treatments = await tx.query<{
    region: RegionCode;
    techniqueCode: TechniqueCode;
    customTechnique: string | null;
    approach: "direct" | "indirect" | null;
    note: string | null;
  }>(
    `select region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach, note
       from public.visit_treatments where practice_id = $1 and visit_id = $2 order by region, technique_code, id`,
    [practiceId, visit.id],
  );
  const findings = await tx.query<{ region: RegionCode }>(
    "select region from public.visit_region_findings where practice_id = $1 and visit_id = $2 order by region",
    [practiceId, visit.id],
  );
  const firstVisitOfCycle = (await cycleVisitAt(tx, practiceId, visit.cycleId, "first"))?.id === visit.id;
  // Un giorno prima della nascita conta come la nascita, come per il consenso revocato.
  const minorAtVisit = isMinor(row.birthDate, visit.visitDate < row.birthDate ? row.birthDate : visit.visitDate);
  const minorAtOpening = isMinor(row.birthDate, row.openedOn < row.birthDate ? row.birthDate : row.openedOn);
  const consents = (await loadValidConsents(tx, practiceId, [visit.patientId])).get(visit.patientId);

  return {
    screeningConfirmed: state !== null && (await everyVisibleAnswered(tx, practiceId, visit, mode)),
    treatments: treatments.map((t) => ({ region: t.region, check: checkTreatment(t, state), note: t.note })),
    copiedCount: await copiedRowsCount(tx, practiceId, visit.id),
    othersPresent: row.othersPresent,
    othersPresentConsented: row.othersPresentConsented,
    adverseReaction: row.adverseReaction,
    adverseReactionNote: row.adverseReactionNote,
    radiationSites: row.radiationSites,
    radiationSide: row.radiationSide,
    firstVisitOfTreatmentCycle: firstVisitOfCycle && row.cycleKind === "trattamento",
    opening: {
      chiefComplaint: row.chiefComplaint,
      mainRegion: row.mainRegion,
      goal: row.goal,
      expectedSessions: row.expectedSessions,
    },
    nprsPre: row.nprsPre,
    adviceCount: row.adviceCount,
    findingRegions: findings.map((f) => f.region),
    treatmentConsentMissing: missingModules(consents, visit.cycleId, minorAtVisit, minorAtOpening).some((m) => m !== "informativa"),
    minorAtVisit,
    planAgreed: row.planAgreed,
    psfsCount: row.psfsCount,
    firstVisitOfCycle,
  };
}

/**
 * «Chiudi la visita»: con `confirmCopied` prima conferma tutti i copiati; poi, se
 * la colonna "Per chiudere" ha bloccanti, risponde con il primo. `alsoMarkDone` segna fatto anche
 * l'appuntamento con `markDone` (che ne controlla giorno e stato); già fatto, resta com'è. `closed_at` è
 * l'istante del clock.
 */
export async function closeVisit(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { visitId, confirmCopied, alsoMarkDone } = CloseVisitInput.parse(input);
  const visit = await loadVisit(tx, practiceId, visitId);
  if (visit?.status !== "draft") throw new DomainError(NOT_ALLOWED);

  if (confirmCopied) await applyVisitOp(tx, practiceId, clock, visit, { op: "conferma", target: "tutti" }, "bozza");
  const [blocking] = closingCheck(await closingFactsFor(tx, practiceId, visit)).blocking;
  if (blocking) throw new DomainError(blocking.text);

  if (alsoMarkDone && (await appointmentStatus(tx, practiceId, visit.appointmentId)) !== "fatto") {
    await markDone(tx, practiceId, clock, { id: visit.appointmentId });
  }
  await tx.query("update public.visits set status = 'closed', closed_at = $3 where practice_id = $1 and id = $2", [
    practiceId,
    visit.id,
    clock.now(),
  ]);
}

async function appointmentStatus(tx: Tx, practiceId: string, appointmentId: string): Promise<string | null> {
  const [row] = await tx.query<{ status: string }>(
    "select status from public.appointments where practice_id = $1 and id = $2",
    [practiceId, appointmentId],
  );
  return row?.status ?? null;
}

// Rettifica -----------------------------------------------------------------------

/** Dopo l'ultima `risposta` o "Nessun'altra voce" della lista viene un `esiti`. */
function requireReconfirmation(ops: readonly VisitOp[]): void {
  const lastAnswer = ops.findLastIndex((o) => o.op === "risposta" || o.op === "nessun_altra_voce");
  if (lastAnswer >= 0 && !ops.slice(lastAnswer + 1).some((o) => o.op === "esiti")) {
    throw new DomainError(RECONFIRM_SCREENING);
  }
}

/**
 * «Salva la rettifica» di una visita chiusa: controlla la lista (riconferma dello
 * screening, ogni voce una volta sola) e ogni operazione (`validateVisitOp`) prima di scrivere; scrive la riga di `visit_amendments` con il motivo, l'istante
 * del clock e `changes` = `[{ op, before, after }]` (prima letto dalle tabelle, dopo = i valori
 * dell'operazione, più le scritture fuori dal bersaglio, `changesFor`); poi applica le operazioni in
 * ordine, nella stessa transazione e senza savepoint. Infine rilegge la colonna "Per chiudere" della
 * visita rettificata: ogni bloccante (screening, conflitto, ma anche presenti, reazione, irradiazione,
 * campi d'apertura) risponde con il suo testo, e con la transazione si annulla anche la riga della
 * rettifica (una visita chiusa resta chiudibile).
 */
export async function amendVisit(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id, visitId, reason, ops } = AmendVisitInput.parse(input);
  const visit = await loadVisit(tx, practiceId, visitId);
  if (visit?.status !== "closed") throw new DomainError(NOT_ALLOWED);
  if (await visitWriteExists(tx, practiceId, visitId, "visit_amendments", id)) return;

  requireReconfirmation(ops);
  await requireUniqueTargets(tx, practiceId, visit, ops);
  for (const op of ops) {
    // Anche una rettifica rifiuta l'id di una riga di un'altra visita prima di scrivere.
    await visitOpExists(tx, practiceId, visitId, op);
    await validateVisitOp(tx, practiceId, visit, op, "rettifica");
  }
  // Il "prima" si legge qui per tutte le operazioni, prima di scrivere: è esatto perché ogni voce
  // compare una volta sola nella lista (`requireUniqueTargets`).
  const changes: Change[] = [];
  for (const op of ops) changes.push(...(await changesFor(tx, practiceId, visit, op)));

  await tx.query(
    `insert into public.visit_amendments (practice_id, visit_id, amended_at, reason, changes, id)
     values ($1, $2, $3, $4, $5::jsonb, coalesce($6::uuid, gen_random_uuid()))`,
    [practiceId, visit.id, clock.now(), reason, JSON.stringify(changes), id ?? null],
  );
  for (const op of ops) await applyVisitOp(tx, practiceId, clock, visit, op, "rettifica");

  const [blocking] = closingCheck(await closingFactsFor(tx, practiceId, visit, "rettifica")).blocking;
  if (blocking) throw new DomainError(blocking.code === "screening" ? SCREENING_REOPENED : blocking.text);
}
