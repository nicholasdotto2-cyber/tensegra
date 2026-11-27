import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { createOwnPatientWithSession } from "./support/own-patient";

// Le foto posturali della Cartella sulla demo dei
// test: seed creato il 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Giulia Ferrante ha le quattro
// sagome del seed, che qui si guardano soltanto. I caricamenti stanno su «Foto Prova», un
// paziente inventato che `beforeAll` crea dall'interfaccia: ogni test ne carica e le toglie,
// e se uno fallisce a metà l'afterEach toglie quelle che restano, così gli altri file non vedono
// niente. I due file di prova sono inventati: una sagoma disegnata su un canvas e un testo; mai la foto di una
// persona. I byte restano in `web/.data/e2e/files/`, fuori da git, e il reset che parte con il server dei test li
// cancella.

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const PHOTO = path.join(FIXTURES, "foto-prova.jpg");
const NOT_A_PHOTO = path.join(FIXTURES, "non-foto.jpg");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FILE_URL = new RegExp(`^/api/files/${UUID}$`);

const OWN = { firstName: "Foto", lastName: "Prova" } as const;
let ownPatientId = "";

test.beforeAll(async ({ browser }, testInfo) => {
  // Nuovo paziente, consensi firmati col mouse, prima visita di ieri fatta e "Non fatturare".
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
// L'indirizzo della vista Foto del paziente proprio, una volta aperta: serve alla pulizia. Mai quella di Giulia.
let photosUrl: string | null = null;

test.beforeEach(({ page }) => {
  consoleErrors = [];
  photosUrl = null;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  // Un'eccezione non gestita della pagina non passa dal canale "console".
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

// Prima la pulizia, poi il controllo della console: il paziente proprio non ha foto all'inizio, quindi ogni foto che
// trova è del test appena finito (o fallito).
test.afterEach(async ({ page }) => {
  if (photosUrl !== null) {
    await page.goto(photosUrl);
    await page.waitForLoadState("networkidle");
    while ((await removeButtons(page).count()) > 0) await removeFirstPhoto(page);
  }
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

/** Dalla scheda già aperta alla vista Foto, cliccando come fa chi la usa. */
async function openPhotosFrom(page: Page, fullName: string): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: fullName })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.getByRole("navigation", { name: "Viste della cartella" }).getByRole("link", { name: "Foto" }).click();
  await expect(page).toHaveURL(/\?tab=cartella&vista=foto$/);
  await expect(photos(page).getByRole("heading", { level: 2, name: "Foto" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** La vista Foto del paziente proprio, dove i test caricano e tolgono. */
async function openPhotos(page: Page): Promise<void> {
  await page.goto(`/pazienti/${ownPatientId}`);
  await page.waitForLoadState("networkidle");
  await openPhotosFrom(page, `${OWN.firstName} ${OWN.lastName}`);
  photosUrl = page.url();
}

/** Dalla lista alla vista Foto di Giulia, solo per guardare: la pulizia non la tocca. */
async function openGiuliaPhotos(page: Page): Promise<void> {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Ferrante Giulia" }).click();
  await openPhotosFrom(page, "Giulia Ferrante");
}

/** La vista Foto (non il riquadro «Ultimi allegati»). */
function photos(page: Page): Locator {
  return page.getByRole("region", { name: "Foto", exact: true });
}

function removeButtons(page: Page): Locator {
  return photos(page).getByRole("button", { name: /^Togli la foto/ });
}

/** «Togli la foto» sulla prima miniatura, con la conferma; poi aspetta che la miniatura sparisca. */
async function removeFirstPhoto(page: Page): Promise<void> {
  const before = await removeButtons(page).count();
  await removeButtons(page).first().click();
  const confirm = page.getByRole("alertdialog", { name: "Togliere la foto?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Togli la foto", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(removeButtons(page)).toHaveCount(before - 1);
}

async function openUploadDialog(page: Page): Promise<Locator> {
  await photos(page).getByRole("button", { name: "Carica foto" }).click();
  const dialog = page.getByRole("dialog", { name: "Carica foto" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Il campo «Foto» del dialogo: l'etichetta porta anche "(obbligatorio)". */
function fileField(dialog: Locator): Locator {
  return dialog.getByLabel(/^Foto/);
}

test("si carica una foto posteriore, compare la miniatura, il doppione e un file che non è una foto sono rifiutati, e si toglie", async ({
  page,
}) => {
  await openPhotos(page);
  await expect(photos(page).getByText("Nessuna foto.")).toBeVisible();

  const dialog = await openUploadDialog(page);
  await expect(dialog.getByText("Inquadra dal collo in giù quando il volto non serve")).toBeVisible();
  // Il primo campo ha il focus, la data riparte da oggi e la didascalia è facoltativa.
  await expect(fileField(dialog)).toBeFocused();
  await expect(dialog.getByLabel("Data")).toHaveValue("2026-11-04");

  // Con il file ma senza la vista, «Salva» dice quale scelta manca e porta il focus sulla prima vista.
  await fileField(dialog).setInputFiles(PHOTO);
  await dialog.getByRole("button", { name: "Salva" }).click();
  await expect(dialog.getByText("Scegli la vista.")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Anteriore" })).toBeFocused();

  // La vista scelta: la foto si salva, il dialogo si chiude e la miniatura compare con la vista e la data.
  await dialog.getByRole("radio", { name: "Posteriore" }).click();
  const thumbnail = page.waitForResponse((response) => FILE_URL.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Salva" }).click();
  await expect(dialog).toHaveCount(0);

  const tile = photos(page).getByRole("listitem");
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText("Posteriore");
  await expect(photos(page).getByRole("heading", { level: 3, name: "mer 4 nov" })).toBeVisible();
  const image = tile.getByRole("img");
  await expect(image).toHaveAttribute("src", FILE_URL);
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // Il browser ha ridisegnato la foto: sono le misure del file di prova, 400 x 600 (mai ingrandita).
  expect(await image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([400, 600]);

  // Il file si legge solo con la sessione, senza cache.
  const response = await thumbnail;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/jpeg");
  expect(response.headers()["cache-control"]).toBe("private, no-store");

  // Lo stesso file di nuovo: il dialogo resta aperto con il doppione sotto il campo del file.
  const again = await openUploadDialog(page);
  await fileField(again).setInputFiles(PHOTO);
  await again.getByRole("radio", { name: "Posteriore" }).click();
  await again.getByRole("button", { name: "Salva" }).click();
  await expect(again.getByText("Questa foto è già nella cartella del 04/11")).toBeVisible();
  await expect(fileField(again)).toBeFocused();
  await expect(fileField(again)).toHaveAttribute("aria-invalid", "true");

  // Un testo con il nome di una foto: il browser non lo legge come immagine e nessuna miniatura nasce.
  await fileField(again).setInputFiles(NOT_A_PHOTO);
  await again.getByRole("button", { name: "Salva" }).click();
  await expect(again.getByText("Il file non è un'immagine JPEG, PNG o WebP.")).toBeVisible();

  // «Torna indietro» chiude senza salvare e il focus torna a «Carica foto»; né il doppione né il testo hanno
  // fatto nascere una miniatura (con il dialogo aperto la pagina sotto è nascosta ai lettori di schermo).
  await again.getByRole("button", { name: "Torna indietro" }).click();
  await expect(again).toHaveCount(0);
  await expect(photos(page).getByRole("listitem")).toHaveCount(1);
  await expect(photos(page).getByRole("button", { name: "Carica foto" })).toBeFocused();

  // Con una sola foto posteriore il confronto dice cosa manca.
  await photos(page).getByRole("button", { name: "Confronta" }).click();
  await expect(photos(page).getByText("Serve una seconda foto della stessa vista.")).toBeVisible();

  // «Togli la foto»: «Torna indietro» la lascia, la conferma la toglie.
  await photos(page).getByRole("button", { name: /^Togli la foto/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Togliere la foto?" });
  await confirm.getByRole("button", { name: "Torna indietro" }).click();
  await expect(photos(page).getByRole("listitem")).toHaveCount(1);
  await removeFirstPhoto(page);
  await expect(photos(page).getByRole("img")).toHaveCount(0);
  await expect(photos(page).getByText("Nessuna foto.")).toBeVisible();
  // La pagina non ha più il pulsante che ha aperto la conferma: il focus va al titolo della vista.
  await expect(photos(page).getByRole("heading", { level: 2, name: "Foto" })).toBeFocused();
});

test("due foto della stessa vista si confrontano affiancate o sovrapposte con opacità, linea a piombo e griglia", async ({
  page,
}) => {
  await openPhotos(page);

  // La prima foto: il file di prova, oggi.
  const first = await openUploadDialog(page);
  await fileField(first).setInputFiles(PHOTO);
  await first.getByRole("radio", { name: "Posteriore" }).click();
  await first.getByRole("button", { name: "Salva" }).click();
  await expect(first).toHaveCount(0);
  await expect(photos(page).getByRole("listitem")).toHaveCount(1);

  // La seconda, il 2/11: un PNG disegnato qui (un'altra sagoma, quindi un altro sha256), con la didascalia.
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 450;
    const c = canvas.getContext("2d");
    if (c === null) throw new Error("Canvas non disponibile");
    c.fillStyle = "#f3efe6";
    c.fillRect(0, 0, 300, 450);
    c.fillStyle = "#7a5c3e";
    c.fillRect(90, 110, 130, 190);
    c.fillRect(100, 300, 40, 110);
    c.fillRect(160, 300, 40, 110);
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
  });
  const second = await openUploadDialog(page);
  await fileField(second).setInputFiles({ name: "seconda.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await second.getByRole("radio", { name: "Posteriore" }).click();
  await second.getByLabel("Data").fill("2026-11-02");
  await second.getByLabel("Didascalia").fill("Prima del trattamento");
  await second.getByRole("button", { name: "Salva" }).click();
  await expect(second).toHaveCount(0);
  await expect(photos(page).getByRole("listitem")).toHaveCount(2);
  // Per data, la più recente in alto; la didascalia sta sotto la miniatura.
  await expect(photos(page).getByRole("heading", { level: 3 })).toHaveText(["mer 4 nov", "lun 2 nov"]);
  await expect(photos(page).getByText("Prima del trattamento")).toBeVisible();

  await photos(page).getByRole("button", { name: "Confronta" }).click();
  const compare = photos(page).getByRole("region", { name: "Confronto" });
  await expect(compare).toBeVisible();
  // La coppia predefinita è la prima foto e l'ultima della vista, affiancate.
  await expect(compare.getByRole("combobox", { name: "Vista" })).toContainText("Posteriore");
  await expect(compare.getByRole("combobox", { name: "Prima foto" })).toContainText("lun 2 nov");
  await expect(compare.getByRole("combobox", { name: "Seconda foto" })).toContainText("mer 4 nov");
  await expect(compare.getByRole("img")).toHaveCount(2);
  await expect(compare.getByRole("button", { name: "Affiancate" })).toHaveAttribute("aria-pressed", "true");
  await expect(compare.getByLabel("Opacità")).toHaveCount(0);

  // Sovrapposte: compare il cursore dell'opacità e la seconda foto prende il valore.
  await compare.getByRole("button", { name: "Sovrapposte" }).click();
  await expect(compare.getByRole("button", { name: "Sovrapposte" })).toHaveAttribute("aria-pressed", "true");
  const opacity = compare.getByLabel("Opacità");
  await expect(opacity).toHaveAttribute("type", "range");
  await opacity.fill("30");
  await expect(opacity).toHaveValue("30");
  await expect(compare.getByRole("img").last()).toHaveCSS("opacity", "0.3");

  // Linea a piombo e griglia si accendono e si spengono; il colore non è l'unico segnale (aria-pressed).
  const plumb = compare.getByRole("button", { name: "Linea a piombo" });
  const grid = compare.getByRole("button", { name: "Griglia" });
  await expect(plumb).toHaveAttribute("aria-pressed", "false");
  await expect(compare.locator("[data-guide='plumb']")).toHaveCount(0);
  await plumb.click();
  await expect(plumb).toHaveAttribute("aria-pressed", "true");
  await expect(compare.locator("[data-guide='plumb']")).toHaveCount(1);
  await grid.click();
  await expect(grid).toHaveAttribute("aria-pressed", "true");
  await expect(compare.locator("[data-guide='grid']")).toHaveCount(1);
  await plumb.click();
  await expect(compare.locator("[data-guide='plumb']")).toHaveCount(0);

  // Tolta la foto più vecchia, la coppia non c'è più e il confronto lo dice.
  await photos(page).getByRole("listitem").filter({ hasText: "Prima del trattamento" }).getByRole("button", { name: /^Togli la foto/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Togliere la foto?" });
  await confirm.getByRole("button", { name: "Togli la foto", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(photos(page).getByRole("listitem")).toHaveCount(1);
  await expect(compare.getByText("Serve una seconda foto della stessa vista.")).toBeVisible();
});

test("foto_del_seed: Giulia ha le quattro sagome e il confronto affianca le due anteriori", async ({ page }) => {
  await openGiuliaPhotos(page);

  // Due serie, anteriore e laterale destra, alla prima visita (D0-35) e all'ultima seduta fatta (D0-10, una
  // domenica che il seed porta al sabato): la più recente in alto.
  const tiles = photos(page).getByRole("listitem");
  await expect(tiles).toHaveCount(4);
  await expect(photos(page).getByRole("heading", { level: 3 })).toHaveText(["sab 24 ott", "mer 30 set"]);
  await expect(tiles.filter({ hasText: "Anteriore" })).toHaveCount(2);
  await expect(tiles.filter({ hasText: "Laterale destra" })).toHaveCount(2);
  for (const image of await tiles.getByRole("img").all()) {
    await expect(image).toHaveAttribute("src", FILE_URL);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }

  // Il confronto parte dalla prima vista con due foto, l'anteriore: la prima e l'ultima, affiancate. Nessun
  // pulsante che scrive viene premuto.
  await photos(page).getByRole("button", { name: "Confronta" }).click();
  const compare = photos(page).getByRole("region", { name: "Confronto" });
  await expect(compare).toBeVisible();
  await expect(compare.getByRole("combobox", { name: "Vista" })).toContainText("Anteriore");
  await expect(compare.getByRole("combobox", { name: "Prima foto" })).toContainText("mer 30 set");
  await expect(compare.getByRole("combobox", { name: "Seconda foto" })).toContainText("sab 24 ott");
  await expect(compare.getByRole("button", { name: "Affiancate" })).toHaveAttribute("aria-pressed", "true");
  const pair = compare.getByRole("img");
  await expect(pair).toHaveCount(2);
  for (const image of await pair.all()) {
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }
});
