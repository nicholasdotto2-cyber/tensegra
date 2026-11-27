import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { NewPhysicianInput } from "./schemas";

// La rubrica dei medici: nessuna pagina propria, il medico nasce da "Nuovo medico"
// dell'anagrafica e si sceglie lì, nella cartella e nel rinvio. Il comando non scrive
// `archived_at`, `created_by` né `created_at`.

/** Crea un medico nella rubrica dello studio. Come utente di un altro studio risponde la RLS (42501). */
export async function createPhysician(
  tx: Tx,
  practiceId: string,
  _clock: Clock,
  input: unknown,
): Promise<{ id: string }> {
  const physician = NewPhysicianInput.parse(input);
  const [row] = await tx.query<{ id: string }>(
    `insert into public.physicians (practice_id, full_name, role, specialty, organization, phone, email, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      practiceId,
      physician.fullName,
      physician.role,
      physician.specialty,
      physician.organization,
      physician.phone,
      physician.email,
      physician.notes,
    ],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return { id: row.id };
}
