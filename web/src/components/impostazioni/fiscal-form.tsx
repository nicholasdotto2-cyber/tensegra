"use client";

import { useState } from "react";

import { saveFiscalSettingsAction } from "@/app/(app)/impostazioni/actions";
import { ChoiceSelect, described, Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { liveExample } from "@/lib/fiscal/example";
import { toLatin1 } from "@/lib/fiscal/latin1";
import { LEGAL_KEYS, legalText, REFERENCES_CHANGE_NOTE, type LegalKey } from "@/lib/fiscal/references";
import type { FiscalRates, PaymentMethod, Regime } from "@/lib/fiscal/types";
import { fiscalCodeProblem, ibanProblem, vatNumberProblem } from "@/lib/fiscal/validators";
import type { FiscalSettingsView } from "@/server/domain/settings/queries";

const REGIMES: readonly { value: Regime; label: string; lines: readonly [string, string]; consequence: string }[] = [
  {
    value: "ordinario", label: "Ordinario con IVA 22%",
    lines: ["Il prezzo del listino comprende l'IVA: la fattura al paziente la scorpora.", "Niente bollo; ritenuta del 20% verso i sostituti d'imposta."],
    consequence: "IVA al 22% scorporata dal prezzo per i pazienti, niente bollo",
  },
  {
    value: "forfettario", label: "Forfettario",
    lines: ["Niente IVA: il paziente paga il prezzo del listino.", "Bollo di 2 euro sopra 77,47 euro, niente ritenuta."],
    consequence: "niente IVA, bollo di 2 euro sopra 77,47 euro",
  },
  {
    value: "esente_sanitario", label: "Esente sanitario",
    lines: ["Niente IVA, bollo di 2 euro sopra 77,47 euro.", "Al paziente la fattura è cartacea o PDF, senza XML."],
    consequence: "esenti da IVA, bollo di 2 euro sopra 77,47 euro, ai pazienti solo PDF",
  },
];
const METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: "contanti", label: "Contanti" }, { value: "carta", label: "Carta" }, { value: "bonifico", label: "Bonifico" },
];
const LEGAL_LABELS: Record<LegalKey, string> = {
  forfettario_xml: "Forfettario: riferimento IVA",
  forfettario_dicitura: "Forfettario: dicitura",
  forfettario_no_ritenuta: "Forfettario: ritenuta",
  esente_xml: "Esente sanitario: riferimento IVA",
  bollo_virtuale_pdf: "Bollo sulle fatture elettroniche",
  bollo_contrassegno_pdf: "Bollo con contrassegno",
  bollo_virtuale_autorizzato_pdf: "Bollo virtuale autorizzato",
  copia_cortesia_pdf: "Copia di cortesia",
};

type Editable = Omit<FiscalSettingsView, keyof FiscalRates | "warnings" | "bankTransferDueDays">;
type Values = { [K in keyof Editable]: NonNullable<Editable[K]> } & {
  inpsSurchargeEnabled: boolean;
  stampChargedToClient: boolean;
  bankTransferDueDays: string;
};

function valuesOf(initial: FiscalSettingsView): Values {
  return {
    regime: initial.regime,
    vatNumber: initial.vatNumber ?? "", taxCode: initial.taxCode ?? "", atecoCode: initial.atecoCode ?? "",
    fiscalAddressLine: initial.fiscalAddressLine ?? "", fiscalPostalCode: initial.fiscalPostalCode ?? "",
    fiscalCity: initial.fiscalCity ?? "", fiscalProvince: initial.fiscalProvince ?? "", fiscalCountry: initial.fiscalCountry,
    inpsSurchargeEnabled: initial.inpsSurchargeEnabled, stampChargedToClient: initial.stampChargedToClient,
    paperStampAuthorization: initial.paperStampAuthorization ?? "", iban: initial.iban ?? "", ibanHolder: initial.ibanHolder ?? "",
    defaultPaymentMethod: initial.defaultPaymentMethod, bankTransferDueDays: String(initial.bankTransferDueDays),
  };
}

// Stessa normalizzazione del comando, per mantenere modulo e stato salvato allineati.
function normalized(values: Values): Values {
  const next = { ...values };
  for (const key of [
    "vatNumber", "taxCode", "atecoCode", "fiscalAddressLine", "fiscalPostalCode", "fiscalCity",
    "fiscalProvince", "fiscalCountry", "paperStampAuthorization", "iban", "ibanHolder",
  ] as const) next[key] = toLatin1(values[key].trim());
  next.taxCode = next.taxCode.replace(/\s/g, "").toUpperCase();
  next.iban = next.iban.replace(/\s/g, "").toUpperCase();
  return next;
}

export function FiscalForm({ initial, example }: {
  initial: FiscalSettingsView;
  example: { name: string; priceCents: number } | null;
}) {
  const [form, formRef] = useSectionForm<Values>(valuesOf(initial));
  const { values, errors, idOf } = form;
  const [savedRegime, setSavedRegime] = useState(initial.regime);
  const [confirming, setConfirming] = useState(false);
  const current = normalized(values);
  const warnings = {
    vatNumber: current.vatNumber === "" ? null : vatNumberProblem(current.vatNumber),
    taxCode: current.taxCode === "" ? null : fiscalCodeProblem(current.taxCode),
    iban: current.iban === "" ? null : ibanProblem(current.iban),
  };
  const rates: FiscalRates = {
    vatRateBp: initial.vatRateBp, inpsSurchargeBp: initial.inpsSurchargeBp, withholdingBp: initial.withholdingBp,
    inpsSurchargeEnabled: values.inpsSurchargeEnabled, stampChargedToClient: values.stampChargedToClient,
  };
  const save = () => {
    form.startSaving(async () => {
      const days = values.bankTransferDueDays.trim();
      const result = await saveFiscalSettingsAction({
        ...current,
        bankTransferDueDays: /^\d+$/.test(days) ? Number(days) : days,
      });
      if (!result.ok) {
        form.fail(result);
        return;
      }
      setSavedRegime(current.regime);
      form.done({ ...current, bankTransferDueDays: String(Number(days)) });
    });
  };

  return (
    <form ref={formRef} noValidate className="flex flex-col gap-6" onSubmit={(event) => {
      event.preventDefault();
      if (form.saving) return;
      if (values.regime !== savedRegime) setConfirming(true);
      else save();
    }}>
      <UnsavedGuard dirty={form.dirty} />
      <p className="text-sm text-muted-foreground">Le modifiche valgono per le nuove fatture. Quelle già emesse non cambiano.</p>

      <fieldset className="flex flex-col gap-4">
        <legend id={idOf("regime-legend")} className="mb-3 text-base font-medium">Regime</legend>
        <RadioGroup value={values.regime} aria-labelledby={idOf("regime-legend")} onValueChange={(value) => form.set("regime", value as Regime)}>
          {REGIMES.map((regime) => (
            <div key={regime.value} className="rounded-lg border p-4 has-[[data-checked]]:border-primary has-[:focus-visible]:border-ring">
              <div className="flex items-center gap-3">
                <RadioGroupItem id={idOf(regime.value)} value={regime.value} className="size-6" aria-labelledby={idOf(`${regime.value}-label`)} aria-invalid={errors.regime === undefined ? undefined : true} aria-describedby={[idOf(`${regime.value}-description`), errors.regime === undefined ? null : `${idOf("regime")}-errore`].filter(Boolean).join(" ")} />
                <Label id={idOf(`${regime.value}-label`)} htmlFor={idOf(regime.value)} className="min-h-6 cursor-pointer">{regime.label}</Label>
              </div>
              <div id={idOf(`${regime.value}-description`)} className="mt-2 space-y-1 text-sm text-muted-foreground">
                {regime.lines.map((line) => <p key={line}>{line}</p>)}
              </div>
            </div>
          ))}
        </RadioGroup>
        {errors.regime === undefined ? null : <p id={`${idOf("regime")}-errore`} className="text-sm text-destructive">{errors.regime}</p>}
        {example === null ? null : <p role="status" aria-label="Esempio dal vivo" className="rounded-lg bg-muted p-4 text-sm">{liveExample(values.regime, rates, example)}</p>}
        {values.regime !== "esente_sanitario" ? null : <>
          <Alert className="bg-warning text-warning-foreground"><AlertDescription className="text-warning-foreground">{"Oggi l'osteopata non è esente (risoluzione 9/E/2026). Usa questo stato solo se cambia la norma."}</AlertDescription></Alert>
          <p className="rounded-lg border p-4 text-sm">Invio al Sistema TS: non attivo in questa versione</p>
        </>}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Anagrafica fiscale</legend>
        <p className="text-sm text-muted-foreground">Nome e cognome si leggono da Studio.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("vatNumber")} label="Partita IVA" error={errors.vatNumber}>
            <Input {...form.text("vatNumber", warnings.vatNumber !== null)} inputMode="numeric" maxLength={11} autoComplete="off" />
            {warnings.vatNumber === null ? null : (
              <Alert id={`${idOf("vatNumber")}-nota`} role="note" className="border-transparent bg-warning text-warning-foreground">
                <AlertDescription className="text-warning-foreground">{warnings.vatNumber}</AlertDescription>
              </Alert>
            )}
          </Field>
          <Field id={idOf("taxCode")} label="Codice fiscale" error={errors.taxCode}>
            <Input {...form.text("taxCode", warnings.taxCode !== null)} maxLength={16} autoComplete="off" />
            {warnings.taxCode === null ? null : (
              <Alert id={`${idOf("taxCode")}-nota`} role="note" className="border-transparent bg-warning text-warning-foreground">
                <AlertDescription className="text-warning-foreground">{warnings.taxCode}</AlertDescription>
              </Alert>
            )}
          </Field>
        </div>
        <Field id={idOf("atecoCode")} label="Codice ATECO" error={errors.atecoCode}>
          <Input {...form.text("atecoCode")} maxLength={8} autoComplete="off" />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Domicilio fiscale</legend>
        <Field id={idOf("fiscalAddressLine")} label="Indirizzo" error={errors.fiscalAddressLine}>
          <Input {...form.text("fiscalAddressLine")} maxLength={60} autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr_8rem]">
          <Field id={idOf("fiscalPostalCode")} label="CAP" error={errors.fiscalPostalCode}>
            <Input {...form.text("fiscalPostalCode")} inputMode="numeric" maxLength={5} autoComplete="off" />
          </Field>
          <Field id={idOf("fiscalCity")} label="Città" error={errors.fiscalCity}>
            <Input {...form.text("fiscalCity")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("fiscalProvince")} label="Provincia" error={errors.fiscalProvince}>
            <Input {...form.text("fiscalProvince")} maxLength={2} autoComplete="off" onChange={(event) => form.set("fiscalProvince", event.target.value.toUpperCase())} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Contributi e imposte</legend>
        <div className="flex items-center gap-3">
          <Switch id={idOf("inpsSurchargeEnabled")} checked={values.inpsSurchargeEnabled} onCheckedChange={(value) => form.set("inpsSurchargeEnabled", value)} {...described(idOf("inpsSurchargeEnabled"), errors.inpsSurchargeEnabled)} />
          <Field id={idOf("inpsSurchargeEnabled")} label="Rivalsa INPS 4%" error={errors.inpsSurchargeEnabled}>{null}</Field>
        </div>
        <div className="flex items-center gap-3">
          <Switch id={idOf("stampChargedToClient")} checked={values.stampChargedToClient} onCheckedChange={(value) => form.set("stampChargedToClient", value)} {...described(idOf("stampChargedToClient"), errors.stampChargedToClient, true)} />
          <Field id={idOf("stampChargedToClient")} label="Rimborso del bollo chiesto al paziente" error={errors.stampChargedToClient} hint="Il bollo è dovuto dallo studio; puoi chiederne il rimborso al paziente">{null}</Field>
        </div>
        {values.regime !== "esente_sanitario" ? null : <Field id={idOf("paperStampAuthorization")} label="Autorizzazione al bollo virtuale per i documenti cartacei" error={errors.paperStampAuthorization}>
          <Input {...form.text("paperStampAuthorization")} maxLength={60} autoComplete="off" />
        </Field>}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Pagamenti</legend>
        <Field id={idOf("iban")} label="IBAN" error={errors.iban}>
          <Input {...form.text("iban", warnings.iban !== null)} autoComplete="off" />
          {warnings.iban === null ? null : (
            <Alert id={`${idOf("iban")}-nota`} role="note" className="border-transparent bg-warning text-warning-foreground">
              <AlertDescription className="text-warning-foreground">{warnings.iban}</AlertDescription>
            </Alert>
          )}
        </Field>
        <Field id={idOf("ibanHolder")} label="Intestatario del conto" error={errors.ibanHolder}>
          <Input {...form.text("ibanHolder")} maxLength={200} autoComplete="off" />
        </Field>
        <ChoiceSelect id={idOf("defaultPaymentMethod")} label="Metodo predefinito" items={METHODS} value={values.defaultPaymentMethod} onChange={(value) => form.set("defaultPaymentMethod", value)} error={errors.defaultPaymentMethod} />
        <Field id={idOf("bankTransferDueDays")} label="Giorni di scadenza del bonifico" error={errors.bankTransferDueDays}>
          <Input {...form.text("bankTransferDueDays")} type="number" inputMode="numeric" min={0} max={120} step={1} />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Riferimenti normativi</legend>
        <p className="text-sm text-muted-foreground">Fino al 31/12/2026</p>
        <dl className="space-y-4 text-sm">
          {LEGAL_KEYS.map((key) => <div key={key}>
            <dt className="font-medium">{LEGAL_LABELS[key]}</dt>
            <dd className="mt-1 text-muted-foreground">{legalText(key, "2026-12-31").text}</dd>
          </div>)}
        </dl>
        <p className="text-sm text-muted-foreground">{REFERENCES_CHANGE_NOTE}</p>
      </fieldset>

      <SaveBar saving={form.saving} formError={form.formError} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent finalFocus={() => formRef.current?.querySelector<HTMLButtonElement>("button[type='submit']") ?? null}>
          <AlertDialogHeader>
            <AlertDialogTitle>Cambiare il regime fiscale?</AlertDialogTitle>
            <AlertDialogDescription>{`Dalle prossime fatture: ${REGIMES.find((regime) => regime.value === values.regime)!.consequence}. Le fatture già emesse non cambiano.`}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button type="button" disabled={form.saving} onClick={() => { setConfirming(false); save(); }}>Cambia regime</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
