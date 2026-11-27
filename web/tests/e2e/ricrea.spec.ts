import { expect, test } from "@playwright/test";

let consoleErrors: string[] = [];
test.beforeEach(({ page }) => {
  consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});
test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

test("ricrea_da_impostazioni", async ({ page }) => {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente", exact: true }).click();
  const patient = page.getByRole("dialog", { name: "Nuovo paziente" });
  await patient.getByLabel(/^Nome/).fill("Prova");
  await patient.getByLabel(/^Cognome/).fill("Ricrea");
  await patient.getByLabel(/^Data di nascita/).fill("1985-01-15");
  await patient.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Prova Ricrea" })).toBeVisible();

  await page.goto("/impostazioni/dati-di-prova");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Dati creati il 04/11/2026 alle 08:30 (versione 1).")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Ricrea i dati di prova per oggi", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Ricrea i dati di prova per oggi", exact: true });
  await expect(dialog.getByText("Tutto ciò che hai inserito o modificato verrà cancellato e sostituito con i dati di prova di oggi.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto("/pazienti?q=Ricrea");
  await expect(page.getByRole("link", { name: "Ricrea Prova", exact: true })).toBeVisible();
  await page.goto("/impostazioni/dati-di-prova");
  await page.waitForLoadState("networkidle");
  await trigger.click();

  // Trattiene la risposta vera per osservare lo stato in attesa senza sostituire l'azione.
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/impostazioni/dati-di-prova", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Ricrea i dati", exact: true }).click();
  try {
    await expect(dialog.getByRole("button", { name: "Sto ricreando i dati...", exact: true })).toBeDisabled();
    // A dialogo aperto il resto della pagina è nascosto all'albero di accessibilità: si cerca anche fra i nascosti.
    await expect(page.getByRole("button", { name: "Ricrea i dati di prova per oggi", exact: true, includeHidden: true })).toBeDisabled();
  } finally {
    release();
  }
  // Ricrea rifà tutto il seed: a macchina carica il redirect arriva dopo i 5 s di default (7 s visti il 30/10).
  await expect(page).toHaveURL(/\/oggi$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Oggi", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fatture da emettere (2)", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Consensi mancanti (2)", exact: true })).toBeVisible();
  const appointments = page.getByRole("region", { name: "Appuntamenti di oggi (5)", exact: true });
  await expect(appointments).toBeVisible();
  await expect(appointments.getByRole("listitem")).toHaveCount(5);
  await page.goto("/pazienti?q=Ricrea");
  await expect(page.getByRole("link", { name: "Ricrea Prova", exact: true })).toHaveCount(0);
});

test("banner_senza_pulsante_oggi", async ({ page }) => {
  await page.goto("/oggi");
  const banner = page.getByRole("region", { name: "Avviso dati di prova" });
  await expect(banner.getByText("Creati oggi alle 08:30")).toBeVisible();
  await expect(banner.getByRole("button", { name: "Ricrea per oggi", exact: true })).toHaveCount(0);
});
