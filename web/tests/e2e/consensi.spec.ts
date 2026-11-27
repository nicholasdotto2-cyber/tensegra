import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type Route, test } from "@playwright/test";

// La raccolta dei consensi dalla tab Consensi sulla demo dei test: D0 =
// mercoledì 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Ogni test crea il suo paziente adulto,
// che resta: un paziente con un consenso non si elimina (niente si cancella). Nessun appuntamento cade negli
// 8 giorni di «Consensi mancanti» di Oggi, così i conteggi della demo non cambiano; anche il minore, che ha un
// appuntamento, resta. Il test dei dati mancanti
// toglie il numero di polizza e lo rimette anche se fallisce a metà. La firma è disegnata col mouse, a piccoli
// passi: la tela tiene un punto ogni 16 ms.
test.describe.configure({ mode: "serial" });

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SCAN = path.join(FIXTURES, "foto-prova.jpg");

const INFORMATIVA = "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)";
const TRATTAMENTO = "Consenso informato al trattamento osteopatico";
const WHATSAPP = "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp.";
const RICHIAMI = "Acconsento a essere ricontattato/a per i controlli periodici.";
const INCOMPLETE = "La firma sembra incompleta. Firma di nuovo.";
const BOTH_CHOICES = "Indica entrambe le scelte.";
const PDF_NOT_CREATED = "Firma salvata, ma il PDF non è stato creato. Riprova a crearlo.";
const POLICY = "RC-0000-DEMO";
const EMPTY = "Nessun consenso raccolto.";
const NO_GUARDIAN = "Per un minore serve un genitore con responsabilità genitoriale o un tutore: aggiungilo nell'anagrafica.";
const SECOND_GUARDIAN = "Compila il nome e la firma del secondo genitore.";
const DOCUMENT_URL = /\/api\/consensi\/[0-9a-f-]{36}\/documento$/;

let consoleErrors: string[] = [];
let policyCleared = false;

test.beforeEach(({ page }) => {
  consoleErrors = [];
  policyCleared = false;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

// Il numero di polizza torna quello del seed, così gli altri file lo trovano.
test.afterEach(async ({ page }) => {
  if (policyCleared) await setPolicyNumber(page, POLICY);
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

function field(scope: Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${label}`));
}

async function setPolicyNumber(page: Page, value: string): Promise<void> {
  await page.goto("/impostazioni/iscrizione-e-polizza");
  await page.waitForLoadState("networkidle");
  const main = page.locator("main#contenuto");
  await main.getByRole("textbox", { name: /^Numero di polizza/ }).fill(value);
  await main.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
}

/** Un paziente adulto nuovo dalla lista; resta aperta la sua scheda. */
async function createPatient(page: Page, firstName: string, lastName: string): Promise<void> {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill(firstName);
  await field(dialog, "Cognome").fill(lastName);
  await field(dialog, "Data di nascita").fill("1980-03-10");
  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${firstName} ${lastName}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function openConsents(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Consensi" }).click();
  await expect(page).toHaveURL(/tab=consensi/);
  await page.waitForLoadState("networkidle");
}

/**
 * La misura vera della tela: il dialogo si apre con un'animazione (zoom-in-95, 100 ms) che la scala per un
 * momento, e una misura presa durante l'apertura esce più piccola di 560.
 */
async function settledBox(canvas: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await canvas.evaluate((element) =>
    Promise.all(
      (element.closest('[role="dialog"]') ?? element)
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("Tela non visibile.");
  return box;
}

/** Tratti orizzontali col mouse, da 20 punti ciascuno, a righe diverse della tela. */
async function draw(page: Page, canvas: Locator, strokes: number): Promise<void> {
  // Nel dialogo lungo del minore la tela può stare sotto i 720 px della finestra: prima si porta in vista.
  await canvas.scrollIntoViewIfNeeded();
  const box = await settledBox(canvas);
  for (let s = 0; s < strokes; s++) {
    const y = box.y + 60 + s * 40;
    // Il tratto parte sulla tela, non sul piede fisso del dialogo o fuori dalla finestra.
    const start = { x: box.x + 40, y };
    expect(await canvas.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, start)).toBe(true);
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 40 + i * 12, y + (i % 2 === 0 ? 4 : -4));
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
  }
}

/** I pixel disegnati della tela: zero se è vuota. */
async function inkedPixels(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) => {
    const c = element as HTMLCanvasElement;
    const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data ?? new Uint8ClampedArray();
    let inked = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) inked++;
    return inked;
  });
}

async function answer(dialog: Locator, statement: string, option: "Sì" | "No"): Promise<void> {
  await dialog.getByRole("radiogroup", { name: statement }).getByRole("radio", { name: option }).click();
}

/** La risposta della Server Action di firma con `pdfReady` false: il PDF «non si è creato», la firma sì. */
async function failPdfOnce(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() !== "POST" || request.headers()["next-action"] === undefined) return route.continue();
  const response = await route.fetch();
  const body = await response.text();
  const headers = { ...response.headers() };
  delete headers["content-length"];
  await route.fulfill({ response, headers, body: body.replace('"pdfReady":true', '"pdfReady":false') });
}

test("tela_e_dialogo: firma col mouse, Cancella, scelte senza risposta, PDF da rifare e Esc", async ({ page }) => {
  await createPatient(page, "Tela", "Consenso");
  await openConsents(page);

  // Esc chiude senza salvare e il focus torna al pulsante.
  const launcher = page.getByRole("button", { name: "Raccogli l'informativa" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: INFORMATIVA });
  await expect(dialog.getByRole("region", { name: "Testo del modulo" })).toContainText(
    "Testo di esempio, da far verificare prima dell'uso con pazienti reali.",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(page.getByText(EMPTY)).toBeVisible();

  await launcher.click();
  await expect(dialog.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Tela Consenso");
  const sign = dialog.getByRole("button", { name: "Firma e salva" });
  const canvas = dialog.getByRole("img", { name: "Firma di Tela Consenso" });
  await expect(sign).toBeDisabled();
  // La tela segue la densità dello schermo: le coordinate restano in pixel CSS.
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).width === Math.round(560 * window.devicePixelRatio))).toBe(true);
  const box = await settledBox(canvas);
  expect(box.width).toBeGreaterThanOrEqual(560);
  expect(box.height).toBeGreaterThanOrEqual(200);

  // Un tratto solo non basta.
  await draw(page, canvas, 1);
  await expect(sign).toBeEnabled();
  await sign.click();
  await expect(dialog.getByText(INCOMPLETE)).toBeVisible();

  // «Cancella firma» svuota la tela e spegne di nuovo «Firma e salva».
  await dialog.getByRole("button", { name: "Cancella firma" }).click();
  await expect(sign).toBeDisabled();
  expect(await inkedPixels(canvas)).toBe(0);

  // Due tratti da 20 punti: la firma basta, e resta dopo un cambio di misura della finestra.
  await draw(page, canvas, 2);
  const inked = await inkedPixels(canvas);
  expect(inked).toBeGreaterThan(0);
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(sign).toBeEnabled();
  expect(await inkedPixels(canvas)).toBe(inked);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(await inkedPixels(canvas)).toBe(inked);

  // Le due scelte partono senza risposta: senza tutte e due non si salva.
  for (const statement of [WHATSAPP, RICHIAMI]) {
    await expect(dialog.getByRole("radiogroup", { name: statement }).getByRole("radio", { checked: true })).toHaveCount(0);
  }
  await sign.click();
  await expect(dialog.getByText(BOTH_CHOICES)).toBeVisible();
  await answer(dialog, WHATSAPP, "No");
  await expect(dialog.getByText(BOTH_CHOICES)).toHaveCount(0);
  await sign.click();
  await expect(dialog.getByText(BOTH_CHOICES)).toBeVisible();
  await answer(dialog, RICHIAMI, "Sì");

  // Il PDF non si crea: la firma è salvata e si riprova senza la tela.
  await page.route("**/pazienti/**", failPdfOnce);
  await sign.click();
  await expect(dialog.getByText(PDF_NOT_CREATED)).toBeVisible();
  await expect(canvas).toHaveCount(0);
  await page.unroute("**/pazienti/**", failPdfOnce);
  const created = page.waitForResponse((response) => DOCUMENT_URL.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Riprova a crearlo" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("PDF creato.")).toBeVisible();

  // Una sola riga: l'informativa valida.
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Valido");
});

test("caricamento: Stampa il modulo senza righe, data futura rifiutata sul campo e avviso della carta", async ({ page }) => {
  await createPatient(page, "Carta", "Consenso");
  await openConsents(page);

  await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
  const dialog = page.getByRole("dialog", { name: INFORMATIVA });
  await dialog.getByRole("radio", { name: "Firma su carta e carico il modulo" }).click();
  await expect(dialog.getByText("Conserva l'originale di carta.")).toBeVisible();

  // Il modulo da firmare a mano: un PDF, nessun consenso registrato.
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Stampa il modulo" }).click();
  expect((await downloaded).suggestedFilename()).toBe("modulo-da-firmare.pdf");

  await answer(dialog, WHATSAPP, "Sì");
  await answer(dialog, RICHIAMI, "No");
  await field(dialog, "Modulo firmato").setInputFiles(SCAN);

  // Domani è nel futuro: il comando lo rifiuta e la frase sta sotto la data, col focus.
  const signedOn = field(dialog, "Data della firma");
  await signedOn.fill("2026-11-05");
  const upload = dialog.getByRole("button", { name: "Carica il modulo firmato" });
  await upload.click();
  await expect(dialog.getByText("La data della firma non può essere nel futuro.")).toBeVisible();
  await expect(signedOn).toBeFocused();
  await expect(signedOn).toHaveAttribute("aria-invalid", "true");

  // Cambiata la data, la frase sparisce e il modulo si salva.
  await signedOn.fill("2026-11-03");
  await expect(dialog.getByText("La data della firma non può essere nel futuro.")).toHaveCount(0);
  await upload.click();
  await expect(dialog).toBeHidden();

  // Una sola riga, quella del caricamento: la stampa non ha registrato niente.
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("03/11/2026");
  await expect(rows.nth(1)).toContainText("Valido");
});

test("mancanti: senza polizza e codice fiscale l'anteprima li elenca con i link e la firma resta possibile", async ({
  page,
}) => {
  policyCleared = true;
  await setPolicyNumber(page, "");

  // Un adulto con tutti i dati del modulo tranne il codice fiscale.
  await createPatient(page, "Dati", "Mancanti");
  const patientUrl = page.url();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Anagrafica" }).click();
  await expect(page).toHaveURL(/tab=anagrafica/);
  const personal = page.getByRole("region", { name: "Dati personali" });
  await field(personal, "Luogo di nascita").fill("Bologna");
  await personal.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const address = page.getByRole("region", { name: "Indirizzo (per la fattura)" });
  await field(address, "Indirizzo").fill("Via della Prova 3");
  await field(address, "CAP").fill("40100");
  await field(address, "Città").fill("Bologna");
  await field(address, "Provincia").fill("BO");
  await address.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const doctors = page.getByRole("region", { name: "Medici" });
  await field(doctors, "Medico curante o pediatra").click();
  await page.getByRole("option", { name: /^Dott\. Luca Ferri/ }).click();
  await doctors.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.").first()).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Una prima visita il 20/11, fuori dagli 8 giorni di Oggi: apre il ciclo del consenso al trattamento.
  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(booking.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText("Prima visita osteopatica");
  await booking.getByLabel("Data", { exact: true }).fill("2026-11-20");
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "10:00", exact: true }).click();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(booking).toBeHidden();

  await openConsents(page);
  const launcher = page.getByRole("button", { name: "Raccogli il consenso al trattamento" });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: TRATTAMENTO });
  await expect(dialog.getByText("Mancano: numero di polizza, codice fiscale del paziente", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "numero di polizza" })).toHaveAttribute("href", "/impostazioni/iscrizione-e-polizza");
  await expect(dialog.getByRole("link", { name: "codice fiscale del paziente" })).toHaveAttribute(
    "href",
    /\/pazienti\/[0-9a-f-]{36}\?tab=anagrafica$/,
  );
  await expect(dialog.getByRole("region", { name: "Testo del modulo" })).toContainText("________");

  // I dati mancanti non fermano la firma.
  const sign = dialog.getByRole("button", { name: "Firma e salva" });
  await draw(page, dialog.getByRole("img", { name: "Firma di Dati Mancanti" }), 2);
  await expect(sign).toBeEnabled();

  // Esc non salva niente e restituisce il focus.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(page.getByText(EMPTY)).toBeVisible();
});

test("minore: senza genitore con responsabilità il motivo giusto; la seconda firma tolta col nome non parte", async ({
  page,
}) => {
  // Il genitore del dialogo nasce «altro»: non può firmare per il minore.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const create = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(create, "Nome").fill("Minore");
  await field(create, "Cognome").fill("Consenso");
  await field(create, "Data di nascita").fill("2017-06-15");
  const newGuardian = create.getByRole("group", { name: "Genitore o tutore" });
  await field(newGuardian, "Nome").fill("Elena");
  await field(newGuardian, "Cognome").fill("Consenso");
  await create.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Minore Consenso" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const patientUrl = page.url().replace(/\?.*$/, "");

  await openConsents(page);
  const informativa = page.getByRole("button", { name: "Raccogli l'informativa" });
  const treatment = page.getByRole("button", { name: "Raccogli il consenso al trattamento" });
  await expect(informativa).toBeDisabled();
  await expect(treatment).toBeDisabled();
  await expect(informativa).toHaveAccessibleDescription(NO_GUARDIAN);
  await expect(treatment).toHaveAccessibleDescription(NO_GUARDIAN);
  await expect(page.getByText("fissa prima un appuntamento")).toHaveCount(0);

  // Elena diventa la madre (con l'indirizzo dell'intestatario) e una prima visita il 20/11 apre il ciclo.
  await page.goto(`${patientUrl}?tab=anagrafica`);
  await page.waitForLoadState("networkidle");
  const mother = page.getByRole("region", { name: "Genitori o tutori" }).getByRole("form", { name: /Elena Consenso/ });
  await field(mother, "Relazione").click();
  await page.getByRole("option", { name: "Madre" }).click();
  await field(mother, "Indirizzo").fill("Via della Prova 5");
  await field(mother, "CAP").fill("40100");
  await field(mother, "Città").fill("Bologna");
  await field(mother, "Provincia").fill("BO");
  await mother.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.").last()).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Data", { exact: true }).fill("2026-11-20");
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "11:00", exact: true }).click();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(booking).toBeHidden();

  await openConsents(page);
  await treatment.click();
  const dialog = page.getByRole("dialog", { name: "Consenso informato al trattamento osteopatico di persona minore" });
  await expect(dialog.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Elena Consenso");

  // Nome e firma del secondo genitore, poi il nome tolto: la tela sparisce e la sua firma con lei.
  const second = field(dialog, "Secondo genitore");
  await second.fill("Marco Consenso");
  const secondCanvas = dialog.getByRole("img", { name: "Firma del secondo genitore" });
  await draw(page, secondCanvas, 2);
  await second.fill("");
  await expect(secondCanvas).toHaveCount(0);
  // Il nome di nuovo: una tela nuova e vuota.
  await second.fill("Marco Consenso");
  await expect(secondCanvas).toHaveAttribute("data-empty", "true");

  // Firmata solo la tela principale: la seconda firma manca, la vecchia non parte di nascosto.
  await draw(page, dialog.getByRole("img", { name: "Firma di Elena Consenso" }), 2);
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog.getByText(SECOND_GUARDIAN)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByText(EMPTY)).toBeVisible();
});

// La raccolta senza ciclo aperto e lo storico della tab Consensi.

const NO_CYCLE = "Il consenso al trattamento si raccoglie per un ciclo: fissa prima un appuntamento.";

test("nuovo_senza_appuntamenti: senza ciclo aperto il trattamento è spento col motivo, l'informativa no; anche a ciclo chiuso", async ({
  page,
}) => {
  await createPatient(page, "Senza", "Ciclo");
  await openConsents(page);
  await expect(page.getByText(EMPTY)).toBeVisible();
  const informativa = page.getByRole("button", { name: "Raccogli l'informativa" });
  const treatment = page.getByRole("button", { name: "Raccogli il consenso al trattamento" });
  await expect(informativa).toBeEnabled();
  await expect(treatment).toBeDisabled();
  await expect(treatment).toHaveAccessibleDescription(NO_CYCLE);
  await expect(page.getByText(NO_CYCLE)).toBeVisible();

  // Davide (seed) ha il ciclo chiuso: si guarda soltanto, senza scaricare né raccogliere niente.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Conti Davide" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Davide Conti" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await openConsents(page);
  await expect(informativa).toBeEnabled();
  await expect(treatment).toBeDisabled();
  await expect(treatment).toHaveAccessibleDescription(NO_CYCLE);
  // Il consenso del ciclo chiuso resta nello storico, ma non si raccoglie di nuovo per quel ciclo.
  const treatmentRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: /^Consenso al trattamento/ }) });
  await expect(treatmentRow).toHaveCount(1);
  await expect(treatmentRow.getByRole("button", { name: "Raccogli di nuovo" })).toBeDisabled();
  await expect(treatmentRow.getByText(NO_CYCLE)).toBeVisible();
  const informativaRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: /^Informativa/ }) });
  await expect(informativaRow.getByRole("button", { name: "Raccogli di nuovo" })).toBeEnabled();
});

/** Il file scaricato da un link della riga: un PDF vero, col nome senza il paziente. */
async function expectPdfDownload(page: Page, link: Locator): Promise<void> {
  const downloaded = page.waitForEvent("download");
  await link.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("consenso-2026-11-04.pdf");
  const bytes = await readFile((await download.path()) ?? "");
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1024);
}

test("storico_ui: vuoto, azioni della riga, PDF vero, revoca con una conferma, raccolta nuova e versione storica", async ({
  page,
}) => {
  await createPatient(page, "Storico", "Consenso");
  const patientUrl = page.url();
  await openConsents(page);
  await expect(page.getByText(EMPTY)).toBeVisible();

  // Una prima visita il 20/11, fuori dagli 8 giorni di Oggi: apre il ciclo del consenso al trattamento.
  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Data", { exact: true }).fill("2026-11-20");
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "12:00", exact: true }).click();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(booking).toBeHidden();

  // Il consenso firmato sulla tela: un adulto nuovo senza codice fiscale, quindi con dati mancanti.
  await openConsents(page);
  await page.getByRole("button", { name: "Raccogli il consenso al trattamento" }).click();
  const dialog = page.getByRole("dialog", { name: TRATTAMENTO });
  await draw(page, dialog.getByRole("img", { name: "Firma di Storico Consenso" }), 2);
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog).toBeHidden();

  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(2);
  const first = rows.nth(1);
  for (const text of ["Consenso al trattamento", "2026.1", "04/11/2026", "Firma sulla tela", "Valido"]) {
    await expect(first).toContainText(text);
  }
  await expect(first.getByText("Firmato con dati mancanti", { exact: true })).toBeVisible();
  const download = first.getByRole("link", { name: "Scarica PDF" });
  await expect(download).toBeVisible();
  await expect(first.getByRole("button", { name: "Registra revoca" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Raccogli di nuovo" })).toBeEnabled();

  // «Scarica PDF» scarica il PDF della firma (se mancasse, la route lo crea).
  await expectPdfDownload(page, download);

  // La revoca: data di oggi già scritta, modalità, una sola conferma.
  await first.getByRole("button", { name: "Registra revoca" }).click();
  const revoke = page.getByRole("alertdialog", { name: "Registrare la revoca?" });
  await expect(revoke.getByLabel("Data della revoca")).toHaveValue("2026-11-04");
  // Senza modalità non si registra niente.
  await revoke.getByRole("button", { name: "Registra revoca" }).click();
  await expect(revoke.getByText("Indica come è arrivata la revoca.")).toBeVisible();
  await revoke.getByRole("radio", { name: "Per iscritto" }).click();
  await expect(revoke.getByText("Indica come è arrivata la revoca.")).toHaveCount(0);
  await revoke.getByRole("button", { name: "Registra revoca" }).click();
  await expect(revoke).toBeHidden();
  await expect(rows).toHaveCount(2);
  await expect(first).toContainText("Revocato il 04/11/2026");
  await expect(first.getByRole("button", { name: "Registra revoca" })).toHaveCount(0);

  // «Raccogli di nuovo»: un documento nuovo, il revocato resta nello storico.
  await first.getByRole("button", { name: "Raccogli di nuovo" }).click();
  await expect(dialog).toBeVisible();
  await draw(page, dialog.getByRole("img", { name: "Firma di Storico Consenso" }), 2);
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Valido");
  const historic = rows.nth(2);
  await expect(historic).toContainText("Revocato il 04/11/2026");
  // Solo l'ultimo documento del modulo si raccoglie di nuovo; lo storico resta scaricabile.
  await expect(historic.getByRole("button", { name: "Raccogli di nuovo" })).toHaveCount(0);
  await expect(rows.nth(1).getByRole("button", { name: "Raccogli di nuovo" })).toBeEnabled();
  await expectPdfDownload(page, historic.getByRole("link", { name: "Scarica PDF" }));
});

// La revoca di una scelta, «Raccogli» da Oggi e «Raccogli ora» nel pannello "Seduta fatta".

const WHATSAPP_LINE = "Promemoria e comunicazioni su WhatsApp";
const RICHIAMI_LINE = "Ricontatto per i controlli periodici";
const MINORE = "Consenso informato al trattamento osteopatico di persona minore";
const SINGLE_GUARDIAN = /^Io sottoscritto\/a dichiaro che l'altro genitore è informato e d'accordo/;
const CONSENT_MISSING = "Manca il consenso al trattamento per questo ciclo.";

/** Firma sulla tela l'informativa dalla tab Consensi: sì a WhatsApp, no ai richiami. */
async function signInformativa(page: Page, signer: string): Promise<void> {
  await openConsents(page);
  await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
  const dialog = page.getByRole("dialog", { name: INFORMATIVA });
  await answer(dialog, WHATSAPP, "Sì");
  await answer(dialog, RICHIAMI, "No");
  await draw(page, dialog.getByRole("img", { name: `Firma di ${signer}` }), 2);
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog).toBeHidden();
}

test("revoca_scelta: solo una scelta valida si revoca, data di oggi, modalità obbligatoria, errore del server sul campo", async ({
  page,
}) => {
  await createPatient(page, "Scelte", "Consenso");
  await signInformativa(page, "Scelte Consenso");

  const choices = page.getByRole("region", { name: "Scelte dell'informativa" });
  const whatsapp = choices.getByRole("listitem").filter({ hasText: WHATSAPP_LINE });
  const richiami = choices.getByRole("listitem").filter({ hasText: RICHIAMI_LINE });
  await expect(whatsapp).toHaveText(new RegExp(`^${WHATSAPP_LINE}: Sì, dal 04/11/2026`));
  await expect(richiami).toHaveText(`${RICHIAMI_LINE}: No, dal 04/11/2026`);
  // Un «No» non si revoca: il pulsante c'è solo per la scelta valida.
  await expect(richiami.getByRole("button", { name: "Revoca la scelta" })).toHaveCount(0);

  const revokeChoice = whatsapp.getByRole("button", { name: "Revoca la scelta" });
  await revokeChoice.click();
  const dialog = page.getByRole("alertdialog", { name: "Registrare la revoca della scelta?" });
  const day = dialog.getByLabel("Data della revoca");
  await expect(day).toHaveValue("2026-11-04");
  // Senza modalità non parte niente.
  await dialog.getByRole("button", { name: "Registra revoca" }).click();
  await expect(dialog.getByText("Indica come è arrivata la revoca.")).toBeVisible();
  await dialog.getByRole("radio", { name: "Con un messaggio" }).click();

  // Prima del sì del 4/11: il comando rifiuta e la frase sta sotto la data, col focus.
  await day.fill("2026-11-03");
  await dialog.getByRole("button", { name: "Registra revoca" }).click();
  await expect(dialog.getByText("La revoca non può avere una data precedente al consenso del 04/11/2026.")).toBeVisible();
  await expect(day).toBeFocused();
  await expect(day).toHaveAttribute("aria-invalid", "true");
  await day.fill("2026-11-04");
  await expect(dialog.getByText("La revoca non può avere una data precedente al consenso del 04/11/2026.")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Registra revoca" }).click();
  await expect(dialog).toBeHidden();

  await expect(whatsapp).toHaveText(`${WHATSAPP_LINE}: No, dal 04/11/2026`);
  await expect(whatsapp.getByRole("button", { name: "Revoca la scelta" })).toHaveCount(0);
  // La scelta si revoca da sola: il documento dell'informativa resta valido.
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Valido");
});

test("raccogli_da_oggi: prima il consenso del genitore, la riga resta con «Informativa», poi esce; il focus torna", async ({
  page,
}) => {
  // Un minore proprio, con la madre di contatto e una prima visita l'11/11 alle 12:00: dentro gli 8 giorni di Oggi, fuori
  // da oggi e da domani. Firmati i due moduli la riga esce, così il conteggio di demo.spec non cambia.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const create = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(create, "Nome").fill("Oggi");
  await field(create, "Cognome").fill("Consenso");
  await field(create, "Data di nascita").fill("2017-06-15");
  const newGuardian = create.getByRole("group", { name: "Genitore o tutore" });
  await field(newGuardian, "Nome").fill("Elena");
  await field(newGuardian, "Cognome").fill("Oggi");
  await create.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Oggi Consenso" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const patientUrl = page.url().replace(/\?.*$/, "");

  await page.goto(`${patientUrl}?tab=anagrafica`);
  await page.waitForLoadState("networkidle");
  const mother = page.getByRole("region", { name: "Genitori o tutori" }).getByRole("form", { name: /Elena Oggi/ });
  await field(mother, "Relazione").click();
  await page.getByRole("option", { name: "Madre" }).click();
  await field(mother, "Indirizzo").fill("Via della Prova 7");
  await field(mother, "CAP").fill("40100");
  await field(mother, "Città").fill("Bologna");
  await field(mother, "Provincia").fill("BO");
  await mother.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.").last()).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Data", { exact: true }).fill("2026-11-11");
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "12:00", exact: true }).click();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(booking).toBeHidden();

  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const block = page.getByRole("region", { name: /^Consensi mancanti/ });
  const row = block.getByRole("listitem").filter({ hasText: "Oggi Consenso" });
  await expect(row).toContainText("Informativa e consenso del genitore");
  await expect(row).toContainText("mer 11 nov alle 12:00");
  const collect = row.getByRole("button", { name: "Raccogli", exact: true });

  // Primo modulo: il consenso del genitore per il ciclo dell'appuntamento, firmato dalla madre.
  await collect.click();
  const treatment = page.getByRole("dialog", { name: MINORE });
  await expect(treatment.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Elena Oggi");
  await treatment.getByRole("checkbox", { name: SINGLE_GUARDIAN }).click();
  await draw(page, treatment.getByRole("img", { name: "Firma di Elena Oggi" }), 2);
  await treatment.getByRole("button", { name: "Firma e salva" }).click();
  await expect(treatment).toBeHidden();
  // La riga resta, con il secondo modulo da raccogliere a parte; il focus torna al suo «Raccogli».
  await expect(row.getByText("Informativa", { exact: true })).toBeVisible();
  await expect(collect).toBeFocused();

  // Secondo modulo: l'informativa, poi la riga esce.
  await collect.click();
  const informativa = page.getByRole("dialog", { name: INFORMATIVA });
  await expect(informativa.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Elena Oggi");
  await answer(informativa, WHATSAPP, "No");
  await answer(informativa, RICHIAMI, "No");
  await draw(page, informativa.getByRole("img", { name: "Firma di Elena Oggi" }), 2);
  await informativa.getByRole("button", { name: "Firma e salva" }).click();
  await expect(informativa).toBeHidden();
  await expect(row).toHaveCount(0);
});

test("raccogli_ora: il pannello Seduta fatta resta aperto, il banner sparisce, i passi non cambiano, Esc rende il focus", async ({
  page,
}) => {
  // Un adulto proprio con l'informativa; la prima visita di giovedì 8/10 alle 13:00, già passata, segnata come fatta.
  await createPatient(page, "Pannello", "Consenso");
  const patientUrl = page.url();
  await signInformativa(page, "Pannello Consenso");
  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Data", { exact: true }).fill("2026-10-08");
  await booking.getByLabel("Ora di inizio").click();
  // Alle 13:00 l'anteprima dice «Fuori dagli orari dello studio.»: è arrivata, e con lei la domanda sull'orario.
  await page.getByRole("option", { name: "13:00", exact: true }).click();
  await expect(booking.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await booking.getByRole("button", { name: /^Salva(?: comunque)?$/ }).click();
  await page
    .getByRole("alertdialog", { name: "L'orario è già passato. Lo segno già come fatto?" })
    .getByRole("button", { name: "Sì, è fatto" })
    .click();
  const panel = page.getByRole("dialog", { name: "Seduta fatta: Pannello Consenso" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(CONSENT_MISSING)).toBeVisible();
  await page.waitForLoadState("networkidle");
  const steps = panel.locator('[data-slot="step-status"]');
  await expect(steps).toHaveCount(3);
  const before = await steps.allTextContents();

  // Esc chiude il dialogo di raccolta senza salvare e rende il focus a «Raccogli ora»; il pannello resta.
  const collectNow = panel.getByRole("button", { name: "Raccogli ora" });
  await collectNow.click();
  const dialog = page.getByRole("dialog", { name: TRATTAMENTO });
  await expect(dialog.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Pannello Consenso");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(collectNow).toBeFocused();
  await expect(panel).toBeVisible();

  // Firmato sopra il pannello: il pannello resta, il banner sparisce, i passi sono quelli di prima.
  await collectNow.click();
  await draw(page, dialog.getByRole("img", { name: "Firma di Pannello Consenso" }), 2);
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(panel.getByText(CONSENT_MISSING)).toHaveCount(0);
  expect(await steps.allTextContents()).toEqual(before);

  // Pulizia per i file dopo questo: la seduta torna non fatta e si elimina, così Oggi non conta un'altra fattura da
  // emettere (demo.spec). Il consenso resta, come ogni consenso.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.goto("/agenda?vista=giorno&data=2026-10-08");
  await page.waitForLoadState("networkidle");
  const appointment = page.locator('[data-day="2026-10-08"]').getByRole("button", { name: /^13:00-14:00, Consenso Pannello, / });
  await appointment.click();
  const detail = page.getByRole("dialog", { name: "Pannello Consenso", exact: true });
  await detail.getByRole("button", { name: "Annulla 'fatto'" }).click();
  await expect(detail.getByRole("button", { name: "Elimina" })).toBeVisible();
  await detail.getByRole("button", { name: "Elimina" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Eliminare l'appuntamento?" });
  await confirm.getByRole("button", { name: "Elimina" }).click();
  await expect(detail).toBeHidden();
  await expect(appointment).toHaveCount(0);
});
