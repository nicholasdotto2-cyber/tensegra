"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type RefObject, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { createReferralAction } from "@/app/(app)/pazienti/[id]/actions";
import { ClinicalAlertDialog } from "@/components/cartella/clinical-alert-dialog";
import { CronologiaView } from "@/components/cartella/cronologia";
import { CycleCloseDialog } from "@/components/cartella/cycle-close-dialog";
import { type NewVisitBooking, NewVisitButton } from "@/components/cartella/new-visit-button";
import { PhotosView } from "@/components/cartella/photos-view";
import { PhotoUploadDialog } from "@/components/cartella/photo-upload-dialog";
import { SideBoxes } from "@/components/cartella/side-boxes";
import { TestsOverTimeView } from "@/components/cartella/tests-over-time";
import { Sparkline } from "@/components/pazienti/sparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PSFS_TITLE } from "@/lib/clinical/labels";
import { type CartellaView, patientHref } from "@/lib/patients/params";
import { cn } from "@/lib/utils";
import type { CartellaTab, TestsOverTime } from "@/server/domain/cartella/queries";
import type { PhotoRow } from "@/server/domain/attachments/queries";

// La tab Cartella: la testata con l'avviso clinico, il ciclo aperto, le azioni
// ("Nuova visita", "Chiudi ciclo", "Nuovo rinvio"), le sotto-viste come link (`vista` nell'URL) e i riquadri
// laterali. "Carica foto" sta nella vista Foto (`PhotosView`), insieme a "Confronta" e a «Togli la foto»; il
// dialogo di caricamento lo monta questa vista.

const NO_CYCLE = "Nessun ciclo aperto.";
const NO_ALERT = "Nessun avviso clinico.";

const VIEWS: readonly { code: CartellaView; label: string }[] = [
  { code: "cronologia", label: "Cronologia" },
  { code: "test", label: "Test nel tempo" },
  { code: "foto", label: "Foto" },
];

interface Props {
  tab: CartellaTab;
  patientId: string;
  vista: CartellaView;
  /** Solo con `vista=test`. */
  tests: TestsOverTime | null;
  /** Solo con `vista=foto`. */
  photos: PhotoRow[] | null;
  booking: NewVisitBooking;
}

/** "Nuovo rinvio": il rinvio in bozza sul ciclo aperto (altrimenti sull'ultimo), poi la lettera. */
function NewReferralButton({ patientId }: { patientId: string }) {
  const router = useRouter();
  const [pending, startPending] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startPending(async () => {
          const result = await createReferralAction({ patientId });
          if (result.ok) router.push(`/pazienti/${result.data.patientId}/rinvii/${result.data.id}`);
          else toast.error(result.message);
        })
      }
    >
      Nuovo rinvio
    </Button>
  );
}

function Head({ header, patientId }: { header: CartellaTab["header"]; patientId: string }) {
  return (
    <section aria-label="Testata della cartella">
      <Card size="sm">
        <CardContent className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <div>
              <dt className="text-muted-foreground">Età</dt>
              <dd>{header.ageText}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Consensi</dt>
              <dd>{header.consentText}</dd>
            </div>
            {header.gp === null ? null : (
              <div>
                <dt className="text-muted-foreground">Medico curante</dt>
                <dd>{header.gp}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Avviso clinico</dt>
              <dd>{header.clinicalAlert ?? NO_ALERT}</dd>
            </div>
          </dl>
          <ClinicalAlertDialog patientId={patientId} alert={header.clinicalAlert} />
        </CardContent>
      </Card>
    </section>
  );
}

function OpenCycle({
  cycle,
  onClose,
  headingRef,
}: {
  cycle: CartellaTab["openCycle"];
  onClose: (cycleId: string) => void;
  /** Dopo una chiusura il pulsante "Chiudi ciclo" sparisce: il focus va al titolo della sezione. */
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const headingId = useId();
  const painText = cycle?.pain.map((p) => p.value).join(" → ") ?? "";
  return (
    <section aria-labelledby={headingId}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId} ref={headingRef} tabIndex={-1} className="outline-none">
              Ciclo aperto
            </h2>
          </CardTitle>
          {cycle === null ? null : (
            <CardAction>
              <Button type="button" variant="outline" size="sm" onClick={() => onClose(cycle.id)}>
                Chiudi ciclo
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {cycle === null ? (
            <p>{NO_CYCLE}</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {cycle.title}
                {cycle.kind === "mantenimento" ? <Badge variant="outline">Mantenimento</Badge> : null}
              </p>
              {cycle.goal === null ? null : <p className="text-muted-foreground">{cycle.goal}</p>}
              {cycle.sessionText === null ? null : <p>{cycle.sessionText}</p>}
              {cycle.pain.length === 0 ? null : (
                <div className="flex items-center gap-3 pt-1">
                  <Sparkline
                    values={cycle.pain.map((p) => p.value)}
                    max={10}
                    label={`Dolore 0-10 a inizio seduta: ${painText}`}
                  />
                  <p className="text-sm">
                    <span className="text-muted-foreground">Dolore 0-10 a inizio seduta: </span>
                    <span className="tabular-nums">{painText}</span>
                  </p>
                </div>
              )}
              {cycle.psfs.length === 0 ? null : (
                <div className="pt-2">
                  <h3 className="text-sm font-medium">{PSFS_TITLE}</h3>
                  <ul className="text-sm">
                    {cycle.psfs.map((item) => (
                      <li key={item.activity}>
                        {item.activity}
                        <span className="text-muted-foreground">
                          {item.initial === null ? ": iniziale non scritto" : `: iniziale ${item.initial}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function CartellaTabView({ tab, patientId, vista, tests, photos, booking }: Props) {
  const [closing, setClosing] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Chiuso il ciclo, il pulsante che aveva aperto la finestra non c'è più: il focus va al titolo della sezione.
  const closedRef = useRef(false);
  return (
    <div className="flex flex-col gap-6">
      <Head header={tab.header} patientId={patientId} />

      <div className="flex flex-wrap gap-2">
        <NewVisitButton patientId={patientId} booking={booking} />
        {tab.canStartReferral ? <NewReferralButton patientId={patientId} /> : null}
      </div>

      <OpenCycle
        cycle={tab.openCycle}
        headingRef={headingRef}
        onClose={(cycleId) => {
          closedRef.current = false;
          setClosing(cycleId);
        }}
      />

      <nav aria-label="Viste della cartella" className="border-b">
        <ul className="-mb-px flex flex-wrap gap-x-1">
          {VIEWS.map((view) => {
            const active = view.code === vista;
            return (
              <li key={view.code}>
                <Link
                  href={patientHref(patientId, { tab: "cartella", vista: view.code })}
                  prefetch={false}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-t-md border-b-2 px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                    active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {view.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        {vista === "cronologia" ? <CronologiaView history={tab.history} patientId={patientId} /> : null}
        {vista === "test" && tests !== null ? <TestsOverTimeView tests={tests} patientId={patientId} /> : null}
        {vista === "foto" && photos !== null ? (
          <PhotosView photos={photos} onUpload={() => setUploading(true)} />
        ) : null}
        <SideBoxes
          referrals={tab.referrals}
          attachments={tab.attachments}
          recallText={tab.recallText}
          patientId={patientId}
        />
      </div>

      {vista === "foto" ? (
        <PhotoUploadDialog patientId={patientId} today={booking.today} open={uploading} onOpenChange={setUploading} />
      ) : null}

      <CycleCloseDialog
        cycleId={closing}
        onClose={() => setClosing(null)}
        onClosed={() => {
          closedRef.current = true;
        }}
        finalFocus={() => (closedRef.current ? headingRef.current : true)}
      />
    </div>
  );
}
