import { expect, type Page, test } from "@playwright/test";

// La scheda del paziente sulla demo dei test: 15 pazienti, seed creato il 4/11/2026 alle 08:30
// (APP_FIXED_NOW in playwright.config.ts). Sola lettura: niente qui cambia i dati. Giulia
// Ferrante, Francesca Longo e Chiara Valli sono pazienti che nessun altro file cambia; Anna Morelli si
// legge soltanto, senza salvare il richiamo.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// Un errore di una risorsa o un'eccezione della pagina arriva dopo il titolo: lo controlla afterEach.
let consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  // Un'eccezione non gestita della pagina non passa dal canale "console".
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

/** Dalla lista alla scheda, cliccando il nome come fa chi la usa ("Morelli Anna"). */
async function openFromList(page: Page, listName: string, heading: string): Promise<void> {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: listName }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("la testata di Anna Morelli ha età, telefono da copiare, avviso clinico e le sezioni come link", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFromList(page, "Morelli Anna", "Anna Morelli");

  await expect(page.getByText("72 anni")).toBeVisible();
  await expect(page.getByText("+39 320 000 0004")).toBeVisible();
  // Il numero è solo testo: nessun `tel:` e nessun `wa.me`, nemmeno nell'HTML.
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);

  // "Copia" scrive negli appunti l'E.164 salvato, senza spazi.
  const copy = page.getByRole("button", { name: "Copia il numero" });
  await expect(copy).toHaveText("Copia");
  await copy.click();
  await expect(page.getByText("Numero copiato.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("+393200000004");

  await expect(page.getByText("Terapia anticoagulante (warfarin)")).toBeVisible();
  // Il seed clinico: il Warfarin dell'anamnesi dà il badge "TAO", e la visita più recente con gli
  // esiti (la bozza di oggi, screening confermato) dà il riassunto dell'esito più severo, il thrust.
  await expect(page.getByText("TAO", { exact: true })).toBeVisible();
  await expect(page.getByText(/Controindicato:|Con cautela:/)).toHaveText("Controindicato: terapia anticoagulante");

  const sections = page.getByRole("navigation", { name: "Sezioni della scheda" });
  await expect(sections.getByRole("link", { name: "Riepilogo" })).toHaveAttribute("aria-current", "page");
  // Le sette tab della scheda in ordine.
  await expect(sections.getByRole("link")).toHaveText(["Riepilogo", "Cartella", "Appuntamenti", "Consensi", "Fatture", "Messaggi", "Anagrafica"]);
  for (const name of ["Cartella", "Appuntamenti", "Consensi", "Fatture", "Messaggi", "Anagrafica"]) {
    const link = sections.getByRole("link", { name });
    await expect(link).toBeVisible();
    await expect(link).not.toHaveAttribute("aria-current", "page");
  }
});

test("il Riepilogo di Anna mostra il ciclo, la cadenza del richiamo e il dialogo «Cambia» si chiude senza salvare", async ({
  page,
}) => {
  await openFromList(page, "Morelli Anna", "Anna Morelli");

  await expect(page.getByRole("heading", { level: 2, name: "Prossimo appuntamento" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Ciclo in corso" })).toBeVisible();
  await expect(page.getByText("Lombalgia ricorrente")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Consensi" })).toBeVisible();
  await expect(page.getByText("Medico curante: non indicato")).toBeVisible();

  // Cadenza di 6 settimane: la riga la dice sempre, con o senza una scadenza sopra.
  await expect(page.getByText("Ogni 6 settimane")).toBeVisible();

  await page.getByRole("button", { name: "Cambia" }).click();
  const dialog = page.getByRole("dialog", { name: "Richiamo" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "6 settimane" })).toBeChecked();
  await dialog.getByRole("radio", { name: "Altra" }).click();
  await dialog.getByLabel("Settimane (da 2 a 52)").fill("1");
  await dialog.getByRole("button", { name: "Salva il richiamo" }).click();
  // Fuori scala: lo dice sotto il campo, il dialogo resta aperto e non scrive.
  await expect(dialog.getByText("Scrivi un numero di settimane da 2 a 52.")).toBeVisible();
  await expect(dialog.getByLabel("Settimane (da 2 a 52)")).toBeFocused();
  await dialog.getByRole("button", { name: "Torna indietro" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Ogni 6 settimane")).toBeVisible();
});

test("un parametro «tab» sconosciuto apre il Riepilogo e ogni sezione si apre dal suo link", async ({ page }) => {
  await openFromList(page, "Morelli Anna", "Anna Morelli");
  const patientUrl = page.url().split("?")[0] ?? "";

  await page.goto(`${patientUrl}?tab=boh`);
  const sections = page.getByRole("navigation", { name: "Sezioni della scheda" });
  await expect(sections.getByRole("link", { name: "Riepilogo" })).toHaveAttribute("aria-current", "page");

  for (const [name, tab] of [
    ["Appuntamenti", "appuntamenti"],
    ["Consensi", "consensi"],
    ["Cartella", "cartella"],
    ["Anagrafica", "anagrafica"],
  ] as const) {
    await sections.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`\\?tab=${tab}$`));
    await expect(sections.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  }
});

test("gli Appuntamenti di Giulia tengono il futuro in alto, i passati sotto e i contatori", async ({ page }) => {
  await openFromList(page, "Ferrante Giulia", "Giulia Ferrante");
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Appuntamenti" }).click();
  await expect(page).toHaveURL(/\?tab=appuntamenti$/);

  await expect(page.getByText("3 fatti, 0 saltati, 0 annullati")).toBeVisible();

  const future = page.getByRole("region", { name: "Futuri" });
  const past = page.getByRole("region", { name: "Passati" });
  await expect(future.getByRole("listitem")).toHaveCount(1);
  await expect(future.getByRole("listitem")).toContainText("mer 4 nov alle 15:00");
  await expect(future.getByRole("listitem")).toContainText("Confermato");
  await expect(past.getByRole("listitem")).toHaveCount(3);
  await expect(past.getByRole("listitem").first()).toContainText("sab 24 ott alle 09:00");
  await expect(past.getByRole("listitem").last()).toContainText("mer 30 set alle 15:00");
  for (const item of await past.getByRole("listitem").all()) await expect(item).toContainText("Fatto");

  // I Futuri vengono prima dei Passati nella pagina.
  const futureBox = await future.boundingBox();
  const pastBox = await past.boundingBox();
  expect(futureBox?.y ?? 0).toBeLessThan(pastBox?.y ?? 0);
});

test("i Consensi di Giulia: stato e data, i due «Raccogli», download e revoca per riga", async ({ page }) => {
  await openFromList(page, "Ferrante Giulia", "Giulia Ferrante");
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Consensi" }).click();
  await expect(page).toHaveURL(/\?tab=consensi$/);

  for (const name of ["Modulo", "Ciclo", "Data", "Stato"]) {
    await expect(page.getByRole("columnheader", { name })).toBeVisible();
  }
  await expect(page.getByRole("cell", { name: "Informativa" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Consenso al trattamento" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Valido" })).toHaveCount(2);
  // La raccolta apre il dialogo; ogni documento valido si scarica e si revoca
  // (qui solo guardati: il download creerebbe il PDF di Giulia, provato in consensi.spec.ts su un paziente proprio).
  await expect(page.getByRole("button", { name: "Raccogli l'informativa" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Raccogli il consenso al trattamento" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Scarica PDF" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Registra revoca" })).toHaveCount(2);
});

test("Francesca Longo non si archivia: il menu dice quanti appuntamenti annullare e non offre l'eliminazione", async ({
  page,
}) => {
  await openFromList(page, "Longo Francesca", "Francesca Longo");

  await page.getByRole("button", { name: "Altre azioni" }).click();
  const archive = page.getByRole("menuitem", { name: "Archivia" });
  await expect(archive).toBeVisible();
  await expect(archive).toBeDisabled();
  // La frase è la descrizione della voce, non solo un testo vicino.
  await expect(archive).toHaveAccessibleDescription("Prima annulla i 2 appuntamenti futuri.");
  await expect(page.getByText("Prima annulla i 2 appuntamenti futuri.")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Elimina definitivamente" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(archive).toHaveCount(0);
});

test("Chiara Valli ha un solo appuntamento futuro e la frase lo dice al singolare", async ({ page }) => {
  await openFromList(page, "Valli Chiara", "Chiara Valli");

  await page.getByRole("button", { name: "Altre azioni" }).click();
  await expect(page.getByRole("menuitem", { name: "Archivia" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Archivia" })).toHaveAccessibleDescription(
    "Prima annulla l'appuntamento futuro.",
  );
  await expect(page.getByText("Prima annulla l'appuntamento futuro.")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Elimina definitivamente" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("un id che non esiste o non è un uuid dà «Paziente non trovato.» con la strada per tornare alla lista", async ({
  page,
}) => {
  await page.goto("/pazienti/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { level: 1, name: "Paziente non trovato." })).toBeVisible();
  await page.getByRole("link", { name: "Torna ai pazienti" }).click();
  await expect(page).toHaveURL(/\/pazienti$/);
  await expect(page.getByRole("heading", { level: 1, name: "Pazienti" })).toBeVisible();

  await page.goto("/pazienti/abc");
  await expect(page.getByRole("heading", { level: 1, name: "Paziente non trovato." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Torna ai pazienti" })).toHaveAttribute("href", "/pazienti");
});
