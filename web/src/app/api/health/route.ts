import { connection } from "next/server";
import { getActor } from "@/server/auth/actor";
import { getDb } from "@/server/db/open";

export const dynamic = "force-dynamic";

type HealthRow = { unaccent: string; trgm: number };

// Non chiede lo studio: risponde anche su un database migrato senza seed. La seconda query è la
// ricerca della lista pazienti scritta come l'indice `patients_search_trgm_idx`: su un
// database vuoto vale 0, ma gira, e fallisce se la funzione o l'indice mancano.
export async function GET() {
  await connection();
  const db = await getDb();
  const { row, patientSearch } = await db.asUser(getActor(), async (tx) => {
    const [row] = await tx.query<HealthRow>(
      "select extensions.unaccent($1) as unaccent, extensions.similarity($2, $3) as trgm",
      ["Bellandì", "bellandi", "bellandini"],
    );
    const [search] = await tx.query<{ n: number }>(
      `select count(*)::int as n from public.patients
        where app.search_text(first_name || ' ' || last_name || ' ' || first_name) like '%' || app.search_text($1) || '%'`,
      ["Bellandì"],
    );
    return { row, patientSearch: search?.n };
  });
  if (!row || patientSearch === undefined) throw new Error("health query returned no row");
  return Response.json({ ok: true, unaccent: row.unaccent, trgm: row.trgm, patientSearch });
}
