import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { BlockError } from "@/components/oggi/block-error";
import { PatientFilters } from "@/components/pazienti/patient-filters";
import type { NewPatientDialogProps } from "@/components/pazienti/new-patient-dialog";
import { NewPatientLauncher, NewPatientTrigger } from "@/components/pazienti/new-patient-launcher";
import { PatientsTable } from "@/components/pazienti/patients-table";
import { WithoutConsentGroup } from "@/components/pazienti/recall-actions";
import { PageHeader } from "@/components/shell/page-header";
import { parsePatientListParams } from "@/lib/patients/params";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { listPatients } from "@/server/domain/patients/list";
import { listActiveServices } from "@/server/domain/services/queries";
import { getClinicalSettings } from "@/server/domain/settings/queries";

// I Pazienti: ricerca, sei filtri con il loro conteggio e la tabella, con lo stato
// nell'URL. Una sola transazione per la pagina, con le letture della lista, delle prestazioni e
// dei default della cartella in un savepoint: se falliscono resta l'intestazione e al posto della lista
// "Non riesco a caricare questo elenco." con "Riprova". Prestazioni e default servono al dialogo
// "Nuovo paziente" e all'appuntamento che segue, e a «Fissa appuntamento» delle righe «Da richiamare», che
// sotto la tabella hanno anche il gruppo chiuso senza consenso ai richiami.

// I default della tabella `clinical_settings`, se la riga dello studio manca.
const DEFAULT_INTERVAL_WEEKS = 2;
const DEFAULT_EXPECTED_SESSIONS = 4;

/** Una ricerca di sole cifre è un telefono, non il cognome di un paziente nuovo. */
const PHONE_SEARCH = /^(?=.*\d)[\d\s+().-]+$/;

/** "rossi" diventa "Rossi", "de luca" "De Luca": il testo cercato come cognome del paziente nuovo. */
function asName(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("it")
    .replace(/(^|[\s'’-])(\p{L})/gu, (_, before: string, letter: string) => `${before}${letter.toLocaleUpperCase("it")}`);
}

export default async function PazientiPage({ searchParams }: PageProps<"/pazienti">) {
  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const params = parsePatientListParams(await searchParams);

  const state = await ctx.db.asUser(ctx.actor, (tx) =>
    settle(tx, "pazienti", async () => ({
      list: await listPatients(tx, ctx.practiceId, clock, params),
      services: await listActiveServices(tx, ctx.practiceId),
      clinical: await getClinicalSettings(tx, ctx.practiceId),
    })),
  );

  if (!state.ok) {
    return (
      <>
        <PageHeader title="Pazienti" />
        <BlockError />
      </>
    );
  }

  const { list, services, clinical } = state.value;
  const creation: Omit<NewPatientDialogProps, "open" | "onOpenChange" | "initialLastName"> = {
    today: clock.today(),
    services: services.map(
      (s): ServiceOption => ({ id: s.id, name: s.name, kind: s.kind, durationMin: s.durationMin, priceCents: s.priceCents }),
    ),
    defaultIntervalWeeks: clinical?.defaultSessionIntervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
    defaultExpectedSessions: clinical?.defaultExpectedSessions ?? DEFAULT_EXPECTED_SESSIONS,
  };

  const searched = params.q.trim();
  const lastName = asName(searched);
  let empty: React.ReactNode = null;
  if (list.rows.length === 0) {
    if (searched !== "" && params.filtro === "tutti") {
      empty = (
        <div className="flex flex-col items-start gap-3">
          <p>{`Nessun paziente trovato per «${searched}».`}</p>
          {PHONE_SEARCH.test(searched) ? null : (
            <NewPatientTrigger lastName={lastName} label={`Crea ${lastName} come nuovo paziente`} />
          )}
        </div>
      );
    } else if (searched === "" && params.filtro === "tutti") {
      empty = (
        <div className="flex flex-col items-start gap-3">
          <p>Nessun paziente.</p>
          <NewPatientTrigger />
        </div>
      );
    } else {
      empty = <p>Nessun paziente in questo elenco.</p>;
    }
  }

  return (
    <NewPatientLauncher {...creation}>
      <PageHeader title="Pazienti" actions={<NewPatientTrigger />} />
      <PatientFilters params={params} counts={list.counts} />
      {empty ?? <PatientsTable list={list} params={params} booking={creation} />}
      <WithoutConsentGroup rows={list.withoutConsent} />
    </NewPatientLauncher>
  );
}
