import { NewAppointmentButton, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { AppointmentsBlock } from "@/components/oggi/appointments-block";
import { ConsentsBlock } from "@/components/oggi/consents-block";
import { InvoicesBlock } from "@/components/oggi/invoices-block";
import { MidnightRefresh } from "@/components/oggi/midnight-refresh";
import { RecallsBlock } from "@/components/oggi/recalls-block";
import { RemindersBlock } from "@/components/oggi/reminders-block";
import { NewPatientLauncher, NewPatientTrigger } from "@/components/pazienti/new-patient-launcher";
import { PageHeader } from "@/components/shell/page-header";
import { dayLong } from "@/lib/format";
import { fixedClock, systemClock } from "@/server/clock";
import { settle } from "@/server/db/settle";
import { getRequestContext } from "@/server/db/next";
import { listDayAppointments, listReminders } from "@/server/domain/appointments/queries";
import { listMissingConsents } from "@/server/domain/consents/queries";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { listTodayRecalls } from "@/server/domain/patients/queries";
import { listActiveServices } from "@/server/domain/services/queries";
import { bandsOf } from "@/server/domain/settings/opening-days";
import { getClinicalSettings, getOpeningHours } from "@/server/domain/settings/queries";

// Oggi: la giornata e le cose da non dimenticare in una schermata, senza clic. Una sola
// transazione per la pagina; ogni blocco legge dentro il suo savepoint, così uno che fallisce
// mostra "Non riesco a caricare questo elenco." e gli altri restano. Prestazioni e default
// della cartella, letti fuori dai blocchi come gli orari, servono al dialogo "Nuovo appuntamento"
// dell'intestazione e di "Fissa appuntamento", e alle azioni delle righe del blocco 1 ("Sposta", il
// pannello "Seduta fatta"). "Nuovo paziente" dell'intestazione apre il dialogo della lista dei pazienti, montato
// una volta sola per la pagina (`NewPatientLauncher`): i blocchi che cambiano non lo smontano.

// I default della tabella `clinical_settings`, se la riga dello studio manca.
const DEFAULT_INTERVAL_WEEKS = 2;
const DEFAULT_EXPECTED_SESSIONS = 4;

export default async function OggiPage() {
  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const today = clock.today();
  const data = await ctx.db.asUser(ctx.actor, async (tx) => ({
    hours: await getOpeningHours(tx, ctx.practiceId),
    services: await listActiveServices(tx, ctx.practiceId),
    clinical: await getClinicalSettings(tx, ctx.practiceId),
    appointments: await settle(tx, "oggi_appuntamenti", () => listDayAppointments(tx, ctx.practiceId, clock, today)),
    consents: await settle(tx, "oggi_consensi", () => listMissingConsents(tx, ctx.practiceId, clock)),
    invoices: await settle(tx, "oggi_fatture", () => listToInvoice(tx, ctx.practiceId, clock)),
    reminders: await settle(tx, "oggi_promemoria", () => listReminders(tx, ctx.practiceId, clock)),
    recalls: await settle(tx, "oggi_richiami", () => listTodayRecalls(tx, ctx.practiceId, clock)),
  }));
  const closedDay = bandsOf(data.hours, today).length === 0;
  const booking = {
    services: data.services.map(
      (s): ServiceOption => ({ id: s.id, name: s.name, kind: s.kind, durationMin: s.durationMin, priceCents: s.priceCents }),
    ),
    defaultIntervalWeeks: data.clinical?.defaultSessionIntervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
    defaultExpectedSessions: data.clinical?.defaultExpectedSessions ?? DEFAULT_EXPECTED_SESSIONS,
  };

  return (
    <NewPatientLauncher today={today} {...booking}>
      <PageHeader
        title="Oggi"
        subtitle={<time dateTime={today}>{dayLong(today)}</time>}
        actions={
          <>
            <NewAppointmentButton {...booking} />
            <NewPatientTrigger variant="outline" />
          </>
        }
      />
      <MidnightRefresh day={today} />
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <AppointmentsBlock state={data.appointments} closedDay={closedDay} today={today} {...booking} />
        </div>
        <div className="flex flex-col gap-6">
          <ConsentsBlock state={data.consents} />
          <InvoicesBlock state={data.invoices} />
          <RemindersBlock state={data.reminders} />
          <RecallsBlock state={data.recalls} {...booking} />
        </div>
      </div>
    </NewPatientLauncher>
  );
}
