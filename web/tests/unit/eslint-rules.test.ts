import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Le regole del lint su misura, provate con la configurazione vera del progetto.
// `filePath` è relativo a web/: il file non deve esistere, conta solo quale blocco di
// configurazione lo riguarda.
const eslint = new ESLint({ cwd: process.cwd() });

const RULES = new Set(["no-restricted-imports", "no-restricted-syntax"]);

async function errors(text: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath });
  if (!result) throw new Error(`ESLint non ha restituito un risultato per ${filePath}`);
  // Un file che non si legge darebbe 0 errori di regola: lo escludiamo, così "0" vuol dire "ok".
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`Errore di parsing in ${filePath}: ${fatal[0]?.message}`);
  return result.messages.filter(
    (m) => m.severity === 2 && m.ruleId !== null && RULES.has(m.ruleId),
  ).length;
}

// Il primo lintText carica la configurazione di Next: a freddo supera i 5 s di default.
describe("regole ESLint del progetto", { timeout: 30_000 }, () => {
  it("un file pulito non dà errori (il test misura davvero)", async () => {
    const ok = 'import { asUser } from "@/server/db/db";\nexport const x = asUser;\n';
    expect(await errors(ok, "src/app/(app)/oggi/x.ts")).toBe(0);
  });

  it("vieta @/server/db/service in src/ tranne src/server/db e recreate.ts", async () => {
    const imp = 'import { asService } from "@/server/db/service";\nexport const x = asService;\n';
    expect(await errors(imp, "src/app/(app)/oggi/x.ts")).toBeGreaterThan(0);
    expect(await errors(imp, "src/server/domain/patients/queries.ts")).toBeGreaterThan(0);
    expect(await errors(imp, "src/server/demo/recreate.ts")).toBe(0);
    expect(await errors(imp, "src/server/db/maintenance.ts")).toBe(0);
  });

  it("vieta pgOf di @/server/db/db fuori da src/server/db", async () => {
    const pg = 'import { pgOf } from "@/server/db/db";\nexport const x = pgOf;\n';
    expect(await errors(pg, "src/server/domain/patients/queries.ts")).toBeGreaterThan(0);
    expect(await errors(pg, "src/app/(app)/oggi/x.ts")).toBeGreaterThan(0);
    expect(await errors(pg, "src/server/db/maintenance.ts")).toBe(0);
    // recreate.ts può importare service.ts, ma non per questo anche pgOf.
    expect(await errors(pg, "src/server/demo/recreate.ts")).toBeGreaterThan(0);
  });

  it("i due divieti sugli import valgono insieme nello stesso file", async () => {
    const both =
      'import { pgOf } from "@/server/db/db";\nimport { asService } from "@/server/db/service";\n' +
      "export const x = [pgOf, asService];\n";
    expect(await errors(both, "src/app/x.ts")).toBe(2);
  });

  it("vieta service.ts anche con un import relativo, non solo con l'alias @/", async () => {
    const rel = (from: string) =>
      `import { asService } from "${from}";\nexport const x = asService;\n`;
    // Da una cartella di dominio, da un file di src/server, da src/app: tutte le grafie.
    expect(await errors(rel("../../db/service"), "src/server/domain/patients/queries.ts")).toBeGreaterThan(0);
    expect(await errors(rel("../db/service"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    expect(await errors(rel("./db/service"), "src/server/clock.ts")).toBeGreaterThan(0);
    expect(await errors(rel("../../server/db/service"), "src/app/x.ts")).toBeGreaterThan(0);
    expect(await errors(rel("../db/service.ts"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    // `export ... from` è un import a tutti gli effetti.
    const reexport = 'export { asService } from "../db/service";\n';
    expect(await errors(reexport, "src/server/domain/a.ts")).toBeGreaterThan(0);
    // Le eccezioni restano pulite: dentro src/server/db e in recreate.ts.
    expect(await errors(rel("./service"), "src/server/db/maintenance.ts")).toBe(0);
    expect(await errors(rel("../db/service"), "src/server/demo/recreate.ts")).toBe(0);
  });

  it("vieta pgOf anche con un import relativo, ma non il resto di db.ts", async () => {
    const rel = (from: string) => `import { pgOf } from "${from}";\nexport const x = pgOf;\n`;
    expect(await errors(rel("../../db/db"), "src/server/domain/patients/queries.ts")).toBeGreaterThan(0);
    expect(await errors(rel("../db/db"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    expect(await errors(rel("./db/db"), "src/server/clock.ts")).toBeGreaterThan(0);
    expect(await errors(rel("../db/db.ts"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    // recreate.ts può usare service.ts, ma non pgOf, nemmeno con un import relativo.
    expect(await errors(rel("../db/db"), "src/server/demo/recreate.ts")).toBeGreaterThan(0);
    expect(await errors(rel("./db"), "src/server/db/maintenance.ts")).toBe(0);
    // Il divieto riguarda solo pgOf: asUser da db.ts resta importabile ovunque.
    const asUser = 'import { asUser } from "../db/db";\nexport const x = asUser;\n';
    expect(await errors(asUser, "src/server/domain/a.ts")).toBe(0);
  });

  it("un import relativo non raddoppia l'errore e i due divieti valgono insieme", async () => {
    const both =
      'import { pgOf } from "../db/db";\nimport { asService } from "../db/service";\n' +
      "export const x = [pgOf, asService];\n";
    expect(await errors(both, "src/server/domain/a.ts")).toBe(2);
    // Con l'alias, un solo errore per riga anche se path e pattern coincidono.
    const alias = 'import { asService } from "@/server/db/service";\nexport const x = asService;\n';
    expect(await errors(alias, "src/server/domain/a.ts")).toBe(1);
  });

  it("vieta runTransaction, toTx e setActorClaims di db.ts fuori da src/server/db, anche in recreate.ts", async () => {
    const imp = (name: string, from = "@/server/db/db") => `import { ${name} } from "${from}";\nexport const x = ${name};\n`;
    for (const name of ["runTransaction", "toTx", "setActorClaims"]) {
      expect(await errors(imp(name), "src/server/domain/patients/queries.ts")).toBe(1);
      expect(await errors(imp(name, "../../db/db"), "src/server/domain/patients/queries.ts")).toBe(1);
      expect(await errors(imp(name), "src/server/demo/recreate.ts")).toBe(1);
      expect(await errors(imp(name, "./db"), "src/server/db/service.ts")).toBe(0);
    }
  });

  it("vieta openDb fuori da src/server/db, ma non getDb", async () => {
    const openDb = 'import { openDb } from "@/server/db/open";\nexport const x = openDb;\n';
    expect(await errors(openDb, "src/server/domain/patients/queries.ts")).toBe(1);
    expect(await errors(openDb, "src/server/demo/recreate.ts")).toBe(1);
    const relative = 'import { openDb } from "../../db/open";\nexport const x = openDb;\n';
    expect(await errors(relative, "src/server/domain/patients/queries.ts")).toBe(1);
    expect(await errors('import { openDb } from "./open";\nexport const x = openDb;\n', "src/server/db/maintenance.ts")).toBe(0);
    // /api/health apre il database dell'app con getDb: resta permesso.
    const getDb = 'import { getDb } from "@/server/db/open";\nexport const x = getDb;\n';
    expect(await errors(getDb, "src/app/api/health/route.ts")).toBe(0);
    expect(await errors(getDb, "src/server/domain/patients/queries.ts")).toBe(0);
  });

  it("vieta @electric-sql/pglite e i suoi sottopath fuori da src/server/db", async () => {
    const imports = [
      'import { PGlite } from "@electric-sql/pglite";\nexport const x = PGlite;\n',
      'import type { PGlite } from "@electric-sql/pglite";\nexport type X = PGlite;\n',
      'import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";\nexport const x = pg_trgm;\n',
    ];
    for (const imp of imports) {
      expect(await errors(imp, "src/server/domain/patients/queries.ts")).toBe(1);
      expect(await errors(imp, "src/server/demo/recreate.ts")).toBe(1);
      expect(await errors(imp, "src/server/db/pglite.ts")).toBe(0);
    }
  });

  it("vieta le grafie .js degli import vietati", async () => {
    expect(
      await errors('import { asService } from "../db/service.js";\nexport const x = asService;\n', "src/server/domain/a.ts"),
    ).toBeGreaterThan(0);
    expect(
      await errors('import { pgOf } from "@/server/db/db.js";\nexport const x = pgOf;\n', "src/app/x.ts"),
    ).toBeGreaterThan(0);
    expect(
      await errors('import { openDb } from "@/server/db/open.js";\nexport const x = openDb;\n', "src/app/x.ts"),
    ).toBeGreaterThan(0);
  });

  it("vieta import() degli stessi moduli, con le eccezioni degli import statici", async () => {
    const dyn = (spec: string) => `export const m = () => import("${spec}");\n`;
    expect(await errors(dyn("@/server/db/service"), "src/app/x.ts")).toBeGreaterThan(0);
    expect(await errors(dyn("../db/service.js"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    expect(await errors(dyn("@/server/db/db"), "src/lib/messages/links.ts")).toBeGreaterThan(0);
    expect(await errors(dyn("@electric-sql/pglite"), "src/app/x.ts")).toBeGreaterThan(0);
    expect(await errors(dyn("@/server/db/service"), "src/server/demo/recreate.ts")).toBe(0);
    expect(await errors(dyn("@/server/db/open"), "src/server/demo/recreate.ts")).toBeGreaterThan(0);
    expect(await errors(dyn("@/server/db/service"), "src/server/db/maintenance.ts")).toBe(0);
  });

  it("vieta il cambio di ruolo nelle stringhe, tranne in db.ts e nella colonna role", async () => {
    const sql = (text: string) => `export const q = ${JSON.stringify(text)};\n`;
    expect(
      await errors(sql("select set_config('role', 'postgres', true)"), "src/server/domain/a.ts"),
    ).toBeGreaterThan(0);
    expect(await errors(sql("SET LOCAL ROLE postgres"), "src/server/domain/a.ts")).toBeGreaterThan(0);
    expect(await errors("export const q = `set role ${'x'}`;\n", "src/app/x.ts")).toBeGreaterThan(0);
    // Dentro src/server/db vale anche per maintenance.ts: solo setActorClaims di db.ts cambia il ruolo.
    expect(
      await errors(sql("select set_config('role', 'postgres', true)"), "src/server/db/maintenance.ts"),
    ).toBeGreaterThan(0);
    expect(await errors(sql("select set_config('role', 'authenticated', true)"), "src/server/db/db.ts")).toBe(0);
    // `set role = $1` è l'update della colonna physicians.role, non un cambio di ruolo.
    expect(
      await errors(sql("update public.physicians set role = $1 where id = $2"), "src/server/domain/a.ts"),
    ).toBe(0);
  });

  // Oltre al ruolo, dentro `asUser` si cambia chi scrive in altri tre modi: `session authorization` rende
  // `current_user` il superutente della sessione, e i claim JWT cambiano l'utente che `auth.uid()` legge pur
  // restando `authenticated`. Solo `setActorClaims` di db.ts lo fa.
  it.each([
    "select set_config('session_authorization', 'postgres', true)",
    "set session authorization default",
    "SET LOCAL SESSION AUTHORIZATION postgres",
    "set session session authorization postgres",
    "reset session authorization",
    "select set_config('request.jwt.claim.sub', $1, true)",
    "select set_config('request.jwt.claim.role', 'service_role', true)",
    "select set_config('request.jwt.claims', $1, true)",
    // La forma `set` degli stessi parametri ha lo stesso effetto di `set_config`.
    "set local request.jwt.claim.sub = $1",
    "set request.jwt.claims to $1",
    "SET LOCAL session_authorization = postgres",
    "reset request.jwt.claim.sub",
  ])("vieta il cambio di utente nelle stringhe, tranne in db.ts: %s", async (text) => {
    const sql = `export const q = ${JSON.stringify(text)};\n`;
    expect(await errors(sql, "src/server/domain/a.ts")).toBe(1);
    expect(await errors(sql, "src/server/db/maintenance.ts")).toBe(1);
    expect(await errors(sql, "src/server/db/db.ts")).toBe(0);
    // Lo stesso testo in un template literal.
    const template = `export const q = \`${text.replace("$1", "${1}")}\`;\n`;
    expect(await errors(template, "src/app/x.ts")).toBe(1);
  });

  it("leggere i claim non è un cambio di utente", async () => {
    const read = (text: string) => `export const q = ${JSON.stringify(text)};\n`;
    expect(await errors(read("select current_setting('request.jwt.claims', true)"), "src/server/domain/a.ts")).toBe(0);
    expect(await errors(read("select auth.uid(), session_user"), "src/server/domain/a.ts")).toBe(0);
  });

  // `allowJs` è attivo e Next compila .js, .jsx e .mjs: un file così in src/ non deve saltare i divieti.
  it("le regole valgono anche per i file JavaScript di src/", async () => {
    const service = 'import { asService } from "@/server/db/service";\nexport const x = asService;\n';
    const role = `export const q = ${JSON.stringify("select set_config('role', 'postgres', true)")};\n`;
    const wa = 'export const u = "https://wa.me/391234";\n';
    for (const file of [
      "src/app/x/route.js",
      "src/app/x/page.jsx",
      "src/server/domain/a.mjs",
      "src/server/domain/a.mts",
    ]) {
      expect(await errors(service, file), file).toBe(1);
      expect(await errors(role, file), file).toBe(1);
      expect(await errors(wa, file), file).toBe(1);
    }
    // I file CommonJS non hanno `export`: solo il testo SQL.
    const commonRole = `module.exports = ${JSON.stringify("select set_config('role', 'postgres', true)")};\n`;
    expect(await errors(commonRole, "src/server/domain/a.cjs")).toBe(1);
    expect(await errors(commonRole, "src/server/domain/a.cts")).toBe(1);
    // Dentro src/server/db: service.ts si può importare, il ruolo no, e l'eccezione è solo db.ts.
    expect(await errors(service, "src/server/db/maintenance.js")).toBe(0);
    expect(await errors(role, "src/server/db/maintenance.js")).toBe(1);
    expect(await errors(role, "src/server/db/maintenance.mjs")).toBe(1);
    expect(await errors(role, "src/server/db/db.js")).toBe(1);
    expect(await errors(role, "src/server/db/db.ts")).toBe(0);
    // recreate.ts e links.ts sono file .ts con la loro eccezione: un omonimo .js non la eredita.
    expect(await errors(service, "src/server/demo/recreate.js")).toBe(1);
    expect(await errors(wa, "src/lib/messages/links.js")).toBe(1);
  });

  it("i blocchi nuovi non cancellano il divieto dei link", async () => {
    const wa = 'export const u = "https://wa.me/391234";\n';
    expect(await errors(wa, "src/server/demo/recreate.ts")).toBeGreaterThan(0);
    expect(await errors(wa, "src/server/db/maintenance.ts")).toBeGreaterThan(0);
    // db.ts ha solo il divieto dei link; links.ts ha tutto tranne i link.
    expect(await errors(wa, "src/server/db/db.ts")).toBeGreaterThan(0);
    expect(await errors(wa, "src/lib/messages/links.ts")).toBe(0);
  });

  it("vieta le stringhe wa.me fuori da src/lib/messages/links.ts", async () => {
    const wa = 'export const u = "https://wa.me/391234";\n';
    expect(await errors(wa, "src/app/x.ts")).toBeGreaterThan(0);
    expect(await errors(wa, "src/lib/messages/links.ts")).toBe(0);
    const waTemplate = "export const u = `https://wa.me/${1}`;\n";
    expect(await errors(waTemplate, "src/app/x.ts")).toBeGreaterThan(0);
  });

  it("vieta le stringhe che iniziano con tel: fuori da src/lib/messages/links.ts", async () => {
    const tel = "export const t = `tel:${1}`;\n";
    expect(await errors(tel, "src/components/x.ts")).toBeGreaterThan(0);
    expect(await errors(tel, "src/lib/messages/links.ts")).toBe(0);
    expect(await errors('export const t = "tel:+391234";\n', "src/app/x.ts")).toBeGreaterThan(0);
    const jsx = 'export const A = () => <a href="tel:+391234">chiama</a>;\n';
    expect(await errors(jsx, "src/components/x.tsx")).toBeGreaterThan(0);
  });
});
