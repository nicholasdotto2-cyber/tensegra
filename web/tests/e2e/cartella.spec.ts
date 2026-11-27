import { expect, type Page, test } from "@playwright/test";

import { createOwnPatientWithSession } from "./support/own-patient";

// La tab Cartella sulla demo dei test: 15 pazienti, seed creato il 4/11/2026 alle
// 08:30 (APP_FIXED_NOW in playwright.config.ts). Sola lettura: ogni finestra si chiude con
// Esc o "Torna indietro" senza salvare, e nessun pulsante che scrive viene premuto ("Compila ora" e il
// salvataggio di "Nuova visita" creerebbero righe nel database che condividono gli altri file). Francesca
// Longo ha il ciclo «Cefalea tensiva» aperto, la prima visita del D0-14 chiusa (dolore 5, rotazione cervicale
// attiva 60° dx e 65° sx), nessuna attività PSFS, nessun rinvio e nessun allegato; nessun file la
// cambia. La «Seduta senza visita» sta su «Cartella Prova», un paziente inventato che `beforeAll` crea
// dall'interfaccia e che nessun test apre in modifica.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const OWN = { firstName: "Cartella", lastName: "Prova" } as const;
let ownPatientId = "";

test.beforeAll(async ({ browser }, testInfo) => {
  // Nuovo paziente, consensi firmati col mouse, prima visita di ieri fatta senza visita e "Non fatturare".
  test.setTimeout(120_000);
  const { baseURL, locale, timezoneId } = testInfo.project.use;
  const page = await browser.newPage({ baseURL, locale, timezoneId });
  try {
    ownPatientId = (await createOwnPatientWithSession(page, OWN)).patientId;
  } finally {
    await page.close();
  }
});

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

/** Dalla lista alla Cartella di Francesca, cliccando come fa chi la usa. */
async function openCartella(page: Page): Promise<void> {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Longo Francesca" }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Francesca Longo" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await expect(page.getByRole("heading", { level: 2, name: "Ciclo aperto" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("la Cartella di Francesca ha la testata, il ciclo aperto, la cronologia e i riquadri laterali", async ({ page }) => {
  await openCartella(page);

  // Testata: l'età, i consensi del ciclo e nessun medico curante (la rubrica di Francesca è vuota).
  const head = page.getByRole("region", { name: "Testata della cartella" });
  await expect(head.getByText("41 anni")).toBeVisible();
  await expect(head.getByText("In regola")).toBeVisible();
  await expect(page.getByText("Medico curante")).toHaveCount(0);

  // Ciclo aperto: titolo con il mese, sedute fatte su previste.
  const cycle = page.getByRole("region", { name: "Ciclo aperto" });
  await expect(cycle.getByText(/^Cefalea tensiva, /)).toBeVisible();
  await expect(cycle.getByText("Seduta 1 di 4")).toBeVisible();

  // Cronologia: il ciclo con la prima visita chiusa del seed, non più una «Seduta senza visita».
  const history = page.getByRole("region", { name: "Cronologia" });
  await expect(history.getByRole("heading", { level: 3, name: /^Cefalea tensiva, / })).toBeVisible();
  await expect(history.getByText("Aperto", { exact: true })).toBeVisible();
  const session = history.getByRole("listitem").filter({ hasText: "Prima visita" });
  await expect(session).toHaveCount(1);
  await expect(session).toContainText("mer 21 ott");
  await expect(session).toContainText("5 → non rilevato");
  await expect(session.getByText("Chiusa", { exact: true })).toBeVisible();
  await expect(session.getByRole("link", { name: "Vedi la visita" })).toBeVisible();
  await expect(history.getByText("Seduta senza visita")).toHaveCount(0);
  await expect(history.getByText("Visita da compilare")).toHaveCount(0);
  await expect(history.getByRole("button", { name: "Compila ora" })).toHaveCount(0);

  // Riquadri laterali: vuoti, ciascuno con la sua frase.
  const rinvii = page.getByRole("region", { name: "Rinvii al medico" });
  await expect(rinvii.getByText("Nessun rinvio.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Ultimi allegati" }).getByText("Nessun allegato.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Richiamo" }).getByText("Nessun richiamo previsto.")).toBeVisible();

  // Azioni: "Nuovo rinvio" c'è (il paziente ha un ciclo), "Carica foto" sta nella vista Foto.
  await expect(page.getByRole("button", { name: "Nuova visita" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chiudi ciclo", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuovo rinvio" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Carica foto" })).toHaveCount(0);
});

test("la Cartella del paziente proprio mostra la seduta di ieri come «Seduta senza visita» con «Compila ora»", async ({ page }) => {
  await page.goto(`/pazienti/${ownPatientId}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: `${OWN.firstName} ${OWN.lastName}` })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");

  // Il ciclo nato dall'agenda ha il titolo provvisorio; la prima visita di ieri è fatta e mai compilata.
  const history = page.getByRole("region", { name: "Cronologia" });
  await expect(history.getByRole("heading", { level: 3, name: "Nuovo ciclo, novembre 2026" })).toBeVisible();
  await expect(history.getByText("Aperto", { exact: true })).toBeVisible();
  const session = history.getByRole("listitem").filter({ hasText: "Seduta senza visita" });
  await expect(session).toHaveCount(1);
  await expect(session).toContainText("mar 3 nov");
  await expect(session.getByText("Visita da compilare")).toBeVisible();
  await expect(session.getByRole("button", { name: "Compila ora" })).toBeVisible();
  // I consensi del ciclo sono firmati: la testata lo dice.
  await expect(page.getByRole("region", { name: "Testata della cartella" }).getByText("In regola")).toBeVisible();
});

test("conteggi_demo_intatti: dopo il paziente proprio Oggi ha ancora 2 fatture da emettere e 2 consensi mancanti", async ({
  page,
}) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("region", { name: "Fatture da emettere (2)" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Consensi mancanti (2)" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Fatture da emettere (2)" }).getByText("Cartella Prova")).toHaveCount(0);
});

test("le sotto-viste della Cartella sono link e il parametro «vista» sta nell'URL", async ({ page }) => {
  await openCartella(page);
  const views = page.getByRole("navigation", { name: "Viste della cartella" });
  await expect(views.getByRole("link", { name: "Cronologia" })).toHaveAttribute("aria-current", "page");

  await views.getByRole("link", { name: "Test nel tempo" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=test$/);
  await expect(views.getByRole("link", { name: "Test nel tempo" })).toHaveAttribute("aria-current", "page");
  // La rotazione cervicale attiva della prima visita, una riga per lato.
  const rotation = (side: string) => page.getByRole("row").filter({ hasText: `Rotazione cervicale attiva ${side}` });
  await expect(rotation("dx").getByRole("cell").nth(0)).toHaveText("60°");
  await expect(rotation("sx").getByRole("cell").nth(0)).toHaveText("65°");
  // I filtri «Ciclo» e «Regione» ci sono e scrivono nell'URL: la cervicale ha la rotazione, la lombare nessun test.
  await expect(page.getByRole("combobox", { name: "Ciclo" })).toContainText("Cefalea tensiva");
  await page.getByRole("combobox", { name: "Regione" }).click();
  await page.getByRole("option", { name: "Cervicale" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=test&ciclo=[0-9a-f-]+&regione=cervical$/);
  await expect(rotation("dx")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Regione" }).click();
  await page.getByRole("option", { name: "Lombare" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=test&ciclo=[0-9a-f-]+&regione=lumbar$/);
  await expect(page.getByText("Nessun test misurato in questa regione.")).toBeVisible();
  await page.getByRole("navigation", { name: "Viste della cartella" }).getByRole("link", { name: "Foto" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=foto$/);
  await page.getByRole("navigation", { name: "Viste della cartella" }).getByRole("link", { name: "Test nel tempo" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=test$/);

  await views.getByRole("link", { name: "Foto" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=foto$/);
  await expect(views.getByRole("link", { name: "Foto" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Nessuna foto.")).toBeVisible();
  // Il caricamento c'è; questo file non lo preme: lo prova foto.spec.ts.
  await expect(page.getByRole("button", { name: "Carica foto" })).toBeVisible();

  // Un valore sconosciuto torna alla Cronologia.
  await page.goto(`${page.url().split("?")[0] ?? ""}?tab=cartella&vista=boh`);
  await expect(page.getByRole("navigation", { name: "Viste della cartella" }).getByRole("link", { name: "Cronologia" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("«Chiudi ciclo» mostra le cinque scelte di esito e le cadenze con la data, e Esc non scrive", async ({ page }) => {
  await openCartella(page);
  await page.getByRole("button", { name: "Chiudi ciclo", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Chiudi ciclo" });
  await expect(dialog).toBeVisible();

  const outcomes = dialog.getByRole("group", { name: "Esito del ciclo" });
  for (const label of [
    "Obiettivo raggiunto",
    "Raggiunto in parte",
    "Non raggiunto",
    "Interrotto dal paziente",
    "Rinviato al medico",
  ]) {
    await expect(outcomes.getByRole("button", { name: label, exact: true })).toBeVisible();
    await expect(outcomes.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "false");
  }

  // Nessuna attività PSFS: niente punteggi e niente «Paziente non tornato».
  await expect(dialog.getByText("Paziente non tornato")).toHaveCount(0);
  await expect(dialog.getByText("Attività importanti per il paziente (PSFS)")).toHaveCount(0);

  // Le cadenze con la data in chiaro accanto alla scelta: l'ultimo fatto è il 21/10/2026.
  const cadence = dialog.getByRole("radiogroup", { name: "Richiamo" });
  await expect(cadence.getByRole("radio", { name: /^4 settimane/ })).toHaveAccessibleName("4 settimane Richiamo il 18/11/2026");
  await expect(cadence.getByRole("radio", { name: /^6 settimane/ })).toHaveAccessibleName("6 settimane Richiamo il 02/12/2026");
  await expect(cadence.getByRole("radio", { name: /^8 settimane/ })).toHaveAccessibleName("8 settimane Richiamo il 16/12/2026");
  await expect(cadence.getByRole("radio", { name: /^12 settimane/ })).toHaveAccessibleName("12 settimane Richiamo il 13/01/2027");
  await expect(cadence.getByRole("radio", { name: "Altra" })).toBeVisible();
  await expect(cadence.getByRole("radio", { name: "Nessun richiamo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Chiudi ciclo", exact: true })).toBeVisible();

  // Esc chiude senza scrivere: il ciclo resta aperto e il focus torna al pulsante che aveva aperto la finestra.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Chiudi ciclo", exact: true })).toBeFocused();
  await expect(page.getByRole("region", { name: "Cronologia" }).getByText("Aperto", { exact: true })).toBeVisible();
});

test("«Nuova visita» apre «Nuovo appuntamento» già fatto, con l'ora 08:30, e Esc non salva", async ({ page }) => {
  await openCartella(page);
  await page.getByRole("button", { name: "Nuova visita" }).click();

  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: /^Paziente/ })).toHaveValue("Longo Francesca");
  await expect(dialog.getByLabel("Data")).toHaveValue("2026-11-04");
  await expect(dialog.getByRole("combobox", { name: "Ora di inizio" })).toContainText("08:30");
  // Al posto della domanda sull'orario passato, una frase.
  await expect(dialog.getByText("L'appuntamento nasce già fatto.")).toBeVisible();
  await expect(dialog.getByText("L'orario è già passato.")).toHaveCount(0);
  // Lo stato è deciso dal pulsante: la scelta Prenotato/Confermato non si offre.
  await expect(dialog.getByRole("radio", { name: "Prenotato" })).toHaveCount(0);
  await expect(dialog.getByLabel("Data")).toHaveAttribute("max", "2026-11-04");

  // Un giorno futuro non può nascere fatto: lo dice il campo e il focus ci va; nessuna scrittura parte.
  await dialog.getByLabel("Data").fill("2026-11-05");
  await dialog.getByRole("button", { name: /^Salva/ }).click();
  const day = dialog.getByLabel("Data");
  await expect(dialog.getByText("Un appuntamento già fatto non può essere in un giorno futuro.")).toBeVisible();
  await expect(day).toBeFocused();
  await expect(day).toHaveAccessibleDescription("Un appuntamento già fatto non può essere in un giorno futuro.");
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Nuova visita" })).toBeFocused();
});

test("«Modifica avviso» apre il campo «Avviso clinico» e «Torna indietro» lo chiude senza salvare", async ({ page }) => {
  await openCartella(page);
  const head = page.getByRole("region", { name: "Testata della cartella" });
  await expect(head.getByText("Nessun avviso clinico.")).toBeVisible();

  await head.getByRole("button", { name: "Modifica avviso" }).click();
  const dialog = page.getByRole("dialog", { name: "Modifica avviso" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Avviso clinico");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await field.fill("Scritto e non salvato");

  await dialog.getByRole("button", { name: "Torna indietro" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(head.getByRole("button", { name: "Modifica avviso" })).toBeFocused();
  await expect(head.getByText("Nessun avviso clinico.")).toBeVisible();
  await expect(page.getByText("Scritto e non salvato")).toHaveCount(0);

  // La finestra riparte da ciò che è salvato.
  await head.getByRole("button", { name: "Modifica avviso" }).click();
  await expect(page.getByRole("dialog", { name: "Modifica avviso" }).getByLabel("Avviso clinico")).toHaveValue("");
  await page.keyboard.press("Escape");
});

test("«Test nel tempo» di Giulia mostra la distanza dita-pavimento delle tre visite e la variazione", async ({ page }) => {
  // Giulia Ferrante ha tre visite chiuse nel ciclo aperto (seed della demo): 28, 18 e 10 cm.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Ferrante Giulia" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Giulia Ferrante" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.getByRole("navigation", { name: "Viste della cartella" }).getByRole("link", { name: "Test nel tempo" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=test$/);

  const row = page.getByRole("row").filter({ hasText: "Distanza dita-pavimento" });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole("cell");
  await expect(cells.nth(0)).toHaveText("28 cm");
  await expect(cells.nth(1)).toHaveText("18 cm");
  await expect(cells.nth(2)).toHaveText("10 cm");
  await expect(cells.nth(3)).toContainText("-18 cm");
});

test("«Chiudi il mantenimento» nel dialogo dell'appuntamento apre la chiusura del ciclo e Esc la chiude senza scrivere", async ({
  page,
}) => {
  // Anna Morelli ha un mantenimento aperto; nessun file lo chiude (il test non salva niente).
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Morelli Anna" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Anna Morelli" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  const service = dialog.getByRole("combobox", { name: /^Prestazione/ });
  // I default del paziente sono arrivati: un mantenimento aperto propone il Controllo, e il link non c'è.
  await expect(service).toContainText("Controllo");
  await expect(dialog.getByLabel(/^Ciclo/)).toHaveValue(/Lombalgia ricorrente/);
  await expect(dialog.getByRole("button", { name: "Chiudi il mantenimento" })).toHaveCount(0);

  // Con una prestazione che apre un ciclo di trattamento, prima si chiude il mantenimento.
  await service.click();
  await page.getByRole("option", { name: "Seduta osteopatica" }).click();
  const link = dialog.getByRole("button", { name: "Chiudi il mantenimento" });
  await expect(link).toBeVisible();
  await link.click();

  const close = page.getByRole("dialog", { name: "Chiudi ciclo" });
  await expect(close).toBeVisible();
  await expect(close.getByRole("group", { name: "Esito del ciclo" })).toBeVisible();
  // Un mantenimento non ha punteggi PSFS.
  await expect(close.getByText("Paziente non tornato")).toHaveCount(0);

  // Esc chiude solo la finestra annidata: il dialogo dell'appuntamento resta, con il link e il focus su di lui.
  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(link).toBeFocused();
  await expect(dialog.getByLabel(/^Ciclo/)).toHaveValue(/Lombalgia ricorrente/);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
