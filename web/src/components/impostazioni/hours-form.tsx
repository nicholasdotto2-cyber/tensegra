"use client";

import Link from "next/link";
import { useState } from "react";

import { saveOpeningHoursAction } from "@/app/(app)/impostazioni/actions";
import { Field, SaveBar, described, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { minutesLabel } from "@/lib/format";
import { type OpeningDayDraft, outsideHoursText, validateOpeningDays } from "@/lib/settings/opening-hours";

// Orari: per giorno Aperto o Chiuso e fino a 2 fasce a passi di 15 minuti, da 00:00
// a 23:45. Gli errori del modulo (`validateOpeningDays`, gli stessi del comando) stanno sotto il campo; dopo
// il salvataggio una frase dice quanti appuntamenti futuri restano fuori dai nuovi orari, con il link
// all'agenda del giorno del primo. Le fasce partono nell'ordine in cui sono salvate (per inizio).

const WEEKDAY_NAMES = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"] as const;
const BAND_NAMES = ["prima", "seconda"] as const;
const QUARTER_COUNT = 96;
const TIME_OPTIONS = Array.from({ length: QUARTER_COUNT }, (_, index) => minutesLabel(index * 15));

// Quando un giorno si apre: la fascia della mattina di uno studio.
const FIRST_BAND = { opens: "09:00", closes: "13:00" };

interface Values {
  days: OpeningDayDraft[];
}

type Band = OpeningDayDraft["bands"][number];

function minutesOf(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// La seconda fascia che propone "Aggiungi una seconda fascia": un'ora e mezza dopo la fine della prima, per
// tre ore, dentro la giornata.
function suggestedSecondBand(first: Band | undefined): Band {
  const end = first === undefined ? null : minutesOf(first.closes);
  if (end === null) return { opens: "14:30", closes: "18:30" };
  const opens = Math.min(Math.ceil((end + 90) / 15) * 15, 22 * 60);
  const closes = Math.min(opens + 180, 23 * 60 + 45);
  return { opens: minutesLabel(opens), closes: minutesLabel(closes) };
}

function TimeSelect({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 w-full min-w-0 rounded-lg border border-input bg-muted px-2 text-base tabular-nums transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
      {...described(id, error)}
    >
      {TIME_OPTIONS.map((time) => (
        <option key={time} value={time}>
          {time}
        </option>
      ))}
    </select>
  );
}

export function HoursForm({ initial }: { initial: { days: OpeningDayDraft[] } }) {
  const [form, formRef] = useSectionForm<Values>(initial);
  const { values, errors, idOf } = form;
  const [outside, setOutside] = useState<{ text: string; day: string | null } | null>(null);

  const changeDay = (index: number, change: (day: OpeningDayDraft) => OpeningDayDraft) =>
    form.setValues((current) => ({
      days: current.days.map((day, i) => (i === index ? change(day) : day)),
    }));

  const changeBand = (dayIndex: number, bandIndex: number, key: keyof Band, value: string) =>
    changeDay(dayIndex, (day) => ({
      ...day,
      bands: day.bands.map((band, j) => (j === bandIndex ? { ...band, [key]: value } : band)),
    }));

  const submit = () => {
    // Gli stessi controlli del comando, prima di partire: un errore per campo, senza andata e ritorno.
    const found = validateOpeningDays(values.days);
    if (Object.keys(found).length > 0) {
      form.showErrors(found);
      return;
    }
    setOutside(null);
    form.startSaving(async () => {
      const result = await saveOpeningHoursAction(values);
      if (!result.ok) {
        form.fail(result);
        return;
      }
      form.done(values);
      const text = outsideHoursText(result.data.outsideCount);
      setOutside(text === null ? null : { text, day: result.data.firstOutsideDay });
    });
  };

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

      <div className="flex flex-col gap-3">
        {values.days.map((day, dayIndex) => {
          const name = WEEKDAY_NAMES[dayIndex] ?? "";
          const dayId = idOf(`days.${dayIndex}`);
          const open = day.bands.length > 0;
          return (
            <div
              key={day.weekday}
              role="group"
              aria-labelledby={`${dayId}-nome`}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[10rem_1fr]"
            >
              <div className="flex flex-col gap-2">
                <span id={`${dayId}-nome`} className="font-medium">
                  {name}
                </span>
                <div className="flex items-center gap-2">
                  <Switch
                    id={`${dayId}-aperto`}
                    checked={open}
                    onCheckedChange={(checked) =>
                      changeDay(dayIndex, (current) => ({ ...current, bands: checked ? [{ ...FIRST_BAND }] : [] }))
                    }
                  />
                  <Label htmlFor={`${dayId}-aperto`} className="font-normal">
                    Aperto<span className="sr-only"> il {name.toLowerCase()}</span>
                  </Label>
                </div>
                {open ? null : <p className="text-sm text-muted-foreground">Chiuso</p>}
              </div>

              {open ? (
                <div className="flex flex-col gap-3">
                  {day.bands.map((band, bandIndex) => {
                    const bandName = BAND_NAMES[bandIndex] ?? "";
                    const opensPath = `days.${dayIndex}.bands.${bandIndex}.opens`;
                    const closesPath = `days.${dayIndex}.bands.${bandIndex}.closes`;
                    return (
                      <div key={bandIndex} className="flex flex-wrap items-start gap-3">
                        <Field
                          id={idOf(opensPath)}
                          label="Inizio"
                          srOnlyLabel={` della ${bandName} fascia`}
                          error={errors[opensPath]}
                          className="w-32"
                        >
                          <TimeSelect
                            id={idOf(opensPath)}
                            value={band.opens}
                            error={errors[opensPath]}
                            onChange={(value) => changeBand(dayIndex, bandIndex, "opens", value)}
                          />
                        </Field>
                        <Field
                          id={idOf(closesPath)}
                          label="Fine"
                          srOnlyLabel={` della ${bandName} fascia`}
                          error={errors[closesPath]}
                          className="w-32"
                        >
                          <TimeSelect
                            id={idOf(closesPath)}
                            value={band.closes}
                            error={errors[closesPath]}
                            onChange={(value) => changeBand(dayIndex, bandIndex, "closes", value)}
                          />
                        </Field>
                      </div>
                    );
                  })}
                  {day.bands.length === 1 ? (
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          changeDay(dayIndex, (current) => ({
                            ...current,
                            bands: [...current.bands, suggestedSecondBand(current.bands[0])],
                          }))
                        }
                      >
                        Aggiungi una seconda fascia
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          changeDay(dayIndex, (current) => ({ ...current, bands: current.bands.slice(0, 1) }))
                        }
                      >
                        Togli la seconda fascia
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <SaveBar saving={form.saving} formError={form.formError} />

      {outside === null ? null : (
        <Alert role="status" className="max-w-xl">
          <AlertDescription>
            {outside.day === null ? (
              outside.text
            ) : (
              <Link
                href={`/agenda?vista=giorno&data=${outside.day}`}
                prefetch={false}
                className="underline underline-offset-3"
              >
                {outside.text}
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}
