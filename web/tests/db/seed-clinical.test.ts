import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_TEST_CODES, SCREENING_ITEMS, SYSTEMS, type ScreeningGroup } from "@/lib/clinical/catalog";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { listRecalls } from "@/server/domain/patients/queries";
import { referralSuggestion } from "@/server/domain/referrals/queries";
import { seedDemo } from "../../seed/demo";
import { openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Il contenuto clinico del seed: la rubrica, i 24 test attivi, le
// visite di Marco, Anna, Roberto e Giulia scritte con i comandi dell'app, il rinvio di Roberto e i cicli chiusi
// con `closeCycle`; le altre storie della demo. Seed del 4/11/2026 alle 07:00, letture come utente demo.

const P = DEMO_PRACTICE_ID;
const D0 = "2026-11-04";
const SEEDED_AT = romeDateTime(D0, "07:00");
const SEED_DIR = join(import.meta.dirname, "..", "..", "seed");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  await seedDemo(db, fixedClock(SEEDED_AT), new MemoryFileStore());
});

afterAll(async () => {
  await pg?.close();
});

function asDemo<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asUser(getActor(), fn);
}

async function patientOf(tx: Tx, firstName: string, lastName: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    "select id from public.patients where practice_id = $1 and first_name = $2 and last_name = $3",
    [P, firstName, lastName],
  );
  if (!row) throw new Error(`${firstName} ${lastName} non c'è`);
  return row.id;
}

interface VisitRow {
  id: string;
  status: "draft" | "closed";
  visitDate: string;
  appointmentDay: string;
  nprsPre: number | null;
  nprsPost: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  treatmentResponse: string | null;
  screeningReviewedAt: Date | null;
}

/** Le visite del paziente in ordine di data, con il giorno di Roma del loro appuntamento. */
function visitsOf(tx: Tx, patientId: string): Promise<VisitRow[]> {
  return tx.query<VisitRow>(
    `select v.id, v.status, v.visit_date as "visitDate",
            to_char(a.starts_at at time zone 'Europe/Rome', 'YYYY-MM-DD') as "appointmentDay",
            v.nprs_pre as "nprsPre", v.nprs_post as "nprsPost",
            v.bp_systolic as "bpSystolic", v.bp_diastolic as "bpDiastolic",
            v.treatment_response as "treatmentResponse",
            v.screening_reviewed_at as "screeningReviewedAt"
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where v.practice_id = $1 and v.patient_id = $2
      order by v.visit_date, a.starts_at`,
    [P, patientId],
  );
}

function findingsOf(tx: Tx, visitId: string) {
  return tx.query<{
    region: string;
    severity: number;
    t: boolean;
    a: boolean;
    r: boolean;
    tn: boolean;
    side: string | null;
    segmentNote: string | null;
    isPrimary: boolean;
    copied: boolean;
  }>(
    `select region, severity, tissue_texture as t, asymmetry as a, restriction as r, tenderness as tn, side,
            segment_note as "segmentNote", is_primary as "isPrimary", copied
       from public.visit_region_findings where practice_id = $1 and visit_id = $2 order by region`,
    [P, visitId],
  );
}

function testsOf(tx: Tx, visitId: string) {
  return tx.query<{
    testCode: string;
    side: string | null;
    valueBool: boolean | null;
    valueLateral: string | null;
    valueNumeric: number | null;
    valueOrdinal: number | null;
  }>(
    `select test_code as "testCode", side, value_bool as "valueBool", value_lateral as "valueLateral",
            value_numeric::float8 as "valueNumeric", value_ordinal as "valueOrdinal"
       from public.visit_test_results where practice_id = $1 and visit_id = $2 and not copied
      order by test_code, side`,
    [P, visitId],
  );
}

function treatmentsOf(tx: Tx, visitId: string) {
  return tx.query<{ region: string; techniqueCode: string }>(
    `select region, technique_code as "techniqueCode"
       from public.visit_treatments where practice_id = $1 and visit_id = $2 and not copied
      order by region, technique_code`,
    [P, visitId],
  );
}

function outcomesOf(tx: Tx, visitId: string) {
  return tx.query<{ family: string; outcome: string; overrideNote: string | null }>(
    `select family, outcome, override_note as "overrideNote"
       from public.visit_screening_outcomes where practice_id = $1 and visit_id = $2
      order by array_position(array['thrust', 'direct', 'indirect'], family)`,
    [P, visitId],
  );
}

function answersOf(tx: Tx, visitId: string) {
  return tx.query<{ itemCode: string; answer: string; fromHistory: boolean }>(
    `select item_code as "itemCode", answer, from_history as "fromHistory"
       from public.visit_screening_answers where practice_id = $1 and visit_id = $2 order by item_code`,
    [P, visitId],
  );
}

function cycleOf(tx: Tx, patientId: string) {
  return tx
    .query<{
      id: string;
      title: string;
      status: string;
      outcome: string | null;
      closedOn: string | null;
      goal: string | null;
      chiefComplaint: string | null;
      mainRegion: string | null;
      planAgreedOn: string | null;
    }>(
      `select id, title, status, outcome, closed_on as "closedOn", goal, chief_complaint as "chiefComplaint",
              main_region as "mainRegion", plan_agreed_on as "planAgreedOn"
         from public.treatment_cycles where practice_id = $1 and patient_id = $2`,
      [P, patientId],
    )
    .then((rows) => {
      const [row] = rows;
      if (!row || rows.length !== 1) throw new Error("il paziente del seed ha un ciclo");
      return row;
    });
}

function psfsOf(tx: Tx, cycleId: string) {
  return tx.query<{ activity: string; score: number | null; phase: string | null; visitId: string | null }>(
    `select i.activity, s.score, s.phase, s.visit_id as "visitId"
       from public.psfs_items i
       left join public.psfs_scores s on s.practice_id = i.practice_id and s.item_id = i.id
      where i.practice_id = $1 and i.cycle_id = $2
      order by i.position`,
    [P, cycleId],
  );
}

const groupCodes = (groups: readonly ScreeningGroup[]): string[] =>
  SCREENING_ITEMS.filter((item) => groups.includes(item.group))
    .map((item) => item.code)
    .sort();

describe("seed clinico", () => {
  it("nessuno scrittore provvisorio resta in seed/", () => {
    const sources = readdirSync(SEED_DIR)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(SEED_DIR, name), "utf8"));
    expect(sources.length).toBeGreaterThan(0);
    for (const text of sources) {
      expect(text).not.toContain("completeRegistryTemporary");
      expect(text).not.toContain("closeCycleTemporary");
    }
  });

  it("le impostazioni della cartella hanno i 24 test attivi", async () => {
    const [row] = await asDemo((tx) =>
      tx.query<{ codes: string[] }>('select active_test_codes as codes from public.clinical_settings where practice_id = $1', [P]),
    );
    expect(row?.codes).toHaveLength(24);
    expect([...(row?.codes ?? [])].sort()).toEqual([...DEFAULT_ACTIVE_TEST_CODES].sort());
  });

  it("Marco: ciclo «Cervicalgia con cefalea» e la prima visita chiusa del P(10)", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Marco", "Bellandi");
      const cycle = await cycleOf(tx, id);
      const visits = await visitsOf(tx, id);
      const [visit] = visits;
      if (!visit) throw new Error("Marco non ha visite");
      return {
        cycle,
        visits,
        findings: await findingsOf(tx, visit.id),
        tests: await testsOf(tx, visit.id),
        treatments: await treatmentsOf(tx, visit.id),
        outcomes: await outcomesOf(tx, visit.id),
        answers: await answersOf(tx, visit.id),
        advice: await tx.query<{ templateCode: string; via: string[] }>(
          `select template_code as "templateCode", communicated_via as via
             from public.visit_advice where practice_id = $1 and visit_id = $2`,
          [P, visit.id],
        ),
        psfs: await psfsOf(tx, cycle.id),
        systems: await tx.query<{ system: string; status: string; note: string | null; reviewedOn: string }>(
          `select system, status, note, reviewed_on as "reviewedOn"
             from public.patient_systems_review where practice_id = $1 and patient_id = $2 order by system`,
          [P, id],
        ),
      };
    });

    expect(out.visits).toHaveLength(1);
    const [visit] = out.visits;
    if (!visit) throw new Error("visita mancante");
    // La prima visita del P(10), chiusa; nessuna visita sul D0.
    expect(visit.status).toBe("closed");
    expect(visit.visitDate).toBe(visit.appointmentDay);
    expect(visit.visitDate < D0).toBe(true);
    expect(visit).toMatchObject({ nprsPre: 7, nprsPost: 4, bpSystolic: 125, bpDiastolic: 80, treatmentResponse: "migliorato" });

    expect(out.cycle).toMatchObject({
      title: "Cervicalgia con cefalea",
      status: "open",
      goal: "Lavorare al computer 2 ore senza dolore",
      chiefComplaint: "Cervicalgia con cefalea che parte dalla nuca, lavorando al computer",
      mainRegion: "cervical",
      planAgreedOn: visit.visitDate,
    });
    expect(out.psfs).toEqual([
      { activity: "Lavorare al computer 2 ore", score: 4, phase: "iniziale", visitId: visit.id },
      { activity: "Guidare 30 minuti", score: 5, phase: "iniziale", visitId: visit.id },
      { activity: "Dormire sul fianco destro", score: 3, phase: "iniziale", visitId: visit.id },
    ]);

    expect(out.findings).toEqual([
      { region: "cervical", severity: 3, t: true, a: false, r: true, tn: true, side: "dx", segmentNote: "C2-C3 dx", isPrimary: true, copied: false },
      { region: "thoracic", severity: 2, t: false, a: true, r: true, tn: false, side: null, segmentNote: null, isPrimary: false, copied: false },
    ]);
    const blank = { valueBool: null, valueLateral: null, valueNumeric: null, valueOrdinal: null };
    expect(out.tests).toEqual([
      { ...blank, testCode: "flessione_rotazione", side: "dx", valueNumeric: 28 },
      { ...blank, testCode: "flessione_rotazione", side: "sx", valueNumeric: 40 },
      { ...blank, testCode: "riflesso_bicipitale", side: "dx", valueOrdinal: 0 },
      { ...blank, testCode: "riflesso_bicipitale", side: "sx", valueOrdinal: 0 },
      { ...blank, testCode: "riflesso_tricipitale", side: "dx", valueOrdinal: 0 },
      { ...blank, testCode: "riflesso_tricipitale", side: "sx", valueOrdinal: 0 },
      { ...blank, testCode: "spurling", side: "dx", valueBool: false },
      { ...blank, testCode: "spurling", side: "sx", valueBool: false },
    ]);
    expect(out.treatments).toEqual([
      { region: "cervical", techniqueCode: "energia_muscolare" },
      { region: "cervical", techniqueCode: "tessuti_molli" },
      { region: "thoracic", techniqueCode: "articolatoria" },
    ]);
    expect(out.advice).toEqual([{ templateCode: "pause_attive", via: ["a_voce"] }]);

    // "Nessun'altra voce" sui gruppi sistemiche, locali, rachide e cervicale: "no" su ogni voce, tre esiti indicati.
    expect(out.answers.map((a) => a.itemCode)).toEqual(groupCodes(["ci_sistemica", "ci_locale", "rf_rachide", "rf_cervicale_vascolare"]));
    expect(out.answers.every((a) => a.answer === "no" && !a.fromHistory)).toBe(true);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
    expect(visit.screeningReviewedAt).not.toBeNull();

    // Gli apparati: solo il sonno da segnalare, alla data della visita.
    expect(out.systems).toHaveLength(SYSTEMS.length);
    expect(out.systems.filter((s) => s.status === "da_segnalare")).toEqual([
      { system: "sonno", status: "da_segnalare", note: "Si sveglia con la nuca rigida", reviewedOn: visit.visitDate },
    ]);
  });

  it("Anna: Warfarin con TAO, due visite chiuse con l'INR e la bozza di oggi con lo screening confermato", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Anna", "Morelli");
      const visits = await visitsOf(tx, id);
      return {
        cycle: await cycleOf(tx, id),
        history: await tx.query<{ kind: string; label: string; riskTags: string[] }>(
          `select kind, label, risk_tags as "riskTags"
             from public.patient_history_items where practice_id = $1 and patient_id = $2 and deleted_at is null`,
          [P, id],
        ),
        visits: await Promise.all(
          visits.map(async (v) => ({
            visit: v,
            answers: await answersOf(tx, v.id),
            outcomes: await outcomesOf(tx, v.id),
            findings: await findingsOf(tx, v.id),
            treatments: await treatmentsOf(tx, v.id),
          })),
        ),
      };
    });

    expect(out.history).toEqual([{ kind: "farmaco", label: "Warfarin 5 mg", riskTags: ["anticoagulante_tao"] }]);
    expect(out.cycle.goal).toBe("Mantenere la schiena mobile");
    expect(out.visits.map((v) => [v.visit.status, v.visit.nprsPre])).toEqual([
      ["closed", 4],
      ["closed", 3],
      ["draft", null],
    ]);

    // La lombare di ogni visita, bozza compresa, è scritta nuova: nessuna riga copiata.
    const lumbar2 = { region: "lumbar", severity: 2, copied: false };
    for (const v of out.visits) {
      expect(v.answers.find((a) => a.itemCode === "ci_avk")).toEqual({ itemCode: "ci_avk", answer: "si", fromHistory: true });
      expect(v.answers.filter((a) => a.itemCode !== "ci_avk").every((a) => a.answer === "no" && !a.fromHistory)).toBe(true);
      expect(v.answers.map((a) => a.itemCode)).toEqual(groupCodes(["ci_sistemica", "ci_locale", "rf_rachide"]));
      expect(v.findings).toHaveLength(1);
      expect(v.findings[0]).toMatchObject(lumbar2);
    }
    for (const v of out.visits.slice(0, 2)) {
      expect(v.outcomes).toEqual([
        { family: "thrust", outcome: "contraindicated", overrideNote: null },
        { family: "direct", outcome: "caution", overrideNote: "INR 2,4 di due giorni prima, dal libretto TAO" },
        { family: "indirect", outcome: "indicated", overrideNote: null },
      ]);
      expect(v.treatments).toEqual([
        { region: "lumbar", techniqueCode: "funzionale" },
        { region: "lumbar", techniqueCode: "tessuti_molli" },
      ]);
    }

    const today = out.visits[2];
    if (!today) throw new Error("bozza mancante");
    expect(today.visit.visitDate).toBe(D0);
    expect(today.visit.screeningReviewedAt?.toISOString()).toBe(SEEDED_AT.toISOString());
    expect(today.outcomes).toEqual([
      { family: "thrust", outcome: "contraindicated", overrideNote: null },
      { family: "direct", outcome: "caution", overrideNote: "INR 2,5 del 03/11/2026 dal libretto TAO" },
      { family: "indirect", outcome: "indicated", overrideNote: null },
    ]);
    expect(today.treatments).toEqual([]);
  });

  it("Roberto: visita del D0-21 con due red flag, rinvio consegnato al Dott. Luca Ferri, ciclo rinviato al medico", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Roberto", "Esposito");
      const sofia = await patientOf(tx, "Sofia", "Rinaldi");
      const visits = await visitsOf(tx, id);
      const [visit] = visits;
      if (!visit) throw new Error("Roberto non ha visite");
      return {
        visits,
        cycle: await cycleOf(tx, id),
        answers: await answersOf(tx, visit.id),
        outcomes: await outcomesOf(tx, visit.id),
        treatments: await treatmentsOf(tx, visit.id),
        physicians: await tx.query<{ fullName: string; role: string }>(
          'select full_name as "fullName", role from public.physicians where practice_id = $1 order by full_name',
          [P],
        ),
        sofia: await tx.query<{ referring: string | null }>(
          `select f.full_name as referring
             from public.patients p left join public.physicians f on f.practice_id = p.practice_id and f.id = p.default_referring_physician_id
            where p.practice_id = $1 and p.id = $2`,
          [P, sofia],
        ),
        roberto: await tx.query<{ recallPaused: boolean; recallWeeks: number | null }>(
          `select recall_paused as "recallPaused", recall_interval_weeks as "recallWeeks"
             from public.patients where practice_id = $1 and id = $2`,
          [P, id],
        ),
        referrals: await tx.query<{
          reason: string;
          urgency: string;
          status: string;
          agreed: boolean;
          letterFileId: string | null;
          physician: string | null;
          visitId: string | null;
          deliveredOn: string | null;
        }>(
          `select r.reason, r.urgency, r.status, r.patient_agreed_to_share as agreed, r.letter_file_id as "letterFileId",
                  f.full_name as physician, r.visit_id as "visitId", r.delivered_on as "deliveredOn"
             from public.referrals r
             left join public.physicians f on f.practice_id = r.practice_id and f.id = r.physician_id
            where r.practice_id = $1 and r.patient_id = $2`,
          [P, id],
        ),
      };
    });

    expect(out.physicians).toEqual([
      { fullName: "Dott. Luca Ferri", role: "mmg" },
      { fullName: "Dott.ssa Carla Moretti", role: "pediatra" },
    ]);
    expect(out.sofia).toEqual([{ referring: "Dott.ssa Carla Moretti" }]);

    expect(out.visits).toHaveLength(1);
    const [visit] = out.visits;
    expect(visit).toMatchObject({ status: "closed", nprsPre: 6, visitDate: "2026-10-14" });
    const yes = out.answers.filter((a) => a.answer === "si").map((a) => a.itemCode);
    expect(yes).toEqual(["rf_nonmech", "rf_weight"]);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
    expect(out.treatments).toEqual([]);

    expect(out.referrals).toEqual([
      {
        reason: "red_flag",
        urgency: "programmato",
        status: "consegnata_al_paziente",
        agreed: true,
        letterFileId: null,
        physician: "Dott. Luca Ferri",
        visitId: visit?.id,
        deliveredOn: "2026-10-14",
      },
    ]);
    expect(out.cycle).toMatchObject({ status: "closed", outcome: "rinviato_al_medico", closedOn: "2026-10-14" });
    // «Nessun richiamo» alla chiusura: pausa, cadenza invariata.
    expect(out.roberto).toEqual([{ recallPaused: true, recallWeeks: 6 }]);
  });

  it("Giulia: tre visite chiuse con dolore, dita-pavimento, TFE, disfunzioni e PSFS iniziale", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Giulia", "Ferrante");
      const visits = await visitsOf(tx, id);
      const cycle = await cycleOf(tx, id);
      return {
        cycle,
        psfs: await psfsOf(tx, cycle.id),
        visits: await Promise.all(
          visits.map(async (v) => ({
            visit: v,
            findings: await findingsOf(tx, v.id),
            tests: await testsOf(tx, v.id),
            treatments: await treatmentsOf(tx, v.id),
            outcomes: await outcomesOf(tx, v.id),
          })),
        ),
      };
    });

    expect(out.visits.map((v) => [v.visit.status, v.visit.nprsPre])).toEqual([
      ["closed", 7],
      ["closed", 5],
      ["closed", 3],
    ]);
    expect(out.visits.map((v) => v.visit.visitDate)).toEqual(["2026-09-30", "2026-10-14", "2026-10-24"]);
    expect(out.visits.map((v) => v.tests.find((t) => t.testCode === "dita_pavimento")?.valueNumeric)).toEqual([28, 18, 10]);
    expect(out.visits.map((v) => v.tests.find((t) => t.testCode === "flessione_in_piedi")?.valueLateral)).toEqual([
      "dx",
      "dx",
      "neg",
    ]);
    expect(out.visits.map((v) => v.findings.map((f) => [f.region, f.severity]))).toEqual([
      [
        ["lumbar", 3],
        ["sacral", 2],
      ],
      [
        ["lumbar", 2],
        ["sacral", 1],
      ],
      [
        ["lumbar", 1],
        ["sacral", 1],
      ],
    ]);
    for (const v of out.visits) {
      expect(v.treatments).toEqual([{ region: "lumbar", techniqueCode: "tessuti_molli" }]);
      expect(v.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
    }
    expect(out.cycle).toMatchObject({ status: "open", mainRegion: "lumbar", goal: "Allacciarsi le scarpe senza dolore" });
    const first = out.visits[0]?.visit.id;
    expect(out.psfs).toEqual([
      { activity: "Guidare 30 minuti", score: 4, phase: "iniziale", visitId: first },
      { activity: "Dormire sul fianco destro", score: 3, phase: "iniziale", visitId: first },
      { activity: "Allacciarmi le scarpe", score: 5, phase: "iniziale", visitId: first },
    ]);
  });

  /** Gli appuntamenti `fatto` del paziente in ordine, con il giorno di Roma e la fine. */
  function doneOf(tx: Tx, patientId: string) {
    return tx.query<{ id: string; day: string; endsAt: Date }>(
      `select id, to_char(starts_at at time zone 'Europe/Rome', 'YYYY-MM-DD') as day, ends_at as "endsAt"
         from public.appointments where practice_id = $1 and patient_id = $2 and status = 'fatto' order by starts_at`,
      [P, patientId],
    );
  }

  function closedAtOf(tx: Tx, visitId: string) {
    return tx
      .query<{ closedAt: Date | null; appointmentId: string }>(
        'select closed_at as "closedAt", appointment_id as "appointmentId" from public.visits where practice_id = $1 and id = $2',
        [P, visitId],
      )
      .then(([row]) => row);
  }

  it("matteo_prima_visita: visita chiusa del P(2) con arto inferiore dx, Thomas e Ober dx positivi, dolore 4", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Matteo", "Ricci");
      const visits = await visitsOf(tx, id);
      const [visit] = visits;
      if (!visit) throw new Error("Matteo non ha visite");
      return {
        visits,
        done: await doneOf(tx, id),
        closed: await closedAtOf(tx, visit.id),
        findings: await findingsOf(tx, visit.id),
        tests: await testsOf(tx, visit.id),
        outcomes: await outcomesOf(tx, visit.id),
        cycle: await cycleOf(tx, id),
      };
    });
    expect(out.visits).toHaveLength(1);
    expect(out.done).toHaveLength(1);
    const [visit] = out.visits;
    const [appointment] = out.done;
    expect(visit).toMatchObject({ status: "closed", nprsPre: 4, visitDate: appointment?.day });
    expect(visit && visit.visitDate < D0).toBe(true);
    expect(out.closed?.appointmentId).toBe(appointment?.id);
    expect(out.closed?.closedAt?.toISOString()).toBe(appointment?.endsAt.toISOString());
    expect(out.findings.map((f) => [f.region, f.severity, f.side])).toEqual([["lower_extremity", 2, "dx"]]);
    const positive = out.tests.filter((t) => t.valueBool === true).map((t) => [t.testCode, t.side]);
    expect(positive).toEqual([
      ["ober", "dx"],
      ["thomas_modificato", "dx"],
    ]);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
    expect(out.cycle).toMatchObject({ status: "open", mainRegion: "lower_extremity" });
  });

  it("francesca_prima_visita: visita chiusa del D0-14 con regione cervicale, dolore 5 e rotazione cervicale attiva", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Francesca", "Longo");
      const visits = await visitsOf(tx, id);
      const [visit] = visits;
      if (!visit) throw new Error("Francesca non ha visite");
      return {
        visits,
        done: await doneOf(tx, id),
        closed: await closedAtOf(tx, visit.id),
        tests: await testsOf(tx, visit.id),
        outcomes: await outcomesOf(tx, visit.id),
        cycle: await cycleOf(tx, id),
      };
    });
    expect(out.visits).toHaveLength(1);
    const [visit] = out.visits;
    const [appointment] = out.done;
    expect(visit).toMatchObject({ status: "closed", nprsPre: 5, visitDate: "2026-10-21", appointmentDay: "2026-10-21" });
    expect(out.closed?.closedAt?.toISOString()).toBe(appointment?.endsAt.toISOString());
    expect(out.cycle).toMatchObject({ status: "open", mainRegion: "cervical" });
    const rotation = out.tests.filter((t) => t.testCode === "rom_rotazione_cervicale");
    expect(rotation.map((t) => t.side)).toEqual(["dx", "sx"]);
    expect(rotation.every((t) => t.valueNumeric !== null)).toBe(true);
    expect(out.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
  });

  it("valentina_due_visite: D0-17 con dolore 5 e P(1) con dolore 7, chiuse", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Valentina", "Greco");
      const visits = await visitsOf(tx, id);
      return {
        visits,
        done: await doneOf(tx, id),
        closed: await Promise.all(visits.map((v) => closedAtOf(tx, v.id))),
        cycle: await cycleOf(tx, id),
      };
    });
    expect(out.visits.map((v) => [v.status, v.nprsPre])).toEqual([
      ["closed", 5],
      ["closed", 7],
    ]);
    expect(out.visits.map((v) => v.appointmentDay)).toEqual(out.done.map((a) => a.day));
    // D0-17 è domenica 18/10: il seed sposta al sabato le prime visite domenicali del pomeriggio.
    expect(out.visits[0]?.visitDate).toBe("2026-10-17");
    expect(out.closed.map((c) => c?.closedAt?.toISOString())).toEqual(out.done.map((a) => a.endsAt.toISOString()));
    expect(out.cycle).toMatchObject({ status: "open", mainRegion: "lumbar" });
  });

  it("nessun_fatto_senza_visita: ogni appuntamento fatto dello studio demo ha la sua visita", async () => {
    const rows = await asDemo((tx) =>
      tx.query<{ name: string }>(
        `select distinct p.first_name || ' ' || p.last_name as name
           from public.appointments a
           join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
          where a.practice_id = $1 and a.status = 'fatto'
            and not exists (select 1 from public.visits v where v.practice_id = a.practice_id and v.appointment_id = a.id)
          order by name`,
        [P],
      ),
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  /** Le attività PSFS del ciclo in ordine, con l'iniziale, il finale e la visita del finale. */
  function psfsTrendOf(tx: Tx, cycleId: string) {
    return tx.query<{ activity: string; initial: number | null; final: number | null; finalVisitId: string | null }>(
      `select i.activity,
              max(s.score) filter (where s.phase = 'iniziale')::int as initial,
              max(s.score) filter (where s.phase = 'finale')::int as final,
              max(s.visit_id::text) filter (where s.phase = 'finale') as "finalVisitId"
         from public.psfs_items i
         left join public.psfs_scores s on s.practice_id = i.practice_id and s.item_id = i.id
        where i.practice_id = $1 and i.cycle_id = $2
        group by i.id, i.activity, i.position
        order by i.position`,
      [P, cycleId],
    );
  }

  /** Il valore di un test in ogni visita, nell'ordine delle visite. */
  const valuesOf = (
    visits: readonly { tests: Awaited<ReturnType<typeof testsOf>> }[],
    testCode: string,
    key: "valueNumeric" | "valueOrdinal" | "valueLateral" | "valueBool",
    side: string | null = null,
  ) => visits.map((v) => v.tests.find((t) => t.testCode === testCode && t.side === side)?.[key] ?? null);

  /** Paziente, ciclo, visite (con disfunzioni, test, tecniche, esiti e risposte) e appuntamenti fatti. */
  async function storyOf(tx: Tx, firstName: string, lastName: string) {
    const id = await patientOf(tx, firstName, lastName);
    const cycle = await cycleOf(tx, id);
    const visits = await visitsOf(tx, id);
    return {
      id,
      cycle,
      done: await doneOf(tx, id),
      psfs: await psfsTrendOf(tx, cycle.id),
      visits: await Promise.all(
        visits.map(async (v) => ({
          visit: v,
          closed: await closedAtOf(tx, v.id),
          findings: await findingsOf(tx, v.id),
          tests: await testsOf(tx, v.id),
          treatments: await treatmentsOf(tx, v.id),
          outcomes: await outcomesOf(tx, v.id),
          answers: await answersOf(tx, v.id),
        })),
      ),
    };
  }

  /** Ogni visita è chiusa sul suo appuntamento fatto, alla fine dell'appuntamento. */
  function expectClosedOnDone(story: Awaited<ReturnType<typeof storyOf>>, count: number) {
    expect(story.done).toHaveLength(count);
    expect(story.visits.map((v) => v.visit.status)).toEqual(Array(count).fill("closed"));
    expect(story.visits.map((v) => v.closed?.appointmentId)).toEqual(story.done.map((a) => a.id));
    expect(story.visits.map((v) => v.closed?.closedAt?.toISOString())).toEqual(story.done.map((a) => a.endsAt.toISOString()));
  }

  it("davide_ciclo_raggiunto: tre visite chiuse, lunge dx 8 -> 12, PSFS finali sulla visita del D0-66, richiamo scaduto da 11 giorni", async () => {
    const out = await asDemo(async (tx) => ({
      story: await storyOf(tx, "Davide", "Conti"),
      recalls: await listRecalls(tx, P, fixedClock(romeDateTime(D0, "07:30")), 7),
    }));
    const { story } = out;
    expectClosedOnDone(story, 3);
    // D0-66 è domenica 30/08: il seed la sposta al sabato.
    expect(story.visits.map((v) => v.visit.visitDate)).toEqual(["2026-08-06", "2026-08-18", "2026-08-29"]);
    const lunge = valuesOf(story.visits, "lunge_carico", "valueNumeric", "dx");
    expect([lunge[0], lunge[2]]).toEqual([8, 12]);
    const last = story.visits[2]?.visit.id;
    expect(story.psfs).toEqual([
      { activity: "Correre 30 minuti", initial: 3, final: 8, finalVisitId: last },
      { activity: "Scendere le scale", initial: 5, final: 9, finalVisitId: last },
      { activity: "Saltare sul posto", initial: 2, final: 7, finalVisitId: last },
    ]);
    expect(story.cycle).toMatchObject({ status: "closed", outcome: "raggiunto", closedOn: "2026-08-29", mainRegion: "lower_extremity" });
    // D0 = 4/11/2026 è un mercoledì.
    expect(out.recalls.rows.find((r) => r.name === "Davide Conti")?.dueText).toBe("Scaduto da 11 giorni");
  });

  it("chiara_gravidanza: in corso a 27 settimane, tag gravidanza, gruppo Gravidanza senza voci, ASLR 3 -> 1, tecniche indirette sul fianco sinistro", async () => {
    const out = await asDemo(async (tx) => {
      const story = await storyOf(tx, "Chiara", "Valli");
      return {
        story,
        lifestyle: await tx.query<{ status: string | null; weeks: number | null; reviewedOn: string | null }>(
          `select pregnancy_status as status, pregnancy_weeks as weeks, last_reviewed_on as "reviewedOn"
             from public.patient_lifestyle where practice_id = $1 and patient_id = $2`,
          [P, story.id],
        ),
        tags: await tx.query<{ riskTags: string[] }>(
          `select risk_tags as "riskTags" from public.patient_history_items
            where practice_id = $1 and patient_id = $2 and deleted_at is null`,
          [P, story.id],
        ),
        treatments: await tx.query<{ family: string; note: string | null }>(
          `select t.family, t.note from public.visit_treatments t
             join public.visits v on v.practice_id = t.practice_id and v.id = t.visit_id
            where t.practice_id = $1 and v.patient_id = $2`,
          [P, story.id],
        ),
      };
    });
    const { story } = out;
    expectClosedOnDone(story, 2);
    const first = story.visits[0];
    expect(out.lifestyle).toEqual([{ status: "in_corso", weeks: 27, reviewedOn: first?.visit.visitDate }]);
    expect(out.tags.flatMap((t) => t.riskTags)).toEqual(["gravidanza"]);
    // "Nessun'altra voce" anche sul gruppo Gravidanza: tutte "no".
    for (const v of story.visits) {
      expect(v.answers.map((a) => a.itemCode)).toEqual(groupCodes(["ci_sistemica", "ci_locale", "rf_rachide", "rf_gravidanza"]));
      expect(v.answers.every((a) => a.answer === "no")).toBe(true);
      expect(v.outcomes.map((o) => o.outcome)).toEqual(["indicated", "indicated", "indicated"]);
      expect(v.treatments.map((t) => t.techniqueCode).sort()).toEqual(["blt", "funzionale"]);
    }
    expect(valuesOf(story.visits, "aslr", "valueOrdinal", "dx")).toEqual([3, 1]);
    expect(out.treatments.length).toBeGreaterThan(0);
    expect(out.treatments.every((t) => t.family === "indirect" && t.note === "Sul fianco sinistro")).toBe(true);
  });

  it("giorgio_osteoporosi: tag osteoporosi, ci_osteo da anamnesi, thrust e dirette con cautela nelle due visite", async () => {
    const out = await asDemo(async (tx) => {
      const story = await storyOf(tx, "Giorgio", "Sala");
      return {
        story,
        tags: await tx.query<{ riskTags: string[] }>(
          `select risk_tags as "riskTags" from public.patient_history_items
            where practice_id = $1 and patient_id = $2 and deleted_at is null`,
          [P, story.id],
        ),
      };
    });
    const { story } = out;
    expectClosedOnDone(story, 2);
    expect(out.tags.flatMap((t) => t.riskTags)).toEqual(["osteoporosi"]);
    for (const v of story.visits) {
      expect(v.answers.find((a) => a.itemCode === "ci_osteo")).toEqual({ itemCode: "ci_osteo", answer: "si", fromHistory: true });
      expect(v.answers.filter((a) => a.itemCode !== "ci_osteo").every((a) => a.answer === "no")).toBe(true);
      expect(v.outcomes.map((o) => [o.family, o.outcome])).toEqual([
        ["thrust", "caution"],
        ["direct", "caution"],
        ["indirect", "indicated"],
      ]);
      expect(v.treatments.length).toBeGreaterThan(0);
    }
    expect(story.cycle).toMatchObject({ status: "open" });
  });

  it("martina_parziale: tre visite chiuse, Adams negativo, dita-pavimento 20 -> 12 cm, ciclo parzialmente raggiunto con i finali", async () => {
    const story = await asDemo((tx) => storyOf(tx, "Martina", "De Luca"));
    expectClosedOnDone(story, 3);
    expect(valuesOf(story.visits, "adams", "valueLateral")[0]).toBe("neg");
    const fingerFloor = valuesOf(story.visits, "dita_pavimento", "valueNumeric");
    expect([fingerFloor[0], fingerFloor[2]]).toEqual([20, 12]);
    expect(story.cycle).toMatchObject({ status: "closed", outcome: "parzialmente_raggiunto", closedOn: "2026-08-31" });
    const last = story.visits[2]?.visit.id;
    expect(story.psfs.length).toBeGreaterThan(0);
    for (const item of story.psfs) {
      expect(item.initial).not.toBeNull();
      expect(item.final).not.toBeNull();
      expect(item.finalVisitId).toBe(last);
    }
  });

  it("lorenzo_faber: una visita chiusa, Patrick (FABER) dx positivo con dolore, bacino severità 2", async () => {
    const out = await asDemo(async (tx) => {
      const story = await storyOf(tx, "Lorenzo", "Gatti");
      const visit = story.visits[0]?.visit.id ?? null;
      return {
        story,
        faber: await tx.query<{ side: string; valueBool: boolean; painProvoked: boolean | null }>(
          `select side, value_bool as "valueBool", pain_provoked as "painProvoked"
             from public.visit_test_results where practice_id = $1 and visit_id = $2 and test_code = 'faber'`,
          [P, visit],
        ),
      };
    });
    expectClosedOnDone(out.story, 1);
    expect(out.faber).toEqual([{ side: "dx", valueBool: true, painProvoked: true }]);
    expect(out.story.visits[0]?.findings.map((f) => [f.region, f.severity])).toEqual([["pelvic", 2]]);
    expect(out.story.cycle).toMatchObject({ status: "open", mainRegion: "pelvic" });
  });

  it("paolo_cervicale: una visita chiusa del D0-20, cervicale severità 2, rotazione cervicale attiva", async () => {
    const story = await asDemo((tx) => storyOf(tx, "Paolo", "Neri"));
    expectClosedOnDone(story, 1);
    const [visit] = story.visits;
    expect(visit?.findings.map((f) => [f.region, f.severity])).toEqual([["cervical", 2]]);
    const rotation = visit?.tests.filter((t) => t.testCode === "rom_rotazione_cervicale") ?? [];
    expect(rotation.map((t) => t.side)).toEqual(["dx", "sx"]);
    expect(rotation.every((t) => t.valueNumeric !== null)).toBe(true);
    expect(story.cycle).toMatchObject({ status: "open", mainRegion: "cervical" });
  });

  it("valentina_rinvio_bozza: rinvio non consegnato al Dott. Luca Ferri, motivo peggioramento, sulla visita di P(1) che propone R2", async () => {
    const out = await asDemo(async (tx) => {
      const id = await patientOf(tx, "Valentina", "Greco");
      const cycle = await cycleOf(tx, id);
      const visits = await visitsOf(tx, id);
      const second = visits[1]?.id;
      if (!second) throw new Error("Valentina non ha la visita di P(1)");
      return {
        second,
        suggestion: await referralSuggestion(tx, P, cycle.id, second),
        referrals: await tx.query<{
          reason: string;
          urgency: string;
          status: string;
          physician: string | null;
          recipientKind: string;
          visitId: string | null;
          deliveredOn: string | null;
          letterFileId: string | null;
        }>(
          `select r.reason, r.urgency, r.status, f.full_name as physician, r.recipient_kind as "recipientKind",
                  r.visit_id as "visitId", r.delivered_on as "deliveredOn", r.letter_file_id as "letterFileId"
             from public.referrals r
             left join public.physicians f on f.practice_id = r.practice_id and f.id = r.physician_id
            where r.practice_id = $1 and r.patient_id = $2`,
          [P, id],
        ),
      };
    });
    expect(out.suggestion).toEqual({ reason: "peggioramento", urgency: "programmato" });
    expect(out.referrals).toEqual([
      {
        reason: "peggioramento",
        urgency: "programmato",
        status: "bozza",
        physician: "Dott. Luca Ferri",
        recipientKind: "medico_curante",
        visitId: out.second,
        deliveredOn: null,
        letterFileId: null,
      },
    ]);
  });

  it("fatture_invariate: «Fatture da emettere» ha ancora Matteo e Valentina", async () => {
    const rows = await asDemo((tx) => listToInvoice(tx, P, fixedClock(romeDateTime(D0, "07:30"))));
    expect(rows.map((r) => r.patientName)).toEqual(["Matteo Ricci", "Valentina Greco"]);
  });
});
