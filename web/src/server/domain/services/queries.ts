import type { ServiceColor, ServiceKind } from "@/lib/agenda/defaults";
import type { Tx } from "@/server/db/db";

// Letture del Listino: la pagina Listino, l'agenda e il dialogo "Nuovo
// appuntamento". Ogni lettura filtra lo studio anche oltre la RLS.

/** Una voce del listino come la mostrano le pagine. Il prezzo è in centesimi, IVA compresa in ordinario. */
export interface ServiceRow {
  id: string;
  kind: ServiceKind;
  name: string;
  invoiceDescription: string;
  durationMin: number;
  priceCents: number;
  color: ServiceColor;
  sortOrder: number;
  /** null = attiva. */
  archivedAt: Date | null;
  /** Gli appuntamenti di ogni stato che usano la voce. */
  usedCount: number;
  /** Mai usata: nessun appuntamento e nessuna riga di fattura, anche annullata o in bozza. */
  deletable: boolean;
}

// Le attive per `sort_order`, poi le archiviate; a parità, per nome senza badare alle maiuscole.
const SELECT_SERVICES = `select s.id,
       s.kind,
       s.name,
       s.invoice_description as "invoiceDescription",
       s.duration_min as "durationMin",
       s.price_cents as "priceCents",
       s.color,
       s.sort_order as "sortOrder",
       s.archived_at as "archivedAt",
       (select count(*)::int
          from public.appointments a
         where a.practice_id = s.practice_id and a.service_id = s.id) as "usedCount",
       not (exists (select 1
                      from public.appointments a
                     where a.practice_id = s.practice_id and a.service_id = s.id)
            or exists (select 1
                         from public.invoice_lines l
                        where l.practice_id = s.practice_id and l.service_id = s.id)) as deletable
  from public.services s
 where s.practice_id = $1`;
const ORDER_SERVICES = "order by (s.archived_at is not null), s.sort_order, lower(s.name), s.id";

/** Tutte le voci: prima le attive, poi le archiviate. */
export function listServices(tx: Tx, practiceId: string): Promise<ServiceRow[]> {
  return tx.query<ServiceRow>(`${SELECT_SERVICES} ${ORDER_SERVICES}`, [practiceId]);
}

/** Le voci attive, quelle che si possono scegliere per un appuntamento. */
export function listActiveServices(tx: Tx, practiceId: string): Promise<ServiceRow[]> {
  return tx.query<ServiceRow>(`${SELECT_SERVICES} and s.archived_at is null ${ORDER_SERVICES}`, [practiceId]);
}

export type Regime = "ordinario" | "forfettario" | "esente_sanitario";

/** Il regime fiscale dello studio; senza la riga dei dati fiscali vale il default della tabella, forfettario. */
export async function getRegime(tx: Tx, practiceId: string): Promise<Regime> {
  const [row] = await tx.query<{ regime: Regime }>("select regime from public.fiscal_settings where practice_id = $1", [
    practiceId,
  ]);
  return row?.regime ?? "forfettario";
}
