import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// `allowJs` è attivo in tsconfig.json e Next compila anche .js, .jsx e .mjs: ogni estensione di un
// file sorgente sta nei pattern, perché un file che non ne ha uno salta i divieti di questo file.
const EXT = "{ts,tsx,js,jsx,mjs,cjs,mts,cts}";
const SRC = [`src/**/*.${EXT}`];

// `service.ts` apre una connessione da superutente, che salta le policy RLS.
const serviceMessage =
  "Connessione da superutente: usala solo in src/server/db o in src/server/demo/recreate.ts.";
// Fuori da src/server/db si lavora solo con `asUser` e `tx`, mai con il PGlite grezzo.
const pgOfMessage =
  "Database senza RLS o fuori da asUser: usalo solo in src/server/db. Le funzioni di dominio ricevono tx.";
// openDb apre un altro PGlite sulla stessa cartella, e il lock dello stesso PID non lo ferma.
const openDbMessage = "openDb apre un secondo PGlite sulla stessa cartella dati: fuori da src/server/db usa getDb.";
const pgliteMessage = "PGlite grezzo, senza RLS né lock: usalo solo in src/server/db.";

// Si usano solo `patterns`: `**/db/service` prende sia l'alias `@/server/db/service` sia le grafie
// relative (`../db/service`, `./db/service.ts`). Un divieto sul solo `paths` esatto sparirebbe
// cambiando il modo di scrivere il path; tenere entrambi darebbe due errori per la stessa riga.
// Le grafie `.js` servono perché TypeScript con `moduleResolution: nodenext` le scrive così.
const servicePattern = {
  group: ["**/db/service", "**/db/service.ts", "**/db/service.js"],
  message: serviceMessage,
};
// `runTransaction` e `toTx` aprono una transazione come `postgres`, quindi senza RLS;
// `setActorClaims` cambia l'utente della transazione aperta (fuori da db, solo switchToUser).
const pgOfPattern = {
  group: ["**/db/db", "**/db/db.ts", "**/db/db.js"],
  importNames: ["pgOf", "runTransaction", "toTx", "setActorClaims"],
  message: pgOfMessage,
};
// `getDb` resta permesso: è l'unico modo giusto di avere il database dell'app (/api/health).
const openDbPattern = {
  group: ["**/db/open", "**/db/open.ts", "**/db/open.js"],
  importNames: ["openDb"],
  message: openDbMessage,
};
const pglitePattern = { group: ["@electric-sql/pglite", "@electric-sql/pglite/*"], message: pgliteMessage };

const linkMessage = "Usa whatsappHref() o telHref() di src/lib/messages/links.ts.";
const importCallMessage = "import() di un modulo del database: stessi divieti degli import statici.";
const roleMessage =
  "Cambio di ruolo o di utente dentro una transazione: esce dalla RLS. Solo setActorClaims di src/server/db/db.ts cambia ruolo e utente.";

// In flat config le opzioni di `no-restricted-syntax` non si fondono tra blocchi: ogni gruppo di
// file ha un solo blocco, con l'elenco completo costruito da questi selettori.

// Ogni link wa.me e tel: nasce in links.ts, dove vale la regola della demo.
const linkSelectors = [
  { selector: "Literal[value=/wa\\.me/]", message: linkMessage },
  { selector: "Literal[value=/^tel:/]", message: linkMessage },
  { selector: "TemplateElement[value.raw=/wa\\.me|tel:/]", message: linkMessage },
];

// In PGlite la sessione è `postgres` (superutente), quindi un `set role` o un
// `set_config('role', ...)` dentro `asUser` esce dalla RLS per il resto della transazione. Lo stesso
// vale per `session authorization` (torna al superutente della sessione) e per i claim JWT, che
// cambiano l'utente di `auth.uid()` restando `authenticated`: è l'effetto di `setActorClaims`, che
// fuori da db.ts non si importa. Il `(?!\s*=)` lascia passare `set role = $1`, l'update della colonna
// `physicians.role`; leggere i claim con `current_setting` non è un cambio.
const ROLE_SQL = [
  String.raw`set_config\s*\(\s*'(role|session_authorization|request\.jwt\.claims?(\.[a-z_]+)?)'`,
  String.raw`\b(re)?set\s+(local\s+|session\s+)?role\b(?!\s*=)`,
  String.raw`\b(re)?set\s+(local\s+|session\s+)?session\s+authorization\b`,
  String.raw`\b(re)?set\s+(local\s+|session\s+)?(session_authorization|request\.jwt\.claims?(\.[a-z_]+)?)\b`,
];
const roleSelectors = ROLE_SQL.flatMap((source) =>
  ["Literal[value", "TemplateElement[value.raw"].map((target) => ({
    selector: `${target}=/${source}/i]`,
    message: roleMessage,
  })),
);

// `no-restricted-imports` non guarda `import()`, che aggirerebbe i divieti sugli import statici.
const importCallSelectors = (dbModules) =>
  [
    String.raw`ImportExpression[source.value=/(^|\/)db\/(${dbModules})(\.[jt]s)?$/]`,
    String.raw`ImportExpression[source.value=/^@electric-sql\/pglite(\/|$)/]`,
  ].map((selector) => ({ selector, message: importCallMessage }));
const importCalls = importCallSelectors("service|db|open");
// recreate.ts può importare service.ts.
const importCallsOfRecreate = importCallSelectors("db|open");

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // In flat config le opzioni di una regola non si fondono tra blocchi: vince l'ultimo blocco
  // che riguarda il file. Per questo i divieti sugli import sono due blocchi che non si
  // sovrappongono, ognuno con l'elenco completo dei path vietati per i suoi file.
  {
    // Tutto src/ tranne src/server/db (dove vivono) e recreate.ts: vietati service.ts, il database
    // senza RLS di db.ts, openDb e PGlite.
    files: SRC,
    ignores: ["src/server/db/**", "src/server/demo/recreate.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [servicePattern, pgOfPattern, openDbPattern, pglitePattern] },
      ],
    },
  },
  {
    // L'unica eccezione per service.ts: "Ricrea" può usarlo, ma per il resto ha gli
    // stessi divieti del blocco sopra.
    files: ["src/server/demo/recreate.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [pgOfPattern, openDbPattern, pglitePattern] }],
    },
  },
  // `no-restricted-syntax`: cinque gruppi di file che non si sovrappongono, ognuno con l'elenco
  // completo dei suoi selettori (link, cambio di ruolo, import() dei moduli vietati).
  {
    // Tutto src/ tranne i quattro gruppi qui sotto.
    files: SRC,
    ignores: ["src/server/db/**", "src/server/demo/recreate.ts", "src/lib/messages/links.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...linkSelectors,
        ...roleSelectors,
        ...importCalls,
      ],
    },
  },
  {
    // links.ts è l'unico posto dove nascono i link wa.me e tel:; per il resto ha gli stessi divieti.
    files: ["src/lib/messages/links.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...roleSelectors,
        ...importCalls,
      ],
    },
  },
  {
    // recreate.ts importa service.ts, ma non db, open né PGlite.
    files: ["src/server/demo/recreate.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...linkSelectors,
        ...roleSelectors,
        ...importCallsOfRecreate,
      ],
    },
  },
  {
    // Dentro src/server/db i moduli del database si importano liberamente, ma il ruolo lo cambia
    // solo setActorClaims di db.ts (blocco dopo questo).
    files: [`src/server/db/**/*.${EXT}`],
    ignores: ["src/server/db/db.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...linkSelectors, ...roleSelectors],
    },
  },
  {
    files: ["src/server/db/db.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...linkSelectors],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
