import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("script_della_demo", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(scripts["verify:full"]).toBe("pnpm verify && pnpm test:e2e");
  expect(scripts["demo:prep"]).toBe("pnpm db:reset && pnpm build");
  expect(scripts["demo:check"]).toBe("tsx scripts/db.ts demo-check");
  expect(scripts.demo).toBe("APP_DEMO_MODE=1 next start -H 127.0.0.1 -p 3000");
});

it("script_di_backup", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(scripts["db:backup"]).toBe("tsx scripts/db.ts backup");
  expect(scripts["db:restore"]).toBe("tsx scripts/db.ts restore");
});
