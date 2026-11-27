import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VAT_INVALID } from "@/lib/fiscal/validators";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { saveFiscalSettings } from "@/server/domain/settings/commands";
import { fiscalRatesOf, getFiscalSettings } from "@/server/domain/settings/queries";
import { STUDIO } from "../../seed/people";
import { PRACTICE_A, USER_A } from "./fixtures";
import { expectPgError, inRollback, inService, inUserA, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const FISCAL = {
  regime: "forfettario",
  vatNumber: "00000000000",
  taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09",
  fiscalAddressLine: "Via delle Prove 7",
  fiscalPostalCode: "40121",
  fiscalCity: "Bologna",
  fiscalProvince: "BO",
  fiscalCountry: "IT",
  inpsSurchargeEnabled: false,
  stampChargedToClient: true,
  paperStampAuthorization: "",
  iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti",
  defaultPaymentMethod: "carta",
  bankTransferDueDays: 15,
};

let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

async function rowsOfA(tx: Tx) {
  return tx.query("select * from public.fiscal_settings where practice_id = $1", [PRACTICE_A]);
}

describe("impostazioni fiscali", () => {
  it("uA inserisce i dati della demo e li rilegge senza avvisi", async () => {
    const saved = await inService(db, async (tx) => {
      await tx.query("delete from public.fiscal_settings where practice_id = $1", [PRACTICE_A]);
      await switchToUser(tx, { userId: USER_A });
      await saveFiscalSettings(tx, PRACTICE_A, clock, {
        ...FISCAL,
        taxCode: ` ${STUDIO.practitionerTaxCode.toLowerCase().slice(0, 8)} ${STUDIO.practitionerTaxCode.toLowerCase().slice(8)} `,
        iban: " it80 n0000001000000000123456 ",
      });
      const view = await getFiscalSettings(tx, PRACTICE_A);
      return { view, rows: await rowsOfA(tx), rates: fiscalRatesOf(view) };
    });
    expect(saved.view).toEqual({
      ...FISCAL,
      paperStampAuthorization: null,
      inpsSurchargeBp: 400,
      withholdingBp: 2000,
      vatRateBp: 2200,
      warnings: { vatNumber: null, taxCode: null, iban: null },
    });
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({
      vat_number: "00000000000", tax_code: STUDIO.practitionerTaxCode,
      fiscal_address_line: "Via delle Prove 7", fiscal_postal_code: "40121",
      fiscal_city: "Bologna", fiscal_province: "BO", iban: "IT80N0000001000000000123456",
      created_by: USER_A,
    });
    expect(saved.rates).toEqual({
      inpsSurchargeEnabled: false, inpsSurchargeBp: 400, withholdingBp: 2000,
      vatRateBp: 2200, stampChargedToClient: true,
    });
  });

  it("un secondo salvataggio aggiorna la stessa riga senza cambiare aliquote e creazione", async () => {
    const saved = await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, FISCAL);
      await tx.query(
        `update public.fiscal_settings set inps_surcharge_bp = 300, withholding_bp = 1900, vat_rate_bp = 2100
          where practice_id = $1`, [PRACTICE_A],
      );
      const before = await rowsOfA(tx);
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...FISCAL, regime: "ordinario" });
      return { before, after: await rowsOfA(tx), view: await getFiscalSettings(tx, PRACTICE_A) };
    });
    expect(saved.after).toHaveLength(1);
    expect(saved.after[0]).toMatchObject({
      regime: "ordinario", inps_surcharge_bp: 300, withholding_bp: 1900, vat_rate_bp: 2100,
      created_at: saved.before[0]?.created_at, created_by: saved.before[0]?.created_by,
    });
    expect(saved.view.regime).toBe("ordinario");
  });

  it("salva la partita IVA con cifra di controllo errata e la rilegge con VAT_INVALID", async () => {
    const saved = await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...FISCAL, vatNumber: "01234560008" });
      return { rows: await rowsOfA(tx), view: await getFiscalSettings(tx, PRACTICE_A) };
    });
    expect(saved.rows[0]?.vat_number).toBe("01234560008");
    expect(saved.view.warnings).toEqual({ vatNumber: VAT_INVALID, taxCode: null, iban: null });
  });

  it.each([
    ["vatNumber", "123", "Scrivi la partita IVA con 11 cifre."],
    ["bankTransferDueDays", 121, "Scrivi un numero di giorni da 0 a 120."],
  ])("rifiuta %s fuori formato prima della scrittura", async (field, value, message) => {
    const saved = await inUserA(db, async (tx) => {
      const before = await rowsOfA(tx);
      const error = await saveFiscalSettings(tx, PRACTICE_A, clock, { ...FISCAL, [field]: value }).then(
        () => expect.fail("Il comando doveva rifiutare l'input."),
        (error: unknown) => error,
      );
      expect(error).toHaveProperty("name", "ZodError");
      return { before, after: await rowsOfA(tx), failure: toActionFailure(error, "test") };
    });
    expect(saved.failure.fieldErrors).toEqual({ [field]: message });
    expect(saved.after).toEqual(saved.before);
  });

  it("rifiuta la chiave in più vatRateBp e lascia invariata la riga", async () => {
    await inUserA(db, async (tx) => {
      const before = await rowsOfA(tx);
      await expect(saveFiscalSettings(tx, PRACTICE_A, clock, { ...FISCAL, vatRateBp: 1000 }))
        .rejects.toMatchObject({ name: "ZodError", issues: [{ code: "unrecognized_keys", keys: ["vatRateBp"] }] });
      expect(await rowsOfA(tx)).toEqual(before);
    });
  });

  it("uB sullo studio A riceve 42501 e non cambia nessuna riga", async () => {
    const before = await inUserA(db, rowsOfA);
    await expectPgError(
      inRollback(db, "B", (tx) => saveFiscalSettings(tx, PRACTICE_A, clock, FISCAL)),
      "42501", /row-level security policy for table "fiscal_settings"/,
    );
    expect(await inUserA(db, rowsOfA)).toEqual(before);
  });

  it("senza riga legge tutti i default della tabella e i campi null", async () => {
    const view = await inService(db, async (tx) => {
      await tx.query("delete from public.fiscal_settings where practice_id = $1", [PRACTICE_A]);
      await switchToUser(tx, { userId: USER_A });
      return getFiscalSettings(tx, PRACTICE_A);
    });
    expect(view).toEqual({
      regime: "forfettario", vatNumber: null, taxCode: null, atecoCode: null,
      fiscalAddressLine: null, fiscalPostalCode: null, fiscalCity: null, fiscalProvince: null,
      fiscalCountry: "IT", inpsSurchargeEnabled: false, inpsSurchargeBp: 400,
      withholdingBp: 2000, vatRateBp: 2200, stampChargedToClient: true,
      paperStampAuthorization: null, iban: null, ibanHolder: null,
      defaultPaymentMethod: "carta", bankTransferDueDays: 15,
      warnings: { vatNumber: null, taxCode: null, iban: null },
    });
  });

  it("salva l'apostrofo tipografico come semplice in tutti i testi liberi di Fisco", async () => {
    const saved = await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, {
        ...FISCAL, fiscalAddressLine: "Via dell’Osteopata 7", fiscalCity: "Città d’Esempio",
        paperStampAuthorization: "Autorizzazione dell’ufficio 7", ibanHolder: "Laura D’Esempio",
      });
      return rowsOfA(tx);
    });
    expect(saved[0]).toMatchObject({
      fiscal_address_line: "Via dell'Osteopata 7", fiscal_city: "Città d'Esempio",
      paper_stamp_authorization: "Autorizzazione dell'ufficio 7", iban_holder: "Laura D'Esempio",
    });
  });
});
