"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId } from "react";

import { Sparkline } from "@/components/pazienti/sparkline";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { REGION_CODES, REGION_LABEL } from "@/lib/clinical/catalog";
import type { Trend } from "@/lib/clinical/compare";
import { patientHref } from "@/lib/patients/params";
import type { TestsOverTime } from "@/server/domain/cartella/queries";

// La vista "Test nel tempo" della Cartella: una riga per test e lato, una
// colonna per visita del ciclo, in fondo la variazione dalla prima misura con la freccia e il segno, e per i
// numerici una linea piccola. Una cella senza misura ha il testo nascosto «non misurato». I filtri «Ciclo» e
// «Regione» stanno nell'URL (`ciclo`, `regione`), così la vista si può condividere e ricaricare.

const ALL_REGIONS = "tutte";
const NO_CYCLES = "Nessun ciclo da mostrare.";
const NO_TESTS = "Nessun test misurato in questo ciclo.";
const NO_TESTS_IN_REGION = "Nessun test misurato in questa regione.";

const TREND_TEXT: Record<Trend, string> = {
  improved: "migliorato",
  worsened: "peggiorato",
  unchanged: "invariato",
};

const REGION_ITEMS = [
  { value: ALL_REGIONS, label: "Tutte le regioni" },
  ...REGION_CODES.map((code) => ({ value: code, label: REGION_LABEL[code] })),
];

function Filters({ tests, patientId }: { tests: TestsOverTime; patientId: string }) {
  const router = useRouter();
  const baseId = useId();
  const cycleItems = tests.cycles.map((c) => ({ value: c.id, label: c.title }));
  const go = (next: { ciclo?: string | null; regione?: TestsOverTime["region"] }) => {
    router.replace(
      patientHref(patientId, {
        tab: "cartella",
        vista: "test",
        ciclo: next.ciclo === undefined ? tests.cycleId : next.ciclo,
        regione: next.regione === undefined ? tests.region : next.regione,
      }),
    );
  };

  return (
    <div className="flex flex-wrap gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${baseId}-ciclo`}>Ciclo</Label>
        <Select
          items={cycleItems}
          value={tests.cycleId}
          onValueChange={(value) => {
            if (value !== null) go({ ciclo: value });
          }}
        >
          <SelectTrigger id={`${baseId}-ciclo`} className="min-w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {cycleItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${baseId}-regione`}>Regione</Label>
        <Select
          items={REGION_ITEMS}
          value={tests.region ?? ALL_REGIONS}
          onValueChange={(value) => {
            if (value === null) return;
            go({ regione: REGION_CODES.find((code) => code === value) ?? null });
          }}
        >
          <SelectTrigger id={`${baseId}-regione`} className="min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGION_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * La variazione: la freccia viene dal verso dei valori (`direction`), non dal testo; per un numero il testo è il
 * segno e il numero, e il giudizio (migliorato, peggiorato) lo dice una parola nascosta. Una variazione a parole
 * ("Migliorato") ha già il suo giudizio nel testo.
 */
function ChangeCell({
  change,
  direction,
}: {
  change: NonNullable<TestsOverTime["rows"][number]["change"]>;
  direction: TestsOverTime["rows"][number]["direction"];
}) {
  const Arrow = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : null;
  return (
    <span className="inline-flex items-center gap-1">
      {Arrow === null ? null : <Arrow aria-hidden="true" className="size-4 shrink-0" />}
      <span className="tabular-nums">{change.text}</span>
      {direction === null || change.trend === null ? null : <span className="sr-only">{`(${TREND_TEXT[change.trend]})`}</span>}
    </span>
  );
}

export function TestsOverTimeView({ tests, patientId }: { tests: TestsOverTime; patientId: string }) {
  const headingId = useId();
  const cycleTitle = tests.cycles.find((c) => c.id === tests.cycleId)?.title ?? null;
  const empty =
    tests.cycleId === null ? NO_CYCLES : tests.rows.length === 0 ? (tests.region === null ? NO_TESTS : NO_TESTS_IN_REGION) : null;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h2 id={headingId} className="text-base font-medium">
        Test nel tempo
      </h2>
      {tests.cycleId === null ? null : <Filters tests={tests} patientId={patientId} />}
      {empty !== null ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{`Test del ciclo ${cycleTitle ?? ""}, una colonna per visita`}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Test</TableHead>
              {tests.columns.map((column) => (
                <TableHead key={column.visitId} scope="col">
                  {column.dateText}
                </TableHead>
              ))}
              <TableHead scope="col">Variazione</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tests.rows.map((row) => (
              <TableRow key={row.key}>
                <TableHead scope="row" className="font-normal">
                  {row.label}
                </TableHead>
                {row.values.map((value, index) => (
                  <TableCell key={tests.columns[index]?.visitId ?? index} className="tabular-nums">
                    {value ?? <span className="sr-only">non misurato</span>}
                  </TableCell>
                ))}
                <TableCell>
                  <span className="flex items-center gap-3">
                    {row.numeric === null ? null : (
                      <Sparkline
                        values={row.numeric}
                        label={`Andamento di ${row.label}: ${row.numeric.map((v) => (v === null ? "non misurato" : String(v).replace(".", ","))).join(", ")}`}
                      />
                    )}
                    {row.change === null ? null : <ChangeCell change={row.change} direction={row.direction} />}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
