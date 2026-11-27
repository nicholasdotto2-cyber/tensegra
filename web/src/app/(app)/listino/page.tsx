import { BlockError } from "@/components/oggi/block-error";
import { NewServiceButton } from "@/components/listino/service-sheet";
import { RegimeNote } from "@/components/listino/regime-note";
import { ServicesTable } from "@/components/listino/services-table";
import { PageHeader } from "@/components/shell/page-header";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { getRegime, listServices } from "@/server/domain/services/queries";

// Il Listino: le prestazioni dello studio con il regime fiscale in cima. Una sola transazione
// per la pagina, con le letture in un savepoint: se falliscono resta l'intestazione e al posto
// della tabella "Non riesco a caricare il listino." con "Riprova". La tabella, il pannello e le conferme
// stanno nei client component, che ricevono solo righe serializzabili.

export default async function ListinoPage() {
  const ctx = await getRequestContext();
  const state = await ctx.db.asUser(ctx.actor, (tx) =>
    settle(tx, "listino", async () => ({
      rows: await listServices(tx, ctx.practiceId),
      regime: await getRegime(tx, ctx.practiceId),
    })),
  );

  return (
    <>
      <PageHeader title="Listino" actions={<NewServiceButton />} />
      {state.ok ? (
        <>
          <RegimeNote regime={state.value.regime} />
          <ServicesTable rows={state.value.rows} />
        </>
      ) : (
        <BlockError message="Non riesco a caricare il listino." />
      )}
    </>
  );
}
