// Una linea piccola dei valori nel tempo (il dolore 0-10 del ciclo). Il grafico da solo non
// basta (WCAG 1.4.1): chi la usa scrive accanto i valori in testo, e `label` è il nome che sente un
// lettore di schermo. Un valore `null` (non scritto) interrompe la linea e non ha un punto. Senza
// `max` la scala sale fino al valore più alto; il fondo è sempre 0.

const WIDTH = 96;
const HEIGHT = 28;
const PAD = 3;
const DOT = 2.5;

export function Sparkline({
  values,
  label,
  max,
}: {
  values: readonly (number | null)[];
  label: string;
  max?: number;
}) {
  const top = max ?? Math.max(1, ...values.map((v) => v ?? 0));
  const step = values.length > 1 ? (WIDTH - 2 * PAD) / (values.length - 1) : 0;
  const x = (index: number) => (values.length > 1 ? PAD + index * step : WIDTH / 2);
  const y = (value: number) => HEIGHT - PAD - (Math.min(Math.max(value, 0), top) / top) * (HEIGHT - 2 * PAD);

  // I tratti continui: ogni valore scritto dopo un buco apre un tratto nuovo.
  const runs: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] | null = null;
  values.forEach((value, index) => {
    if (value === null) {
      current = null;
      return;
    }
    if (current === null) {
      current = [];
      runs.push(current);
    }
    current.push({ index, value });
  });

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="shrink-0 text-primary"
    >
      {runs.map((run) =>
        run.length > 1 ? (
          <polyline
            key={run[0]?.index}
            points={run.map((p) => `${x(p.index)},${y(p.value)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null,
      )}
      {values.map((value, index) =>
        value === null ? null : (
          <circle key={index} cx={x(index)} cy={y(value)} r={DOT} fill="currentColor" />
        ),
      )}
    </svg>
  );
}
