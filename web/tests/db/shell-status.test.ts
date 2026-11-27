import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { createAppointment } from "@/server/domain/appointments/commands";
import { countToInvoice } from "@/server/domain/invoices/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { getShellStatus } from "@/server/domain/shell/queries";
import { STUDIO } from "../../seed/people";
import { PRACTICE_A, SERVICE_A } from "./fixtures";
import { asUserB, inService, inUserA, openTestDb } from "./helpers";

// La riga di stato della shell: nome dello studio, banner dei dati
// di prova, numero accanto a "Fatture" e punto di avviso di "Impostazioni". I dati nascono come uA e
// ogni test torna indietro. L'orologio è giovedì 22/10/2026 alle 08:30 di Roma.

const D0 = fixedClock("2026-10-22T08:30:00+02:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

/** Una seduta già fatta, senza fattura e senza motivo per non fatturarla: finisce in "da emettere". */
async function doneSession(tx: Tx, firstName: string, lastName: string, day: string): Promise<void> {
  const patient = await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" });
  await createAppointment(tx, PRACTICE_A, D0, {
    patient: { kind: "existing", patientId: patient.id },
    serviceId: SERVICE_A,
    day,
    time: "09:00",
    durationMin: 45,
    cycle: { kind: "new" },
    priceCents: 6000,
    status: "fatto",
  });
}

// Le colonne dello studio che spengono l'avviso, con un valore valido per ciascuna.
const STUDIO_FIELDS = {
  address_line: "Via Saragozza 10",
  postal_code: "40123",
  city: "Bologna",
  province: "BO",
} as const;
const FISCAL_FIELDS = {
  vat_number: "00000000000",
  tax_code: STUDIO.practitionerTaxCode,
  fiscal_address_line: "Via Saragozza 10",
  fiscal_postal_code: "40123",
  fiscal_city: "Bologna",
  fiscal_province: "BO",
} as const;

const sets = (values: Record<string, string | null>): { sql: string; params: (string | null)[] } => ({
  sql: Object.keys(values)
    .map((column, index) => `${column} = $${index + 2}`)
    .join(", "),
  params: Object.values(values),
});

/** Scrive i dati dello studio e quelli fiscali come uA; `blank` ne lascia una colonna vuota. */
async function fillSettings(tx: Tx, blank?: string): Promise<void> {
  const pick = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).map(([column, value]) => [column, column === blank ? null : value]));
  const studio = sets(pick(STUDIO_FIELDS));
  await tx.query(`update public.practice_settings set ${studio.sql} where practice_id = $1`, [PRACTICE_A, ...studio.params]);
  const fiscal = sets(pick(FISCAL_FIELDS));
  await tx.query(`update public.fiscal_settings set ${fiscal.sql} where practice_id = $1`, [PRACTICE_A, ...fiscal.params]);
}

describe("getShellStatus", () => {
  it("dà il nome dello studio dalla tabella practices e la fixture non è una demo", async () => {
    const status = await inUserA(db, async (tx) => {
      const [practice] = await tx.query<{ name: string }>("select name from public.practices where id = $1", [PRACTICE_A]);
      return { practice, status: await getShellStatus(tx, PRACTICE_A, D0) };
    });
    expect(status.practice?.name).toBe("Studio A");
    expect(status.status).toMatchObject({
      practiceName: "Studio A",
      isDemo: false,
      demoSeededAt: null,
      toInvoiceCount: 0,
    });
  });

  it("segue le impostazioni: il nome cambiato e la demo con l'istante del seed", async () => {
    const status = await inUserA(db, async (tx) => {
      await tx.query("update public.practices set name = 'Studio Borgo Tiglio' where id = $1", [PRACTICE_A]);
      await tx.query(
        `update public.practice_settings set is_demo = true, demo_seeded_at = '2026-10-19T07:12:00Z' where practice_id = $1`,
        [PRACTICE_A],
      );
      return getShellStatus(tx, PRACTICE_A, D0);
    });
    expect(status.practiceName).toBe("Studio Borgo Tiglio");
    expect(status.isDemo).toBe(true);
    expect(status.demoSeededAt).toEqual(new Date("2026-10-19T07:12:00Z"));
  });

  it("toInvoiceCount è il numero di countToInvoice", async () => {
    const out = await inUserA(db, async (tx) => {
      const before = await getShellStatus(tx, PRACTICE_A, D0);
      await doneSession(tx, "Marco", "Bellandi", "2026-10-21");
      await doneSession(tx, "Anna", "Morelli", "2026-10-15");
      const after = await getShellStatus(tx, PRACTICE_A, D0);
      return { before, after, count: await countToInvoice(tx, PRACTICE_A, D0) };
    });
    expect(out.before.toInvoiceCount).toBe(0);
    expect(out.count).toBe(2);
    expect(out.after.toInvoiceCount).toBe(out.count);
  });

  it("settingsWarning: acceso nella fixture, che non ha partita IVA, spento con i campi dello studio", async () => {
    const out = await inUserA(db, async (tx) => {
      const fixture = await getShellStatus(tx, PRACTICE_A, D0);
      await fillSettings(tx);
      return { fixture, filled: await getShellStatus(tx, PRACTICE_A, D0) };
    });
    expect(out.fixture.settingsWarning).toBe(true);
    expect(out.filled.settingsWarning).toBe(false);
  });

  it.each([...Object.keys(STUDIO_FIELDS), ...Object.keys(FISCAL_FIELDS)])(
    "settingsWarning: acceso se manca %s",
    async (column) => {
      const status = await inUserA(db, async (tx) => {
        await fillSettings(tx, column);
        return getShellStatus(tx, PRACTICE_A, D0);
      });
      expect(status.settingsWarning).toBe(true);
    },
  );

  it("settingsWarning: acceso anche con tutti i campi e una partita IVA dalla cifra di controllo sbagliata", async () => {
    const status = await inUserA(db, async (tx) => {
      await fillSettings(tx);
      await tx.query("update public.fiscal_settings set vat_number = '01234560008' where practice_id = $1", [PRACTICE_A]);
      return getShellStatus(tx, PRACTICE_A, D0);
    });
    expect(status.settingsWarning).toBe(true);
  });

  it("settingsWarning: un campo di soli spazi vale come mancante", async () => {
    const status = await inUserA(db, async (tx) => {
      await fillSettings(tx);
      await tx.query("update public.fiscal_settings set fiscal_city = '  ' where practice_id = $1", [PRACTICE_A]);
      return getShellStatus(tx, PRACTICE_A, D0);
    });
    expect(status.settingsWarning).toBe(true);
  });

  it("settingsWarning: acceso se manca la riga di fiscal_settings", async () => {
    // uA non cancella le righe fiscali (policy S, I, U): la cancella il servizio, e la lettura è la stessa.
    const status = await inService(db, async (tx) => {
      await fillSettings(tx);
      await tx.query("delete from public.fiscal_settings where practice_id = $1", [PRACTICE_A]);
      return getShellStatus(tx, PRACTICE_A, D0);
    });
    expect(status.settingsWarning).toBe(true);
  });

  it("uB sull'id dello studio A non legge niente di A", async () => {
    await expect(asUserB(db, (tx) => getShellStatus(tx, PRACTICE_A, D0))).rejects.toThrow(
      "Le impostazioni dello studio non esistono.",
    );
  });
});
