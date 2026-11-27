import { expect, type Locator, type Page, test } from "@playwright/test";

// La lista dei pazienti e il dialogo "Nuovo paziente" sulla demo dei test: 15
// pazienti attivi, seed creato il 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts).
// Ogni test che salva un paziente lo elimina prima di finire: a fine file la lista torna a
// «Tutti (15)».

// Il 4/11/2026 meno 10 anni: un minore, qualunque sia il giorno in cui gira il test.
const MINOR_BIRTH_DATE = "2016-11-04";
const GUARDIAN_MISSING = "Per un minore servono nome e cognome di un genitore.";

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

// I test che salvano un paziente lo eliminano alla fine; se uno fallisce a metà, questo lo toglie lo stesso
// (anche da archiviato), così il database e2e resta a 15 pazienti per gli altri test e gli altri file.
let createsPatient = false;
let initialTotal: number;
let initialInCycle: number;
let initialMissingConsents: number;

/** Il numero fra parentesi del filtro, letto dalla pagina: "In ciclo (11)" dà 11. */
async function filterCount(page: Page, label: string): Promise<number> {
  const link = page.getByRole("navigation", { name: "Filtri" }).getByRole("link", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
  const count = Number(/\((\d+)\)$/.exec((await link.textContent()) ?? "")?.[1]);
  expect(Number.isInteger(count)).toBe(true);
  return count;
}

test.beforeEach(async ({ page }) => {
  createsPatient = false;
  // I file precedenti possono creare pazienti propri, per esempio Prova Editor di fattura-editor.spec.ts, che è in
  // ciclo e senza consensi (regola dei test e2e). Totale, "In ciclo" e "Consensi mancanti" si leggono qui,
  // prima delle scritture del test; gli altri conteggi del seed non li tocca nessun file precedente.
  await openList(page);
  initialTotal = await filterCount(page, "Tutti");
  initialInCycle = await filterCount(page, "In ciclo");
  initialMissingConsents = await filterCount(page, "Consensi mancanti");
  // Il seed ne ha 10 e 2; i file precedenti possono solo aggiungerne.
  expect(initialInCycle).toBeGreaterThanOrEqual(10);
  expect(initialMissingConsents).toBeGreaterThanOrEqual(2);
});

test.afterEach(async ({ page }) => {
  if (!createsPatient) return;
  for (const url of ["/pazienti?q=Rossi", "/pazienti?filtro=archiviati&q=Rossi"]) {
    await openList(page, url);
    const left = page.getByRole("link", { name: "Rossi Prova" });
    if ((await left.count()) === 0) continue;
    await left.first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Prova Rossi" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await deleteOpenPatient(page, "Prova Rossi");
  }
});

function filter(page: Page, name: string): Locator {
  return page.getByRole("navigation", { name: "Filtri" }).getByRole("link", { name });
}

/**
 * Apre la lista e aspetta che la pagina sia attiva: un campo riempito o un link cliccato prima che
 * React sia pronto perde il testo o fa una navigazione intera (i controlli sulla ricerca lo richiedono).
 */
async function openList(page: Page, url = "/pazienti"): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Dalla scheda aperta: menu, «Elimina definitivamente», conferma con il nome; poi la lista senza il paziente. */
async function deleteOpenPatient(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Altre azioni" }).click();
  await page.getByRole("menuitem", { name: "Elimina definitivamente" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Eliminare definitivamente ${name}?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Elimina definitivamente" }).click();

  await expect(page).toHaveURL(/\/pazienti$/);
  await expect(filter(page, `Tutti (${initialTotal})`)).toBeVisible();
}

/** Il campo "Nome" o "Cognome" di un gruppo: l'etichetta porta anche "(obbligatorio)". */
function field(group: Locator, label: "Nome" | "Cognome"): Locator {
  return group.getByLabel(new RegExp(`^${label}`));
}

test("la lista mostra ricerca, filtri con conteggio e la prima riga con il nome come link", async ({ page }) => {
  await openList(page);

  await expect(page.getByRole("heading", { level: 1, name: "Pazienti" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuovo paziente" })).toBeVisible();

  const search = page.getByLabel("Cerca paziente");
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute("placeholder", "Nome, cognome o telefono");

  for (const name of [
    `Tutti (${initialTotal})`,
    `In ciclo (${initialInCycle})`,
    "Da richiamare (2)",
    `Consensi mancanti (${initialMissingConsents})`,
    "Senza prossimo passo (1)",
    "Archiviati (0)",
  ]) {
    await expect(filter(page, name)).toBeVisible();
  }
  await expect(filter(page, `Tutti (${initialTotal})`)).toHaveAttribute("aria-current", "page");

  for (const name of ["Paziente", "Telefono", "Ciclo", "Prossimo appuntamento", "Richiamo", "Consensi"]) {
    await expect(page.getByRole("columnheader", { name })).toBeVisible();
  }

  const first = page.getByRole("row").nth(1);
  await expect(first).toContainText("Bellandi Marco");
  await expect(first).toContainText("47 anni");
  await expect(first.getByRole("link", { name: "Bellandi Marco" })).toHaveAttribute(
    "href",
    /^\/pazienti\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("«Paziente» si ordina con un clic: crescente all'inizio, poi decrescente", async ({ page }) => {
  await openList(page);

  const header = page.getByRole("columnheader", { name: "Paziente" });
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(page.getByRole("columnheader", { name: "Prossimo appuntamento" })).toHaveAttribute("aria-sort", "none");

  await header.getByRole("button", { name: "Paziente" }).click();

  await expect(page).toHaveURL(/verso=desc/);
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("row").nth(1)).not.toContainText("Bellandi Marco");
});

test("«Da richiamare» tiene i due pazienti da richiamare e scrive il filtro nell'URL", async ({ page }) => {
  await openList(page);

  await filter(page, "Da richiamare (2)").click();

  await expect(page).toHaveURL(/filtro=da_richiamare/);
  await expect(filter(page, "Da richiamare (2)")).toHaveAttribute("aria-current", "page");
  const rows = page.getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Conti Davide");
  await expect(rows.nth(2)).toContainText("Sala Giorgio");
});

test("una ricerca senza risultati propone di creare il paziente e il dialogo parte dal cognome cercato", async ({
  page,
}) => {
  await openList(page);

  const search = page.getByLabel("Cerca paziente");
  await search.fill("rossi");
  // Dopo 250 ms la ricerca va nell'URL e il campo tiene testo e focus.
  await expect(page).toHaveURL(/q=rossi/);
  await expect(page.getByText("Nessun paziente trovato per «rossi».")).toBeVisible();
  await expect(search).toHaveValue("rossi");
  await expect(filter(page, "Tutti (0)")).toBeVisible();

  await page.getByRole("button", { name: "Crea Rossi come nuovo paziente" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await expect(dialog).toBeVisible();
  await expect(field(dialog, "Cognome")).toHaveValue("Rossi");
  await expect(dialog.getByText("Versione di prova: inserisci solo dati inventati.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salva e apri la scheda" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salva e fissa un appuntamento" })).toBeVisible();
});

test("per un minore il dialogo chiede il genitore e, senza, lo dice sotto il campo col focus", async ({ page }) => {
  await openList(page);
  await page.getByRole("button", { name: "Nuovo paziente" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await expect(dialog.getByRole("group", { name: "Genitore o tutore" })).toHaveCount(0);

  await field(dialog, "Nome").fill("Prova");
  await field(dialog, "Cognome").fill("Rossi");
  await dialog.getByLabel(/^Data di nascita/).fill(MINOR_BIRTH_DATE);

  const guardian = dialog.getByRole("group", { name: "Genitore o tutore" });
  await expect(guardian).toBeVisible();

  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();

  const guardianFirstName = field(guardian, "Nome");
  await expect(guardianFirstName).toBeFocused();
  await expect(guardianFirstName).toHaveAccessibleDescription(GUARDIAN_MISSING);
  await expect(guardian.getByText(GUARDIAN_MISSING)).toBeVisible();
  // Rifiutato: il dialogo resta aperto e la lista non ha un paziente in più.
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(filter(page, `Tutti (${initialTotal})`)).toBeVisible();
});

test("un filtro scelto mentre la ricerca aspetta resta, e il testo scritto con lui", async ({ page }) => {
  await openList(page);

  await page.getByLabel("Cerca paziente").fill("bel");
  // Il clic arriva prima dei 250 ms della ricerca: la ricerca in attesa non deve riportare il filtro a «Tutti».
  await filter(page, `In ciclo (${initialInCycle})`).click();

  await expect(page).toHaveURL(/filtro=in_ciclo/);
  await expect(page).toHaveURL(/q=bel/);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/filtro=in_ciclo/);
  await expect(page.getByLabel("Cerca paziente")).toHaveValue("bel");
});

test("una ricerca per numero senza risultati non propone di creare un paziente", async ({ page }) => {
  await openList(page, "/pazienti?q=999999");

  await expect(page.getByText("Nessun paziente trovato per «999999».")).toBeVisible();
  await expect(page.getByRole("button", { name: /come nuovo paziente/ })).toHaveCount(0);
});

test("dal vuoto della ricerca «Salva e fissa un appuntamento» apre l'appuntamento sul paziente nuovo", async ({
  page,
}) => {
  createsPatient = true;
  await openList(page);
  await page.getByLabel("Cerca paziente").fill("rossi");
  await page.getByRole("button", { name: "Crea Rossi come nuovo paziente" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill("Prova");
  await dialog.getByLabel(/^Data di nascita/).fill(MINOR_BIRTH_DATE);
  const guardian = dialog.getByRole("group", { name: "Genitore o tutore" });
  await field(guardian, "Nome").fill("Elena");
  await field(guardian, "Cognome").fill("Rossi");
  await dialog.getByRole("button", { name: "Salva e fissa un appuntamento" }).click();

  // La lista sotto cambia (il vuoto lascia il posto alla riga nuova): il dialogo dell'appuntamento resta.
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(booking).toBeVisible();
  await expect(booking.getByLabel(/^Paziente/)).toHaveValue("Rossi Prova");
  // Il dialogo aperto nasconde la lista agli strumenti di accessibilità: si cerca la riga nel DOM.
  await expect(page.locator("tbody tr").first()).toContainText("Rossi Prova");
  await expect(booking).toBeVisible();

  // Chiuso senza fissare: il paziente resta; lo si apre dalla riga e lo si elimina, così la lista torna a 15.
  await booking.getByRole("button", { name: "Annulla" }).click();
  await expect(booking).toHaveCount(0);
  await page.getByRole("link", { name: "Rossi Prova" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Prova Rossi" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await deleteOpenPatient(page, "Prova Rossi");
});

test("un paziente minore si salva con il genitore, si apre la scheda e si elimina", async ({ page }) => {
  createsPatient = true;
  await openList(page);
  await page.getByRole("button", { name: "Nuovo paziente" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill("Prova");
  await field(dialog, "Cognome").fill("Rossi");
  await dialog.getByLabel(/^Data di nascita/).fill(MINOR_BIRTH_DATE);
  const guardian = dialog.getByRole("group", { name: "Genitore o tutore" });
  await field(guardian, "Nome").fill("Elena");
  await field(guardian, "Cognome").fill("Rossi");
  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();

  await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Prova Rossi" })).toBeVisible();
  await expect(page.getByText("Minore", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Il richiamo si cambia dal Riepilogo e la scheda lo rilegge.
  await expect(page.getByText("Nessun richiamo previsto.")).toBeVisible();
  await page.getByRole("button", { name: "Cambia" }).click();
  const recall = page.getByRole("dialog", { name: "Richiamo" });
  await recall.getByRole("radio", { name: "8 settimane" }).click();
  await recall.getByRole("button", { name: "Salva il richiamo" }).click();
  await expect(recall).toHaveCount(0);
  await expect(page.getByText("Ogni 8 settimane")).toBeVisible();

  // Archivia chiede conferma col nome; "Torna indietro" restituisce il focus al pulsante del menu.
  const menu = page.getByRole("button", { name: "Altre azioni" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Archivia" }).click();
  const archive = page.getByRole("alertdialog", { name: "Archiviare Prova Rossi?" });
  await expect(archive.getByText("Il paziente esce da liste e ricerche. Lo ritrovi in Archiviati.")).toBeVisible();
  await archive.getByRole("button", { name: "Torna indietro" }).click();
  await expect(archive).toHaveCount(0);
  await expect(menu).toBeFocused();

  // Confermata, la scheda resta con l'etichetta e senza "Nuovo appuntamento" (un archiviato non ne ha di nuovi);
  // Ripristina toglie l'etichetta e riporta il pulsante, senza conferma.
  await expect(page.getByRole("button", { name: "Nuovo appuntamento" })).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Archivia" }).click();
  await archive.getByRole("button", { name: "Archivia" }).click();
  await expect(archive).toHaveCount(0);
  await expect(page.getByText("Archiviato", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuovo appuntamento" })).toHaveCount(0);
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Archivia" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Ripristina" }).click();
  await expect(page.getByText("Archiviato", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nuovo appuntamento" })).toBeVisible();

  await deleteOpenPatient(page, "Prova Rossi");
});
