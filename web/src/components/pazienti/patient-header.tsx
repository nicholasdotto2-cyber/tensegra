"use client";

import { Copy, OctagonAlert, Send, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { messageRecipientAction } from "@/app/(app)/pazienti/[id]/message-actions";
import { useContactSnapshot } from "@/components/messaggi/use-contact-snapshot";

import { NewAppointmentButton, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { PatientMenu } from "@/components/pazienti/patient-menu";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { whatsappHref } from "@/lib/messages/links";
import { DEMO_NOTICE } from "@/lib/messages/texts";
import type { PatientHeader } from "@/server/domain/patients/card";

// La testata della scheda: nome, età, telefono con "Copia", le etichette
// (ciclo, consensi, "Minore" o "Lattante", "Anagrafica da completare"), l'avviso clinico e il riassunto dello
// screening, "Nuovo appuntamento" e il menu. "Apri WhatsApp" senza testo usa destinatario e permessi del server; il numero
// non diventa mai un link `tel:`. "Copia" mette negli appunti l'E.164 salvato, che si incolla così in WhatsApp
// o nella rubrica del telefono.

const NO_PHONE = "Telefono non indicato";

function CopyPhone({ phone }: { phone: string }) {
  const copy = () => {
    // Gli appunti possono mancare o essere negati: il paziente non perde niente, si dice e si riprova.
    navigator.clipboard
      .writeText(phone)
      .then(() => toast.success("Numero copiato."))
      .catch(() => toast.error("Non ho copiato il numero. Riprova."));
  };
  return (
    <Button type="button" variant="outline" size="sm" aria-label="Copia il numero" onClick={copy}>
      <Copy aria-hidden="true" data-icon="inline-start" />
      Copia
    </Button>
  );
}

export function PatientHeaderBar({
  header,
  booking,
}: {
  header: PatientHeader;
  booking: { services: readonly ServiceOption[]; defaultIntervalWeeks: number; defaultExpectedSessions: number };
}) {
  const screeningBlocks = header.screeningSeverity === "contraindicated";
  const whatsappId = useId();
  const { snapshot: recipient, pending } = useContactSnapshot(header.id, header.messageRecipient, () => messageRecipientAction(header.id));
  // In rilettura (o dopo una rilettura fallita) il pulsante resta spento senza frase: il numero può esserci.
  const disabledReason = pending ? null : recipient?.whatsappDisabledReason ?? (recipient === null ? "Numero mancante" : null);
  const href = recipient !== null && disabledReason === null ? whatsappHref(recipient, "") : null;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={header.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{header.ageText}</span>
            {header.phone === null || header.phoneText === null ? (
              <span>{NO_PHONE}</span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{header.phoneText}</span>
                <CopyPhone phone={header.phone} />
              </span>
            )}
            <span className="flex flex-col items-start gap-1 text-sm">
              {href === null ? (
                <Button type="button" variant="outline" size="sm" disabled aria-describedby={disabledReason === null ? undefined : whatsappId}>
                  Apri WhatsApp
                </Button>
              ) : (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener"
                  aria-describedby={recipient?.isDemo ? whatsappId : undefined}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Apri WhatsApp
                </a>
              )}
              {href === null ? (
                disabledReason === null ? null : <span id={whatsappId}>{disabledReason}</span>
              ) : recipient?.isDemo ? (
                <span id={whatsappId}>{DEMO_NOTICE}</span>
              ) : null}
              {recipient !== null && recipient.kind !== "paziente" && recipient.name !== "" ? (
                <span>{`A ${recipient.name} (${recipient.kind})`}</span>
              ) : null}
            </span>
          </div>
        }
        actions={
          <>
            {/* Un archiviato non ha appuntamenti nuovi: si ripristina prima (il comando lo rifiuta). */}
            {header.archived ? null : <NewAppointmentButton {...booking} prefill={{ patientId: header.id }} />}
            <PatientMenu
              patientId={header.id}
              name={header.name}
              archived={header.archived}
              archiveBlock={header.archiveBlock}
              canDelete={header.canDelete}
            />
          </>
        }
      />

      {header.archived || header.labels.length > 0 || header.badges.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Stato del paziente">
          {header.archived ? (
            <li>
              <Badge variant="secondary">Archiviato</Badge>
            </li>
          ) : null}
          {header.labels.map((label) => (
            <li key={label}>
              <Badge variant="outline">{label}</Badge>
            </li>
          ))}
          {header.badges.map((badge) => (
            <li key={badge}>
              <Badge variant="secondary">{badge}</Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {header.clinicalAlert === null ? null : (
        <Alert role="note" className="border-transparent bg-warning text-warning-foreground">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="text-warning-foreground">{header.clinicalAlert}</AlertDescription>
        </Alert>
      )}
      {header.screeningText === null ? null : (
        <Alert
          role="note"
          variant={screeningBlocks ? "destructive" : "default"}
          className={screeningBlocks ? undefined : "border-transparent bg-warning text-warning-foreground"}
        >
          {screeningBlocks ? <OctagonAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <AlertDescription className={screeningBlocks ? undefined : "text-warning-foreground"}>
            {header.screeningText}
          </AlertDescription>
        </Alert>
      )}
      {header.referralText === null ? null : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Send aria-hidden="true" className="size-4" />
          {header.referralText}
        </p>
      )}
    </div>
  );
}
