import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEMS } from "@/lib/clinical/catalog";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import {
  removeHistoryItem,
  saveHistoryItem,
  saveLifestyle,
  savePerinatal,
  saveSystemsReview,
} from "@/server/domain/history/commands";
import { activeRiskTags, getHistory, pregnancyInProgress } from "@/server/domain/history/queries";
import { INVALID } from "@/server/domain/history/schemas";
import { PATIENT_A1, PATIENT_A2, PATIENT_A3, PRACTICE_A, PRACTICE_B } from "./fixtures";
import { asUserA, asUserB, inUserA, openTestDb } from "./helpers";

// L'anamnesi del paziente: voci con etichette di rischio, apparati,
// stile di vita con la gravidanza, storia perinatale. Come uA, mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando risponde con un DomainError di testo `message` (e sul campo `field`, se dato). */
async function expectDomainError(p: Promise<unknown>, message: string, field?: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
  if (field !== undefined) expect((error as { field?: string }).field).toBe(field);
}

/** Il comando fallisce nello schema: la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(nameOf(error), String(error)).toBe("ZodError");
  return toActionFailure(error, "test");
}

const ITEM = {
  kind: "farmaco",
  label: "Warfarin 5 mg",
  region: null,
  occurredOn: null,
  occurredYear: null,
  ongoing: true,
  note: null,
};
const item = (patientId: string, extra: Record<string, unknown> = {}) => ({ patientId, ...ITEM, ...extra });

const SCAR_TEXT = "La cicatrice vale per interventi e traumi, con la regione.";
const WEEKS_TEXT = "Scrivi le settimane, da 1 a 42.";

async function itemRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.patient_history_items where practice_id = $1 and id = $2", [
    PRACTICE_A,
    id,
  ]);
  return row;
}

describe("saveHistoryItem", () => {
  it("un farmaco TAO senza riskTags accende anticoagulante_tao, un NAO anticoagulante_nao, gli altri niente", async () => {
    await inUserA(db, async (tx) => {
      const tao = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2));
      const nao = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "Eliquis 5 mg" }));
      const other = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "Tachipirina 1000" }));
      expect((await itemRow(tx, tao.id))?.risk_tags).toEqual(["anticoagulante_tao"]);
      expect((await itemRow(tx, nao.id))?.risk_tags).toEqual(["anticoagulante_nao"]);
      expect((await itemRow(tx, other.id))?.risk_tags).toEqual([]);
    });
  });

  it("con riskTags [] l'etichetta tolta a mano resta tolta, e un'etichetta messa a mano si salva", async () => {
    await inUserA(db, async (tx) => {
      const removed = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { riskTags: [] }));
      expect((await itemRow(tx, removed.id))?.risk_tags).toEqual([]);
      const manual = await saveHistoryItem(
        tx,
        PRACTICE_A,
        clock,
        item(PATIENT_A2, { kind: "patologia", label: "Osteoporosi", riskTags: ["osteoporosi", "osteoporosi"] }),
      );
      expect((await itemRow(tx, manual.id))?.risk_tags).toEqual(["osteoporosi"]);
    });
  });

  it("un intervento con cicatrice e regione si salva con tutti i suoi campi", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveHistoryItem(
        tx,
        PRACTICE_A,
        clock,
        item(PATIENT_A2, {
          kind: "intervento",
          label: "  Appendicectomia  ",
          region: "abdomen_other",
          occurredOn: "2015-06-12",
          occurredYear: null,
          ongoing: false,
          riskTags: ["cicatrice"],
          note: "",
        }),
      );
      const row = await itemRow(tx, id);
      expect(row).toMatchObject({
        patient_id: PATIENT_A2,
        kind: "intervento",
        label: "Appendicectomia",
        region: "abdomen_other",
        occurred_on: "2015-06-12",
        ongoing: false,
        risk_tags: ["cicatrice"],
        note: null,
        deleted_at: null,
      });
      const trauma = await saveHistoryItem(
        tx,
        PRACTICE_A,
        clock,
        item(PATIENT_A2, { kind: "trauma", label: "Taglio al ginocchio", region: "lower_extremity", occurredYear: 2009, riskTags: ["cicatrice"] }),
      );
      expect((await itemRow(tx, trauma.id))?.occurred_year).toBe(2009);
    });
  });

  it("la cicatrice su una patologia, un farmaco o senza regione risponde con la frase, sul campo riskTags", async () => {
    await inUserA(db, async (tx) => {
      for (const extra of [
        { kind: "patologia", label: "Ernia", region: "lumbar", riskTags: ["cicatrice"] },
        { kind: "farmaco", label: "Cortisone", region: "lumbar", riskTags: ["cicatrice"] },
        { kind: "intervento", label: "Appendicectomia", region: null, riskTags: ["cicatrice"] },
      ]) {
        await expectDomainError(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, extra)), SCAR_TEXT, "riskTags");
      }
      const rows = await tx.query("select 1 from public.patient_history_items where patient_id = $1", [PATIENT_A2]);
      expect(rows).toHaveLength(0);
    });
  });

  it("un tag fuori vocabolario è «Valore non valido»", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { riskTags: ["magia"] })));
      expect(failure.message).toBe(INVALID);
      expect(failure.fieldErrors?.["riskTags.0"]).toBe(INVALID);
    });
  });

  it("etichetta obbligatoria e massimo 200, regione e tipo dal vocabolario, chiavi in più rifiutate", async () => {
    await inUserA(db, async (tx) => {
      expect((await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "   " })))).fieldErrors?.label).toBe(
        "Campo obbligatorio.",
      );
      expect(
        (await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "a".repeat(201) })))).fieldErrors?.label,
      ).toBe("Massimo 200 caratteri.");
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "a".repeat(200) }));
      expect((await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { region: "gomito" })))).message).toBe(INVALID);
      expect((await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { kind: "allergia" })))).message).toBe(INVALID);
      expect((await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { practiceId: PRACTICE_B })))).message).toBe(INVALID);
      expect(
        (await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { note: "a".repeat(501) })))).fieldErrors?.note,
      ).toBe("Massimo 500 caratteri.");
    });
  });

  it("l'anno fuori da 1900-2100 è «Scrivi un anno fra 1900 e 2100.»; gli estremi passano", async () => {
    await inUserA(db, async (tx) => {
      for (const occurredYear of [1899, 2101, 19]) {
        const failure = await formFailure(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { occurredYear })));
        expect(failure.fieldErrors?.occurredYear, String(occurredYear)).toBe("Scrivi un anno fra 1900 e 2100.");
      }
      for (const occurredYear of [1900, 2100]) await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { occurredYear }));
    });
  });

  it("con itemId modifica la voce: senza riskTags tiene quelli salvati, con riskTags li cambia", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2));
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { itemId: id, label: "Warfarin 3 mg", ongoing: false }));
      expect(await itemRow(tx, id)).toMatchObject({ label: "Warfarin 3 mg", ongoing: false, risk_tags: ["anticoagulante_tao"] });
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { itemId: id, riskTags: [] }));
      expect((await itemRow(tx, id))?.risk_tags).toEqual([]);
      const count = await tx.query("select 1 from public.patient_history_items where patient_id = $1", [PATIENT_A2]);
      expect(count).toHaveLength(1);
    });
  });

  it("la voce da modificare sta fra quelle di questo paziente, non tolte e dei quattro tipi", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2));
      // Un altro paziente dello stesso studio.
      await expectDomainError(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A3, { itemId: id })), NOT_ALLOWED);
      // Una voce che non c'è.
      await expectDomainError(
        saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { itemId: "a0000000-0000-4000-8000-0000000000ff" })),
        NOT_ALLOWED,
      );
      // Una voce tolta.
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, itemId: id });
      await expectDomainError(saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { itemId: id })), NOT_ALLOWED);
      // Un'allergia (nel modello, senza pulsante): non si riscrive come un altro tipo.
      const [allergy] = await tx.query<{ id: string }>(
        `insert into public.patient_history_items (practice_id, patient_id, kind, label)
         values ($1, $2, 'allergia', 'Penicillina') returning id`,
        [PRACTICE_A, PATIENT_A2],
      );
      await expectDomainError(
        saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { itemId: allergy?.id })),
        NOT_ALLOWED,
      );
    });
  });

  it("un paziente che non c'è è «Operazione non permessa»", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(
        saveHistoryItem(tx, PRACTICE_A, clock, item("a0000000-0000-4000-8000-0000000000ee")),
        NOT_ALLOWED,
      );
    });
  });
});

describe("removeHistoryItem", () => {
  it("scrive deleted_at all'istante del clock; la voce esce da getHistory e da activeRiskTags", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2));
      expect(await activeRiskTags(tx, PRACTICE_A, PATIENT_A2)).toEqual(["anticoagulante_tao"]);

      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, itemId: id });
      expect((await itemRow(tx, id))?.deleted_at).toEqual(clock.now());
      expect(await activeRiskTags(tx, PRACTICE_A, PATIENT_A2)).toEqual([]);
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A2)).items).toEqual([]);

      // Togliere di nuovo non sposta l'istante.
      await removeHistoryItem(tx, PRACTICE_A, fixedClock("2026-11-06T09:00:00+01:00"), { patientId: PATIENT_A2, itemId: id });
      expect((await itemRow(tx, id))?.deleted_at).toEqual(clock.now());
    });
  });

  it("una voce che non c'è, o di un altro paziente, è «Operazione non permessa»", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2));
      await expectDomainError(removeHistoryItem(tx, PRACTICE_A, clock, { patientId: PATIENT_A3, itemId: id }), NOT_ALLOWED);
      await expectDomainError(
        removeHistoryItem(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, itemId: "a0000000-0000-4000-8000-0000000000ff" }),
        NOT_ALLOWED,
      );
    });
  });
});

describe("activeRiskTags", () => {
  it("l'unione delle etichette delle voci attive, in ordine di vocabolario e senza doppioni", async () => {
    await inUserA(db, async (tx) => {
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { kind: "patologia", label: "Osteoporosi", riskTags: ["osteoporosi", "fumo"] }));
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "Sintrom" }));
      await saveHistoryItem(tx, PRACTICE_A, clock, item(PATIENT_A2, { label: "Coumadin" }));
      expect(await activeRiskTags(tx, PRACTICE_A, PATIENT_A2)).toEqual(["anticoagulante_tao", "osteoporosi", "fumo"]);
      expect(await activeRiskTags(tx, PRACTICE_A, PATIENT_A3)).toEqual([]);
    });
  });
});

const systemRows = (overrides: Record<string, { status: string; note: string | null }> = {}) =>
  SYSTEMS.map((s) => ({ system: s.code, status: "nulla", note: null, ...overrides[s.code] }));

describe("saveSystemsReview", () => {
  it("salva gli 8 apparati insieme, e salvando di nuovo aggiorna le stesse 8 righe", async () => {
    await inUserA(db, async (tx) => {
      await saveSystemsReview(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A2,
        reviewedOn: "2026-11-04",
        rows: systemRows({ sonno: { status: "da_segnalare", note: "Si sveglia con la nuca rigida" } }),
      });
      const first = await tx.query<{ system: string; status: string; note: string | null; reviewed_on: string }>(
        "select system, status, note, reviewed_on from public.patient_systems_review where patient_id = $1 order by system",
        [PATIENT_A2],
      );
      expect(first).toHaveLength(8);
      expect(first.find((r) => r.system === "sonno")).toMatchObject({
        status: "da_segnalare",
        note: "Si sveglia con la nuca rigida",
        reviewed_on: "2026-11-04",
      });

      await saveSystemsReview(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A2,
        reviewedOn: "2026-11-11",
        rows: systemRows({ sonno: { status: "nulla", note: "" } }),
      });
      const second = await tx.query<{ system: string; status: string; note: string | null; reviewed_on: string }>(
        "select system, status, note, reviewed_on from public.patient_systems_review where patient_id = $1 order by system",
        [PATIENT_A2],
      );
      expect(second).toHaveLength(8);
      expect(second.find((r) => r.system === "sonno")).toMatchObject({ status: "nulla", note: null, reviewed_on: "2026-11-11" });
    });
  });

  it("un paziente con già un apparato in anagrafica (fixture) resta a 8 righe", async () => {
    await inUserA(db, async (tx) => {
      await saveSystemsReview(tx, PRACTICE_A, clock, { patientId: PATIENT_A1, reviewedOn: "2026-11-04", rows: systemRows() });
      const rows = await tx.query("select 1 from public.patient_systems_review where patient_id = $1", [PATIENT_A1]);
      expect(rows).toHaveLength(8);
    });
  });

  it("getHistory dà sempre gli 8 apparati nell'ordine di SYSTEMS, «Niente da segnalare» per quelli mai salvati", async () => {
    await inUserA(db, async (tx) => {
      const empty = (await getHistory(tx, PRACTICE_A, PATIENT_A2)).systems;
      expect(empty.map((s) => s.system)).toEqual(SYSTEMS.map((s) => s.code));
      expect(empty.map((s) => s.label)).toEqual(SYSTEMS.map((s) => s.label));
      expect(empty.every((s) => s.status === "nulla" && s.note === null)).toBe(true);

      // Con rows in disordine, il risultato segue comunque SYSTEMS.
      await saveSystemsReview(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A2,
        reviewedOn: "2026-11-04",
        rows: [...systemRows({ digerente: { status: "da_segnalare", note: "Reflusso" } })].reverse(),
      });
      const saved = (await getHistory(tx, PRACTICE_A, PATIENT_A2)).systems;
      expect(saved.map((s) => s.system)).toEqual(SYSTEMS.map((s) => s.code));
      expect(saved[0]).toEqual({ system: "digerente", label: "Digerente", status: "da_segnalare", note: "Reflusso" });
    });
  });

  it("7 righe, un apparato ripetuto o sconosciuto sono «Valore non valido»; la nota arriva a 300", async () => {
    await inUserA(db, async (tx) => {
      const base = { patientId: PATIENT_A2, reviewedOn: "2026-11-04" };
      expect((await formFailure(saveSystemsReview(tx, PRACTICE_A, clock, { ...base, rows: systemRows().slice(1) }))).message).toBe(INVALID);
      const repeated = systemRows();
      repeated[7] = { system: "digerente", status: "nulla", note: null };
      expect((await formFailure(saveSystemsReview(tx, PRACTICE_A, clock, { ...base, rows: repeated }))).message).toBe(INVALID);
      const unknown = systemRows();
      unknown[7] = { system: "cute", status: "nulla", note: null };
      expect((await formFailure(saveSystemsReview(tx, PRACTICE_A, clock, { ...base, rows: unknown }))).message).toBe(INVALID);
      const longNote = systemRows({ sonno: { status: "da_segnalare", note: "a".repeat(301) } });
      expect(
        (await formFailure(saveSystemsReview(tx, PRACTICE_A, clock, { ...base, rows: longNote }))).message,
      ).toBe("Massimo 300 caratteri.");
      expect(
        (await formFailure(saveSystemsReview(tx, PRACTICE_A, clock, { ...base, reviewedOn: "04/11/2026", rows: systemRows() }))).fieldErrors
          ?.reviewedOn,
      ).toBe("Scrivi la data nel formato 22/10/2026.");
      const stored = await tx.query("select 1 from public.patient_systems_review where patient_id = $1", [PATIENT_A2]);
      expect(stored).toHaveLength(0);
    });
  });
});

// Un giorno della visita diverso dal "oggi" del clock (4/11): la data salvata è quella dell'input.
const VISIT_DAY = "2026-11-02";
const LIFESTYLE = {
  reviewedOn: VISIT_DAY,
  occupation: "Insegnante",
  sport: null,
  familyHistory: null,
  pregnancyStatus: null,
  pregnancyWeeks: null,
};
const lifestyle = (patientId: string, extra: Record<string, unknown> = {}) => ({ patientId, ...LIFESTYLE, ...extra });

describe("saveLifestyle", () => {
  it("«In corso» con 30 settimane: pregnancyInProgress è vero, e la riga è una sola anche salvando di nuovo", async () => {
    await inUserA(db, async (tx) => {
      expect(await pregnancyInProgress(tx, PRACTICE_A, PATIENT_A2)).toBe(false);
      await saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus: "in_corso", pregnancyWeeks: 30 }));
      expect(await pregnancyInProgress(tx, PRACTICE_A, PATIENT_A2)).toBe(true);
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A2)).lifestyle).toMatchObject({
        occupation: "Insegnante",
        pregnancyStatus: "in_corso",
        pregnancyWeeks: 30,
        lastReviewedOn: VISIT_DAY,
      });
      await saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { reviewedOn: "2026-11-10", pregnancyStatus: "in_corso", pregnancyWeeks: 31 }));
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A2)).lifestyle?.lastReviewedOn).toBe("2026-11-10");

      await saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus: "post_partum" }));
      expect(await pregnancyInProgress(tx, PRACTICE_A, PATIENT_A2)).toBe(false);
      const rows = await tx.query("select pregnancy_weeks from public.patient_lifestyle where patient_id = $1", [PATIENT_A2]);
      expect(rows).toEqual([{ pregnancy_weeks: null }]);
    });
  });

  it("le settimane senza «In corso» (no, post partum, niente) sono «Scrivi le settimane, da 1 a 42.» sul campo", async () => {
    await inUserA(db, async (tx) => {
      for (const pregnancyStatus of ["no", "post_partum", null]) {
        await expectDomainError(
          saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus, pregnancyWeeks: 12 })),
          WEEKS_TEXT,
          "pregnancyWeeks",
        );
      }
      const rows = await tx.query("select 1 from public.patient_lifestyle where patient_id = $1", [PATIENT_A2]);
      expect(rows).toHaveLength(0);
    });
  });

  it("le settimane fuori da 1-42 hanno lo stesso testo; 1 e 42 passano", async () => {
    await inUserA(db, async (tx) => {
      for (const pregnancyWeeks of [43, 0, -3, 12.5]) {
        const failure = await formFailure(
          saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus: "in_corso", pregnancyWeeks })),
        );
        expect(failure.fieldErrors?.pregnancyWeeks, String(pregnancyWeeks)).toBe(WEEKS_TEXT);
      }
      for (const pregnancyWeeks of [1, 42]) {
        await saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus: "in_corso", pregnancyWeeks }));
      }
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A2)).lifestyle?.pregnancyWeeks).toBe(42);
    });
  });

  it("«In corso» senza settimane si salva (non si sa ancora), e i testi vuoti diventano null", async () => {
    await inUserA(db, async (tx) => {
      await saveLifestyle(
        tx,
        PRACTICE_A,
        clock,
        lifestyle(PATIENT_A2, { occupation: "  ", sport: "Nuoto", familyHistory: "", pregnancyStatus: "in_corso" }),
      );
      expect(await pregnancyInProgress(tx, PRACTICE_A, PATIENT_A2)).toBe(true);
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A2)).lifestyle).toMatchObject({
        occupation: null,
        sport: "Nuoto",
        familyHistory: null,
        pregnancyWeeks: null,
      });
    });
  });

  it("senza reviewedOn o con una data scritta male non si salva niente", async () => {
    await inUserA(db, async (tx) => {
      const withoutDate = Object.fromEntries(Object.entries(lifestyle(PATIENT_A2)).filter(([key]) => key !== "reviewedOn"));
      expect((await formFailure(saveLifestyle(tx, PRACTICE_A, clock, withoutDate))).fieldErrors?.reviewedOn).toBe("Campo obbligatorio.");
      expect(
        (await formFailure(saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { reviewedOn: "02/11/2026" })))).fieldErrors?.reviewedOn,
      ).toBe("Scrivi la data nel formato 22/10/2026.");
      const rows = await tx.query("select 1 from public.patient_lifestyle where patient_id = $1", [PATIENT_A2]);
      expect(rows).toHaveLength(0);
    });
  });

  it("un valore fuori vocabolario o una chiave in più è «Valore non valido»", async () => {
    await inUserA(db, async (tx) => {
      expect((await formFailure(saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { pregnancyStatus: "forse" })))).message).toBe(INVALID);
      expect((await formFailure(saveLifestyle(tx, PRACTICE_A, clock, lifestyle(PATIENT_A2, { lastReviewedOn: "2026-11-04" })))).message).toBe(INVALID);
    });
  });
});

const PERINATAL = {
  gestationalAgeWeeks: null,
  birthWeightG: null,
  deliveryMode: null,
  presentation: null,
  labourHours: null,
  apgar1: null,
  apgar5: null,
  nicuStay: null,
  suctionDifficulty: null,
  plagiocephalyNoted: null,
  torticollisNoted: null,
  colic: null,
  reflux: null,
  feeding: null,
  preferredHeadSide: null,
  notes: null,
};
const perinatal = (patientId: string, extra: Record<string, unknown> = {}) => ({ patientId, ...PERINATAL, ...extra });

describe("savePerinatal", () => {
  it("salva e rilegge peso, apgar, settimane e le scelte, con il travaglio come numero", async () => {
    await inUserA(db, async (tx) => {
      await savePerinatal(
        tx,
        PRACTICE_A,
        clock,
        perinatal(PATIENT_A3, {
          gestationalAgeWeeks: 38,
          birthWeightG: 3200,
          deliveryMode: "cesareo_programmato",
          presentation: "podalica",
          labourHours: 4.5,
          apgar1: 8,
          apgar5: 10,
          nicuStay: false,
          colic: true,
          feeding: "misto",
          preferredHeadSide: "dx",
          notes: "Nata con un giro di cordone",
        }),
      );
      const perinatalRow = (await getHistory(tx, PRACTICE_A, PATIENT_A3)).perinatal;
      expect(perinatalRow).toMatchObject({
        gestationalAgeWeeks: 38,
        birthWeightG: 3200,
        deliveryMode: "cesareo_programmato",
        presentation: "podalica",
        apgar1: 8,
        apgar5: 10,
        nicuStay: false,
        suctionDifficulty: null,
        colic: true,
        feeding: "misto",
        preferredHeadSide: "dx",
        notes: "Nata con un giro di cordone",
      });
      // numeric(4,1) torna da PGlite come stringa: la query lo legge con ::float8.
      expect(perinatalRow?.labourHours).toBe(4.5);
      expect(typeof perinatalRow?.labourHours).toBe("number");
    });
  });

  it("i limiti dei check passano agli estremi e sono «Valore non valido» appena fuori", async () => {
    await inUserA(db, async (tx) => {
      for (const extra of [
        { birthWeightG: 300, apgar1: 0, apgar5: 10, labourHours: 0, gestationalAgeWeeks: 22 },
        { birthWeightG: 6500, labourHours: 72, gestationalAgeWeeks: 44 },
      ]) {
        await savePerinatal(tx, PRACTICE_A, clock, perinatal(PATIENT_A3, extra));
      }
      for (const extra of [
        { birthWeightG: 7000 },
        { birthWeightG: 299 },
        { apgar1: 11 },
        { apgar5: -1 },
        { gestationalAgeWeeks: 21 },
        { gestationalAgeWeeks: 45 },
        { labourHours: 72.5 },
        { labourHours: -1 },
        { labourHours: 4.55 },
        { birthWeightG: 3200.5 },
        { deliveryMode: "volo" },
        { feeding: "latte" },
      ]) {
        const failure = await formFailure(savePerinatal(tx, PRACTICE_A, clock, perinatal(PATIENT_A3, extra)));
        expect(failure.message, JSON.stringify(extra)).toBe(INVALID);
      }
      expect(
        (await formFailure(savePerinatal(tx, PRACTICE_A, clock, perinatal(PATIENT_A3, { notes: "a".repeat(1001) })))).fieldErrors?.notes,
      ).toBe("Massimo 1000 caratteri.");
      const row = (await getHistory(tx, PRACTICE_A, PATIENT_A3)).perinatal;
      expect(row).toMatchObject({ birthWeightG: 6500, labourHours: 72 });
    });
  });

  it("salvare di nuovo aggiorna la stessa riga e riscrive tutto il gruppo (un null salvato è un null)", async () => {
    await inUserA(db, async (tx) => {
      await savePerinatal(tx, PRACTICE_A, clock, perinatal(PATIENT_A1, { birthWeightG: 3100, colic: true }));
      await savePerinatal(tx, PRACTICE_A, clock, perinatal(PATIENT_A1, { apgar5: 9 }));
      const rows = await tx.query("select 1 from public.perinatal_histories where patient_id = $1", [PATIENT_A1]);
      expect(rows).toHaveLength(1);
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A1)).perinatal).toMatchObject({
        birthWeightG: null,
        colic: null,
        apgar5: 9,
      });
    });
  });

  it("una chiave che manca non diventa un null salvato: è «Valore non valido»", async () => {
    await inUserA(db, async (tx) => {
      const partial = Object.fromEntries(
        Object.entries(perinatal(PATIENT_A3, { birthWeightG: 3000 })).filter(([key]) => key !== "colic"),
      );
      expect((await formFailure(savePerinatal(tx, PRACTICE_A, clock, partial))).message).toBe(INVALID);
      expect((await getHistory(tx, PRACTICE_A, PATIENT_A3)).perinatal).toBeNull();
    });
  });
});

describe("getHistory", () => {
  it("un paziente senza anamnesi ha tutto vuoto e gli apparati a «nulla»", async () => {
    await inUserA(db, async (tx) => {
      const view = await getHistory(tx, PRACTICE_A, PATIENT_A2);
      expect(view.items).toEqual([]);
      expect(view.lifestyle).toBeNull();
      expect(view.perinatal).toBeNull();
      expect(view.systems).toHaveLength(8);
    });
  });

  it("le voci tengono i campi riletti, anche quelle del seed (un'allergia), e non quelle tolte", async () => {
    await inUserA(db, async (tx) => {
      const view = await getHistory(tx, PRACTICE_A, PATIENT_A1);
      expect(view.items.map((i) => i.label)).toEqual(["Distorsione di caviglia"]);
      expect(view.items[0]).toMatchObject({
        kind: "trauma",
        region: null,
        occurredOn: null,
        occurredYear: null,
        ongoing: true,
        riskTags: [],
        note: null,
      });
      expect(view.lifestyle?.occupation).toBe("Commessa");
    });
  });
});

// Studio B sugli id di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B sugli id di A", () => {
  let isolated: Db;
  let isolatedPg: PGlite;

  beforeAll(async () => {
    ({ db: isolated, pg: isolatedPg } = await openTestDb());
  });

  afterAll(async () => {
    await isolatedPg?.close();
  });

  const snapshotOfA = () =>
    asUserA(isolated, async (tx) => ({
      items: await tx.query("select * from public.patient_history_items where practice_id = $1 order by id", [PRACTICE_A]),
      systems: await tx.query("select * from public.patient_systems_review where practice_id = $1 order by id", [PRACTICE_A]),
      lifestyle: await tx.query("select * from public.patient_lifestyle where practice_id = $1 order by id", [PRACTICE_A]),
      perinatal: await tx.query("select * from public.perinatal_histories where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("ogni comando risponde «Operazione non permessa» e A non cambia; le letture di B non vedono A", async () => {
    const before = await snapshotOfA();
    const [seedItem] = before.items as { id: string }[];
    expect(seedItem).toBeDefined();
    await asUserB(isolated, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        const patientId = PATIENT_A1;
        await expectDomainError(saveHistoryItem(tx, practiceId, clock, item(patientId)), NOT_ALLOWED);
        await expectDomainError(
          saveHistoryItem(tx, practiceId, clock, item(patientId, { itemId: seedItem?.id, label: "Cambiato" })),
          NOT_ALLOWED,
        );
        await expectDomainError(removeHistoryItem(tx, practiceId, clock, { patientId, itemId: seedItem?.id }), NOT_ALLOWED);
        await expectDomainError(
          saveSystemsReview(tx, practiceId, clock, { patientId, reviewedOn: "2026-11-04", rows: systemRows() }),
          NOT_ALLOWED,
        );
        await expectDomainError(saveLifestyle(tx, practiceId, clock, lifestyle(patientId)), NOT_ALLOWED);
        await expectDomainError(savePerinatal(tx, practiceId, clock, perinatal(patientId)), NOT_ALLOWED);
      }
      const view = await getHistory(tx, PRACTICE_A, PATIENT_A1);
      expect(view.items).toEqual([]);
      expect(view.lifestyle).toBeNull();
      expect(await activeRiskTags(tx, PRACTICE_A, PATIENT_A1)).toEqual([]);
      expect(await pregnancyInProgress(tx, PRACTICE_A, PATIENT_A1)).toBe(false);
    });
    expect(await snapshotOfA()).toEqual(before);
  });
});
