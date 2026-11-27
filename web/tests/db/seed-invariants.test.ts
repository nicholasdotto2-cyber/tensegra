import { existsSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insideOpening, overlaps } from "@/lib/agenda/slots";
import { type AppointmentStatus, isActive } from "@/lib/agenda/status";
import type { RegionCode, TechniqueCode } from "@/lib/clinical/catalog";
import { checkTreatment } from "@/lib/clinical/rules";
import { toFatturaModel } from "@/lib/fiscal/model";
import { sdiChecks } from "@/lib/fiscal/sdi-checks";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { dayField, timeOf } from "@/lib/format";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { addDaysRome, daysBetween, endsSameRomeDay, fixedClock, isoWeekday, romeDateTime, romeMinutes, todayRome } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { bookingDefaults, listDayAppointments, listReminders, previewAppointment, suggestStart } from "@/server/domain/appointments/queries";
import { listMissingConsents } from "@/server/domain/consents/queries";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { listRecalls } from "@/server/domain/patients/queries";
import { listActiveServices } from "@/server/domain/services/queries";
import { bandsOf, openDayAfter } from "@/server/domain/settings/opening-days";
import { getOpeningHours, getPracticeSettings } from "@/server/domain/settings/queries";
import { getVisitEditor } from "@/server/domain/visits/editor";
import { loadScreeningState } from "@/server/domain/visits/ops";
import { seedDemo } from "../../seed/demo";
import { seedCounters } from "../../seed/invoices";
import { openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Invarianti del seed per i passi 1 e 2 della demo: per ogni D0 della settimana, nella
// settimana del cambio d'ora (la domenica 25/10/2026 ha 25 ore) e a metà gennaio, il seed delle 07:00 e
// le letture di Oggi e del dialogo "Nuovo appuntamento" come utente demo alle 07:30, alle 12:30 e alle
// 18:30. Ogni D0 ha il suo database clonato dal modello. Per la cartella: nessun istante
// clinico dopo l'ora di controllo, nessuna tecnica in contrasto con gli esiti della sua visita (punto 9) e
// l'avviso clinico di Oggi solo su Anna.

const P = DEMO_PRACTICE_ID;

const D0S = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-10-23",
  "2026-10-25",
  "2026-10-26",
  "2027-01-13",
];
const HOURS = ["07:30", "12:30", "18:30"];

// P(1) del seed, atteso fisso: il lunedì torna al sabato, D0 domenicale apre anche la domenica.
const PREVIOUS_OPEN_DAY: Record<string, string> = {
  "2026-11-02": "2026-10-31",
  "2026-11-03": "2026-11-02",
  "2026-11-04": "2026-11-03",
  "2026-11-05": "2026-11-04",
  "2026-11-06": "2026-11-05",
  "2026-11-07": "2026-11-06",
  "2026-11-08": "2026-11-07",
  "2026-10-23": "2026-10-22",
  "2026-10-25": "2026-10-24",
  "2026-10-26": "2026-10-24",
  "2027-01-13": "2027-01-12",
};

type Rows = [label: string, time: string][];

/** Le ore della demo nei giorni con due fasce, in fila dalle 09:00 nei giorni con la sola mattina. */
const TODAY: Record<"twoBands" | "oneBand", Rows> = {
  twoBands: [
    ["Bellandi Marco", "09:00"],
    ["Morelli Anna", "10:00"],
    ["Rinaldi Sofia, 4 mesi", "11:00"],
    ["Ferrante Giulia", "15:00"],
    ["Longo Francesca", "16:00"],
  ],
  oneBand: [
    ["Bellandi Marco", "09:00"],
    ["Morelli Anna", "09:45"],
    ["Rinaldi Sofia, 4 mesi", "10:15"],
    ["Ferrante Giulia", "11:15"],
    ["Longo Francesca", "12:00"],
  ],
};

const TOMORROW: Record<"twoBands" | "oneBand", Rows> = {
  twoBands: [
    ["Chiara Valli", "09:30"],
    ["Elisa Fontana", "11:00"],
    ["Paolo Neri", "17:00"],
  ],
  oneBand: [
    ["Chiara Valli", "09:00"],
    ["Elisa Fontana", "09:45"],
    ["Paolo Neri", "10:45"],
  ],
};

const shapeOf = (bands: readonly unknown[]): "twoBands" | "oneBand" => (bands.length === 1 ? "oneBand" : "twoBands");

function asDemo<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asUser(getActor(), fn);
}

it("copertura_invarianti: i dieci punti hanno una prova o un file dichiarato", ({ task }) => {
  // I titoli vengono dai test raccolti da Vitest: una voce senza il suo `it` non basta.
  type CollectedTask = { name: string; tasks?: readonly CollectedTask[] };
  const names = (tasks: readonly CollectedTask[]): string[] =>
    tasks.flatMap((entry) => entry.tasks ? names(entry.tasks) : [entry.name]);
  const collected = names(task.file.tasks);
  const coverage = [
    { point: 1, tests: ["invariante 1:"] },
    { point: 2, tests: ["invariante 2:", "matrice_seed:"] },
    { point: 3, tests: ["invariante 3:"] },
    { point: 4, tests: ["invariante 4:"] },
    { point: 5, tests: ["invarianti fiscali 5 e 8:"] },
    { point: 6, tests: ["invariante 6:"] },
    { point: 7, file: "../e2e/links.spec.ts" },
    { point: 8, tests: ["invarianti fiscali 5 e 8:"] },
    { point: 9, tests: ["invariante 9: codici inventati", "invariante 9: nessuna riga di trattamento", "invariante 9: R2 attiva solo per Valentina"] },
    { point: 10, file: "./seed-consents-messages.test.ts" },
  ];
  expect(coverage.map(({ point }) => point)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const entry of coverage) {
    if (entry.file) expect(existsSync(new URL(entry.file, import.meta.url)), `punto ${entry.point}: ${entry.file}`).toBe(true);
    for (const title of entry.tests ?? []) {
      expect(collected.some((name) => name.startsWith(title)), `punto ${entry.point}: ${title}`).toBe(true);
    }
  }
});

describe.each(D0S)("seed con D0 %s", (d0) => {
  const seededAt = romeDateTime(d0, "07:00");
  let db: Db;
  let pg: PGlite;

  beforeAll(async () => {
    ({ db, pg } = await openTestDb());
    await seedDemo(db, fixedClock(seededAt), new MemoryFileStore());
  });

  afterAll(async () => {
    await pg?.close();
  });

  it("banner: studio demo, creato all'istante del seed, versione 1", async () => {
    const settings = await asDemo(db, (tx) => getPracticeSettings(tx, P));
    expect(settings).toMatchObject({ isDemo: true, demoSeedVersion: 1 });
    expect(settings?.demoSeededAt?.toISOString()).toBe(seededAt.toISOString());
  });

  it("la bozza di oggi di Anna porta l'INR del giorno di calendario prima di D0", async () => {
    const notes = await asDemo(db, (tx) =>
      tx.query<{ note: string | null }>(
        `select o.override_note as note
           from public.visit_screening_outcomes o
           join public.visits v on v.practice_id = o.practice_id and v.id = o.visit_id
           join public.patients p on p.practice_id = v.practice_id and p.id = v.patient_id
          where o.practice_id = $1 and p.first_name = 'Anna' and p.last_name = 'Morelli'
            and v.status = 'draft' and v.visit_date = $2 and o.family = 'direct'`,
        [P, d0],
      ),
    );
    expect(notes).toEqual([{ note: `INR 2,5 del ${dayField(addDaysRome(d0, -1))} dal libretto TAO` }]);
  });

  it("davide_per_ogni_d0: il ritardo vero del richiamo, 11 giorni solo se D0 è un mercoledì", async () => {
    const recalls = await asDemo(db, (tx) => listRecalls(tx, P, fixedClock(romeDateTime(d0, "07:30")), 7));
    const davide = recalls.rows.find((row) => row.name === "Davide Conti");
    expect(davide?.dueText).toBe(isoWeekday(d0) === 3 ? "Scaduto da 11 giorni" : "Scaduto da 10 giorni");
  });

  it("invariante 6: ogni appuntamento finisce lo stesso giorno, nessuna sovrapposizione fra attivi", async () => {
    const rows = await asDemo(db, (tx) =>
      tx.query<{ startsAt: Date; durationMin: number; status: AppointmentStatus }>(
        `select starts_at as "startsAt", duration_min as "durationMin", status
           from public.appointments where practice_id = $1 order by starts_at`,
        [P],
      ),
    );
    expect(rows.length).toBe(37);
    const byDay = new Map<string, { startMin: number; endMin: number }[]>();
    for (const row of rows) {
      expect(endsSameRomeDay(row.startsAt, row.durationMin)).toBe(true);
      if (!isActive(row.status)) continue;
      const day = todayRome(row.startsAt);
      const startMin = romeMinutes(row.startsAt);
      byDay.set(day, [...(byDay.get(day) ?? []), { startMin, endMin: startMin + row.durationMin }]);
    }
    for (const [day, spans] of byDay) {
      spans.forEach((a, i) => {
        for (const b of spans.slice(i + 1)) expect(overlaps(a, b), `${day} ${a.startMin} ${b.startMin}`).toBe(false);
      });
    }
  });

  describe.each(HOURS)("alle %s", (time) => {
    const clock = fixedClock(romeDateTime(d0, time));

    it("invariante 1: 5 appuntamenti attivi di oggi, tutti negli orari", async () => {
      const { rows, week } = await asDemo(db, async (tx) => ({
        rows: await listDayAppointments(tx, P, clock, d0),
        week: await getOpeningHours(tx, P),
      }));
      const bands = bandsOf(week, d0);
      const active = rows.filter((row) => isActive(row.status));
      expect(active.map((row) => [row.patientLabel, timeOf(row.startsAt)])).toEqual(TODAY[shapeOf(bands)]);
      for (const row of active) {
        expect(insideOpening(bands, romeMinutes(row.startsAt), romeMinutes(row.endsAt)), row.patientLabel).toBe(true);
      }
    });

    it("invariante 2: i promemoria di A(1) sono Chiara, Elisa e Paolo", async () => {
      const { block, week } = await asDemo(db, async (tx) => ({
        block: await listReminders(tx, P, clock),
        week: await getOpeningHours(tx, P),
      }));
      expect(block.day).toBe(openDayAfter(week, d0, 1));
      expect(block.rows.map((row) => [row.recipientText, timeOf(row.startsAt)])).toEqual(
        TOMORROW[shapeOf(bandsOf(week, block.day))],
      );
    });

    it("invariante 3: due sedute da fatturare e due pazienti senza consensi", async () => {
      const { toInvoice, missing } = await asDemo(db, async (tx) => ({
        toInvoice: await listToInvoice(tx, P, clock),
        missing: await listMissingConsents(tx, P, clock),
      }));
      expect(toInvoice.map((row) => row.patientName)).toEqual(["Matteo Ricci", "Valentina Greco"]);
      expect(missing.map((row) => `${row.firstName} ${row.lastName}`)).toEqual(["Sofia Rinaldi", "Elisa Fontana"]);
    });

    it("istanti clinici mai dopo l'ora di controllo (i created_at sono l'ora vera e non si guardano)", async () => {
      const [late] = await asDemo(db, (tx) =>
        tx.query<{ reviewed: number; closed: number; amended: number }>(
          `select (select count(*)::int from public.visits where practice_id = $1 and screening_reviewed_at > $2) as reviewed,
                  (select count(*)::int from public.visits where practice_id = $1 and closed_at > $2) as closed,
                  (select count(*)::int from public.visit_amendments where practice_id = $1 and amended_at > $2) as amended`,
          [P, clock.now()],
        ),
      );
      expect(late).toEqual({ reviewed: 0, closed: 0, amended: 0 });
    });

    it("nessun_istante_dopo_l_ora: le visite del seed clinico completo entrano nel controllo degli istanti clinici", async () => {
      const rows = await asDemo(db, (tx) =>
        tx.query<{ name: string; visits: number; late: number; referrals: number; lateReferrals: number }>(
          `select p.first_name || ' ' || p.last_name as name,
                  count(v.id)::int as visits,
                  count(v.id) filter (where v.closed_at > $2 or v.screening_reviewed_at > $2)::int as late,
                  (select count(*)::int from public.referrals r where r.practice_id = p.practice_id and r.patient_id = p.id) as referrals,
                  (select count(*)::int from public.referrals r
                    where r.practice_id = p.practice_id and r.patient_id = p.id and r.created_on > $3) as "lateReferrals"
             from public.patients p
             join public.visits v on v.practice_id = p.practice_id and v.patient_id = p.id
            where p.practice_id = $1
              and (p.first_name, p.last_name) in (('Davide', 'Conti'), ('Chiara', 'Valli'), ('Giorgio', 'Sala'),
                   ('Martina', 'De Luca'), ('Lorenzo', 'Gatti'), ('Paolo', 'Neri'), ('Valentina', 'Greco'))
            group by p.practice_id, p.id, p.first_name, p.last_name
            order by name`,
          [P, clock.now(), d0],
        ),
      );
      // Il numero di visite della demo per paziente: senza le visite nuove il controllo passerebbe per assenza.
      expect(rows.map((r) => [r.name, r.visits, r.referrals])).toEqual([
        ["Chiara Valli", 2, 0],
        ["Davide Conti", 3, 0],
        ["Giorgio Sala", 2, 0],
        ["Lorenzo Gatti", 1, 0],
        ["Martina De Luca", 3, 0],
        ["Paolo Neri", 1, 0],
        ["Valentina Greco", 2, 1],
      ]);
      expect(rows.every((r) => r.late === 0 && r.lateReferrals === 0)).toBe(true);
    });

    it("invarianti fiscali 5 e 8: bolli, mese precedente, numeri, giorni di Roma e SdI", async () => {
      const { invoices, events } = await asDemo(db, async (tx) => ({
        invoices: await tx.query<{
          id: string; doc_type: string; year: number; number: number; issue_date: string;
          issued_at: Date; stamp_due: boolean; recipient_kind: string; snapshot: InvoiceSnapshot; xml: string;
        }>(`select id, doc_type, year, number, issue_date, issued_at, stamp_due, recipient_kind, snapshot, xml
              from public.invoices where practice_id = $1 and status <> 'bozza' order by issued_at`, [P]),
        events: await tx.query<{ invoice_id: string; at: Date }>(
          `select e.invoice_id, e.at from public.invoice_events e
             join public.invoices i on i.practice_id = e.practice_id and i.id = e.invoice_id
            where e.practice_id = $1 and i.status <> 'bozza'`, [P]),
      }));
      expect(invoices).toHaveLength(24);
      expect(invoices.some((r) => r.stamp_due)).toBe(true);
      expect(invoices.some((r) => !r.stamp_due)).toBe(true);
      const previousMonth = addDaysRome(`${d0.slice(0, 7)}-01`, -1).slice(0, 7);
      expect(invoices.filter((r) => r.doc_type === "TD01" && r.recipient_kind !== "committente"
        && r.issue_date.startsWith(previousMonth)).length).toBeGreaterThanOrEqual(3);
      const last = new Map(seedCounters(d0).filter((r) => r.series === "TD01").map((r) => [r.year, r.lastNumber]));
      const lastDay = new Map<number, string>();
      let creditNumber = 0;
      for (const row of invoices) {
        expect(row.issued_at.getTime()).toBeLessThanOrEqual(clock.now().getTime());
        expect(todayRome(row.issued_at)).toBe(row.issue_date);
        expect(row.year).toBe(Number(row.issue_date.slice(0, 4)));
        if (row.doc_type === "TD01") {
          expect(row.number).toBe((last.get(row.year) ?? 0) + 1);
          expect(row.issue_date >= (lastDay.get(row.year) ?? "")).toBe(true);
          last.set(row.year, row.number);
          lastDay.set(row.year, row.issue_date);
        } else expect(row.number).toBe(++creditNumber);
        expect(row.xml).toBeTruthy();
        expect(sdiChecks(toFatturaModel(row.snapshot))).toEqual([]);
        for (const event of events.filter((e) => e.invoice_id === row.id)) {
          expect(todayRome(event.at)).toBe(row.issue_date);
          expect(event.at.getTime()).toBeLessThanOrEqual(clock.now().getTime());
        }
      }
      expect(creditNumber).toBe(1);
    });

    it("invariante 9: R2 attiva solo per Valentina sulla visita di P(1)", async () => {
      await asDemo(db, async (tx) => {
        const visits = await tx.query<{
          id: string; patientId: string; firstName: string; lastName: string; day: string; status: string;
        }>(
          `select v.id, v.patient_id as "patientId", p.first_name as "firstName", p.last_name as "lastName",
                  v.visit_date as day, v.status
             from public.visits v
             join public.patients p on p.practice_id = v.practice_id and p.id = v.patient_id
            where v.practice_id = $1 order by v.visit_date, v.id`,
          [P],
        );
        expect(visits.length).toBeGreaterThan(0);
        const isValentina = (v: typeof visits[number]) => v.firstName === "Valentina" && v.lastName === "Greco";
        const target = (v: typeof visits[number]) => isValentina(v) && v.day === PREVIOUS_OPEN_DAY[d0];
        // Anche la presenza delle due visite è obbligatoria: il controllo non passa per assenza.
        expect(visits.filter(isValentina)).toHaveLength(2);
        expect(visits.filter(target)).toHaveLength(1);
        expect(visits.filter((v) => v.status === "draft").map((v) => [v.firstName, v.lastName, v.day])).toEqual([
          ["Anna", "Morelli", d0],
        ]);
        for (const visit of visits) {
          expect(["closed", "draft"]).toContain(visit.status);
          const editor = await getVisitEditor(tx, P, clock, visit.patientId, visit.id);
          expect(editor, `${visit.firstName} ${visit.lastName}, ${visit.day}`).not.toBeNull();
          expect(editor!.prompts.some((prompt) => prompt.code === "R2"),
            `${visit.firstName} ${visit.lastName}, ${visit.day}, ${time}`).toBe(target(visit));
        }
      });
    });

    it("invariante 9: codici inventati anche nei committenti e nelle fotografie", async () => {
      const values = await asDemo(db, async (tx) => ({
        people: await tx.query<{ tax_code: string | null }>(
          `select tax_code from public.patients where practice_id = $1
           union all select tax_code from public.patient_guardians where practice_id = $1`, [P]),
        fiscal: await tx.query<{ tax_code: string | null; vat_number: string | null; iban: string | null }>(
          `select tax_code, vat_number, iban from public.fiscal_settings where practice_id = $1`, [P]),
        parties: await tx.query<{ tax_code: string | null; vat_number: string | null }>(
          `select tax_code, vat_number from public.billing_parties where practice_id = $1`, [P]),
        snapshots: await tx.query<{ snapshot: InvoiceSnapshot }>(
          `select snapshot from public.invoices where practice_id = $1 and status <> 'bozza'`, [P]),
      }));
      const taxCodes = [...values.people.map((r) => r.tax_code), ...values.fiscal.map((r) => r.tax_code),
        ...values.parties.map((r) => r.tax_code), ...values.snapshots.flatMap(({ snapshot: s }) => [s.supplier.taxCode, s.recipient.taxCode])];
      const vats = [...values.fiscal.map((r) => r.vat_number), ...values.parties.map((r) => r.vat_number),
        ...values.snapshots.flatMap(({ snapshot: s }) => [s.supplier.vatNumber, s.recipient.vatNumber])];
      for (const code of taxCodes.filter((v) => v !== null)) {
        if (code.length === 11) expect(code.slice(7, 10)).toBe("000");
        else expect(code.slice(11, 15)).toBe("X999");
      }
      for (const vat of vats.filter((v) => v !== null)) expect(vat.slice(7, 10)).toBe("000");
      const ibans = [...values.fiscal.map((r) => r.iban), ...values.snapshots.map(({ snapshot: s }) => s.payment.iban)];
      for (const iban of ibans.filter((v) => v !== null)) expect(iban.slice(5, 10)).toBe("00000");
    });

    it("invariante 9: nessuna riga di trattamento in contrasto con gli esiti salvati della sua visita", async () => {
      const checks = await asDemo(db, async (tx) => {
        const rows = await tx.query<{
          visitId: string;
          region: RegionCode;
          techniqueCode: TechniqueCode;
          customTechnique: string | null;
          approach: "direct" | "indirect" | null;
        }>(
          `select visit_id as "visitId", region, technique_code as "techniqueCode",
                  custom_technique as "customTechnique", approach
             from public.visit_treatments where practice_id = $1 order by visit_id, region, technique_code`,
          [P],
        );
        const out: { techniqueCode: string; kind: string }[] = [];
        for (const row of rows) {
          const check = checkTreatment(row, await loadScreeningState(tx, P, row.visitId));
          out.push({ techniqueCode: row.techniqueCode, kind: check.kind });
        }
        return out;
      });
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.filter((c) => c.kind === "blocked")).toEqual([]);
    });

    it("sul D0 l'avviso clinico di Oggi c'è solo sulla riga di Anna", async () => {
      const rows = await asDemo(db, (tx) => listDayAppointments(tx, P, clock, d0));
      expect(rows.filter((row) => row.signals.includes("avviso_clinico")).map((row) => row.patientLabel)).toEqual([
        "Morelli Anna",
      ]);
    });

    it("invariante 4: Davide scaduto e Giorgio da richiamare, Martina senza consenso, Anna mai", async () => {
      const recalls = await asDemo(db, (tx) => listRecalls(tx, P, clock, 7));
      expect(recalls.rows.map((row) => row.name)).toEqual(["Davide Conti", "Giorgio Sala"]);
      expect(recalls.rows[0]?.dueText).toMatch(/^Scaduto/);
      expect(recalls.withoutConsent.map((row) => row.name)).toEqual(["Martina De Luca"]);
    });

    it("matrice_seed: 2 richiami più 1 senza consenso, 3 promemoria con il loro stato, 2 consensi mancanti", async () => {
      const { recalls, reminders, missing } = await asDemo(db, async (tx) => ({
        recalls: await listRecalls(tx, P, clock, 7),
        reminders: await listReminders(tx, P, clock),
        missing: await listMissingConsents(tx, P, clock),
      }));
      expect(recalls.rows).toHaveLength(2);
      expect(recalls.withoutConsent).toHaveLength(1);
      expect(reminders.rows.map((row) => [row.recipientText, row.statusText])).toEqual([
        ["Chiara Valli", "Da inviare"],
        ["Elisa Fontana", "Manca il consenso WhatsApp: telefona o usa Copia per un SMS"],
        ["Paolo Neri", "Da inviare"],
      ]);
      // I due consensi mancanti sono quelli di Sofia ed Elisa.
      expect(missing.map((row) => `${row.firstName} ${row.lastName}`).sort()).toEqual(["Elisa Fontana", "Sofia Rinaldi"]);
    });

    it("passo 2: la serie di Matteo ogni 2 settimane per 3, tre date libere a 14 giorni l'una dall'altra", async () => {
      const outcome = await asDemo(db, async (tx) => {
        const [matteo] = await tx.query<{ id: string }>(
          "select id from public.patients where practice_id = $1 and first_name = 'Matteo' and last_name = 'Ricci'",
          [P],
        );
        if (!matteo) throw new Error("Matteo Ricci non c'è");
        const defaults = await bookingDefaults(tx, P, clock, { patientId: matteo.id });
        const services = await listActiveServices(tx, P);
        const start = await suggestStart(tx, P, clock, { durationMin: 45 });
        const preview = await previewAppointment(tx, P, clock, {
          day: start.day,
          time: start.time,
          durationMin: 45,
          repeat: { intervalWeeks: defaults.intervalWeeks, count: defaults.seriesCount },
        });
        return { defaults, services, preview };
      });
      const { defaults, services, preview } = outcome;
      expect(services.find((s) => s.id === defaults.serviceId)?.kind).toBe("seduta");
      expect(defaults.cycle.kind).toBe("existing");
      if (defaults.cycle.kind === "existing") expect(defaults.cycle.title).toMatch(/^Dolore al ginocchio destro, /);
      expect(defaults.seriesCount).toBe(3);
      expect(defaults.intervalWeeks).toBe(2);
      expect(preview.rows.map((row) => row.state)).toEqual(["libero", "libero", "libero"]);
      const [first, second, third] = preview.rows;
      if (!first || !second || !third) throw new Error("anteprima incompleta");
      expect(daysBetween(first.day, second.day)).toBe(14);
      expect(daysBetween(second.day, third.day)).toBe(14);
    });
  });
});
