import { notFound } from "next/navigation";

import { AppearanceSection } from "@/components/impostazioni/appearance-section";
import { ClinicalForm } from "@/components/impostazioni/clinical-form";
import { ConsentsSection } from "@/components/impostazioni/consents-section";
import { DemoDataSection } from "@/components/impostazioni/demo-data-section";
import { FiscalForm } from "@/components/impostazioni/fiscal-form";
import { HoursForm } from "@/components/impostazioni/hours-form";
import { MessagesSection } from "@/components/impostazioni/messages-section";
import { RegistrationForm } from "@/components/impostazioni/registration-form";
import { SettingsNav } from "@/components/impostazioni/settings-nav";
import { StudioForm } from "@/components/impostazioni/studio-form";
import { BlockError } from "@/components/oggi/block-error";
import { PageHeader } from "@/components/shell/page-header";
import { DEFAULT_ACTIVE_TEST_CODES } from "@/lib/clinical/catalog";
import { minutesLabel } from "@/lib/format";
import type { OpeningDayDraft } from "@/lib/settings/opening-hours";
import { BUILT_SECTIONS, isBuiltSection } from "@/lib/settings/sections";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { listActiveServices } from "@/server/domain/services/queries";
import { listMessageTemplates } from "@/server/domain/messages/queries";
import { getClinicalSettings, getConsentSettings, getFiscalSettings, getOpeningHours, getPracticeSettings, hasMessagePreviewPatients } from "@/server/domain/settings/queries";
import { readVerified } from "@/server/files/consents";
import { getFileStore } from "@/server/files/disk-store";
import type { ConsentValues } from "@/lib/consents/render";
import { studioConsentValues } from "@/lib/consents/studio-values";

// Una sezione di Impostazioni: sottomenu a sinistra (in alto sotto 1024 px) e il modulo della
// sezione con il suo "Salva". Una sola transazione per la pagina, con le letture in un savepoint: se
// falliscono resta il sottomenu e al posto del modulo "Non riesco a caricare questa sezione." con "Riprova".
// Uno slug sconosciuto o solo demo in uno studio vero
// dà "Pagina non trovata". I moduli ricevono solo valori serializzabili.

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
// I default della tabella `clinical_settings`, se la riga dello studio manca.
const DEFAULT_CLINICAL = {
  defaultRecallWeeks: 6,
  defaultExpectedSessions: 4,
  defaultSessionIntervalWeeks: 2,
  referralPrompts: ["R1", "R2", "R3"] as ("R1" | "R2" | "R3")[],
  activeTestCodes: [...DEFAULT_ACTIVE_TEST_CODES],
  pediatricRedFlagsEnabled: false,
};

export default async function SettingsSectionPage({ params }: PageProps<"/impostazioni/[sezione]">) {
  const { sezione } = await params;
  // Una sezione che il programma non ha, in nessuno studio, non apre nemmeno il database.
  const section = BUILT_SECTIONS.find((s) => s.slug === sezione);
  if (section === undefined) notFound();

  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const state = await ctx.db.asUser(ctx.actor, (tx) =>
    settle(tx, "impostazioni", async () => {
      const settings = await getPracticeSettings(tx, ctx.practiceId);
      if (settings === null) throw new Error("Impostazioni dello studio assenti.");
      const services = sezione === "fisco" || sezione === "consensi" ? await listActiveServices(tx, ctx.practiceId) : [];
      const example = services.find((service) => service.kind === "seduta") ?? services[0];
      return {
        settings,
        hours: sezione === "orari" ? await getOpeningHours(tx, ctx.practiceId) : null,
        clinical: sezione === "cartella" ? await getClinicalSettings(tx, ctx.practiceId) : null,
        fiscal: sezione === "fisco" ? await getFiscalSettings(tx, ctx.practiceId) : null,
        templates: sezione === "messaggi" ? await listMessageTemplates(tx, ctx.practiceId) : [],
        hasPreviewPatients: sezione === "messaggi" ? await hasMessagePreviewPatients(tx, ctx.practiceId) : false,
        consents: sezione === "consensi" ? await getConsentSettings(tx, ctx.practiceId) : null,
        consentValues: sezione === "consensi" ? studioConsentValues(settings, services, clock.today()) : {},
        example: example === undefined ? null : { name: example.name, priceCents: example.priceCents },
      };
    }),
  );
  // Dati di prova esiste solo in uno studio demo; se la lettura è fallita non lo sappiamo e il sottomenu
  // mostra le altre.
  const isDemo = state.ok && state.value.settings.isDemo;
  if (state.ok && !isBuiltSection(sezione, isDemo)) notFound();
  const sections = BUILT_SECTIONS.filter((s) => s.demoOnly !== true || isDemo);
  const signature = state.ok ? state.value.consents?.signature : null;
  const png = signature ? await readVerified(getFileStore(), signature) : null;
  const signaturePng = png ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null;
  // Riga presente ma byte assenti o alterati: non è «nessuna firma», va disegnata e salvata di nuovo.
  const signatureUnreadable = Boolean(signature) && png === null;

  return (
    <>
      <PageHeader title="Impostazioni" />
      <div className="flex flex-col gap-6 lg:flex-row">
        <SettingsNav sections={sections} current={sezione} />
        <section aria-labelledby="sezione-titolo" className="flex min-w-0 max-w-2xl flex-1 flex-col gap-6">
          <h2 id="sezione-titolo" className="text-xl font-semibold tracking-tight">
            {section.label}
          </h2>
          {state.ok ? (
            sectionBody(sezione, state.value, clock.today(), { png: signaturePng, unreadable: signatureUnreadable })
          ) : (
            <BlockError message="Non riesco a caricare questa sezione." />
          )}
        </section>
      </div>
    </>
  );
}

type Loaded = {
  settings: NonNullable<Awaited<ReturnType<typeof getPracticeSettings>>>;
  hours: Awaited<ReturnType<typeof getOpeningHours>> | null;
  clinical: Awaited<ReturnType<typeof getClinicalSettings>>;
  fiscal: Awaited<ReturnType<typeof getFiscalSettings>> | null;
  templates: Awaited<ReturnType<typeof listMessageTemplates>>;
  hasPreviewPatients: boolean;
  consents: Awaited<ReturnType<typeof getConsentSettings>>;
  consentValues: ConsentValues;
  example: { name: string; priceCents: number } | null;
};

function sectionBody(slug: string, { settings, hours, clinical, fiscal, example, templates, hasPreviewPatients, consents, consentValues }: Loaded, today: string, signature: { png: string | null; unreadable: boolean }) {
  switch (slug) {
    case "studio":
      return <StudioForm initial={settings} />;
    case "fisco":
      return fiscal === null ? null : <FiscalForm initial={fiscal} example={example} />;
    case "orari": {
      const days: OpeningDayDraft[] = WEEKDAYS.map((weekday) => ({
        weekday,
        bands: (hours?.[weekday] ?? []).map((band) => ({
          opens: minutesLabel(band.opensMin),
          closes: minutesLabel(band.closesMin),
        })),
      }));
      return <HoursForm initial={{ days }} />;
    }
    case "iscrizione-e-polizza":
      return <RegistrationForm initial={{ ...settings, today }} />;
    case "cartella":
      return <ClinicalForm initial={clinical ?? DEFAULT_CLINICAL} />;
    case "messaggi":
      return <MessagesSection initial={templates} defaultAddressing={settings.defaultAddressing} hasPatients={hasPreviewPatients} />;
    case "consensi":
      return consents === null ? null : <ConsentsSection retentionYears={consents.retentionYears} signaturePng={signature.png} signatureUnreadable={signature.unreadable} previewValues={consentValues} />;
    case "aspetto":
      return <AppearanceSection />;
    case "dati-di-prova":
      return <DemoDataSection initial={settings} />;
    default:
      return null;
  }
}
