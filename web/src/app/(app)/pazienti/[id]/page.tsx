import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { z } from "zod";

import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { CartellaTabView } from "@/components/cartella/cartella-tab";
import { BlockError } from "@/components/oggi/block-error";
import { AppointmentsTabView } from "@/components/pazienti/appointments-tab";
import { ConsentsTabView } from "@/components/pazienti/consents-tab";
import { InvoicesTabView } from "@/components/pazienti/invoices-tab";
import { MessagesTabView } from "@/components/pazienti/messages-tab";
import { PatientHeaderBar } from "@/components/pazienti/patient-header";
import { PatientTabs } from "@/components/pazienti/patient-tabs";
import { RegistryTab } from "@/components/pazienti/registry-tab";
import { SummaryTabView } from "@/components/pazienti/summary-tab";
import { PageHeader } from "@/components/shell/page-header";
import { floorToQuarter } from "@/lib/agenda/slots";
import { isMinor, minutesLabel } from "@/lib/format";
import { type CartellaView, parsePatientTabParams } from "@/lib/patients/params";
import { fixedClock, romeMinutes, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { type Settled, settle } from "@/server/db/settle";
import { listPhotos, type PhotoRow } from "@/server/domain/attachments/queries";
import { type CartellaTab, getCartellaTab, getTestsOverTime, type TestsOverTime } from "@/server/domain/cartella/queries";
import { type InvoiceRow, listPatientInvoices } from "@/server/domain/invoices/queries";
import { listPatientMessages, type MessageLogRow } from "@/server/domain/messages/queries";
import {
  type ChoiceLine,
  type CollectTargets,
  type ConsentLine,
  getCollectTargets,
  getPatientHeader,
  getRegistry,
  getSummaryTab,
  listPatientAppointments,
  listPatientChoices,
  listPatientConsents,
  type PatientAppointments,
  type RegistryView,
  type SummaryTab,
} from "@/server/domain/patients/card";
import { listPhysicians, type PhysicianOption } from "@/server/domain/physicians/queries";
import { listActiveServices } from "@/server/domain/services/queries";
import { getClinicalSettings } from "@/server/domain/settings/queries";

// La scheda del paziente: testata e sezione attiva, con la sezione nell'URL (`?tab=`). Una sola
// transazione per la pagina, con due `settle`: la testata (con le prestazioni e i default che servono
// a "Nuovo appuntamento") e il contenuto della sezione. Se il contenuto non si legge resta la testata e al
// posto della sezione "Non riesco a caricare questo elenco." con "Riprova". La Cartella legge, secondo `vista`,
// anche i test nel tempo o le foto nello stesso `settle`. Un id che non è un uuid, o un
// paziente che non c'è o è di un altro studio, è 404 "Paziente non trovato." (`not-found.tsx` del segmento).

// I default della tabella `clinical_settings`, se la riga dello studio manca.
const DEFAULT_INTERVAL_WEEKS = 2;
const DEFAULT_EXPECTED_SESSIONS = 4;

const PATIENT_ID = z.uuid();

type Body =
  | { tab: "riepilogo"; value: SummaryTab }
  | { tab: "appuntamenti"; value: PatientAppointments }
  | { tab: "consensi"; value: ConsentLine[]; choices: ChoiceLine[]; collect: CollectTargets; today: string }
  | { tab: "fatture"; value: InvoiceRow[] }
  | { tab: "messaggi"; value: MessageLogRow[] }
  | { tab: "anagrafica"; registry: RegistryView; physicians: PhysicianOption[]; minor: boolean }
  | { tab: "cartella"; cartella: CartellaTab; vista: CartellaView; tests: TestsOverTime | null; photos: PhotoRow[] | null };

export default async function PatientPage({ params, searchParams }: PageProps<"/pazienti/[id]">) {
  const { id } = await params;
  // Prima di toccare il database: un id che non è un uuid non può essere di nessun paziente.
  if (!PATIENT_ID.safeParse(id).success) notFound();

  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const { tab, vista, ciclo, regione } = parsePatientTabParams(await searchParams);

  const state = await ctx.db.asUser(ctx.actor, async (tx) => {
    const head = await settle(tx, "testata", async () => ({
      header: await getPatientHeader(tx, ctx.practiceId, clock, id),
      services: await listActiveServices(tx, ctx.practiceId),
      clinical: await getClinicalSettings(tx, ctx.practiceId),
    }));
    // Un paziente assente non ha sezioni da leggere.
    if (!head.ok || head.value.header === null) return { head, body: null };

    const body = await settle(tx, "sezione", async (): Promise<Body> => {
      switch (tab) {
        case "riepilogo": {
          const value = await getSummaryTab(tx, ctx.practiceId, clock, id);
          if (value === null) throw new Error("Riepilogo assente per un paziente che c'è.");
          return { tab, value };
        }
        case "appuntamenti":
          return { tab, value: await listPatientAppointments(tx, ctx.practiceId, clock, id) };
        case "consensi": {
          const collect = await getCollectTargets(tx, ctx.practiceId, clock, id);
          if (collect === null) throw new Error("Consensi assenti per un paziente che c'è.");
          return {
            tab,
            value: await listPatientConsents(tx, ctx.practiceId, id, collect),
            choices: await listPatientChoices(tx, ctx.practiceId, id),
            collect,
            today: clock.today(),
          };
        }
        case "fatture":
          return { tab, value: await listPatientInvoices(tx, ctx.practiceId, id) };
        case "messaggi":
          return { tab, value: await listPatientMessages(tx, ctx.practiceId, id) };
        case "anagrafica": {
          const registry = await getRegistry(tx, ctx.practiceId, id);
          if (registry === null) throw new Error("Anagrafica assente per un paziente che c'è.");
          return {
            tab,
            registry,
            physicians: await listPhysicians(tx, ctx.practiceId),
            minor: isMinor(registry.personali.birthDate, clock.today()),
          };
        }
        case "cartella":
          return {
            tab,
            cartella: await getCartellaTab(tx, ctx.practiceId, clock, id),
            vista,
            tests:
              vista === "test" ? await getTestsOverTime(tx, ctx.practiceId, id, { cycleId: ciclo, region: regione }) : null,
            photos: vista === "foto" ? await listPhotos(tx, ctx.practiceId, id) : null,
          };
      }
    });
    return { head, body };
  });

  // Fuori dal `settle`: `notFound()` lancia, e un savepoint lo scambierebbe per un blocco fallito.
  if (state.head.ok && state.head.value.header === null) notFound();
  if (!state.head.ok) {
    return (
      <>
        <PageHeader title="Paziente" />
        <BlockError message="Non riesco a caricare la scheda del paziente." />
      </>
    );
  }

  const { header, services, clinical } = state.head.value;
  if (header === null) notFound();
  const booking = {
    services: services.map(
      (s): ServiceOption => ({ id: s.id, name: s.name, kind: s.kind, durationMin: s.durationMin, priceCents: s.priceCents }),
    ),
    defaultIntervalWeeks: clinical?.defaultSessionIntervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
    defaultExpectedSessions: clinical?.defaultExpectedSessions ?? DEFAULT_EXPECTED_SESSIONS,
  };

  // "Nuova visita" della Cartella: oggi e l'ora di Roma al quarto d'ora precedente (08:37 diventa 08:30).
  const cartellaBooking = {
    ...booking,
    today: clock.today(),
    nowTime: minutesLabel(floorToQuarter(romeMinutes(clock.now()))),
  };

  return (
    <>
      <PatientHeaderBar header={header} booking={booking} />
      <PatientTabs patientId={id} current={tab} />
      <TabContent patientId={id} body={state.body} booking={cartellaBooking} />
    </>
  );
}

function TabContent({
  patientId,
  body,
  booking,
}: {
  patientId: string;
  body: Settled<Body> | null;
  booking: ComponentProps<typeof CartellaTabView>["booking"];
}) {
  if (body === null || !body.ok) return <BlockError />;
  const content = body.value;
  switch (content.tab) {
    case "riepilogo":
      return <SummaryTabView tab={content.value} patientId={patientId} />;
    case "appuntamenti":
      return <AppointmentsTabView tab={content.value} patientId={patientId} />;
    case "consensi":
      return (
        <ConsentsTabView
          patientId={patientId}
          rows={content.value}
          choices={content.choices}
          collect={content.collect}
          today={content.today}
        />
      );
    case "fatture":
      return <InvoicesTabView rows={content.value} />;
    case "messaggi":
      return <MessagesTabView rows={content.value} />;
    case "anagrafica":
      return <RegistryTab registry={content.registry} physicians={content.physicians} minor={content.minor} />;
    case "cartella":
      return (
        <CartellaTabView
          tab={content.cartella}
          patientId={patientId}
          vista={content.vista}
          tests={content.tests}
          photos={content.photos}
          booking={booking}
        />
      );
  }
}
