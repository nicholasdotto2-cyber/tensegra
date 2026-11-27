import { KIND_LABEL, type ServiceKind } from "@/lib/agenda/defaults";
import { type Clock, romeDayBounds } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { BLOCKED_DELETE, DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { ApplyPriceInput, ServiceIdInput, ServiceInput, ServiceUpdateInput } from "./schemas";

// Comandi del Listino: una voce usata si archivia e non si elimina, resta almeno
// una voce attiva per ogni tipo su cui contano i default dell'agenda (archiviazione,
// eliminazione e cambio di tipo), e un cambio di prezzo tocca solo gli appuntamenti futuri ancora al
// prezzo vecchio. Nessun comando scrive `created_by`, `created_at` o `practice_id` di una riga esistente.

/** Le tre voci di partenza: "Crea le tre voci di partenza" e il seed. */
export const DEFAULT_SERVICES = [
  {
    kind: "prima_visita",
    name: "Prima visita osteopatica",
    invoiceDescription: "Prima visita osteopatica",
    durationMin: 60,
    priceCents: 8000,
    color: "ocra",
  },
  {
    kind: "seduta",
    name: "Seduta osteopatica",
    invoiceDescription: "Trattamento osteopatico",
    durationMin: 45,
    priceCents: 5500,
    color: "petrolio",
  },
  {
    kind: "controllo",
    name: "Controllo",
    invoiceDescription: "Controllo osteopatico",
    durationMin: 30,
    priceCents: 4500,
    color: "salvia",
  },
] as const satisfies readonly ServiceInput[];

const NAME_TAKEN = "Esiste già una prestazione attiva con questo nome.";

const nameTaken = (): DomainError => new DomainError(NAME_TAKEN, { field: "name" });

/** "Serve almeno una prestazione attiva di tipo Seduta.". */
const lastActive = (kind: ServiceKind, field?: string): DomainError =>
  new DomainError(`Serve almeno una prestazione attiva di tipo ${KIND_LABEL[kind]}.`, field ? { field } : {});

interface CurrentService {
  kind: ServiceKind;
  name: string;
  priceCents: number;
  archivedAt: Date | null;
}

/** La riga com'è nel database. Se non c'è (o è di un altro studio) è "Operazione non permessa". */
async function currentOf(tx: Tx, practiceId: string, id: string): Promise<CurrentService> {
  const [row] = await tx.query<CurrentService>(
    `select kind, name, price_cents as "priceCents", archived_at as "archivedAt"
       from public.services
      where practice_id = $1 and id = $2`,
    [practiceId, id],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

/** Un'altra voce attiva con lo stesso nome, senza badare alle maiuscole (come l'indice unico). */
async function activeNameTaken(tx: Tx, practiceId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.query(
    `select 1
       from public.services
      where practice_id = $1
        and archived_at is null
        and lower(name) = lower($2)
        and id is distinct from $3::uuid
      limit 1`,
    [practiceId, name, exceptId],
  );
  return rows.length > 0;
}

/** Vero se nessun'altra voce attiva ha questo tipo. Per `altro` non c'è nessuna regola. */
async function isLastActiveOfKind(tx: Tx, practiceId: string, id: string, kind: ServiceKind): Promise<boolean> {
  if (kind === "altro") return false;
  const rows = await tx.query(
    `select 1
       from public.services
      where practice_id = $1 and kind = $2 and archived_at is null and id <> $3
      limit 1`,
    [practiceId, kind, id],
  );
  return rows.length === 0;
}

/** Il prossimo `sort_order`: il massimo dello studio più uno, anche fra le voci archiviate. */
async function nextSortOrder(tx: Tx, practiceId: string): Promise<number> {
  const [row] = await tx.query<{ next: number }>(
    "select coalesce(max(sort_order), 0)::int + 1 as next from public.services where practice_id = $1",
    [practiceId],
  );
  return row?.next ?? 1;
}

async function insertService(tx: Tx, practiceId: string, service: ServiceInput, sortOrder: number): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.services
       (practice_id, kind, name, invoice_description, duration_min, price_cents, color, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      practiceId,
      service.kind,
      service.name,
      service.invoiceDescription,
      service.durationMin,
      service.priceCents,
      service.color,
      sortOrder,
    ],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row.id;
}

/** Una voce nuova, attiva, in fondo al listino. */
export async function createService(
  tx: Tx,
  practiceId: string,
  _clock: Clock,
  input: unknown,
): Promise<{ id: string }> {
  const service = ServiceInput.parse(input);
  if (await activeNameTaken(tx, practiceId, service.name, null)) throw nameTaken();
  const id = await insertService(tx, practiceId, service, await nextSortOrder(tx, practiceId));
  return { id };
}

/**
 * Le tre voci di partenza, solo se nessuna voce è attiva (il pulsante compare solo col listino
 * vuoto). È l'unico comando che non riceve niente dal modulo, quindi nella firma c'è il `Clock` e
 * non l'input; l'orologio non serve (nessun istante da scrivere), e il tipo lo dichiara per chi chiama.
 */
export const createDefaultServices: (tx: Tx, practiceId: string, clock: Clock) => Promise<void> = async (
  tx,
  practiceId,
) => {
  const active = await tx.query("select 1 from public.services where practice_id = $1 and archived_at is null limit 1", [
    practiceId,
  ]);
  if (active.length > 0) throw new DomainError(NOT_ALLOWED);
  const first = await nextSortOrder(tx, practiceId);
  for (const [index, service] of DEFAULT_SERVICES.entries()) {
    await insertService(tx, practiceId, service, first + index);
  }
};

/**
 * Modifica una voce. Cambiare prezzo non tocca appuntamenti né fatture: risponde quanti
 * appuntamenti futuri sono ancora al prezzo vecchio, e `applyPriceToFuture` li porta
 * al nuovo se l'utente lo chiede. Cambiare durata non tocca gli appuntamenti esistenti.
 */
export async function updateService(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ futureAtOldPrice: number; oldPriceCents: number }> {
  const service = ServiceUpdateInput.parse(input);
  const current = await currentOf(tx, practiceId, service.id);
  // Una voce archiviata non conta fra le attive: né per il nome né per il tipo.
  if (current.archivedAt === null) {
    if (await activeNameTaken(tx, practiceId, service.name, service.id)) throw nameTaken();
    if (service.kind !== current.kind && (await isLastActiveOfKind(tx, practiceId, service.id, current.kind))) {
      throw lastActive(current.kind, "kind");
    }
  }
  const rows = await tx.query(
    `update public.services
        set kind = $3,
            name = $4,
            invoice_description = $5,
            duration_min = $6,
            price_cents = $7,
            color = $8
      where practice_id = $1 and id = $2
      returning id`,
    [
      practiceId,
      service.id,
      service.kind,
      service.name,
      service.invoiceDescription,
      service.durationMin,
      service.priceCents,
      service.color,
    ],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
  if (service.priceCents === current.priceCents) {
    return { futureAtOldPrice: 0, oldPriceCents: current.priceCents };
  }
  const [count] = await tx.query<{ n: number }>(
    `select count(*)::int as n
       from public.appointments
      where practice_id = $1
        and service_id = $2
        and status in ('prenotato', 'confermato')
        and starts_at >= $3
        and price_cents = $4`,
    [practiceId, service.id, romeDayBounds(clock.today()).start, current.priceCents],
  );
  return { futureAtOldPrice: count?.n ?? 0, oldPriceCents: current.priceCents };
}

/**
 * Porta al prezzo attuale della voce gli appuntamenti prenotati o confermati da 00:00 di oggi che
 * hanno ancora il prezzo vecchio. Passati, fatti, annullati, saltati e quelli a un altro prezzo
 * (concordato) non cambiano.
 */
export async function applyPriceToFuture(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ updated: number }> {
  const { serviceId, oldPriceCents } = ApplyPriceInput.parse(input);
  const service = await currentOf(tx, practiceId, serviceId);
  if (service.priceCents === oldPriceCents) return { updated: 0 };
  const rows = await tx.query(
    `update public.appointments
        set price_cents = $3
      where practice_id = $1
        and service_id = $2
        and status in ('prenotato', 'confermato')
        and starts_at >= $4
        and price_cents = $5
      returning id`,
    [practiceId, serviceId, service.priceCents, romeDayBounds(clock.today()).start, oldPriceCents],
  );
  return { updated: rows.length };
}

/** Archivia una voce attiva, con l'istante del clock. L'ultima voce attiva di un tipo resta. */
export async function archiveService(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id } = ServiceIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  if (current.archivedAt !== null) throw new DomainError(NOT_ALLOWED);
  if (await isLastActiveOfKind(tx, practiceId, id, current.kind)) throw lastActive(current.kind);
  const rows = await tx.query(
    `update public.services
        set archived_at = $3
      where practice_id = $1 and id = $2 and archived_at is null
      returning id`,
    [practiceId, id, clock.now()],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Riattiva una voce archiviata, se nessun'altra voce attiva ha il suo nome. */
export async function restoreService(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { id } = ServiceIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  if (current.archivedAt === null) throw new DomainError(NOT_ALLOWED);
  if (await activeNameTaken(tx, practiceId, current.name, id)) throw nameTaken();
  const rows = await tx.query(
    `update public.services
        set archived_at = null
      where practice_id = $1 and id = $2 and archived_at is not null
      returning id`,
    [practiceId, id],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/**
 * Elimina una voce mai usata (nessun appuntamento e nessuna riga di fattura, anche
 * in bozza o annullata). In quest'ordine: l'uso, poi la regola della voce attiva per tipo, poi la
 * delete. Se la delete arriva comunque al database, `23001` (Postgres 18) e `23503` (Postgres 17)
 * sono lo stesso blocco.
 */
export async function deleteService(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { id } = ServiceIdInput.parse(input);
  // Il tipo serve alla regola: una voce che non c'è (o di un altro studio) si ferma qui.
  const current = await currentOf(tx, practiceId, id);
  const [usage] = await tx.query<{ used: boolean }>(
    `select exists (select 1 from public.appointments where practice_id = $1 and service_id = $2)
         or exists (select 1 from public.invoice_lines where practice_id = $1 and service_id = $2) as used`,
    [practiceId, id],
  );
  if (usage?.used) throw new DomainError(BLOCKED_DELETE);
  if (current.archivedAt === null && (await isLastActiveOfKind(tx, practiceId, id, current.kind))) {
    throw lastActive(current.kind);
  }
  let rows: unknown[];
  try {
    rows = await tx.query("delete from public.services where practice_id = $1 and id = $2 returning id", [
      practiceId,
      id,
    ]);
  } catch (error) {
    const code = pgCode(error);
    if (code === "23001" || code === "23503") throw new DomainError(BLOCKED_DELETE);
    throw error;
  }
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}
