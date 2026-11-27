import type { Tx } from "@/server/db/db";
import type { PhysicianRole } from "./schemas";

// La rubrica dei medici per le scelte dell'anagrafica, della cartella e del rinvio.

export interface PhysicianOption {
  id: string;
  fullName: string;
  role: PhysicianRole;
}

/** I medici non archiviati dello studio, per nome senza maiuscole, poi id. */
export async function listPhysicians(tx: Tx, practiceId: string): Promise<PhysicianOption[]> {
  return tx.query<PhysicianOption>(
    `select id, full_name as "fullName", role
       from public.physicians
      where practice_id = $1 and archived_at is null
      order by lower(full_name), id`,
    [practiceId],
  );
}
