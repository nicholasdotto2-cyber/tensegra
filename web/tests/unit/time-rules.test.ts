import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Regole del tempo controllate sul testo dei file di src/: un fuso in più, un
// giorno preso dal fuso della macchina o un orologio letto nel dominio escono qui, non in agenda.

const WEB = resolve(".");

/** I file sotto `dir` (relativo a web/), come "src/server/clock.ts". Una cartella che non c'è ancora non ne ha. */
function filesUnder(dir: string): string[] {
  const abs = resolve(WEB, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(WEB, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function text(file: string): string {
  return readFileSync(resolve(WEB, file), "utf8");
}

const CLOCK_READS: RegExp[] = [
  /new Date\(\s*\)/,
  /Date\.now\(/,
  // `clock.now()` passa, `select now()` no
  /(?<![.\w])now\(\)/i,
  /current_date/i,
  /current_timestamp/i,
  /localtimestamp/i,
];

function readsClock(source: string): boolean {
  return CLOCK_READS.some((pattern) => pattern.test(source));
}

const MACHINE_DAY = [".getDate()", ".getHours()", "toISOString().slice(0, 10)"];

describe("regole del tempo", () => {
  it("il fuso di Roma compare solo in clock.ts e format.ts", () => {
    const withZone = filesUnder("src").filter((file) => text(file).includes("Europe/Rome"));
    expect(withZone).toEqual(["src/lib/format.ts", "src/server/clock.ts"]);
  });

  it("format.ts non importa dal server", () => {
    for (const file of ["src/lib/format.ts", "src/lib/phone.ts"]) {
      expect(text(file), file).not.toContain("@/server");
    }
  });

  it("il dominio non legge l'orologio", () => {
    expect(readsClock("const t = clock.now();")).toBe(false);
    expect(readsClock("select now()")).toBe(true);

    const offenders = filesUnder("src/server/domain").filter((file) => readsClock(text(file)));
    expect(offenders).toEqual([]);
  });

  it("niente giorni dal fuso della macchina", () => {
    const offenders = [...filesUnder("src/server"), ...filesUnder("src/lib")].filter((file) => {
      const source = text(file);
      return MACHINE_DAY.some((pattern) => source.includes(pattern));
    });
    expect(offenders).toEqual([]);
  });
});
