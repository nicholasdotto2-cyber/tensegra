import { defineConfig, devices } from "@playwright/test";

// L'e2e gira sulla build (pnpm build prima) con una cartella dati sua, ricreata a ogni
// avvio: i test scrivono sullo stesso database e la demo vera non si tocca. Porta 3100, quella
// dello smoke è la 3200. Solo 127.0.0.1, mai le altre interfacce.
const PORT = 3100;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Il browser come quello dello studio: campi data in giorno/mese/anno e ora di Roma.
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec tsx scripts/db.ts e2e-reset && pnpm exec next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: {
      APP_DATA_DIR: ".data/e2e",
      APP_DEMO_MODE: "1",
      APP_FIXED_NOW: "2026-11-04T08:30:00+01:00",
    },
    reuseExistingServer: false,
  },
});
