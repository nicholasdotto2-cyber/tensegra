import { expect, type Page, test } from "@playwright/test";

// I collegamenti su Oggi, sull'agenda e sulla scheda,
// provati sulla demo dei test: D0 = mercoledì 4/11/2026 alle 08:30 (APP_FIXED_NOW in
// playwright.config.ts). Sola lettura (regola dei test e2e: il file viene prima di
// `demo.spec.ts` e non emette fatture): nessun clic su "Apri la visita" né su "Compila ora" (creerebbero una
// visita e cambierebbero i conteggi degli altri file), l'editor della fattura si chiude senza salvare, ogni
// finestra si chiude con Esc. "Compila ora" e "Chiudi il ciclo" del pannello "Seduta fatta" li prova il passo 4
// di `demo.spec.ts`, "Emetti fattura" le prove delle fatture: il pannello si apre solo segnando un fatto.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** La prima visita di Marco Bellandi, fatta e fatturata nel seed: P(10), il decimo giorno aperto prima di D0. */
const MARCO_FIRST_VISIT = "2026-10-23";
/** La prima visita di Matteo Ricci, fatta e non fatturata nel seed: P(2), lunedì 2 novembre. */
const MATTEO_FIRST_VISIT = "2026-11-02";

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

async function openOggi(page: Page): Promise<void> {
  await page.goto("/oggi");
  await expect(page.getByRole("heading", { level: 1, name: "Oggi" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** La sezione della scheda dalla barra dei link. */
async function openTab(page: Page, label: string): Promise<void> {
  const link = page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: label, exact: true });
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
  await page.waitForLoadState("networkidle");
}

test("l'intestazione di Oggi ha «Nuovo paziente»: apre il dialogo, Esc lo chiude e il focus torna al pulsante", async ({
  page,
}) => {
  await openOggi(page);

  const button = page.getByRole("button", { name: "Nuovo paziente" });
  await expect(page.getByRole("button", { name: "Nuovo appuntamento" })).toBeVisible();
  await button.click();

  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^Nome/)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});

test("il menu della riga di Giulia ha «Apri la visita» e «Apri scheda paziente», che porta alla scheda", async ({
  page,
}) => {
  await openOggi(page);

  const row = page
    .getByRole("region", { name: "Appuntamenti di oggi (5)" })
    .getByRole("listitem")
    .filter({ hasText: "Ferrante Giulia" });
  await row.getByRole("button", { name: "Menu" }).click();

  await expect(page.getByRole("menuitem", { name: "Sposta" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Annulla appuntamento" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Apri la visita" })).toBeVisible();
  const patient = page.getByRole("menuitem", { name: "Apri scheda paziente" });
  await expect(patient).toBeVisible();

  // Esc chiude il menu e riporta il focus al suo pulsante; poi si riapre e si segue il collegamento.
  await page.keyboard.press("Escape");
  await expect(patient).toBeHidden();
  await expect(row.getByRole("button", { name: "Menu" })).toBeFocused();

  await row.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Apri scheda paziente" }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Giulia Ferrante" })).toBeVisible();
});

test("«Apri scheda paziente» si raggiunge e si apre da tastiera: Invio sulla voce porta alla scheda", async ({ page }) => {
  await openOggi(page);

  const row = page
    .getByRole("region", { name: "Appuntamenti di oggi (5)" })
    .getByRole("listitem")
    .filter({ hasText: "Ferrante Giulia" });
  await row.getByRole("button", { name: "Menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Sposta" })).toBeFocused();

  // Sposta, Annulla appuntamento, Apri la visita, Apri scheda paziente: tre frecce.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Apri scheda paziente" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Giulia Ferrante" })).toBeVisible();
});

test("«Vedi tutti» in coda ai richiami porta ai pazienti col filtro «Da richiamare»", async ({ page }) => {
  await openOggi(page);

  const recalls = page.getByRole("region", { name: "Da richiamare (2)" });
  const link = recalls.getByRole("link", { name: "Vedi tutti" });
  await expect(link).toHaveAttribute("href", "/pazienti?filtro=da_richiamare");
  await link.click();

  await expect(page).toHaveURL(/\/pazienti\?filtro=da_richiamare$/);
  await expect(page.getByRole("heading", { level: 1, name: "Pazienti" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Da richiamare (2)" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("row")).toHaveCount(3);
});

test("nell'agenda del 4/11 il dettaglio di Giulia ha il nome come link alla scheda e la riga «Visita»", async ({
  page,
}) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-04");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^\d{2}:\d{2}-\d{2}:\d{2}, Ferrante Giulia, / }).click();
  const detail = page.getByRole("dialog", { name: "Giulia Ferrante" });
  await expect(detail).toBeVisible();

  // La visita non c'è ancora, ma la seduta di oggi si può aprire anche prima del "fatto".
  await expect(detail.getByText("Visita", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Apri la visita" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // Il nome del titolo è un link alla scheda.
  await page.getByRole("button", { name: /^\d{2}:\d{2}-\d{2}:\d{2}, Ferrante Giulia, / }).click();
  const link = page.getByRole("dialog", { name: "Giulia Ferrante" }).getByRole("link", { name: "Giulia Ferrante" });
  await expect(link).toHaveAttribute("href", new RegExp(`^/pazienti/${UUID}$`));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Giulia Ferrante" })).toBeVisible();
});

// La visita di oggi di Anna (bozza del seed) tiene il giorno; l'ora resta modificabile. Il dialogo
// si chiude con Esc senza salvare.
test("«Sposta» sulla riga di Anna, che ha già la visita in bozza: la data è ferma con il motivo, l'ora no", async ({
  page,
}) => {
  await openOggi(page);
  const row = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Morelli Anna" });
  await row.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Sposta" }).click();

  const move = page.getByRole("dialog", { name: "Modifica appuntamento" });
  const day = move.getByLabel("Data", { exact: true });
  await expect(day).toBeDisabled();
  await expect(day).toHaveAccessibleDescription("Questo appuntamento ha già una visita: non si sposta a un altro giorno.");
  await expect(move.getByLabel("Ora di inizio")).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(move).toBeHidden();
});

test("«Emetti» su Matteo in «Fatture da emettere» apre «Nuova fattura» con la seduta; chiuso senza salvare il blocco resta (2)", async ({
  page,
}) => {
  await openOggi(page);

  const block = page.getByRole("region", { name: "Fatture da emettere (2)" });
  const row = block.getByRole("listitem").filter({ hasText: "Matteo Ricci" });
  const emit = row.getByRole("button", { name: "Emetti" });
  await emit.click();

  // L'editor come pannello laterale sopra Oggi, mai una navigazione.
  const panel = page.getByRole("dialog", { name: "Nuova fattura" });
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/oggi$/);
  const line = panel.getByRole("group", { name: "Riga 1" });
  await expect(line.getByLabel("Descrizione")).toHaveValue("Prima visita osteopatica");
  await expect(line.getByLabel("Data della prestazione")).toHaveValue(MATTEO_FIRST_VISIT);
  await expect(line.getByLabel("Prezzo")).toHaveValue("80,00");
  await expect(panel.getByRole("group", { name: "Riga 2" })).toHaveCount(0);

  // Chiudere senza un'azione non salva una bozza: la seduta resta da fatturare.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(emit).toBeFocused();
  await expect(block).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Fatture da emettere (2)" })).toBeVisible();
});

test("nell'agenda della prima visita di Marco il dettaglio ha la riga «Fattura» col numero e il link alla fattura", async ({
  page,
}) => {
  await page.goto(`/agenda?vista=giorno&data=${MARCO_FIRST_VISIT}`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /^\d{2}:\d{2}-\d{2}:\d{2}, Bellandi Marco, / }).click();
  const detail = page.getByRole("dialog", { name: "Marco Bellandi", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Fattura", { exact: true })).toBeVisible();
  const invoice = detail.getByRole("link", { name: /^Fattura \d+\/2026$/ });
  await expect(invoice).toHaveAttribute("href", new RegExp(`^/fatture/${UUID}$`));
  const number = ((await invoice.textContent()) ?? "").replace(/^Fattura /, "");

  // Il link porta al dettaglio di quella fattura.
  await invoice.click();
  await expect(page).toHaveURL(new RegExp(`/fatture/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${number}` })).toBeVisible();
});

test("la scheda di Marco: la tab «Fatture» con la sua fattura, PDF e XML; in «Appuntamenti» il link sulla prima visita", async ({
  page,
}) => {
  await page.goto("/pazienti?q=Bellandi");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Bellandi Marco" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Marco Bellandi" })).toBeVisible();

  // La tab Fatture sta fra Consensi e Messaggi; Messaggi prima di Anagrafica.
  const tabs = page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link");
  await expect(tabs).toHaveText(["Riepilogo", "Cartella", "Appuntamenti", "Consensi", "Fatture", "Messaggi", "Anagrafica"]);

  await openTab(page, "Fatture");
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}\\?tab=fatture$`));
  const rows = page.getByRole("row").filter({ hasText: "Marco Bellandi" });
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toContainText("Prima visita osteopatica");
  await expect(row).toContainText("Pagata");
  const number = row.getByRole("link", { name: /^\d+\/2026$/ });
  await expect(number).toHaveAttribute("href", new RegExp(`^/fatture/${UUID}$`));
  const label = (await number.textContent()) ?? "";
  const href = (await number.getAttribute("href")) ?? "";
  const id = href.slice("/fatture/".length);
  await expect(row.getByRole("link", { name: /^PDF/ })).toHaveAttribute("href", `/api/fatture/${id}/pdf?download=1`);
  await expect(row.getByRole("link", { name: /^XML/ })).toHaveAttribute("href", `/api/fatture/${id}/xml`);

  // Le destinazioni sono il PDF e l'XML della fattura, non una pagina d'errore.
  const pdf = await page.request.get(`/api/fatture/${id}/pdf?download=1`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  const xml = await page.request.get(`/api/fatture/${id}/xml`);
  expect(xml.status()).toBe(200);
  expect(xml.headers()["content-type"]).toBe("application/xml; charset=utf-8");
  const xmlText = await xml.text();
  expect(xmlText.startsWith("<?xml")).toBe(true);
  expect(xmlText).toContain("FatturaElettronica");

  // Il numero porta al dettaglio della fattura.
  const fattureTab = page.url();
  await number.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${label}` })).toBeVisible();

  // Appuntamenti: la prima visita, fra i passati, porta il link alla stessa fattura, e il link ci arriva.
  await page.goto(fattureTab);
  await expect(page.getByRole("heading", { level: 1, name: "Marco Bellandi" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await openTab(page, "Appuntamenti");
  const past = page.getByRole("region", { name: "Passati" });
  const visit = past.getByRole("listitem").filter({ hasText: "Prima visita osteopatica" });
  const visitLink = visit.getByRole("link", { name: `Fattura ${label}` });
  await expect(visitLink).toHaveAttribute("href", href);
  await visitLink.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${label}` })).toBeVisible();
});

test("la scheda di Martina: la tab «Fatture» ha le 3 fatture intestate alla madre", async ({ page }) => {
  await page.goto("/pazienti?q=Martina");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "De Luca Martina" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Martina De Luca" })).toBeVisible();

  await openTab(page, "Fatture");
  const rows = page.getByRole("row").filter({ hasText: "Simona De Luca" });
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) await expect(row).toContainText("per Martina De Luca");
  // Solo le sue: l'intestazione e le tre righe.
  await expect(page.getByRole("row")).toHaveCount(4);
});
