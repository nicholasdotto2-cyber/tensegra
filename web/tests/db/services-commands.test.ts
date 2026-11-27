import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import { BLOCKED_DELETE, isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import {
  applyPriceToFuture,
  archiveService,
  createDefaultServices,
  createService,
  deleteService,
  restoreService,
  updateService,
} from "@/server/domain/services/commands";
import { getRegime, listActiveServices, listServices } from "@/server/domain/services/queries";
import { APPOINTMENT_A, CYCLE_A, invoiceDraft, PATIENT_A1, PRACTICE_A, SERVICE_A } from "./fixtures";
import { asUserA, asUserB, expectPgError, idOf, inRollback, inService, inUserA, insertRow, openTestDb } from "./helpers";

// Comandi del Listino: una voce usata si archivia e non si elimina, resta almeno una
// voce attiva per ogni tipo su cui contano i default dell'agenda, e un cambio di prezzo tocca solo gli
// appuntamenti futuri ancora al prezzo vecchio.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const MISSING = "c0000000-0000-4000-8000-0000000000ff";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

/** La seduta della fixture, come la rimanda il modulo di modifica. */
const SEDUTA_A = {
  id: SERVICE_A,
  kind: "seduta",
  name: "Seduta osteopatica",
  invoiceDescription: "Seduta di osteopatia",
  durationMin: 45,
  priceCents: 6000,
  color: "petrolio",
};

/** Una seconda seduta e due voci di altro tipo, come le crea il modulo di una voce nuova. */
const SEDUTA_LUNGA = {
  kind: "seduta",
  name: "Seduta lunga",
  invoiceDescription: "Seduta lunga di osteopatia",
  durationMin: 60,
  priceCents: 7000,
  color: "oceano",
};
const CERTIFICATO = {
  kind: "altro",
  name: "Certificato",
  invoiceDescription: "Certificato di prestazione",
  durationMin: 15,
  priceCents: 2000,
  color: "ardesia",
};
const PRIMA_VISITA = {
  kind: "prima_visita",
  name: "Prima visita osteopatica",
  invoiceDescription: "Prima visita osteopatica",
  durationMin: 60,
  priceCents: 8000,
  color: "ocra",
};

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

/** L'errore con cui il comando fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando fallisce prima del database (DomainError o ZodError): la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(["DomainError", "ZodError"], String(error)).toContain(nameOf(error));
  return toActionFailure(error, "test");
}

/** Il comando risponde con un DomainError di testo `message`: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

const expectNotAllowed = (p: Promise<unknown>): Promise<void> => expectDomainError(p, NOT_ALLOWED);

const blockedDelete = (p: Promise<unknown>): Promise<void> => expectDomainError(p, BLOCKED_DELETE);

const lastActive = (kind: string): string => `Serve almeno una prestazione attiva di tipo ${kind}.`;
const NAME_TAKEN = "Esiste già una prestazione attiva con questo nome.";

async function serviceRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.services where id = $1", [id]);
  return row;
}

async function activeServices(tx: Tx) {
  return tx.query(
    `select name, kind, duration_min, price_cents, color, invoice_description, sort_order
       from public.services
      where practice_id = $1 and archived_at is null
      order by sort_order, name`,
    [PRACTICE_A],
  );
}

async function countServices(tx: Tx): Promise<number> {
  const [row] = await tx.query<{ n: number }>("select count(*)::int as n from public.services where practice_id = $1", [
    PRACTICE_A,
  ]);
  return row?.n ?? -1;
}

/** Un appuntamento di A sul primo paziente e sul suo ciclo, inserito come uA. */
async function insertAppointment(
  tx: Tx,
  startsAt: string,
  options: { status?: "prenotato" | "confermato" | "fatto" | "annullato"; priceCents?: number; serviceId?: string } = {},
): Promise<string> {
  const { status = "prenotato", priceCents = 6000, serviceId = SERVICE_A } = options;
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments
       (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, 45, $6, $7, $8)
     returning id`,
    [PRACTICE_A, PATIENT_A1, serviceId, CYCLE_A, startsAt, priceCents, status, status === "annullato" ? "paziente" : null],
  );
  if (!row) throw new Error("nessun appuntamento inserito");
  return row.id;
}

async function appointmentRows(tx: Tx, ids: readonly string[]) {
  return tx.query<{ id: string; price_cents: number; duration_min: number; status: string; starts_at: Date }>(
    `select id, price_cents, duration_min, status, starts_at
       from public.appointments
      where id = any($1::uuid[])
      order by starts_at, id`,
    [ids],
  );
}

describe("createDefaultServices", () => {
  it("crea le tre voci di partenza quando non resta nessuna voce attiva", async () => {
    const rows = await inUserA(db, async (tx) => {
      // Un update diretto: il comando rifiuterebbe di archiviare l'ultima seduta attiva.
      await tx.query("update public.services set archived_at = $2 where id = $1", [SERVICE_A, clock.now()]);
      await createDefaultServices(tx, PRACTICE_A, clock);
      return { active: await activeServices(tx), listed: await listActiveServices(tx, PRACTICE_A) };
    });
    expect(rows.active).toEqual([
      {
        name: "Prima visita osteopatica",
        kind: "prima_visita",
        duration_min: 60,
        price_cents: 8000,
        color: "ocra",
        invoice_description: "Prima visita osteopatica",
        sort_order: 1,
      },
      {
        name: "Seduta osteopatica",
        kind: "seduta",
        duration_min: 45,
        price_cents: 5500,
        color: "petrolio",
        invoice_description: "Trattamento osteopatico",
        sort_order: 2,
      },
      {
        name: "Controllo",
        kind: "controllo",
        duration_min: 30,
        price_cents: 4500,
        color: "salvia",
        invoice_description: "Controllo osteopatico",
        sort_order: 3,
      },
    ]);
    expect(rows.listed.map((row) => row.name)).toEqual(["Prima visita osteopatica", "Seduta osteopatica", "Controllo"]);
  });

  it("con una voce attiva risponde Operazione non permessa e non crea niente", async () => {
    await inUserA(db, async (tx) => {
      await expectNotAllowed(createDefaultServices(tx, PRACTICE_A, clock));
      expect(await countServices(tx)).toBe(1);
    });
  });
});

describe("createService", () => {
  it("scrive la voce, senza spazi ai lati, in fondo al listino", async () => {
    const saved = await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, { ...PRIMA_VISITA, name: "  Prima visita osteopatica " });
      const second = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      return { id, row: await serviceRow(tx, id), second: await serviceRow(tx, second.id) };
    });
    expect(saved.row).toMatchObject({
      id: saved.id,
      practice_id: PRACTICE_A,
      kind: "prima_visita",
      name: "Prima visita osteopatica",
      invoice_description: "Prima visita osteopatica",
      duration_min: 60,
      price_cents: 8000,
      color: "ocra",
      sort_order: 1,
      archived_at: null,
    });
    // Il massimo era 0 (la seduta della fixture): la prima voce nuova è 1, la seconda 2.
    expect(saved.second).toMatchObject({ name: "Certificato", sort_order: 2 });
  });

  it("il nuovo ordine parte dal massimo anche fra le voci archiviate", async () => {
    const order = await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      await archiveService(tx, PRACTICE_A, clock, { id });
      const next = await createService(tx, PRACTICE_A, clock, { ...CERTIFICATO, name: "Referto" });
      return (await serviceRow(tx, next.id))?.sort_order;
    });
    expect(order).toBe(2);
  });

  it("un nome già attivo, senza badare alle maiuscole, risponde sul campo name", async () => {
    const failure = await inUserA(db, async (tx) => {
      const result = await formFailure(createService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, name: "seduta osteopatica" }));
      // Dopo un DomainError la transazione è valida: nessuna riga è stata scritta.
      expect(await countServices(tx)).toBe(1);
      return result;
    });
    expect(failure).toEqual({ ok: false, refused: true, message: NAME_TAKEN, fieldErrors: { name: NAME_TAKEN } });
  });

  it("il nome di una voce archiviata si può riusare", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await archiveService(tx, PRACTICE_A, clock, { id });
      const again = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      expect((await serviceRow(tx, again.id))?.archived_at).toBeNull();
    });
  });

  it.each([
    ["nome vuoto", { name: "   " }, "name", "Campo obbligatorio."],
    ["nome oltre 60 caratteri", { name: "a".repeat(61) }, "name", "Massimo 60 caratteri."],
    ["descrizione vuota", { invoiceDescription: "" }, "invoiceDescription", "Campo obbligatorio."],
    ["descrizione oltre 200 caratteri", { invoiceDescription: "a".repeat(201) }, "invoiceDescription", "Massimo 200 caratteri."],
    ["tipo sconosciuto", { kind: "visita" }, "kind", "Valore non valido"],
    ["durata fuori elenco", { durationMin: 50 }, "durationMin", "Valore non valido"],
    ["durata come testo", { durationMin: "45" }, "durationMin", "Valore non valido"],
    ["prezzo negativo", { priceCents: -1 }, "priceCents", "Valore non valido"],
    ["prezzo oltre 9.999,99 euro", { priceCents: 1_000_000 }, "priceCents", "Valore non valido"],
    ["prezzo con i decimali", { priceCents: 5500.5 }, "priceCents", "Valore non valido"],
    ["colore sconosciuto", { color: "rosso" }, "color", "Valore non valido"],
  ])("rifiuta %s prima del database", async (_label, change, field, message) => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, ...change }));
      expect(failure).toEqual({ ok: false, refused: true, message, fieldErrors: { [field]: message } });
      expect(await countServices(tx)).toBe(1);
    });
  });

  it("accetta prezzo zero e il prezzo più alto", async () => {
    await inUserA(db, async (tx) => {
      const free = await createService(tx, PRACTICE_A, clock, { ...CERTIFICATO, priceCents: 0 });
      const top = await createService(tx, PRACTICE_A, clock, { ...CERTIFICATO, name: "Percorso", priceCents: 999_999 });
      expect((await serviceRow(tx, free.id))?.price_cents).toBe(0);
      expect((await serviceRow(tx, top.id))?.price_cents).toBe(999_999);
    });
  });

  it("rifiuta chiavi in più e l'input che non è un oggetto", async () => {
    await inUserA(db, async (tx) => {
      for (const extra of [{ practiceId: PRACTICE_A }, { archivedAt: null }, { sortOrder: 9 }, { id: SERVICE_A }]) {
        const error = await rejectionOf(createService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, ...extra }));
        expect(nameOf(error), String(error)).toBe("ZodError");
      }
      expect(nameOf(await rejectionOf(createService(tx, PRACTICE_A, clock, null)))).toBe("ZodError");
      expect(await countServices(tx)).toBe(1);
    });
  });
});

describe("archiveService", () => {
  it("l'ultima seduta attiva non si archivia", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(archiveService(tx, PRACTICE_A, clock, { id: SERVICE_A }));
      expect(failure).toEqual({ ok: false, refused: true, message: lastActive("Seduta") });
      expect((await serviceRow(tx, SERVICE_A))?.archived_at).toBeNull();
    });
  });

  it("con una seconda seduta attiva passa, e scrive l'istante del clock", async () => {
    const row = await inUserA(db, async (tx) => {
      await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await archiveService(tx, PRACTICE_A, clock, { id: SERVICE_A });
      return serviceRow(tx, SERVICE_A);
    });
    expect(row?.archived_at).toEqual(clock.now());
  });

  it.each([
    ["prima_visita", PRIMA_VISITA, "Prima visita"],
    ["controllo", { ...PRIMA_VISITA, kind: "controllo", name: "Controllo", durationMin: 30 }, "Controllo"],
  ])("vale anche per l'ultima voce attiva di tipo %s", async (_kind, input, label) => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, input);
      await expectDomainError(archiveService(tx, PRACTICE_A, clock, { id }), lastActive(label));
      expect((await serviceRow(tx, id))?.archived_at).toBeNull();
    });
  });

  it("una voce di tipo altro si archivia sempre", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      await archiveService(tx, PRACTICE_A, clock, { id });
      return serviceRow(tx, id);
    });
    expect(row?.archived_at).toEqual(clock.now());
  });

  it("una voce già archiviata o che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      await archiveService(tx, PRACTICE_A, clock, { id });
      await expectNotAllowed(archiveService(tx, PRACTICE_A, fixedClock("2026-11-05T09:00:00+01:00"), { id }));
      // L'istante dell'archiviazione è quello del primo comando.
      expect((await serviceRow(tx, id))?.archived_at).toEqual(clock.now());
      await expectNotAllowed(archiveService(tx, PRACTICE_A, clock, { id: MISSING }));
    });
  });

  it("rifiuta un id che non è un uuid e chiavi in più", async () => {
    await inUserA(db, async (tx) => {
      expect(nameOf(await rejectionOf(archiveService(tx, PRACTICE_A, clock, { id: "1" })))).toBe("ZodError");
      expect(nameOf(await rejectionOf(archiveService(tx, PRACTICE_A, clock, { id: SERVICE_A, practiceId: PRACTICE_A })))).toBe(
        "ZodError",
      );
    });
  });
});

describe("restoreService", () => {
  it("toglie archived_at senza altro", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      await archiveService(tx, PRACTICE_A, clock, { id });
      await restoreService(tx, PRACTICE_A, clock, { id });
      return serviceRow(tx, id);
    });
    expect(row).toMatchObject({ name: "Certificato", archived_at: null });
  });

  it("con il nome già preso da una voce attiva risponde sul campo name", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await archiveService(tx, PRACTICE_A, clock, { id });
      await createService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, name: "seduta lunga" });
      const failure = await formFailure(restoreService(tx, PRACTICE_A, clock, { id }));
      expect(failure).toEqual({ ok: false, refused: true, message: NAME_TAKEN, fieldErrors: { name: NAME_TAKEN } });
      expect((await serviceRow(tx, id))?.archived_at).toEqual(clock.now());
    });
  });

  it("una voce attiva o che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectNotAllowed(restoreService(tx, PRACTICE_A, clock, { id: SERVICE_A }));
      await expectNotAllowed(restoreService(tx, PRACTICE_A, clock, { id: MISSING }));
    });
  });
});

describe("deleteService", () => {
  it("una voce usata da un appuntamento non si elimina e la riga resta", async () => {
    await inUserA(db, async (tx) => {
      await blockedDelete(deleteService(tx, PRACTICE_A, clock, { id: SERVICE_A }));
      expect(await serviceRow(tx, SERVICE_A)).toBeDefined();
    });
  });

  it("una voce usata solo da una riga di fattura in bozza non si elimina (C4)", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      await tx.query(
        `insert into public.invoice_lines (practice_id, invoice_id, line_number, line_kind, service_id, description,
                                           quantity, unit_price_cents, line_total_cents, vat_rate_bp, nature)
         values ($1, $2, 1, 'prestazione', $3, 'Certificato di prestazione', 1, 2000, 2000, 0, 'N2.2')`,
        [PRACTICE_A, invoiceId, id],
      );
      const [listed] = (await listServices(tx, PRACTICE_A)).filter((row) => row.id === id);
      expect(listed).toMatchObject({ usedCount: 0, deletable: false });
      await blockedDelete(deleteService(tx, PRACTICE_A, clock, { id }));
      expect(await serviceRow(tx, id)).toBeDefined();
    });
  });

  it("una voce mai usata di tipo altro sparisce", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      expect(await deleteService(tx, PRACTICE_A, clock, { id })).toBeUndefined();
      expect(await serviceRow(tx, id)).toBeUndefined();
      expect(await countServices(tx)).toBe(1);
    });
  });

  it("l'ultima voce attiva di un tipo, anche se mai usata, non si elimina", async () => {
    await inUserA(db, async (tx) => {
      // La seduta della fixture è usata: la archivio con un update diretto e lascio sola la nuova.
      await tx.query("update public.services set archived_at = $2 where id = $1", [SERVICE_A, clock.now()]);
      const { id } = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await expectDomainError(deleteService(tx, PRACTICE_A, clock, { id }), lastActive("Seduta"));
      expect(await serviceRow(tx, id)).toBeDefined();
    });
  });

  it("una voce archiviata mai usata si elimina anche se il suo tipo non ha altre voci attive", async () => {
    await inUserA(db, async (tx) => {
      const id = idOf(
        await insertRow(tx, "services", {
          practice_id: PRACTICE_A,
          kind: "controllo",
          name: "Controllo vecchio",
          invoice_description: "Controllo",
          duration_min: 30,
          price_cents: 4000,
          color: "salvia",
          archived_at: clock.now(),
        }),
      );
      await deleteService(tx, PRACTICE_A, clock, { id });
      expect(await serviceRow(tx, id)).toBeUndefined();
    });
  });

  it("una voce che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectNotAllowed(deleteService(tx, PRACTICE_A, clock, { id: MISSING }));
    });
  });

  // Se tra il controllo e la delete nasce un collegamento, la chiave restrict risponde con 23001
  // (Postgres 18) o 23503 (Postgres 17): il comando le tratta come il controllo esplicito. Il
  // collegamento che nasce nel mezzo non si può ottenere con una sola connessione, quindi qui la
  // delete fallisce con il codice vero e tutto il resto va al database.
  it.each(["23001", "23503"])("se la delete arriva al database e risponde %s, il testo è quello del blocco", async (code) => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      const failing: Tx = {
        query: <T>(text: string, params?: readonly SqlParam[]): Promise<T[]> =>
          /^\s*delete\s+from\s+public\.services/i.test(text)
            ? Promise.reject(Object.assign(new Error('update or delete on table "services" violates foreign key'), { code }))
            : tx.query<T>(text, params),
      };
      await blockedDelete(deleteService(failing, PRACTICE_A, clock, { id }));
    });
  });
});

describe("updateService", () => {
  it("scrive i sei campi e lascia in pace il resto della riga", async () => {
    const saved = await inUserA(db, async (tx) => {
      const before = await serviceRow(tx, SERVICE_A);
      const result = await updateService(tx, PRACTICE_A, clock, {
        id: SERVICE_A,
        kind: "seduta",
        name: "  Seduta osteopatica lunga ",
        invoiceDescription: "Seduta lunga di osteopatia",
        durationMin: 60,
        priceCents: 6000,
        color: "oceano",
      });
      return { before, result, after: await serviceRow(tx, SERVICE_A) };
    });
    expect(saved.result).toEqual({ futureAtOldPrice: 0, oldPriceCents: 6000 });
    expect(saved.after).toMatchObject({
      name: "Seduta osteopatica lunga",
      invoice_description: "Seduta lunga di osteopatia",
      duration_min: 60,
      price_cents: 6000,
      color: "oceano",
      kind: "seduta",
      sort_order: saved.before?.sort_order,
      archived_at: null,
      created_at: saved.before?.created_at,
      created_by: saved.before?.created_by,
    });
  });

  it("un cambio di prezzo dice quanti appuntamenti futuri sono ancora al prezzo vecchio", async () => {
    const result = await inUserA(db, async (tx) => {
      const other = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      const futures = [
        // Oggi, prima dell'ora del clock: conta, il giorno comincia alle 00:00.
        await insertAppointment(tx, "2026-11-04T00:15:00+01:00"),
        await insertAppointment(tx, "2026-11-05T09:00:00+01:00"),
      ];
      const atOtherPrice = await insertAppointment(tx, "2026-11-06T09:00:00+01:00", { priceCents: 5000 });
      const ignored = [
        // Ieri sera, un annullato, un fatto e un'altra voce: nessuno dei quattro conta.
        await insertAppointment(tx, "2026-11-03T22:30:00+01:00"),
        await insertAppointment(tx, "2026-11-07T09:00:00+01:00", { status: "annullato" }),
        await insertAppointment(tx, "2026-11-07T10:00:00+01:00", { status: "fatto" }),
        await insertAppointment(tx, "2026-11-07T11:00:00+01:00", { serviceId: other.id }),
      ];
      const answer = await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, priceCents: 6500 });
      const rows = await appointmentRows(tx, [APPOINTMENT_A, ...futures, atOtherPrice, ...ignored]);
      return { answer, service: await serviceRow(tx, SERVICE_A), rows };
    });
    expect(result.answer).toEqual({ futureAtOldPrice: 2, oldPriceCents: 6000 });
    expect(result.service?.price_cents).toBe(6500);
    // La sola modifica del listino non tocca nessun appuntamento.
    expect(result.rows.map((row) => row.price_cents).sort()).toEqual(
      [6000, 6000, 6000, 6000, 6000, 6000, 6000, 5000].sort(),
    );
  });

  it("conta anche i confermati", async () => {
    const answer = await inUserA(db, async (tx) => {
      await insertAppointment(tx, "2026-11-05T09:00:00+01:00", { status: "confermato" });
      await insertAppointment(tx, "2026-11-05T10:00:00+01:00");
      return updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, priceCents: 0 });
    });
    expect(answer).toEqual({ futureAtOldPrice: 2, oldPriceCents: 6000 });
  });

  it("un cambio di durata non cambia nessun appuntamento", async () => {
    await inUserA(db, async (tx) => {
      const ids = [
        APPOINTMENT_A,
        await insertAppointment(tx, "2026-11-05T09:00:00+01:00"),
        await insertAppointment(tx, "2026-11-05T10:00:00+01:00", { status: "confermato" }),
      ];
      const before = await appointmentRows(tx, ids);
      const answer = await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, durationMin: 60 });
      expect(answer).toEqual({ futureAtOldPrice: 0, oldPriceCents: 6000 });
      expect((await serviceRow(tx, SERVICE_A))?.duration_min).toBe(60);
      expect(await appointmentRows(tx, ids)).toEqual(before);
    });
  });

  it("il nome di un'altra voce attiva risponde sul campo name; il proprio, anche con altre maiuscole, passa", async () => {
    await inUserA(db, async (tx) => {
      await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      const failure = await formFailure(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, name: "SEDUTA LUNGA" }));
      expect(failure).toEqual({ ok: false, refused: true, message: NAME_TAKEN, fieldErrors: { name: NAME_TAKEN } });
      expect((await serviceRow(tx, SERVICE_A))?.name).toBe("Seduta osteopatica");
      await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, name: "SEDUTA OSTEOPATICA" });
      expect((await serviceRow(tx, SERVICE_A))?.name).toBe("SEDUTA OSTEOPATICA");
    });
  });

  it("una voce archiviata si modifica anche con il nome di una voce attiva; è il ripristino a rifiutarla", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await archiveService(tx, PRACTICE_A, clock, { id });
      await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, id, name: "Seduta osteopatica" });
      expect((await serviceRow(tx, id))?.name).toBe("Seduta osteopatica");
      await expectDomainError(restoreService(tx, PRACTICE_A, clock, { id }), NAME_TAKEN);
    });
  });

  it("l'ultima seduta attiva non cambia tipo", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, kind: "altro" }));
      expect(failure).toEqual({
        ok: false,
        refused: true,
        message: lastActive("Seduta"),
        fieldErrors: { kind: lastActive("Seduta") },
      });
      expect((await serviceRow(tx, SERVICE_A))?.kind).toBe("seduta");
    });
  });

  it("con una seconda seduta attiva il tipo cambia", async () => {
    await inUserA(db, async (tx) => {
      await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, kind: "altro" });
      expect((await serviceRow(tx, SERVICE_A))?.kind).toBe("altro");
    });
  });

  it("una voce archiviata cambia tipo senza toccare le voci attive", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      const second = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      await archiveService(tx, PRACTICE_A, clock, { id: second.id });
      await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_LUNGA, id: second.id, kind: "controllo", name: "Controllo lungo" });
      expect((await serviceRow(tx, second.id))?.kind).toBe("controllo");
      expect((await serviceRow(tx, id))?.kind).toBe("altro");
    });
  });

  it("una voce che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectNotAllowed(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, id: MISSING }));
    });
  });

  it("rifiuta i valori fuori elenco e le chiavi in più prima del database", async () => {
    await inUserA(db, async (tx) => {
      const price = await formFailure(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, priceCents: -5 }));
      expect(price).toEqual({ ok: false, refused: true, message: "Valore non valido", fieldErrors: { priceCents: "Valore non valido" } });
      const id = await formFailure(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, id: "uno" }));
      expect(id.fieldErrors).toHaveProperty("id");
      const extra = await rejectionOf(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, archivedAt: null }));
      expect(nameOf(extra)).toBe("ZodError");
      expect((await serviceRow(tx, SERVICE_A))?.price_cents).toBe(6000);
    });
  });
});

describe("applyPriceToFuture", () => {
  it("porta al prezzo nuovo solo i futuri prenotati o confermati ancora al prezzo vecchio", async () => {
    const result = await inUserA(db, async (tx) => {
      const atOld = [
        await insertAppointment(tx, "2026-11-04T00:15:00+01:00"),
        await insertAppointment(tx, "2026-11-05T09:00:00+01:00", { status: "confermato" }),
      ];
      const atOtherPrice = await insertAppointment(tx, "2026-11-06T09:00:00+01:00", { priceCents: 5000 });
      const untouched = [
        await insertAppointment(tx, "2026-11-03T22:30:00+01:00"),
        await insertAppointment(tx, "2026-11-07T09:00:00+01:00", { status: "annullato" }),
        await insertAppointment(tx, "2026-11-07T10:00:00+01:00", { status: "fatto" }),
      ];
      const asked = await updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, priceCents: 6500 });
      const applied = await applyPriceToFuture(tx, PRACTICE_A, clock, {
        serviceId: SERVICE_A,
        oldPriceCents: asked.oldPriceCents,
      });
      const again = await applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: 6000 });
      return {
        asked,
        applied,
        again,
        changed: await appointmentRows(tx, atOld),
        other: await appointmentRows(tx, [atOtherPrice]),
        untouched: await appointmentRows(tx, [APPOINTMENT_A, ...untouched]),
      };
    });
    expect(result.asked).toEqual({ futureAtOldPrice: 2, oldPriceCents: 6000 });
    expect(result.applied).toEqual({ updated: 2 });
    expect(result.again).toEqual({ updated: 0 });
    expect(result.changed.map((row) => row.price_cents)).toEqual([6500, 6500]);
    expect(result.other.map((row) => row.price_cents)).toEqual([5000]);
    expect(result.untouched.map((row) => row.price_cents)).toEqual([6000, 6000, 6000, 6000]);
  });

  it("senza appuntamenti al prezzo vecchio risponde zero", async () => {
    await inUserA(db, async (tx) => {
      expect(await applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: 4321 })).toEqual({
        updated: 0,
      });
    });
  });

  it("con il prezzo vecchio uguale a quello della voce non scrive niente", async () => {
    await inUserA(db, async (tx) => {
      const id = await insertAppointment(tx, "2026-11-05T09:00:00+01:00");
      const before = await appointmentRows(tx, [id]);
      expect(await applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: 6000 })).toEqual({
        updated: 0,
      });
      expect(await appointmentRows(tx, [id])).toEqual(before);
    });
  });

  it("una voce che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectNotAllowed(applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: MISSING, oldPriceCents: 6000 }));
    });
  });

  it("rifiuta un prezzo che non è un intero non negativo e chiavi in più", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: -1 }));
      expect(failure).toEqual({ ok: false, refused: true, message: "Valore non valido", fieldErrors: { oldPriceCents: "Valore non valido" } });
      const extra = await rejectionOf(
        applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: 6000, newPriceCents: 1 }),
      );
      expect(nameOf(extra)).toBe("ZodError");
    });
  });
});

describe("listServices e getRegime", () => {
  it("SERVICE_A è usata una volta e non si può eliminare", async () => {
    const rows = await inUserA(db, (tx) => listServices(tx, PRACTICE_A));
    expect(rows).toEqual([
      {
        id: SERVICE_A,
        kind: "seduta",
        name: "Seduta osteopatica",
        invoiceDescription: "Seduta di osteopatia",
        durationMin: 45,
        priceCents: 6000,
        color: "petrolio",
        sortOrder: 0,
        archivedAt: null,
        usedCount: 1,
        deletable: false,
      },
    ]);
  });

  it("le attive vengono per ordine, poi le archiviate; listActiveServices ha solo le attive", async () => {
    const { all, active, ids } = await inUserA(db, async (tx) => {
      const lunga = await createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA);
      const certificato = await createService(tx, PRACTICE_A, clock, CERTIFICATO);
      const prima = await createService(tx, PRACTICE_A, clock, PRIMA_VISITA);
      await archiveService(tx, PRACTICE_A, clock, { id: lunga.id });
      return {
        all: await listServices(tx, PRACTICE_A),
        active: await listActiveServices(tx, PRACTICE_A),
        ids: { lunga: lunga.id, certificato: certificato.id, prima: prima.id },
      };
    });
    expect(all.map((row) => row.id)).toEqual([SERVICE_A, ids.certificato, ids.prima, ids.lunga]);
    expect(all.map((row) => row.sortOrder)).toEqual([0, 2, 3, 1]);
    expect(all.at(-1)?.archivedAt).toEqual(clock.now());
    expect(active.map((row) => row.id)).toEqual([SERVICE_A, ids.certificato, ids.prima]);
    expect(active.every((row) => row.archivedAt === null)).toBe(true);
    // Una voce mai usata si può eliminare.
    expect(all.find((row) => row.id === ids.certificato)).toMatchObject({ usedCount: 0, deletable: true });
  });

  it("a parità di ordine vengono per nome, senza badare alle maiuscole", async () => {
    const names = await inUserA(db, async (tx) => {
      for (const name of ["zeta", "Beta", "alfa"]) {
        await insertRow(tx, "services", {
          practice_id: PRACTICE_A,
          kind: "altro",
          name,
          invoice_description: "Prova",
          duration_min: 30,
          price_cents: 1000,
          color: "ardesia",
          sort_order: 7,
        });
      }
      return (await listActiveServices(tx, PRACTICE_A)).map((row) => row.name);
    });
    expect(names).toEqual(["Seduta osteopatica", "alfa", "Beta", "zeta"]);
  });

  it("usedCount conta gli appuntamenti di ogni stato", async () => {
    const row = await inUserA(db, async (tx) => {
      await insertAppointment(tx, "2026-11-05T09:00:00+01:00", { status: "annullato" });
      await insertAppointment(tx, "2026-11-05T10:00:00+01:00", { status: "fatto" });
      return (await listServices(tx, PRACTICE_A)).find((service) => service.id === SERVICE_A);
    });
    expect(row).toMatchObject({ usedCount: 3, deletable: false });
  });

  it("getRegime legge il regime dello studio", async () => {
    const regimes = await inUserA(db, async (tx) => {
      const found: string[] = [await getRegime(tx, PRACTICE_A)];
      for (const regime of ["ordinario", "esente_sanitario"]) {
        await tx.query("update public.fiscal_settings set regime = $2 where practice_id = $1", [PRACTICE_A, regime]);
        found.push(await getRegime(tx, PRACTICE_A));
      }
      return found;
    });
    expect(regimes).toEqual(["forfettario", "ordinario", "esente_sanitario"]);
  });

  it("getRegime senza la riga dei dati fiscali è forfettario", async () => {
    const regime = await inService(db, async (tx) => {
      await tx.query("delete from public.fiscal_settings where practice_id = $1", [PRACTICE_A]);
      return getRegime(tx, PRACTICE_A);
    });
    expect(regime).toBe("forfettario");
  });
});

// Studio B sui dati di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B", () => {
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
      services: await tx.query("select * from public.services where practice_id = $1 order by id", [PRACTICE_A]),
      appointments: await tx.query("select * from public.appointments where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("archiveService come uB su SERVICE_A: Operazione non permessa e la riga di A è invariata", async () => {
    const before = await snapshotOfA();
    await asUserB(isolated, (tx) => expectNotAllowed(archiveService(tx, PRACTICE_A, clock, { id: SERVICE_A })));
    expect(await snapshotOfA()).toEqual(before);
    expect(before.services[0]).toMatchObject({ id: SERVICE_A, archived_at: null });
  });

  it("update, ripristino, eliminazione e prezzo come uB sugli id di A: Operazione non permessa e A non cambia", async () => {
    const before = await snapshotOfA();
    await asUserB(isolated, async (tx) => {
      await expectNotAllowed(updateService(tx, PRACTICE_A, clock, { ...SEDUTA_A, priceCents: 1, name: "Preso" }));
      await expectNotAllowed(restoreService(tx, PRACTICE_A, clock, { id: SERVICE_A }));
      await expectNotAllowed(deleteService(tx, PRACTICE_A, clock, { id: SERVICE_A }));
      await expectNotAllowed(applyPriceToFuture(tx, PRACTICE_A, clock, { serviceId: SERVICE_A, oldPriceCents: 6000 }));
    });
    expect(await snapshotOfA()).toEqual(before);
  });

  it("createService e createDefaultServices come uB su PRACTICE_A falliscono e A non cambia", async () => {
    const before = await snapshotOfA();
    await expectPgError(
      inRollback(isolated, "B", (tx) => createService(tx, PRACTICE_A, clock, SEDUTA_LUNGA)),
      "42501",
      /row-level security policy for table "services"/,
    );
    await expectPgError(
      inRollback(isolated, "B", (tx) => createDefaultServices(tx, PRACTICE_A, clock)),
      "42501",
      /row-level security policy for table "services"/,
    );
    expect(await snapshotOfA()).toEqual(before);
  });

  it("le query come uB su PRACTICE_A non vedono niente", async () => {
    const seen = await inRollback(isolated, "B", async (tx) => ({
      all: await listServices(tx, PRACTICE_A),
      active: await listActiveServices(tx, PRACTICE_A),
    }));
    expect(seen).toEqual({ all: [], active: [] });
  });
});
