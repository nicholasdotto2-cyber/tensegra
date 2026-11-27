import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { validateFatturaXml } from "../support/xsd";

// L'editor della fattura sulla demo dei test: D0 = mercoledì 4/11/2026
// alle 08:30 (APP_FIXED_NOW). Il file viene dopo demo.spec.ts nell'ordine alfabetico ed emette solo per dati suoi
// (regola dei test e2e): il paziente «Prova Editor» senza codice fiscale, con l'indirizzo dall'Anagrafica e una
// seduta fatta ieri, e un committente. Il codice fiscale inventato (comune X999) arriva dal pannello, che lo salva
// anche in anagrafica. Paziente, fattura emessa e committente restano: fatture.spec.ts ("fattura-e" < "fatture")
// lavora sulla stessa seduta. Il file è seriale.
test.describe.configure({ mode: "serial" });

const TAX_CODE = "DTRPRV80A01X999Q";
const PARTY = "Committente Prova Editor";
const PARTY_VAT = "11111110000";
const YESTERDAY = "2026-11-03";
const YESTERDAY_SHORT = "mar 3 nov";
// La domanda «L'orario è già passato» arriva solo con l'anteprima, 300 ms dopo l'ultimo cambio: senza,
// "Salva" prenota senza chiedere. Alle 07:00, prima dell'apertura delle 09:00, l'anteprima porta l'avviso «Fuori dagli
// orari dello studio.», che dice che è arrivata (come in stati-appuntamento.spec.ts); dentro gli orari non c'è niente
// da aspettare sullo schermo.
const PAST_TIME = "07:00";

let consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

/** Il campo con l'etichetta data: le etichette possono portare anche "(obbligatorio)". */
function field(scope: Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${label}`));
}

/** La tab "Da emettere (N)" della pagina Fatture. */
function toInvoiceTab(page: Page): Locator {
  return page.getByRole("link", { name: /^Da emettere \(\d+\)$/ });
}

async function openNewInvoice(page: Page): Promise<Locator> {
  await page.goto("/fatture");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuova fattura" }).click();
  const panel = page.getByRole("dialog", { name: "Nuova fattura" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Riepilogo" })).toBeVisible();
  return panel;
}

async function choosePatient(page: Page, panel: Locator): Promise<void> {
  // "Paziente" è anche una scelta di "Intestata a": il campo di ricerca è la combobox.
  await panel.getByRole("combobox", { name: "Paziente" }).fill("Editor");
  await page.getByRole("option", { name: "Prova Editor" }).click();
}

test("il paziente Prova Editor con l'indirizzo e una seduta fatta ieri", async ({ page }) => {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill("Prova");
  await field(dialog, "Cognome").fill("Editor");
  await field(dialog, "Data di nascita").fill("1980-01-01");
  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Prova Editor" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Anagrafica" }).click();
  const address = page.getByRole("region", { name: "Indirizzo (per la fattura)" });
  await field(address, "Indirizzo").fill("Via della Prova 1");
  await field(address, "CAP").fill("40100");
  await field(address, "Città").fill("Bologna");
  await field(address, "Provincia").fill("BO");
  await address.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();

  await page.goto(`/agenda?vista=giorno&data=${YESTERDAY}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Paziente").fill("Editor");
  await page.getByRole("option", { name: "Editor Prova" }).click();
  await expect(booking.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText("Prima visita osteopatica");
  await booking.getByLabel("Data", { exact: true }).fill(YESTERDAY);
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: PAST_TIME, exact: true }).click();
  await expect(booking.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "L'orario è già passato. Lo segno già come fatto?" })
    .getByRole("button", { name: "Sì, è fatto" })
    .click();
  const done = page.getByRole("dialog", { name: "Seduta fatta: Prova Editor" });
  await expect(done).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(done).toBeHidden();
});

test("chiudere il pannello senza salvare non toglie la seduta da Fatture da emettere", async ({ page }) => {
  await page.goto("/fatture");
  await page.waitForLoadState("networkidle");
  const before = await toInvoiceTab(page).textContent();
  const panel = await openNewInvoice(page);
  await choosePatient(page, panel);
  await panel.getByRole("button", { name: "Aggiungi sedute da fatturare" }).click();
  await panel.getByRole("button", { name: `Aggiungi la seduta del ${YESTERDAY_SHORT}` }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.reload();
  await expect(toInvoiceTab(page)).toHaveText(before ?? "");
});

test("righe, riepilogo dal vivo, incasso e bozza; riaperta, il codice fiscale si completa e la fattura si emette", async ({
  page,
}) => {
  const panel = await openNewInvoice(page);
  await choosePatient(page, panel);

  // Le righe: la seduta di ieri, una voce del listino e una riga libera; le ultime due si tolgono.
  await panel.getByRole("button", { name: "Aggiungi sedute da fatturare" }).click();
  const sessions = panel.getByRole("list", { name: "Sedute da fatturare" });
  await expect(sessions.getByRole("listitem").filter({ hasText: YESTERDAY_SHORT })).toBeVisible();
  await panel.getByRole("button", { name: `Aggiungi la seduta del ${YESTERDAY_SHORT}` }).click();
  const first = panel.getByRole("group", { name: "Riga 1" });
  await expect(first.getByLabel("Data della prestazione")).toHaveValue(YESTERDAY);
  await panel.getByRole("button", { name: "Aggiungi dal listino" }).click();
  await page.getByRole("menuitem").first().click();
  await expect(panel.getByRole("group", { name: "Riga 2" })).toBeVisible();
  await panel.getByRole("button", { name: "Riga libera" }).click();
  const free = panel.getByRole("group", { name: "Riga 3" });
  await expect(free.getByLabel("Descrizione")).toBeFocused();
  await free.getByLabel("Descrizione").fill("Riga di prova");
  await free.getByLabel("Prezzo").fill("10,00");
  await panel.getByRole("button", { name: "Togli riga 3" }).click();
  await panel.getByRole("button", { name: "Togli riga 2" }).click();
  await expect(panel.getByRole("group", { name: "Riga 2" })).toHaveCount(0);

  // Il riepilogo segue il prezzo: sopra 77,47 euro compare il rimborso del bollo.
  const summary = panel.getByRole("region", { name: "Riepilogo" });
  await expect(summary).toContainText("Forfettario: niente IVA, bollo di 2 euro sopra 77,47 euro");
  await first.getByLabel("Prezzo").fill("40,00");
  await expect(summary).not.toContainText("Rimborso imposta di bollo");
  await first.getByLabel("Prezzo").fill("80,00");
  await expect(summary).toContainText("Rimborso imposta di bollo");
  await expect(summary).toContainText("82,00");

  // Un prezzo che non si legge si ferma sotto il campo.
  await first.getByLabel("Prezzo").fill("abc");
  await panel.getByRole("button", { name: "Salva bozza" }).click();
  await expect(first.getByText("Scrivi un importo, per esempio 55,00.")).toBeVisible();
  await expect(first.getByLabel("Prezzo")).toBeFocused();
  await first.getByLabel("Prezzo").fill("80,00");

  // Incassata 3 giorni fa: è la data della fattura.
  await panel.getByRole("checkbox", { name: "Già incassata" }).check();
  await panel.getByLabel("Data dell'incasso").fill("2026-11-01");
  await expect(summary).toContainText("Data della fattura: 01/11/2026, giorno dell'incasso");

  await panel.getByRole("button", { name: "Salva bozza" }).click();
  await expect(page.getByText("Bozza salvata.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Bozza di fattura" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Bozza di fattura" })).toBeHidden();
  await page.reload();
  const drafts = page.getByRole("link", { name: "Bozze (2)" });
  await expect(drafts).toBeVisible();

  // Riaperta: il paziente non ha il codice fiscale, i controlli lo dicono e il campo è nel pannello.
  await drafts.click();
  await page.getByRole("row").filter({ hasText: "Prova Editor" }).getByRole("button", { name: "Modifica" }).click();
  const draft = page.getByRole("dialog", { name: "Bozza di fattura" });
  await expect(draft.getByRole("group", { name: "Riga 1" }).getByLabel("Prezzo")).toHaveValue("80,00");
  const checks = draft.getByRole("region", { name: "Controlli" });
  const missing = checks.getByRole("button", { name: "Codice fiscale del paziente mancante" });
  await expect(missing).toBeVisible();
  await missing.click();
  const taxCode = draft.getByLabel("Codice fiscale");
  await expect(taxCode).toBeFocused();
  await taxCode.fill(TAX_CODE);
  await draft.getByRole("button", { name: "Salva in anagrafica" }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
  await expect(missing).toHaveCount(0);

  // Emetti e segna pagata: la conferma col numero, poi i due download.
  await draft.getByRole("button", { name: "Emetti e segna pagata" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Emettere la fattura?" });
  await expect(confirm).toBeVisible();
  const text = (await confirm.textContent()) ?? "";
  const number = /Alla fattura verrà assegnato il numero (\d+\/2026)\. Il numero non si può riusare\./.exec(text)?.[1];
  expect(number).toBeDefined();
  await expect(confirm.getByRole("button", { name: "Torna indietro" })).toBeVisible();
  await confirm.getByRole("button", { name: "Emetti fattura" }).click();
  await expect(draft.getByRole("heading", { name: `Fattura ${number} emessa` })).toBeVisible();

  const pdfHref = await draft.getByRole("link", { name: "Scarica PDF" }).getAttribute("href");
  const pdf = await page.request.get(pdfHref ?? "");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  const download = page.waitForEvent("download");
  await draft.getByRole("link", { name: "Scarica XML" }).click();
  const xmlFile = await download;
  expect(xmlFile.suggestedFilename()).toMatch(/^PROVA_IT/);
  const xml = await readFile((await xmlFile.path()) ?? "", "utf8");
  expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });

  // Il codice fiscale scritto nel pannello è in anagrafica.
  await page.keyboard.press("Escape");
  await page.goto("/pazienti?q=Editor");
  await page.getByRole("link", { name: "Editor Prova" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Prova Editor" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Anagrafica" }).click();
  await expect(page.getByRole("region", { name: "Dati personali" }).getByLabel("Codice fiscale")).toHaveValue(TAX_CODE);
});

test("Nuovo committente lo crea e lo sceglie; Elimina bozza toglie la bozza", async ({ page }) => {
  const panel = await openNewInvoice(page);
  await panel.getByRole("radio", { name: "Committente" }).check();
  await panel.getByRole("button", { name: "Nuovo committente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo committente" });
  await expect(field(dialog, "Denominazione")).toBeFocused();
  await field(dialog, "Denominazione").fill(PARTY);
  await field(dialog, "Partita IVA").fill(PARTY_VAT);
  await field(dialog, "Indirizzo").fill("Via del Committente 2");
  await field(dialog, "CAP").fill("40100");
  await field(dialog, "Città").fill("Bologna");
  await field(dialog, "Provincia").fill("BO");
  await dialog.getByRole("button", { name: "Salva il committente" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "Committente" })).toContainText(PARTY);

  await panel.getByRole("button", { name: "Riga libera" }).click();
  const line = panel.getByRole("group", { name: "Riga 1" });
  await line.getByLabel("Descrizione").fill("Consulenza di prova");
  await line.getByLabel("Prezzo").fill("100,00");
  await panel.getByRole("button", { name: "Salva bozza" }).click();
  await expect(page.getByText("Bozza salvata.")).toBeVisible();
  const draft = page.getByRole("dialog", { name: "Bozza di fattura" });
  await draft.getByRole("button", { name: "Elimina bozza" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Eliminare la bozza?" });
  await confirm.getByRole("button", { name: "Elimina bozza" }).click();
  await expect(page.getByText("Bozza eliminata.")).toBeVisible();
  await expect(draft).toBeHidden();
  await page.reload();
  await expect(page.getByRole("link", { name: "Bozze (1)" })).toBeVisible();
});

test("edit_durante_peek: mentre arriva il numero i campi sono fermi, Torna indietro li riapre e si emette l'ultimo importo", async ({
  page,
}) => {
  const panel = await openNewInvoice(page);
  await panel.getByRole("radio", { name: "Committente" }).check();
  await panel.getByRole("combobox", { name: "Committente" }).click();
  await page.getByRole("option", { name: PARTY }).click();
  await panel.getByRole("button", { name: "Riga libera" }).click();
  const line = panel.getByRole("group", { name: "Riga 1" });
  await line.getByLabel("Descrizione").fill("Consulenza durante la conferma");
  await line.getByLabel("Prezzo").fill("100,00");

  // La lettura del numero (l'unica azione con issueDate) resta in sospeso finché il test non la lascia andare.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let peeks = 0;
  await page.route("**/fatture**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"] !== undefined && request.postData()?.includes("issueDate")) {
      peeks += 1;
      if (peeks === 1) await held;
    }
    await route.continue();
  });
  await panel.getByRole("button", { name: "Emetti", exact: true }).click();
  await expect.poll(() => peeks).toBe(1);
  // Prima della risposta i campi sono già disabilitati: nessuna modifica che la conferma non mostrerebbe.
  await expect(line.getByLabel("Prezzo")).toBeDisabled();
  await expect(line.getByLabel("Descrizione")).toBeDisabled();
  // La Checkbox non è nativa: il fieldset non basta, deve essere disabilitata anche lei.
  await expect(panel.getByRole("checkbox", { name: "Già incassata" })).toBeDisabled();
  release();
  const confirm = page.getByRole("alertdialog", { name: "Emettere la fattura?" });
  await expect(confirm).toContainText(/Alla fattura verrà assegnato il numero \d+\/2026\. Il numero non si può riusare\./);
  // Con la conferma aperta il pannello sotto è nascosto agli strumenti di accessibilità: lo si cerca anche fra
  // gli elementi nascosti.
  const hiddenLine = page
    .getByRole("dialog", { name: "Nuova fattura", includeHidden: true })
    .getByRole("group", { name: "Riga 1", includeHidden: true });
  await expect(hiddenLine.getByRole("textbox", { name: "Prezzo", includeHidden: true })).toBeDisabled();

  // Torna indietro riapre i campi e conserva il testo scritto.
  await confirm.getByRole("button", { name: "Torna indietro" }).click();
  await expect(confirm).toBeHidden();
  await expect(line.getByLabel("Prezzo")).toBeEnabled();
  await expect(line.getByLabel("Prezzo")).toHaveValue("100,00");
  await expect(line.getByLabel("Descrizione")).toHaveValue("Consulenza durante la conferma");

  // L'ultimo importo scritto prima del clic è quello confermato ed emesso.
  await line.getByLabel("Prezzo").fill("120,00");
  await panel.getByRole("button", { name: "Emetti", exact: true }).click();
  await expect(confirm).toContainText(/numero \d+\/2026\./);
  await expect(hiddenLine.getByRole("textbox", { name: "Prezzo", includeHidden: true })).toHaveValue("120,00");
  await confirm.getByRole("button", { name: "Emetti fattura" }).click();
  await expect(panel.getByRole("heading", { name: /^Fattura \d+\/2026 emessa$/ })).toBeVisible();
  const xmlHref = await panel.getByRole("link", { name: "Scarica XML" }).getAttribute("href");
  const xml = await (await page.request.get(xmlHref ?? "")).text();
  expect(xml).toContain("<PrezzoTotale>120.00</PrezzoTotale>");
  expect(xml).not.toContain("<PrezzoTotale>100.00</PrezzoTotale>");
});
