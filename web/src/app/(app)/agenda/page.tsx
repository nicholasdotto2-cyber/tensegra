import Link from "next/link";

import { AgendaView } from "@/components/agenda/agenda-view";
import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { AgendaToolbar } from "@/components/agenda/toolbar";
import { BlockError } from "@/components/oggi/block-error";
import { PageHeader } from "@/components/shell/page-header";
import { gridWindow, visibleWeekdays } from "@/lib/agenda/grid";
import { isActive } from "@/lib/agenda/status";
import { dayLong, weekdayShortDay, weekRangeLabel } from "@/lib/format";
import { addDaysRome, fixedClock, isoWeekday, mondayOf, romeMinutes, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { toBlock } from "@/server/domain/appointments/blocks";
import { listRange } from "@/server/domain/appointments/queries";
import { parseAgendaParams } from "@/server/domain/appointments/schemas";
import { listActiveServices } from "@/server/domain/services/queries";
import { getClinicalSettings, getOpeningHours } from "@/server/domain/settings/queries";

// L'agenda: giorno o settimana, con lo stato nell'URL. Una sola transazione
// per la pagina e le letture in un savepoint: se falliscono la barra resta e la griglia lascia il
// posto a "Non riesco a caricare l'agenda." con "Riprova". I blocchi nascono qui (`toBlock`): il client
// riceve solo `AgendaBlock`. Barra, griglia e dialogo "Nuovo appuntamento" stanno in `AgendaView`, che
// riceve solo dati serializzabili: servizi attivi e default della cartella sono per il dialogo.

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
// I default della tabella `clinical_settings`, se la riga dello studio manca.
const DEFAULT_INTERVAL_WEEKS = 2;
const DEFAULT_EXPECTED_SESSIONS = 4;

export default async function AgendaPage({ searchParams }: PageProps<"/agenda">) {
  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const today = clock.today();
  const { view, day, showCancelled } = parseAgendaParams(await searchParams, today);
  const week = view === "settimana";
  const from = week ? mondayOf(day) : day;
  const to = addDaysRome(from, week ? 7 : 1);

  const state = await ctx.db.asUser(ctx.actor, (tx) =>
    settle(tx, "agenda", async () => ({
      hours: await getOpeningHours(tx, ctx.practiceId),
      appointments: await listRange(tx, ctx.practiceId, from, to),
      services: await listActiveServices(tx, ctx.practiceId),
      clinical: await getClinicalSettings(tx, ctx.practiceId),
    })),
  );

  const step = week ? 7 : 1;
  const toolbar = {
    view,
    day,
    prevDay: addDaysRome(day, -step),
    nextDay: addDaysRome(day, step),
    today,
    showCancelled,
  };

  if (!state.ok) {
    return (
      <>
        <PageHeader title="Agenda" />
        <AgendaToolbar {...toolbar} label={week ? weekRangeLabel(from, addDaysRome(from, 5)) : dayLong(day)} />
        <BlockError message="Non riesco a caricare l'agenda." />
      </>
    );
  }

  const { hours, clinical } = state.value;
  // Gli annullati sono nascosti nella settimana, salvo "Mostra annullati"; nel giorno si vedono.
  const blocks = state.value.appointments
    .map(toBlock)
    .filter((block) => !week || showCancelled || block.status !== "annullato");
  const shownDays = week
    ? visibleWeekdays(hours, new Set(blocks.map((block) => isoWeekday(block.day)))).map((weekday) =>
        addDaysRome(from, weekday - 1),
      )
    : [day];
  const days = shownDays.map((d) => {
    const own = blocks.filter((block) => block.day === d);
    return {
      day: d,
      // "gio 22 · 5": gli appuntamenti attivi del giorno.
      header: `${weekdayShortDay(d)} · ${own.filter((block) => isActive(block.status)).length}`,
      bands: hours[isoWeekday(d)],
      blocks: own,
    };
  });
  const range = gridWindow(hours, shownDays.map(isoWeekday), blocks);
  const label = week ? weekRangeLabel(shownDays[0] ?? from, shownDays.at(-1) ?? from) : dayLong(day);
  const hasHours = WEEKDAYS.some((weekday) => hours[weekday].length > 0);

  const services: ServiceOption[] = state.value.services.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    durationMin: s.durationMin,
    priceCents: s.priceCents,
  }));

  return (
    <>
      <PageHeader title="Agenda" />
      <AgendaView
        {...toolbar}
        label={label}
        days={days}
        window={range}
        nowMin={shownDays.includes(today) ? romeMinutes(clock.now()) : null}
        todayDay={today}
        services={services}
        defaultIntervalWeeks={clinical?.defaultSessionIntervalWeeks ?? DEFAULT_INTERVAL_WEEKS}
        defaultExpectedSessions={clinical?.defaultExpectedSessions ?? DEFAULT_EXPECTED_SESSIONS}
      >
        {hasHours ? null : (
          <p>
            {/* Una pagina dinamica con i dati dello studio, come le voci della sidebar: niente prefetch. */}
            <Link href="/impostazioni/orari" prefetch={false} className="text-primary underline underline-offset-4">
              Imposta gli orari dello studio per vedere le fasce chiuse.
            </Link>
          </p>
        )}
      </AgendaView>
    </>
  );
}
