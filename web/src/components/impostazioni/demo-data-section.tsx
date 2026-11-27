"use client";

import { saveDemoTestPhoneAction } from "@/app/(app)/impostazioni/actions";
import { Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Input } from "@/components/ui/input";
import { RecreateDemoButton } from "@/components/shell/recreate-demo-button";
import { dayField, romeDay, timeOf } from "@/lib/format";
import { phoneDisplay, toE164 } from "@/lib/phone";
import type { PracticeSettingsView } from "@/server/domain/settings/queries";

// Dati di prova, solo in uno studio demo: quando e con quale versione sono stati creati i
// dati, la ricreazione per oggi e il numero per le prove WhatsApp.

export type DemoDataInitial = Pick<PracticeSettingsView, "demoSeededAt" | "demoSeedVersion" | "demoTestPhone">;

const PHONE_HINT =
  "Se lo compili, i messaggi della demo si aprono verso questo numero (per esempio il tuo). Se lo lasci vuoto, WhatsApp ti chiede a chi inviarli.";

interface Values {
  demoTestPhone: string;
}

export function DemoDataSection({ initial }: { initial: DemoDataInitial }) {
  const [form, formRef] = useSectionForm<Values>({
    demoTestPhone: initial.demoTestPhone === null ? "" : phoneDisplay(initial.demoTestPhone),
  });
  const { values, errors, idOf } = form;

  const submit = () => {
    form.startSaving(async () => {
      const result = await saveDemoTestPhoneAction(values);
      if (!result.ok) {
        form.fail(result);
        return;
      }
      const e164 = toE164(values.demoTestPhone);
      form.done({ demoTestPhone: e164 === null ? values.demoTestPhone.trim() : phoneDisplay(e164) });
    });
  };

  const seededAt = initial.demoSeededAt;
  const seededDay = seededAt === null ? null : romeDay(seededAt);
  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <UnsavedGuard dirty={form.dirty} />

      {seededAt === null || seededDay === null || initial.demoSeedVersion === null ? null : (
        <p>
          Dati creati il{" "}
          <time dateTime={`${seededDay}T${timeOf(seededAt)}`}>
            {dayField(seededDay)} alle {timeOf(seededAt)}
          </time>{" "}
          (versione {initial.demoSeedVersion}).
        </p>
      )}

      <div><RecreateDemoButton label="Ricrea i dati di prova per oggi" /></div>

      <Field
        id={idOf("demoTestPhone")}
        label="Numero per le prove WhatsApp"
        optional
        hint={PHONE_HINT}
        error={errors.demoTestPhone}
        className="max-w-md"
      >
        <Input {...form.text("demoTestPhone", true)} type="tel" autoComplete="off" />
      </Field>

      <SaveBar saving={form.saving} formError={form.formError} />
    </form>
  );
}
