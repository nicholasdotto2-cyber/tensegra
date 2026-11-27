import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

// I richiami di Oggi e di Pazienti sulla demo dei test: seed del
// 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Il primo test legge soltanto la riga di Davide
// Conti (nessun clic che scrive) per l'avviso della demo accanto a ogni link WhatsApp, prima senza e poi con il
// numero per le prove, che torna vuoto alla fine. Il secondo crea il suo paziente adulto, Ettore Richiamo, con
// l'informativa caricata (sì a WhatsApp e ai richiami) e un fatto del 7/10: copia il richiamo, dichiara l'invio,
// lo rimanda e lo sospende. Il paziente resta con i richiami sospesi, quindi fuori da ogni lista «Da richiamare»;
// il suo fatto resta (niente si cancella) fra le sedute da fatturare e i consensi mancanti di Oggi, che i file
// dopo questo non contano. Nessun invio e nessuna rete: ogni apertura di wa.me è intercettata.
test.describe.configure({ mode: "serial" });

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SCAN = path.join(FIXTURES, "foto-prova.jpg");

const DEMO_NOTICE = "Dati di prova: il messaggio va al numero per le prove.";
const COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
const INFORMATIVA = "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)";
const WHATSAPP = "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp.";
const RICHIAMI = "Acconsento a essere ricontattato/a per i controlli periodici.";
const TEST_PHONE = "333 000 0099";
const WA_PAGE = { status: 200, contentType: "text/html", body: '<!doctype html><link rel="icon" href="data:,"><title>WhatsApp</title>' };

let consoleErrors: string[] = [];
let testPhoneSet = false;

test.beforeEach(async ({ page, context }) => {
  consoleErrors = [];
  testPhoneSet = false;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await context.route("https://wa.me/**", (route) => route.fulfill(WA_PAGE));
});

// Il numero per le prove torna vuoto, come nel seed, anche se il test si ferma a metà.
test.afterEach(async ({ page }) => {
  if (testPhoneSet) await setTestPhone(page, "");
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

function field(scope: Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${label}`));
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Il numero per le prove WhatsApp di Impostazioni, Dati di prova; vuoto lo toglie. */
async function setTestPhone(page: Page, phone: string): Promise<void> {
  await open(page, "/impostazioni/dati-di-prova");
  await page.getByLabel(/^Numero per le prove WhatsApp/).fill(phone);
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
}

function recallsOf(page: Page): Locator {
  return page.getByRole("region", { name: /^Da richiamare \(\d+\)$/ });
}

/** Ogni link WhatsApp in `scope` porta il prefisso atteso e ha accanto, e come descrizione, l'avviso della demo. */
async function expectDemoNotice(scope: Locator, prefix: string): Promise<void> {
  const anchors = scope.locator('a[href^="https://wa.me/"]');
  await expect(anchors).not.toHaveCount(0);
  for (const anchor of await anchors.all()) {
    await expect(anchor).toHaveText("Apri WhatsApp");
    expect(await anchor.getAttribute("href")).toMatch(new RegExp(`^${prefix.replace(/[.?/]/g, "\\$&")}`));
    await expect(anchor).toHaveAccessibleDescription(DEMO_NOTICE);
    await expect(anchor.locator("xpath=following-sibling::*[1]")).toHaveText(DEMO_NOTICE);
  }
}

/** La riga di Davide in Oggi e in Pazienti, filtro «Da richiamare»: ogni link ha il suo avviso. */
async function expectDavideNotices(page: Page, prefix: string): Promise<void> {
  await open(page, "/oggi");
  const today = recallsOf(page).getByRole("listitem").filter({ hasText: "Davide Conti" });
  await expect(today).toHaveCount(1);
  await expectDemoNotice(today, prefix);

  await open(page, "/pazienti?filtro=da_richiamare");
  const row = page.getByRole("row").filter({ hasText: "Conti Davide" });
  await expect(row).toHaveCount(1);
  await expectDemoNotice(row, prefix);
}

test("avviso_demo_riga_richiamo: accanto a ogni link WhatsApp della riga, in Oggi e in Pazienti, anche col numero per le prove", async ({
  page,
}) => {
  // Senza numero per le prove la demo apre WhatsApp senza destinatario, mai sul cellulare di Davide.
  await expectDavideNotices(page, "https://wa.me/?text=");

  testPhoneSet = true;
  await setTestPhone(page, TEST_PHONE);
  await expectDavideNotices(page, "https://wa.me/393330000099?text=");
});

/** Un paziente adulto nuovo dalla lista; resta aperta la sua scheda. */
async function createPatient(page: Page, firstName: string, lastName: string): Promise<void> {
  await open(page, "/pazienti");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill(firstName);
  await field(dialog, "Cognome").fill(lastName);
  await field(dialog, "Data di nascita").fill("1975-06-21");
  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${firstName} ${lastName}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function openTab(page: Page, name: "Consensi" | "Riepilogo"): Promise<void> {
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name }).click();
  await page.waitForLoadState("networkidle");
}

/** L'informativa firmata su carta il 5/10 e caricata, con il sì a WhatsApp e ai richiami. */
async function uploadInformativa(page: Page): Promise<void> {
  await openTab(page, "Consensi");
  await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
  const dialog = page.getByRole("dialog", { name: INFORMATIVA });
  await dialog.getByRole("radio", { name: "Firma su carta e carico il modulo" }).click();
  await dialog.getByRole("radiogroup", { name: WHATSAPP }).getByRole("radio", { name: "Sì" }).click();
  await dialog.getByRole("radiogroup", { name: RICHIAMI }).getByRole("radio", { name: "Sì" }).click();
  await field(dialog, "Modulo firmato").setInputFiles(SCAN);
  await field(dialog, "Data della firma").fill("2026-10-05");
  await dialog.getByRole("button", { name: "Carica il modulo firmato" }).click();
  await expect(dialog).toBeHidden();
}

/** La prima visita di mercoledì 7/10 alle 13:00, segnata come fatta dalla domanda sull'orario passato. */
async function bookDone(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(booking.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText(/\S/);
  await booking.getByLabel("Data", { exact: true }).fill("2026-10-07");
  await booking.getByLabel("Ora di inizio").click();
  // Alle 13:00 l'anteprima dice «Fuori dagli orari dello studio.»: è arrivata, e con lei la domanda sull'orario.
  await page.getByRole("option", { name: "13:00", exact: true }).click();
  await expect(booking.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await booking.getByRole("button", { name: /^Salva(?: comunque)?$/ }).click();
  await page
    .getByRole("alertdialog", { name: "L'orario è già passato. Lo segno già come fatto?" })
    .getByRole("button", { name: "Sì, è fatto" })
    .click();
  const done = page.getByRole("dialog", { name: `Seduta fatta: ${name}` });
  await expect(done).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(done).toBeHidden();
}

/** «Cambia» del Riepilogo con una delle scelte rapide. */
async function setCadence(page: Page, weeks: 4 | 6): Promise<void> {
  await openTab(page, "Riepilogo");
  await page.getByRole("button", { name: "Cambia" }).click();
  const dialog = page.getByRole("dialog", { name: "Richiamo" });
  await dialog.getByRole("radio", { name: `${weeks} settimane` }).click();
  await dialog.getByRole("button", { name: "Salva il richiamo" }).click();
  await expect(dialog).toHaveCount(0);
}

test("copia, invio dichiarato, rinvio e sospensione di un richiamo, in Oggi e in Pazienti", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createPatient(page, "Ettore", "Richiamo");
  const patientUrl = page.url();
  await uploadInformativa(page);
  await bookDone(page, "Ettore Richiamo");
  // 7/10 + 4 settimane = 4/11, oggi.
  await setCadence(page, 4);
  await expect(page.getByText("Scade oggi")).toBeVisible();

  // In Oggi: la riga con la scadenza, l'ultima seduta e le azioni. Senza cellulare WhatsApp resta fermo.
  await open(page, "/oggi");
  const row = recallsOf(page).getByRole("listitem").filter({ hasText: "Ettore Richiamo" });
  await expect(row).toContainText("Scade oggi");
  await expect(row).toContainText("Ultima seduta 07/10, ogni 4 settimane");
  await expect(row.getByRole("button", { name: "Apri WhatsApp" })).toBeDisabled();
  await expect(row.getByText("Numero mancante")).toBeVisible();

  // «Fissa appuntamento» apre il dialogo col paziente già scelto; Esc lo chiude senza salvare.
  await row.getByRole("button", { name: "Fissa appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(booking.getByLabel("Paziente")).toHaveValue("Richiamo Ettore");
  await page.keyboard.press("Escape");
  await expect(booking).toBeHidden();

  // «Copia» copia il testo preparato; la copia non è un invio: lo dichiara «Sì».
  await row.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(row.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/Ettore/);
  const question = row.getByRole("group", { name: "Hai inviato il messaggio?" });
  await expect(question).toBeVisible();
  await expect(row).not.toContainText("In attesa di risposta");
  await question.getByRole("button", { name: "Sì", exact: true }).click();
  // La conferma sta fuori dalla riga: dopo il sì la riga va in fondo e può uscire dalle 5 mostrate.
  await expect(recallsOf(page).getByRole("status", { name: "Esito del richiamo" })).toHaveText(
    "Richiamo di Ettore Richiamo: segnato come inviato.",
  );

  // In Pazienti la riga resta contata, in fondo con l'ordine dei richiami, «In attesa di risposta», con le stesse azioni.
  await open(page, "/pazienti?filtro=da_richiamare");
  const listRow = page.getByRole("row").filter({ hasText: "Richiamo Ettore" });
  await expect(page.getByRole("row").last()).toContainText("Richiamo Ettore");
  await expect(listRow).toContainText("In attesa di risposta");
  await expect(listRow.getByRole("button", { name: "Copia", exact: true })).toBeVisible();
  await expect(listRow.getByRole("button", { name: "Fissa appuntamento" })).toBeVisible();

  // «Rimanda di 2 settimane»: fuori da Oggi e da Pazienti; il Riepilogo non mostra una scadenza nuova.
  await listRow.getByRole("button", { name: "Altre azioni del richiamo di Ettore Richiamo" }).click();
  await page.getByRole("menuitem", { name: "Rimanda di 2 settimane" }).click();
  await expect(listRow).toHaveCount(0);
  await open(page, "/oggi");
  await expect(recallsOf(page).getByText("Ettore Richiamo")).toHaveCount(0);
  await open(page, patientUrl);
  const summary = page.getByRole("region", { name: "Richiamo" });
  await expect(summary).toContainText("Ogni 4 settimane");
  await expect(summary).not.toContainText("Scade oggi");

  // Una cadenza diversa azzera il rinvio: 7/10 + 6 settimane = 18/11, nei 30 giorni di Pazienti.
  await setCadence(page, 6);
  await expect(page.getByRole("region", { name: "Richiamo" })).toContainText("Fra 14 giorni");
  await open(page, "/pazienti?filtro=da_richiamare");
  const again = page.getByRole("row").filter({ hasText: "Richiamo Ettore" });
  await expect(again).toContainText("Fra 14 giorni");

  // «Sospendi i richiami» conserva la cadenza e toglie la riga.
  await again.getByRole("button", { name: "Altre azioni del richiamo di Ettore Richiamo" }).click();
  await page.getByRole("menuitem", { name: "Sospendi i richiami" }).click();
  await expect(again).toHaveCount(0);
  await open(page, patientUrl);
  const paused = page.getByRole("region", { name: "Richiamo" });
  await expect(paused).toContainText("Sospeso");
  await expect(paused).toContainText("Ogni 6 settimane");
});
