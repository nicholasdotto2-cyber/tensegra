import { z } from "zod";
import {
  ADVICE_TEMPLATES,
  APPROACH_DECLARED,
  FAMILIES,
  FREE_TEST,
  REGION_CODES,
  SCREENING_GROUPS,
  screeningItem,
  technique,
  TECHNIQUES,
  testDefinition,
  type Family,
  type RegionCode,
  type ResultType,
  type ScreeningGroup,
  type TechniqueCode,
} from "@/lib/clinical/catalog";
import {
  AMEND_REASON_MAX,
  AMEND_REASON_MIN,
  AMEND_REASON_SHORT,
  APPROACH_REQUIRED,
  TECHNIQUE_NAME_REQUIRED,
} from "@/lib/clinical/labels";
import { CycleOpeningInput } from "@/server/domain/cycles/schemas";

// Gli input della visita. Ogni modifica di
// una visita è un'operazione (`VisitOp`) che lo stesso codice applica in bozza (`editVisit`) e in
// rettifica (`amendVisit`). Gli schemi sono `.strict()` anche negli oggetti annidati, e i
// limiti sono quelli dei check di `visits` e delle sue figlie; le regole che guardano il catalogo
// stanno qui, quelle che guardano il database (gruppi visibili, prima visita del ciclo) nei comandi.

/** Un valore che il chiamante non produce: lo stesso testo del 23514. */
export const INVALID = "Valore non valido";
export const REGIONS_REQUIRED = "Scegli almeno una regione.";

const maxChars = (n: number): string => `Massimo ${n} caratteri.`;

const blankToNull = (value: string | null): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

/** Un testo facoltativo: "" e null diventano null, il resto si salva senza spazi ai lati. */
const limitedText = (max: number) =>
  z
    .string({ error: INVALID })
    .nullable()
    .transform(blankToNull)
    .pipe(z.string().max(max, { error: maxChars(max) }).nullable());

/** Un intero fra `min` e `max` o null, con lo stesso testo per un tipo sbagliato o un valore fuori limite. */
const boundedInt = (min: number, max: number) =>
  z.int({ error: INVALID }).min(min, { error: INVALID }).max(max, { error: INVALID }).nullable();

const unique = <T>(items: T[]): T[] => [...new Set(items)];

const regionCode = z.enum(REGION_CODES as readonly [RegionCode, ...RegionCode[]], { error: INVALID });

/** L'appuntamento da cui nasce la visita. */
export const StartVisitInput = z.object({ appointmentId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();
export type StartVisitInput = z.input<typeof StartVisitInput>;

export const RADIATION_SITES = ["gluteo", "coscia", "sotto_ginocchio", "braccio", "mano"] as const;

/**
 * I campi della visita. Ogni chiave è facoltativa: una chiave che manca non cambia la colonna, `null`
 * (o "" per un testo) la svuota, `[]` toglie l'irradiazione. Le regole fra campi (lato con
 * l'irradiazione, nota con la reazione, consenso dei presenti) valgono alla chiusura.
 */
export const VisitFieldsInput = z
  .object(
    {
      location: z.enum(["studio", "domicilio", "altro"], { error: INVALID }).optional(),
      othersPresent: limitedText(200).optional(),
      othersPresentConsented: z.boolean({ error: INVALID }).nullable().optional(),
      nprsPre: boundedInt(0, 10).optional(),
      nprsPost: boundedInt(0, 10).optional(),
      subjectiveUpdate: limitedText(1000).optional(),
      radiationSites: z.array(z.enum(RADIATION_SITES, { error: INVALID }), { error: INVALID }).transform(unique).optional(),
      radiationSide: z.enum(["dx", "sx", "bilaterale"], { error: INVALID }).nullable().optional(),
      treatmentResponse: z.enum(["migliorato", "invariato", "peggiorato"], { error: INVALID }).nullable().optional(),
      adverseReaction: z.enum(["nessuna", "lieve", "moderata", "grave"], { error: INVALID }).nullable().optional(),
      adverseReactionNote: limitedText(500).optional(),
      observationNote: limitedText(1000).optional(),
      workingHypothesis: limitedText(1000).optional(),
      planNext: limitedText(500).optional(),
      bpSystolic: boundedInt(50, 260).optional(),
      bpDiastolic: boundedInt(30, 160).optional(),
    },
    { error: INVALID },
  )
  .strict();
export type VisitFieldsInput = z.input<typeof VisitFieldsInput>;

const ANSWER_NOTE_MAX = 300;
const OVERRIDE_NOTE_MAX = 500;

/**
 * Una risposta dello screening: sostituisce tutta la risposta salvata della voce (regioni, sottovoci,
 * nota) e non è più "da anamnesi". Le regioni valgono solo per le voci locali, e un "si" locale ne
 * vuole almeno una; le sottovoci sono quelle della voce.
 */
const AnswerOp = z
  .object(
    {
      op: z.literal("risposta"),
      itemCode: z.string({ error: INVALID }),
      answer: z.enum(["no", "si", "non_so"], { error: INVALID }),
      regions: z.array(regionCode, { error: INVALID }).transform(unique).default([]),
      subAnswers: z.array(z.string({ error: INVALID }), { error: INVALID }).transform(unique).default([]),
      note: limitedText(ANSWER_NOTE_MAX).optional(),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine((value, ctx) => {
    const item = screeningItem(value.itemCode);
    if (!item) {
      ctx.addIssue({ code: "custom", message: INVALID, path: ["itemCode"] });
      return;
    }
    if (item.scope === "global" && value.regions.length > 0) {
      ctx.addIssue({ code: "custom", message: INVALID, path: ["regions"] });
    }
    if (item.scope === "local" && value.answer === "si" && value.regions.length === 0) {
      ctx.addIssue({ code: "custom", message: REGIONS_REQUIRED, path: ["regions"] });
    }
    if (value.subAnswers.some((code) => !item.subItems.some((sub) => sub.code === code))) {
      ctx.addIssue({ code: "custom", message: INVALID, path: ["subAnswers"] });
    }
  });

const screeningGroup = z.enum(
  SCREENING_GROUPS.map((g) => g.code) as [ScreeningGroup, ...ScreeningGroup[]],
  { error: INVALID },
);

/** "Nessun'altra voce": "no" su ogni voce visibile del gruppo senza risposta. */
const NoOtherOp = z.object({ op: z.literal("nessun_altra_voce"), group: screeningGroup }, { error: INVALID }).strict();

const outcome = z.enum(["indicated", "caution", "contraindicated"], { error: INVALID });

/**
 * «Conferma lo screening»: i tre esiti scelti dall'osteopata, una volta per famiglia. Il suggerito lo
 * calcola il comando dalle risposte salvate; la nota serve quando l'esito è più lieve del suggerito.
 */
const OutcomesOp = z
  .object(
    {
      op: z.literal("esiti"),
      outcomes: z
        .array(
          z
            .object(
              {
                family: z.enum(FAMILIES as readonly [Family, ...Family[]], { error: INVALID }),
                outcome,
                overrideNote: limitedText(OVERRIDE_NOTE_MAX).optional(),
              },
              { error: INVALID },
            )
            .strict(),
          { error: INVALID },
        )
        .length(FAMILIES.length, { error: INVALID })
        .refine((rows) => new Set(rows.map((r) => r.family)).size === rows.length, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();

/** "Nessuna variazione dal 15/10": le risposte della visita sorgente, esiti ricalcolati e confermati. */
const NoChangeOp = z.object({ op: z.literal("nessuna_variazione") }, { error: INVALID }).strict();

/** Il punteggio iniziale di un'attività PSFS alla prima visita del ciclo; null lo toglie. */
const PsfsOp = z
  .object(
    { op: z.literal("psfs"), itemId: z.uuid({ error: INVALID }), score: boundedInt(0, 10) },
    { error: INVALID },
  )
  .strict();

const FieldsOp = z.object({ op: z.literal("campi"), values: VisitFieldsInput }, { error: INVALID }).strict();

// Disfunzioni, test, tecniche e consigli.
// Ogni scrittura porta la riga intera: un campo che manca vale il suo default, non "lascia com'è".

export const SEVERITY_ZERO_TEXT = "Con severità 0 segna almeno una lettera TART, o togli la regione.";
export const SIDE_REQUIRED = "Scegli il lato.";
export { APPROACH_REQUIRED, TECHNIQUE_NAME_REQUIRED };
export const CHANNEL_REQUIRED = "Scegli almeno un canale.";

/** "Valore fuori dai limiti del test (0-90).", con la virgola dei decimali. */
export function outOfRangeText(min: number, max: number): string {
  const n = (v: number) => String(v).replace(".", ",");
  return `Valore fuori dai limiti del test (${n(min)}-${n(max)}).`;
}

/** Il codice del test libero: non è nel catalogo, ha il suo nome (`custom_label`). */
export { FREE_TEST };
/** `value_numeric numeric(6, 2)`: il test libero, senza limiti di catalogo, resta sotto 10000. */
const FREE_NUMERIC_MAX = 9999.99;

/** Una regione con le lettere TART: severità 0 vuole almeno una lettera, come il check della tabella. */
const FindingOp = z
  .object(
    {
      op: z.literal("disfunzione"),
      id: z.uuid({ error: INVALID }).optional(),
      region: regionCode,
      severity: z.int({ error: INVALID }).min(0, { error: INVALID }).max(3, { error: INVALID }),
      tissueTexture: z.boolean({ error: INVALID }).default(false),
      asymmetry: z.boolean({ error: INVALID }).default(false),
      restriction: z.boolean({ error: INVALID }).default(false),
      tenderness: z.boolean({ error: INVALID }).default(false),
      side: z.enum(["dx", "sx", "bilaterale", "centrale"], { error: INVALID }).nullable().default(null),
      segmentNote: limitedText(200).default(null),
      isPrimary: z.boolean({ error: INVALID }).default(false),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine((value, ctx) => {
    if (value.severity === 0 && !(value.tissueTexture || value.asymmetry || value.restriction || value.tenderness)) {
      ctx.addIssue({ code: "custom", message: SEVERITY_ZERO_TEXT, path: ["severity"] });
    }
  });

const RemoveFindingOp = z.object({ op: z.literal("togli_disfunzione"), region: regionCode }, { error: INVALID }).strict();

const VALUE_KEYS = ["valueBool", "valueLateral", "valueNumeric", "valueOrdinal"] as const;
type ValueKey = (typeof VALUE_KEYS)[number];
const VALUE_KEY_OF: Record<ResultType, ValueKey> = {
  binary: "valueBool",
  lateral: "valueLateral",
  numeric: "valueNumeric",
  ordinal: "valueOrdinal",
};

/**
 * Il risultato di un test: il valore nel campo del tipo del test e nei suoi limiti, il lato per i
 * test per lato. Senza valore serve almeno il dolore provocato o una nota ("non eseguibile per dolore"):
 * una riga vuota è "Valore non valido". Il test libero ha il suo
 * nome e usa `valueBool` o `valueNumeric`. Che il test sia attivo nello studio lo guarda il comando.
 */
const TestOp = z
  .object(
    {
      op: z.literal("test"),
      id: z.uuid({ error: INVALID }).optional(),
      testCode: z.string({ error: INVALID }),
      customLabel: limitedText(60).default(null),
      customUnit: limitedText(10).default(null),
      side: z.enum(["dx", "sx"], { error: INVALID }).nullable().default(null),
      valueBool: z.boolean({ error: INVALID }).nullable().default(null),
      valueLateral: z.enum(["neg", "dx", "sx", "bil"], { error: INVALID }).nullable().default(null),
      valueNumeric: z.number({ error: INVALID }).nullable().default(null),
      valueOrdinal: z.int({ error: INVALID }).nullable().default(null),
      painProvoked: z.boolean({ error: INVALID }).nullable().default(null),
      note: limitedText(200).default(null),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine((value, ctx) => {
    const invalid = (key: string) => ctx.addIssue({ code: "custom", message: INVALID, path: [key] });
    const given = VALUE_KEYS.filter((key) => value[key] !== null);
    // Una riga vuota non è un risultato: per togliere un test c'è `togli_test`.
    if (given.length === 0 && value.painProvoked === null && value.note === null) {
      ctx.addIssue({ code: "custom", message: INVALID, path: [] });
    }

    if (value.testCode === FREE_TEST) {
      if (value.customLabel === null) invalid("customLabel");
      for (const key of given) if (key !== "valueBool" && key !== "valueNumeric") invalid(key);
      if (given.length > 1) invalid(given[1] as string);
      if (value.valueNumeric !== null && Math.abs(value.valueNumeric) > FREE_NUMERIC_MAX) invalid("valueNumeric");
      return;
    }

    const def = testDefinition(value.testCode);
    if (!def) {
      invalid("testCode");
      return;
    }
    if (value.customLabel !== null) invalid("customLabel");
    if (value.customUnit !== null) invalid("customUnit");
    if (def.perSide && value.side === null) ctx.addIssue({ code: "custom", message: SIDE_REQUIRED, path: ["side"] });
    if (!def.perSide && value.side !== null) invalid("side");

    const own = VALUE_KEY_OF[def.resultType];
    for (const key of given) if (key !== own) invalid(key);
    if (def.resultType === "numeric" && value.valueNumeric !== null && def.min !== null && def.max !== null) {
      if (value.valueNumeric < def.min || value.valueNumeric > def.max) {
        ctx.addIssue({ code: "custom", message: outOfRangeText(def.min, def.max), path: ["valueNumeric"] });
      }
    }
    if (def.resultType === "ordinal" && value.valueOrdinal !== null) {
      const labels = def.ordinalLabels?.length ?? 0;
      if (value.valueOrdinal < 0 || value.valueOrdinal >= labels) invalid("valueOrdinal");
    }
  });

const RemoveTestOp = z.object({ op: z.literal("togli_test"), resultId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();

const techniqueCode = z.enum(TECHNIQUES.map((t) => t.code) as [TechniqueCode, ...TechniqueCode[]], { error: INVALID });


/** Una tecnica in una regione: acceso = una riga; tolleranza "buona" di partenza. */
const TechniqueOp = z
  .object(
    {
      op: z.literal("tecnica"),
      id: z.uuid({ error: INVALID }).optional(),
      region: regionCode,
      techniqueCode,
      customTechnique: limitedText(60).default(null),
      approach: z.enum(["direct", "indirect"], { error: INVALID }).nullable().default(null),
      tolerance: z.enum(["buona", "fastidio", "interrotta"], { error: INVALID }).default("buona"),
      response: z.enum(["migliorato", "invariato", "peggiorato"], { error: INVALID }).nullable().default(null),
      note: limitedText(300).default(null),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine((value, ctx) => {
    const t = technique(value.techniqueCode);
    if (value.techniqueCode === "altra" && value.customTechnique === null) {
      ctx.addIssue({ code: "custom", message: TECHNIQUE_NAME_REQUIRED, path: ["customTechnique"] });
    }
    if (value.techniqueCode !== "altra" && value.customTechnique !== null) {
      ctx.addIssue({ code: "custom", message: INVALID, path: ["customTechnique"] });
    }
    if (APPROACH_DECLARED.includes(value.techniqueCode) && value.approach === null) {
      ctx.addIssue({ code: "custom", message: APPROACH_REQUIRED, path: ["approach"] });
    }
    if (!t?.variableApproach && value.approach !== null) {
      ctx.addIssue({ code: "custom", message: INVALID, path: ["approach"] });
    }
  });

const RemoveTechniqueOp = z
  .object({ op: z.literal("togli_tecnica"), treatmentId: z.uuid({ error: INVALID }) }, { error: INVALID })
  .strict();

const adviceChannel = z.enum(["a_voce", "foglio_stampato", "messaggio_copiato"], { error: INVALID });

const adviceTemplate = z.enum(ADVICE_TEMPLATES.map((t) => t.code) as [string, ...string[]], { error: INVALID });

/**
 * Un consiglio dato: il testo del modello copiato nella visita (`text` null o vuoto)
 * oppure il testo modificato, e almeno un canale. "Messaggio copiato" si sceglie anche a mano, senza una riga del
 * registro; la copia del messaggio lo aggiunge da sé (`markAdviceMessagePrepared`).
 */
const AdviceOp = z
  .object(
    {
      op: z.literal("consiglio"),
      id: z.uuid({ error: INVALID }).optional(),
      adviceId: z.uuid({ error: INVALID }).optional(),
      templateCode: adviceTemplate,
      text: limitedText(1000).default(null),
      communicatedVia: z
        .array(adviceChannel, { error: INVALID })
        .transform(unique)
        .pipe(z.array(adviceChannel).min(1, { error: CHANNEL_REQUIRED })),
    },
    { error: INVALID },
  )
  .strict();

const RemoveAdviceOp = z
  .object({ op: z.literal("togli_consiglio"), adviceId: z.uuid({ error: INVALID }) }, { error: INVALID })
  .strict();

/** Conferma una riga copiata dalla visita precedente, o tutte; i consigli non si copiano. */
const ConfirmOp = z
  .object(
    {
      op: z.literal("conferma"),
      target: z.union(
        [
          z.literal("tutti"),
          z
            .object(
              { table: z.enum(["findings", "tests", "treatments"], { error: INVALID }), id: z.uuid({ error: INVALID }) },
              { error: INVALID },
            )
            .strict(),
        ],
        { error: INVALID },
      ),
    },
    { error: INVALID },
  )
  .strict();

/**
 * I campi d'apertura del ciclo dalla prima visita: gli stessi di `updateCycleOpening`
 * tranne il ciclo, che è quello della visita. Ammessa solo sulla prima visita del ciclo, in bozza e in
 * rettifica; dopo la chiusura della prima visita è l'unica via per cambiarli.
 */
const OpeningOp = z
  .object({ op: z.literal("apertura"), ...CycleOpeningInput.omit({ cycleId: true }).shape }, { error: INVALID })
  .strict();

/** Le operazioni sulla visita. */
export const VisitOpInput = z.discriminatedUnion(
  "op",
  [
    FieldsOp,
    AnswerOp,
    NoOtherOp,
    OutcomesOp,
    NoChangeOp,
    PsfsOp,
    FindingOp,
    RemoveFindingOp,
    TestOp,
    RemoveTestOp,
    TechniqueOp,
    RemoveTechniqueOp,
    AdviceOp,
    RemoveAdviceOp,
    ConfirmOp,
    OpeningOp,
  ],
  { error: INVALID },
);
export type VisitOp = z.output<typeof VisitOpInput>;

/** Una modifica di una visita in bozza. */
export const EditVisitInput = z
  .object({ visitId: z.uuid({ error: INVALID }), op: VisitOpInput }, { error: INVALID })
  .strict();
export type EditVisitInput = z.input<typeof EditVisitInput>;

/** "Copia dalla visita precedente"; `replace` dopo «Sostituire i dati copiati non confermati?». */
export const CopyVisitInput = z
  .object({ visitId: z.uuid({ error: INVALID }), replace: z.boolean({ error: INVALID }) }, { error: INVALID })
  .strict();
export type CopyVisitInput = z.input<typeof CopyVisitInput>;

/**
 * «Chiudi la visita»: `confirmCopied` per "Conferma tutti i copiati e chiudi",
 * `alsoMarkDone` per "Segna anche l'appuntamento come fatto".
 */
export const CloseVisitInput = z
  .object(
    {
      visitId: z.uuid({ error: INVALID }),
      confirmCopied: z.boolean({ error: INVALID }),
      alsoMarkDone: z.boolean({ error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();
export type CloseVisitInput = z.input<typeof CloseVisitInput>;

const AMEND_OPS_MAX = 50;
// Il motivo lo controllano anche il dialogo della rettifica (`src/lib/clinical/labels.ts`, una sola copia).
export { AMEND_REASON_MIN, AMEND_REASON_SHORT };

/**
 * «Salva la rettifica»: il motivo, 10-500 caratteri senza gli spazi ai lati come il check
 * di `visit_amendments`, e le modifiche raccolte dall'editor, applicate in ordine.
 */
export const AmendVisitInput = z
  .object(
    {
      id: z.uuid({ error: INVALID }).optional(),
      visitId: z.uuid({ error: INVALID }),
      reason: z
        .string({ error: AMEND_REASON_SHORT })
        .trim()
        .min(AMEND_REASON_MIN, { error: AMEND_REASON_SHORT })
        .max(AMEND_REASON_MAX, { error: maxChars(AMEND_REASON_MAX) }),
      ops: z
        .array(VisitOpInput, { error: INVALID })
        .min(1, { error: INVALID })
        .max(AMEND_OPS_MAX, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();
export type AmendVisitInput = z.input<typeof AmendVisitInput>;
