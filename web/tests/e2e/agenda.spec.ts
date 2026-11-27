import { expect, type Locator, type Page, test } from "@playwright/test";

// La griglia dell'agenda sulla demo dei test: D0 = mercoledì
// 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Sola lettura: niente qui
// cambia i dati, e i conteggi e gli stati letti sono dei blocchi del seed di giovedì 5/11, che nessun e2e cambia:
// messaggi.spec, che gira dopo, aggiunge al 5/11 alle 20:00 un appuntamento suo e lo annulla. Del 4/11 si
// leggono solo colore e altezza, che un blocco segnato come fatto dalla demo tiene.

// Il campo della data in italiano: giorno, mese, anno.
test.use({ locale: "it-IT" });

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

/** Il blocco di un paziente: il nome accessibile è «09:00-09:45, Bellandi Marco, Seduta osteopatica, Confermato». */
function block(page: Page, patient: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^\\d{2}:\\d{2}-\\d{2}:\\d{2}, ${patient}, `) });
}

async function heightOf(locator: Locator): Promise<number | undefined> {
  return (await locator.boundingBox())?.height;
}

test("senza parametri mostra la settimana di oggi con i giorni, i blocchi e i colori delle prestazioni", async ({ page }) => {
  await page.goto("/agenda");

  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("button", { name: "2-7 novembre 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settimana", pressed: true })).toBeVisible();
  // Da lunedì a sabato: la domenica del seed è chiusa e senza appuntamenti.
  await expect(page.locator("[data-day]")).toHaveCount(6);
  await expect(page.getByText("gio 5 · 3", { exact: true })).toBeVisible();

  // Prima visita 60 minuti in ocra, seduta 45 in petrolio, controllo 30 in salvia: un'ora è alta 96 px.
  const sofia = block(page, "Rinaldi Sofia");
  const marco = block(page, "Bellandi Marco");
  const anna = block(page, "Morelli Anna");
  await expect(sofia).toHaveAttribute("data-color", "ocra");
  await expect(marco).toHaveAttribute("data-color", "petrolio");
  await expect(anna).toHaveAttribute("data-color", "salvia");
  expect(await heightOf(sofia)).toBe(96);
  expect(await heightOf(marco)).toBe(72);
  expect(await heightOf(anna)).toBe(48);
  // Nome accessibile e stato scritto su Chiara Valli, seduta confermata del 5/11: Marco Bellandi del 4/11
  // diventa "Fatto" nel passo 4 della demo.
  const chiara = block(page, "Valli Chiara");
  await expect(chiara).toHaveAccessibleName("09:30-10:15, Valli Chiara, Seduta osteopatica, Confermato");
  await expect(chiara.getByText("Confermato", { exact: true })).toBeVisible();

  // La linea dell'ora sta nella colonna di oggi, con il suo testo per i lettori di schermo.
  await expect(page.locator('[data-day="2026-11-04"] [data-slot="now-line"]')).toHaveText("Ora attuale: 08:30");
  await expect(page.locator('[data-slot="now-line"]')).toHaveCount(1);
});

test('la pausa pranzo è una fascia "Chiuso" fra le 13:00 e le 14:30', async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  const column = page.locator('[data-day="2026-11-04"]');
  const bands = column.locator('[data-slot="closed-band"]');
  // Nella finestra 08:00-20:30: prima delle 09:00, la pausa, dopo le 19:30.
  await expect(bands).toHaveCount(3);
  const lunch = bands.nth(1);
  await expect(lunch).toHaveText("Chiuso");
  const columnBox = await column.boundingBox();
  const lunchBox = await lunch.boundingBox();
  // 13:00 è 5 ore dopo l'inizio della finestra (5 x 96 px), la pausa dura un'ora e mezza.
  expect((lunchBox?.y ?? 0) - (columnBox?.y ?? 0)).toBe(480);
  expect(lunchBox?.height).toBe(144);
});

test('gli annullati sono nascosti nella settimana e compaiono con "Mostra annullati"', async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  await expect(block(page, "Bellandi Marco")).toBeVisible();
  await expect(block(page, "Sala Giorgio")).toHaveCount(0);

  const toggle = page.getByRole("switch", { name: "Mostra annullati" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();

  await expect(page).toHaveURL(/[?&]annullati=1(&|$)/);
  const giorgio = block(page, "Sala Giorgio");
  await expect(giorgio).toBeVisible();
  await expect(giorgio).toHaveAccessibleName(/, Annullato$/);
  await expect(giorgio).toHaveAttribute("data-status", "annullato");
  await expect(page.getByRole("switch", { name: "Mostra annullati" })).toHaveAttribute("aria-checked", "true");
});

test("con il focus su Settimana successiva le frecce cambiano settimana e il focus resta", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  const next = page.getByRole("link", { name: "Settimana successiva" });
  await next.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page).toHaveURL(/[?&]data=2026-11-11(&|$)/);
  await expect(page.getByRole("button", { name: "9-14 novembre 2026" })).toBeVisible();
  await expect(next).toBeFocused();

  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/[?&]data=2026-11-04(&|$)/);
  await expect(page.getByRole("button", { name: "2-7 novembre 2026" })).toBeVisible();
});

test("Giorno porta alla vista del giorno", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  await page.getByRole("button", { name: "Giorno" }).click();

  await expect(page).toHaveURL(/[?&]vista=giorno(&|$)/);
  await expect(page).toHaveURL(/[?&]data=2026-11-04(&|$)/);
  await expect(page.getByRole("button", { name: "mercoledì 4 novembre 2026" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Giorno", pressed: true })).toBeVisible();
  await expect(page.locator("[data-day]")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Giorno successivo" })).toBeVisible();
  // "Mostra annullati" vale solo per la settimana.
  await expect(page.getByRole("switch", { name: "Mostra annullati" })).toHaveCount(0);
});

test("scrivere solo il giorno nella data non cambia pagina, ed Esc lascia la data com'era", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  const dateButton = page.getByRole("button", { name: "2-7 novembre 2026" });
  await dateButton.click();
  const field = page.getByLabel("Data", { exact: true });
  await expect(field).toBeFocused();

  // 10/11/2026 è già una data valida, ma il mese e l'anno possono ancora cambiare: la pagina resta dov'è
  // anche dopo una pausa (WCAG 3.2.2).
  await page.keyboard.type("10");
  await expect(field).toHaveValue("2026-11-10");
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/[?&]data=2026-11-04(&|$)/);
  await expect(field).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();
  await expect(dateButton).toBeFocused();
  await expect(page).toHaveURL(/[?&]data=2026-11-04(&|$)/);

  // Riaperto, il campo torna al giorno della pagina.
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("2026-11-04");
});

test("Invio, un clic fuori dal calendario o Tab portano alla data scritta", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");
  const field = page.getByLabel("Data", { exact: true });
  // Il focus passa al campo appena dopo l'apertura: si scrive solo quando c'è.
  const openDate = async (label: string) => {
    await page.getByRole("button", { name: label }).click();
    await expect(field).toBeFocused();
  };

  await openDate("2-7 novembre 2026");
  await page.keyboard.type("10");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]data=2026-11-10(&|$)/);
  await expect(field).toBeHidden();
  await expect(page.getByRole("button", { name: "9-14 novembre 2026" })).toBeFocused();

  await openDate("9-14 novembre 2026");
  await page.keyboard.type("18");
  await page.getByRole("heading", { level: 1, name: "Agenda" }).click();
  await expect(page).toHaveURL(/[?&]data=2026-11-18(&|$)/);
  await expect(page.getByRole("button", { name: "16-21 novembre 2026" })).toBeVisible();

  await openDate("16-21 novembre 2026");
  await page.keyboard.type("25");
  // Tab passa prima per i segmenti del campo (quanti dipende dal browser), poi esce dal calendario.
  const inDateField = () => page.evaluate(() => document.activeElement?.getAttribute("type") === "date");
  for (let presses = 0; presses < 5 && (await inDateField()); presses += 1) {
    await expect(page).toHaveURL(/[?&]data=2026-11-18(&|$)/);
    await page.keyboard.press("Tab");
  }
  await expect(page).toHaveURL(/[?&]data=2026-11-25(&|$)/);
  await expect(page.getByRole("button", { name: "23-28 novembre 2026" })).toBeVisible();
});

/** Quanto di un testo del blocco si vede e quanto è lungo intero, in px. */
async function widths(locator: Locator): Promise<{ shown: number; full: number }> {
  return locator.evaluate((element) => ({ shown: element.clientWidth, full: element.scrollWidth }));
}

test("in un blocco stretto cede prima la prestazione e lo stato resta scritto", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");

  // Il seed non ha blocchi affiancati, quindi la larghezza si impone sul blocco. Morelli Anna è un
  // controllo da 30 minuti: il nome sulla prima riga, prestazione e stato sulla seconda. Il controllo non
  // dipende dallo stato del blocco.
  const anna = block(page, "Morelli Anna");
  const patient = anna.locator('[data-slot="block-patient"]');
  const service = anna.locator('[data-slot="block-service"]');
  const status = anna.locator('[data-slot="block-status"]');

  // 110 px, la colonna più stretta della settimana: lo stato resta intero e si accorcia la prestazione.
  await anna.evaluate((element) => (element.style.width = "110px"));
  const wideStatus = await widths(status);
  expect(wideStatus.shown).toBe(wideStatus.full);
  const wideService = await widths(service);
  expect(wideService.shown).toBeLessThan(wideService.full);

  // 73 px, due blocchi affiancati in una colonna di 150 px (1280 px con la sidebar aperta): lo stato si
  // accorcia coi puntini solo dopo che la prestazione ha ceduto tutto, e non sparisce.
  await anna.evaluate((element) => (element.style.width = "73px"));
  const narrowStatus = await widths(status);
  if (narrowStatus.shown < narrowStatus.full) expect((await widths(service)).shown).toBe(0);
  expect(narrowStatus.shown).toBeGreaterThan(0);
  await expect(status).toBeVisible();
  await expect(patient).toBeVisible();
});

test("gli avvisi del dialogo stanno in una regione aria-live che c'è già prima dell'avviso (WCAG 4.1.3)", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Nuovo appuntamento" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(dialog).toBeVisible();

  // Un lettore di schermo annuncia solo i cambi dentro una regione che esisteva già: prima nessun avviso.
  const region = dialog.locator('[aria-live="polite"][data-slot="time-warnings"]');
  await expect(region).toHaveCount(1);
  await region.evaluate((element) => Reflect.set(element, "__stessaRegione", true));

  // Giovedì 5/11 alle 09:30 c'è Chiara Valli fino alle 10:15: l'avviso arriva nella stessa regione.
  await dialog.getByLabel("Data", { exact: true }).fill("2026-11-05");
  await dialog.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "09:30", exact: true }).click();
  await expect(region).toContainText("Si sovrappone a Valli Chiara, 09:30-10:15.");
  expect(await region.evaluate((element) => Reflect.get(element, "__stessaRegione"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});


/**
 * Un clic fuori, poi il pannello è ancora aperto finita l'animazione di uscita (100-200 ms): durante
 * l'uscita il pannello resta visibile, quindi si guarda dopo.
 */
async function stillOpenAfterOutsideClick(page: Page, panel: Locator): Promise<void> {
  await page.mouse.click(10, 400);
  await page.waitForTimeout(500);
  await expect(panel).toBeVisible();
}

test("un clic fuori dal dialogo non butta via un appuntamento iniziato; Esc chiude", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");
  const opener = page.getByRole("button", { name: "Nuovo appuntamento" }).first();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });

  // Senza modifiche un clic fuori chiude, come prima.
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 400);
  await expect(dialog).toBeHidden();

  // Con le note scritte il clic fuori non fa niente; Esc chiude.
  await opener.click();
  await dialog.getByLabel("Note").fill("Porta la risonanza");
  await stillOpenAfterOutsideClick(page, dialog);
  await expect(dialog.getByLabel("Note")).toHaveValue("Porta la risonanza");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Anche una scelta da un elenco conta come modifica; "Annulla" chiude.
  await opener.click();
  await dialog.getByLabel("Durata").click();
  await page.getByRole("option", { name: "60 min" }).click();
  await stillOpenAfterOutsideClick(page, dialog);
  await dialog.getByRole("button", { name: "Annulla" }).click();
  await expect(dialog).toBeHidden();
});
