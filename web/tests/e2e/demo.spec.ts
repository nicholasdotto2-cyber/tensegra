import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, type Request, type Route, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { PATIENTS, STUDIO, taxCodeOf } from "../../seed/people";
import { findForbidden, seedForbidden } from "../support/forbidden";
import { pdfText } from "../support/pdf-text";
import { validateFatturaXml } from "../support/xsd";

// Lo scenario di demo passo per passo, sulla demo dei test: D0 = mercoledì 4/11/2026 alle
// 08:30 (APP_FIXED_NOW in playwright.config.ts). I passi cambiano i dati in ordine, quindi il file è
// seriale e l'unico che cambia i conteggi dei passi 1 e 2.
//
// Punto della lista -> test di questo file, nell'ordine dei passi della demo:
//  1. Oggi da `/`: 5, 3 di domani, 2, 2, 2       -> «passo 1: Oggi senza clic» (più il gruppo senza consenso e il
//                                                    cambio di giorno, sempre del passo 1)
//  2. Matteo ogni 2 settimane, 3 blocchi a 14 gg -> «passo 2: serie di Matteo ogni 2 settimane»
//  3. firma col mouse, PDF 200, niente "________" -> «passo 3: Sofia da Oggi, ...»
//  4. Marco alle 08:30, pannello, fattura, XML,   -> «passo 4: Segna come fatta e Compila ora su Marco»; non
//     visita chiusa in cronologia                     dipende da appuntamenti senza visita di altri pazienti
//                                                    (con il seed attuale non ce ne sono)
//  5. Anna: dirette con cautela, INR di D0-1,     -> «passo 5: Anna in terapia e la lettera di Roberto»
//     HVLA disabilitata, nessuna nota copiata
//  6. prima visita di Marco 80,00 più bollo 2,00  -> «passo 6: le fatture di Marco, ...»
//  7. Chiara: Copia, href wa.me senza numeri,     -> «passo 7: il promemoria di Chiara ...»
//     Elisa senza link
//  8. Davide «Scaduto da 11 giorni», Martina      -> «passo 8: il richiamo di Davide ...»
//  9. ZIP del mese precedente senza dati vietati  -> «passo 9: l'export per l'elenco speciale ...»
// 10. regime e ritorno, tema, console pulita      -> «passo 10: Fisco ...» e afterEach su ogni test; l'upload delle
//                                                    foto sta in `foto.spec.ts`
// Gli altri test (pannello di Anna, «Fissa» di Sofia, rettifica di Marco) non sono punti della lista e stanno fra
// i passi che usano i loro dati.
test.describe.configure({ mode: "serial" });

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

test("passo 1: Oggi senza clic", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/oggi$/);
  await expect(page.getByRole("heading", { level: 1, name: "Oggi" })).toBeVisible();
  await expect(page.getByText("mercoledì 4 novembre 2026")).toBeVisible();

  // Blocco 1: i cinque appuntamenti in ordine di orario, ognuno con il suo stato.
  const appointments = page.getByRole("region", { name: "Appuntamenti di oggi (5)" });
  const rows = appointments.getByRole("listitem");
  await expect(rows).toContainText([
    "Bellandi Marco",
    "Morelli Anna",
    "Rinaldi Sofia, 4 mesi",
    "Ferrante Giulia",
    "Longo Francesca",
  ]);
  for (const index of [0, 1, 2, 3]) await expect(rows.nth(index).getByText("Confermato", { exact: true })).toBeVisible();
  await expect(rows.nth(4).getByText("Prenotato", { exact: true })).toBeVisible();
  await expect(appointments.getByText("Confermato", { exact: true })).toHaveCount(4);
  await expect(appointments.getByText("Prenotato", { exact: true })).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Seduta 2 di 4");
  await expect(rows.nth(3)).toContainText("Seduta 4 di 4");
  // Gli orari sono `<time>` con la data e l'ora di Roma.
  await expect(rows.nth(0).locator("time").first()).toHaveAttribute("datetime", "2026-11-04T09:00");
  await expect(rows.nth(0)).toContainText("09:00-09:45");

  // I segnali: solo quelli che la demo prevede, ognuno sulla riga giusta.
  await expect(rows.nth(2)).toContainText("Consenso mancante");
  await expect(rows.nth(1)).toContainText("Avviso clinico");
  await expect(appointments.getByText("Consenso mancante")).toHaveCount(1);
  await expect(appointments.getByText("Avviso clinico")).toHaveCount(1);
  for (const absent of ["Anagrafica da completare", "Visita da compilare", "Da chiudere"]) {
    await expect(appointments.getByText(absent)).toHaveCount(0);
  }

  // Blocco 2: Sofia oggi alle 11:00, Elisa domani alle 11:00.
  const consents = page.getByRole("region", { name: "Consensi mancanti (2)" });
  const consentRows = consents.getByRole("listitem");
  await expect(consentRows).toHaveCount(2);
  await expect(consentRows.nth(0)).toContainText("Sofia Rinaldi, 4 mesi");
  await expect(consentRows.nth(0)).toContainText("Informativa e consenso del genitore");
  await expect(consentRows.nth(0)).toContainText("oggi alle 11:00");
  await expect(consentRows.nth(1)).toContainText("Elisa Fontana");
  await expect(consentRows.nth(1)).toContainText("domani alle 11:00");

  // Blocco 3: le due sedute fatte e non fatturate, dalla più vecchia.
  const invoices = page.getByRole("region", { name: "Fatture da emettere (2)" });
  const invoiceRows = invoices.getByRole("listitem");
  await expect(invoiceRows).toHaveCount(2);
  await expect(invoiceRows.nth(0)).toContainText("80,00 €");
  await expect(invoiceRows.nth(1)).toContainText("55,00 €");

  // Blocco 4: giovedì 5 novembre, in ordine di orario.
  const reminders = page.getByRole("region", { name: "Promemoria per domani, giovedì 5 (3)" });
  await expect(reminders.getByRole("listitem")).toContainText(["Chiara Valli", "Elisa Fontana", "Paolo Neri"]);

  // Blocco 5: due richiami in regola e un gruppo chiuso per chi non ha dato il consenso.
  const recalls = page.getByRole("region", { name: "Da richiamare (2)" });
  const recallRows = recalls.getByRole("listitem");
  await expect(recallRows.nth(0)).toContainText("Davide Conti");
  // D0 è un mercoledì: il ritardo vero è di 11 giorni (10 negli altri giorni).
  await expect(recallRows.nth(0)).toContainText("Scaduto da 11 giorni");
  await expect(recallRows.nth(0)).toContainText(/Ultima seduta \d{2}\/\d{2}/);
  await expect(recallRows.nth(0)).toContainText("ogni 8 settimane");
  await expect(recallRows.nth(1)).toContainText("Giorgio Sala");
  await expect(recallRows.nth(1)).toContainText("ogni 4 settimane");
  await expect(recalls.getByRole("button", { name: "Senza consenso ai richiami (1)" })).toBeVisible();

  // Il numero accanto a Fatture in sidebar è lo stesso del blocco 3.
  const invoicesLink = page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: /^Fatture/ });
  await expect(invoicesLink).toHaveAccessibleName(/^Fatture\s+2\s+da emettere$/);

  // Nessun blocco è fallito.
  await expect(page.getByText("Non riesco a caricare questo elenco.")).toHaveCount(0);

  // Prima Server Action sotto `next start`: al ritorno sulla scheda Oggi chiede il giorno al server.
  // Il giorno non è cambiato, quindi la pagina resta lo stesso documento.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Reflect.set(window, "__stessoDocumento", true));
  const action = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined,
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await action).status()).toBe(200);
  expect(await page.evaluate(() => Reflect.get(window, "__stessoDocumento"))).toBe(true);
  await expect(page.getByRole("region", { name: "Appuntamenti di oggi (5)" })).toBeVisible();
});

test("passo 1: il gruppo senza consenso ai richiami si apre con un clic", async ({ page }) => {
  await page.goto("/oggi");

  const recalls = page.getByRole("region", { name: "Da richiamare (2)" });
  const group = recalls.getByRole("button", { name: "Senza consenso ai richiami (1)" });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(recalls.getByText("Martina De Luca")).toHaveCount(0);

  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expect(recalls.getByText("Martina De Luca")).toBeVisible();
});

test("passo 1: se il giorno è cambiato Oggi si aggiorna da sola, senza ricaricarsi", async ({ page }) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Reflect.set(window, "__stessoDocumento", true));

  // Il server risponde sempre 4/11 (APP_FIXED_NOW): la risposta dell'azione la porto al giorno dopo,
  // come se la scheda fosse tornata visibile dopo la mezzanotte.
  await page.route("**/oggi", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || request.headers()["next-action"] === undefined) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("2026-11-04", "2026-11-05") });
  });
  const refresh = page.waitForRequest(
    (request) =>
      request.method() === "GET" && request.headers()["rsc"] === "1" && new URL(request.url()).pathname === "/oggi",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refresh;

  // La pagina si è riletta dal server, non è stata ricaricata.
  expect(await page.evaluate(() => Reflect.get(window, "__stessoDocumento"))).toBe(true);
  await expect(page.getByRole("region", { name: "Appuntamenti di oggi (5)" })).toBeVisible();
});

/** Il testo scelto in un campo a scelta (un pulsante con l'elenco), senza la freccia. */
function chosen(select: Locator): Locator {
  return select.locator('[data-slot="select-value"]');
}

test("passo 2: serie di Matteo ogni 2 settimane", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-11-04");
  await page.waitForLoadState("networkidle");

  const opener = page.getByRole("button", { name: "Nuovo appuntamento" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(dialog).toBeVisible();

  // Scelto il paziente, prestazione, durata, prezzo e ciclo arrivano da soli dal listino e dal ciclo
  // aperto del seed; data e ora sono quelle proposte.
  await dialog.getByLabel("Paziente").fill("Ricci");
  await page.getByRole("option", { name: "Ricci Matteo" }).click();
  await expect(chosen(dialog.getByLabel("Prestazione"))).toHaveText("Seduta osteopatica");
  await expect(chosen(dialog.getByLabel("Durata"))).toHaveText("45 min");
  await expect(dialog.getByLabel("Prezzo concordato")).toHaveValue("55,00");
  await expect(dialog.getByLabel("Ciclo")).toHaveValue("Dolore al ginocchio destro, novembre 2026");
  await expect(dialog.getByLabel("Data", { exact: true })).toHaveValue("2026-11-04");
  await expect(chosen(dialog.getByLabel("Ora di inizio"))).toHaveText("12:00");

  // Ogni 2 settimane, 3 sedute: le previste del ciclo (4) meno la prima visita fatta.
  await dialog.getByRole("checkbox", { name: "Ripeti ogni" }).check();
  await dialog.getByRole("combobox", { name: "Ripeti ogni" }).click();
  await page.getByRole("option", { name: "2 settimane" }).click();
  await expect(chosen(dialog.getByRole("combobox", { name: "Ripeti ogni" }))).toHaveText("2 settimane");
  await expect(chosen(dialog.getByLabel("Numero di sedute in totale"))).toHaveText("3");

  const rows = dialog.getByRole("list").getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await expect(rows).toContainText(["mer 4 nov", "mer 18 nov", "mer 2 dic"]);
  for (const index of [0, 1, 2]) {
    await expect(rows.nth(index)).toContainText("Libero");
    await expect(rows.nth(index).getByRole("checkbox")).toBeChecked();
  }

  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // I tre blocchi sono salvati: ci sono anche dopo aver ricaricato la pagina, a 14 giorni l'uno dall'altro.
  await page.reload();
  for (const day of ["2026-11-04", "2026-11-18", "2026-12-02"]) {
    if (day !== "2026-11-04") await page.goto(`/agenda?vista=settimana&data=${day}`);
    await expect(
      page.locator(`[data-day="${day}"]`).getByRole("button", { name: /^12:00-12:45, Ricci Matteo, / }),
    ).toBeVisible();
  }
});

const MINOR_CONSENT = "Consenso informato al trattamento osteopatico di persona minore";
const SINGLE_GUARDIAN = /^Io sottoscritto\/a dichiaro che l'altro genitore è informato e d'accordo/;
const SOFIA = PATIENTS.find((patient) => patient.firstName === "Sofia" && patient.lastName === "Rinaldi");
// Il codice fiscale di Elena Rinaldi, la madre, con D0 = 4/11/2026 e il comune X999 (seed/people.ts): fisso.
const ELENA_TAX_CODE = "RNLLNE92H67X999P";

/**
 * La misura vera della tela: il dialogo si apre con un'animazione (zoom-in-95, 100 ms) che la scala per un
 * momento, e una misura presa durante l'apertura esce più piccola.
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

/**
 * La firma col mouse: tratti orizzontali da 21 punti (la discesa e 20 passi), a righe diverse della tela, a
 * passi di 25 ms (la tela tiene un punto ogni 16 ms). Restituisce i punti mossi.
 */
async function drawSignature(page: Page, canvas: Locator, strokes: number): Promise<number> {
  // Nel dialogo lungo del minore la tela sta sotto la finestra: prima si porta in vista.
  await canvas.scrollIntoViewIfNeeded();
  const box = await settledBox(canvas);
  let points = 0;
  for (let s = 0; s < strokes; s++) {
    const y = box.y + 60 + s * 40;
    // Il tratto parte sulla tela, non sul piede fisso del dialogo.
    const start = { x: box.x + 40, y };
    expect(await canvas.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, start)).toBe(true);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    points += 1;
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 40 + i * 12, y + (i % 2 === 0 ? 4 : -4));
      await page.waitForTimeout(25);
      points += 1;
    }
    await page.mouse.up();
  }
  return points;
}

test("passo 3: Sofia da Oggi, il consenso del genitore firmato col mouse da Elena, il PDF e l'informativa che manca ancora", async ({
  page,
}) => {
  // Il codice fiscale fisso è quello che il seed calcola per Elena al D0 della demo.
  expect(SOFIA?.contactGuardian).toBeDefined();
  expect(taxCodeOf(SOFIA!.contactGuardian!, "2026-11-04")).toBe(ELENA_TAX_CODE);

  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const consents = page.getByRole("region", { name: "Consensi mancanti (2)" });
  const sofia = consents.getByRole("listitem").filter({ hasText: "Sofia Rinaldi" });
  await expect(sofia).toContainText("Informativa e consenso del genitore");
  const collect = sofia.getByRole("button", { name: "Raccogli", exact: true });

  // «Raccogli» apre per primo il consenso del genitore, per il ciclo dell'appuntamento di oggi alle 11:00.
  await collect.click();
  const dialog = page.getByRole("dialog", { name: MINOR_CONSENT });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Chi firma" })).toHaveValue("Elena Rinaldi");

  // Il testo è compilato tutto: nessuna riga vuota, i dati della madre, rischi e alternative, compenso e polizza.
  const text = dialog.getByRole("region", { name: "Testo del modulo" });
  await expect(text).not.toContainText("________");
  await expect(text).toContainText("Minore: Sofia Rinaldi");
  await expect(text).toContainText(`Firmatario: Elena Rinaldi, codice fiscale ${ELENA_TAX_CODE}, in qualità di genitore o tutore.`);
  await expect(text).toContainText("circa una persona su due può avere disturbi lievi e passeggeri");
  await expect(text).toContainText("Alternative: non trattare, attendere, rivolgersi al medico");
  await expect(text).toContainText("Prima visita 80,00");
  await expect(text).toContainText(
    `Polizza di responsabilità civile professionale ${STUDIO.insurance.company}, n. ${STUDIO.insurance.policyNumber}`,
  );
  await expect(dialog.getByText(/^Mancano:/)).toHaveCount(0);
  // Sotto i 6 anni la voce del minore parte con «Non applicabile per l'età».
  await expect(dialog.getByLabel("Voce del minore")).toHaveValue("Non applicabile per l'età");

  // Firma solo la madre: la dichiarazione sull'altro genitore, poi la firma col mouse, due tratti e almeno 30 punti.
  await dialog.getByRole("checkbox", { name: SINGLE_GUARDIAN }).click();
  const canvas = dialog.getByRole("img", { name: "Firma di Elena Rinaldi" });
  const points = await drawSignature(page, canvas, 2);
  expect(points).toBeGreaterThanOrEqual(30);
  await expect(canvas).toHaveAttribute("data-empty", "false");
  await dialog.getByRole("button", { name: "Firma e salva" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Consenso salvato.")).toBeVisible();

  // Sofia resta nei consensi mancanti: manca ancora l'informativa, che qui non si firma (cambierebbe lo scenario).
  await expect(consents).toBeVisible();
  await expect(sofia.getByText("Informativa", { exact: true })).toBeVisible();
  await expect(collect).toBeFocused();

  // La scheda di Sofia: il consenso del genitore firmato oggi sulla tela, valido e senza dati mancanti.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Rinaldi Sofia" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sofia Rinaldi" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const summary = page.getByRole("region", { name: "Consensi" });
  await expect(summary.getByRole("definition").filter({ hasText: /^Firmato il 04\/11\/2026$/ })).toHaveCount(1);
  await expect(summary).toContainText("Consenso del genitoreFirmato il 04/11/2026");
  await expect(summary).toContainText("InformativaManca");

  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Consensi" }).click();
  await expect(page).toHaveURL(/tab=consensi/);
  await page.waitForLoadState("networkidle");
  const rows = page.getByRole("table").getByRole("row");
  await expect(rows).toHaveCount(2);
  const signed = rows.nth(1);
  for (const value of ["Consenso del genitore", "2026.1", "04/11/2026", "Firma sulla tela", "Valido"]) {
    await expect(signed).toContainText(value);
  }
  await expect(signed.getByText("Firmato con dati mancanti", { exact: true })).toHaveCount(0);

  // «Scarica PDF»: la risposta è un PDF da 200 e il file scaricato ha il testo firmato.
  const link = signed.getByRole("link", { name: "Scarica PDF" });
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/api\/consensi\/[0-9a-f-]{36}\/documento/);
  const response = await page.request.get(href ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/pdf");
  const downloaded = page.waitForEvent("download");
  await link.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("consenso-2026-11-04.pdf");
  const bytes = await readFile((await download.path()) ?? "");
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(Buffer.compare(bytes, await response.body())).toBe(0);
  const pdf = await pdfLines(bytes);
  expect(pdf).not.toContain("________");
  expect(pdf).toContain(MINOR_CONSENT);
  expect(pdf).toContain(`Firmatario: Elena Rinaldi, codice fiscale ${ELENA_TAX_CODE}`);
  expect(pdf).toContain("Prima visita 80,00");
  expect(pdf).toContain(STUDIO.insurance.policyNumber);
  expect(pdf).toContain("Non applicabile per l'età");
});

/** Il blocco di un paziente nella griglia: «09:00-09:45, Bellandi Marco, Seduta osteopatica, Confermato». */
function block(page: Page, patient: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^\\d{2}:\\d{2}-\\d{2}:\\d{2}, ${patient}, `) });
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EDITOR_URL = new RegExp(`/pazienti/${UUID}/visite/${UUID}$`);
const PAIN_START = "Dolore 0-10 (NRS) a inizio seduta";
const PAIN_END = "Dolore 0-10 (NRS) a fine seduta";
const PILLS = ["Thrust: indicato", "Dirette: indicato", "Indirette: indicato"];

const saveStatus = (page: Page): Locator => page.getByRole("status").filter({ hasText: /Salvato|Non ho salvato/ });
const sectionOf = (page: Page, letter: "a" | "b" | "c" | "d" | "e"): Locator => page.locator(`#sezione-${letter}`);
/** Il pulsante di un valore della scala del dolore (0-10). */
const painValue = (page: Page, scale: string, value: number): Locator =>
  page.getByRole("radiogroup", { name: scale }).getByRole("radio", { name: String(value), exact: true });

test("passo 4: Segna come fatta e Compila ora su Marco", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-04");
  await page.waitForLoadState("networkidle");

  // Il dettaglio di Marco: alle 08:30 la seduta delle 09:00 non è iniziata, quindi la domanda.
  await block(page, "Bellandi Marco").click();
  const detail = page.getByRole("dialog", { name: "Marco Bellandi", exact: true });
  await expect(detail).toBeVisible();
  // Data e orario del dettaglio sono `<time>` con la data e l'ora di Roma dell'inizio.
  const times = detail.locator("time");
  await expect(times).toHaveText(["mercoledì 4 novembre 2026", "09:00-09:45"]);
  for (const index of [0, 1]) await expect(times.nth(index)).toHaveAttribute("datetime", "2026-11-04T09:00");
  await detail.getByRole("button", { name: "Segna come fatta" }).click();
  const question = page.getByRole("alertdialog", { name: "Inizia alle 09:00. Segnarlo comunque come fatto?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Segna come fatta" }).click();

  // Il pannello "Seduta fatta": i tre passi nell'ordine del banco, ognuno con il suo stato.
  const panel = page.getByRole("dialog", { name: "Seduta fatta: Marco Bellandi" });
  await expect(panel).toBeVisible();
  await expect(detail).toBeHidden();
  const steps = panel.getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.getByRole("heading")).toHaveText(["Incasso e fattura", "Prossima seduta", "Visita"]);
  // Per Marco a D0: incasso da fare, prossima seduta già fissata il 16/11, visita da fare.
  await expect(steps.locator('[data-slot="step-status"]')).toHaveText(["da fare", "fatto", "da fare"]);
  await expect(panel.getByText("Prossima seduta già fissata: lunedì 16 novembre alle 09:00")).toBeVisible();
  // Il passo 2 offre anche "Chiudi il ciclo": c'è, e non si preme.
  await expect(panel.getByRole("button", { name: "Chiudi il ciclo" })).toBeVisible();

  // Carta resta premuto e si salva sull'appuntamento.
  const card = panel.getByRole("button", { name: "Carta" });
  const saved = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined,
  );
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  expect((await saved).status()).toBe(200);

  // Con un metodo scelto il passo 1 offre «Emetti e segna pagata»: apre l'editor con la seduta di oggi.
  await steps.nth(0).getByRole("button", { name: "Emetti e segna pagata" }).click();
  const editor = page.getByRole("dialog", { name: "Nuova fattura" });
  await expect(editor).toBeVisible();
  const line = editor.getByRole("group", { name: "Riga 1" });
  await expect(line.getByLabel("Descrizione")).toHaveValue("Trattamento osteopatico");
  await expect(line.getByLabel("Data della prestazione")).toHaveValue("2026-11-04");
  await expect(line.getByLabel("Prezzo")).toHaveValue("55,00");
  await expect(editor.getByRole("group", { name: "Riga 2" })).toHaveCount(0);
  // 55,00 € sono sotto 77,47 €: niente bollo.
  const summary = editor.getByRole("region", { name: "Riepilogo" });
  await expect(summary).toContainText("Forfettario: niente IVA, bollo di 2 euro sopra 77,47 euro");
  await expect(summary).not.toContainText("Rimborso imposta di bollo");

  // La conferma col numero: il seed emette fino al 302/2026.
  await editor.getByRole("button", { name: "Emetti e segna pagata" }).click();
  const confirmIssue = page.getByRole("alertdialog", { name: "Emettere la fattura?" });
  await expect(confirmIssue).toContainText(
    "Alla fattura verrà assegnato il numero 303/2026. Il numero non si può riusare.",
  );
  await confirmIssue.getByRole("button", { name: "Emetti fattura" }).click();
  await expect(editor.getByRole("heading", { name: "Fattura 303/2026 emessa" })).toBeVisible();

  // Il PDF: lo chiedo all'indirizzo del pulsante.
  const pdfHref = await editor.getByRole("link", { name: "Scarica PDF" }).getAttribute("href");
  expect(pdfHref).toMatch(/^\/api\/fatture\/[0-9a-f-]{36}\/pdf\?download=1$/);
  const invoicePdf = await page.request.get(pdfHref ?? "");
  expect(invoicePdf.status()).toBe(200);
  expect(invoicePdf.headers()["content-type"]).toBe("application/pdf");
  expect((await invoicePdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

  // L'XML: il contatore INVIO parte da 279 e il seed ne usa 24 (le 23 TD01 e la nota di Lorenzo), quindi
  // questo file è il progressivo 304, `progressive(304)` = "0008G".
  const xmlDownload = page.waitForEvent("download", { predicate: (file) => file.suggestedFilename().endsWith(".xml") });
  await editor.getByRole("link", { name: "Scarica XML" }).click();
  const xmlFile = await xmlDownload;
  expect(xmlFile.suggestedFilename()).toBe(`PROVA_IT${STUDIO.practitionerTaxCode}_0008G.xml`);
  const xml = await readFile((await xmlFile.path()) ?? "", "utf8");
  expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });
  expect(xml).toContain("<ImportoTotaleDocumento>55.00</ImportoTotaleDocumento>");
  expect(xml).not.toContain("DatiBollo");

  // Chiuso l'editor, il pannello si è riletto: incasso e fattura fatti.
  await editor.getByRole("button", { name: "Chiudi", exact: true }).last().click();
  await expect(editor).toBeHidden();
  await expect(steps.locator('[data-slot="step-status"]')).toHaveText(["fatto", "fatto", "da fare"]);

  // "Compila ora" crea la visita di oggi e apre l'editor, in bozza e con la barra della seduta 2.
  await panel.getByRole("button", { name: "Compila ora" }).click();
  await expect(page).toHaveURL(EDITOR_URL);
  await expect(page.getByRole("heading", { level: 1, name: "mercoledì 4 novembre 2026" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const bar = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(bar).toContainText("Marco Bellandi");
  await expect(bar).toContainText("Cervicalgia con cefalea");
  await expect(bar).toContainText("Seduta 2 di 4");
  await expect(bar.getByText("Bozza", { exact: true })).toBeVisible();

  // Sezione A: dolore a inizio seduta 6, novità e reazioni «Nessuna». Il salvataggio parte da solo.
  const a = sectionOf(page, "a");
  await painValue(page, PAIN_START, 6).click();
  await expect(painValue(page, PAIN_START, 6)).toHaveAttribute("aria-checked", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");
  const news = a.getByLabel("Novità dall'ultima seduta");
  await news.fill("Cefalea meno frequente");
  await news.blur();
  const reactions = a.getByRole("radiogroup", { name: "Reazioni dopo l'ultima seduta" });
  await reactions.getByRole("radio", { name: "Nessuna", exact: true }).click();
  await expect(reactions.getByRole("radio", { name: "Nessuna", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");

  // La destinazione: dopo aver ricaricato la pagina i tre valori ci sono.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(painValue(page, PAIN_START, 6)).toHaveAttribute("aria-checked", "true");
  await expect(sectionOf(page, "a").getByLabel("Novità dall'ultima seduta")).toHaveValue("Cefalea meno frequente");
  await expect(
    sectionOf(page, "a")
      .getByRole("radiogroup", { name: "Reazioni dopo l'ultima seduta" })
      .getByRole("radio", { name: "Nessuna", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  // Sezione B: «Nessuna variazione dal gg/mm» dà le tre pillole, tutte "indicato".
  const b = sectionOf(page, "b");
  const pills = b.getByRole("list", { name: "Esiti dello screening" });
  await expect(pills).toHaveCount(0);
  await b.getByRole("button", { name: /^Nessuna variazione dal \d{2}\/\d{2}$/ }).click();
  await expect(pills.getByRole("listitem")).toHaveText(PILLS);

  // La copia dalla visita precedente è ora attiva: le regioni Cervicale e Dorsale tornano «da confermare».
  const copy = page.getByRole("button", { name: "Copia dalla visita precedente" });
  await expect(copy).toBeEnabled();
  await copy.click();
  const c = sectionOf(page, "c");
  const regions = c.getByRole("list", { name: "Regioni" });
  await expect(regions.getByRole("button", { name: /^Cervicale, .*da confermare$/ })).toBeVisible();
  await expect(regions.getByRole("button", { name: /^Dorsale, .*da confermare$/ })).toBeVisible();

  // «Confronta con» «la prima visita del ciclo»: accanto alla sagoma di oggi ci sono le due della prima visita.
  await c.getByRole("radiogroup", { name: "Confronta con" }).getByRole("radio", { name: "la prima visita del ciclo" }).click();
  const comparison = c.locator("[data-compare]");
  await expect(comparison).toContainText("Confronto con la prima visita del ciclo");
  await expect(comparison.locator("svg")).toHaveCount(2);

  // Flessione-rotazione a destra 38° (28° alla prima misura): +10° dx con la freccia.
  const rotation = c.getByLabel("Flessione-rotazione cervicale (cefalea cervicogenica) dx (°)");
  await rotation.fill("38");
  await rotation.blur();
  const change = c.getByText("+10° dx");
  await expect(change).toBeVisible();
  await expect(change.locator("xpath=..").locator("svg")).toHaveCount(1);

  // Sezione D: risposta al trattamento «Migliorato».
  const d = sectionOf(page, "d");
  const response = d.getByRole("radiogroup", { name: "Risposta al trattamento" }).getByRole("radio", { name: "Migliorato", exact: true });
  await response.click();
  await expect(response).toHaveAttribute("aria-checked", "true");

  // Dolore a fine seduta 3 (colonna destra).
  await painValue(page, PAIN_END, 3).click();
  await expect(painValue(page, PAIN_END, 3)).toHaveAttribute("aria-checked", "true");

  // Sezione E: i consigli proposti dalle regioni copiate hanno «Pause attive al computer» per primo, non spuntato;
  // la spunta lo scrive con il suo testo.
  const e = sectionOf(page, "e");
  const advice = e.getByRole("checkbox");
  await expect(advice.first()).toHaveAccessibleName("Pause attive al computer");
  await expect(advice.first()).toHaveAttribute("aria-checked", "false");
  await advice.first().click();
  await expect(advice.first()).toHaveAttribute("aria-checked", "true");
  await expect(e.getByLabel("Testo: Pause attive al computer")).not.toHaveValue("");
  await expect(saveStatus(page)).toHaveText("Salvato");

  // "Conferma tutti i copiati e chiudi": una sola azione. L'appuntamento è già fatto, quindi nessuna domanda.
  await page.getByRole("button", { name: "Conferma tutti i copiati e chiudi" }).click();
  await expect(page.getByText("Visita chiusa.")).toBeVisible();
  await expect(bar.getByText("Chiusa", { exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Rettifica", exact: true })).toBeVisible();
  await expect(painValue(page, PAIN_END, 3)).toBeDisabled();

  // La destinazione: riletta la visita chiusa, il 38° e «Migliorato» ci sono, in sola lettura.
  await page.reload();
  await page.waitForLoadState("networkidle");
  const closedRotation = sectionOf(page, "c").getByLabel("Flessione-rotazione cervicale (cefalea cervicogenica) dx (°)");
  await expect(closedRotation).toHaveValue("38");
  await expect(closedRotation).toBeDisabled();
  await expect(
    sectionOf(page, "d").getByRole("radiogroup", { name: "Risposta al trattamento" }).getByRole("radio", { name: "Migliorato", exact: true }),
  ).toHaveAttribute("aria-checked", "true");

  // La Cartella: il ciclo «Cervicalgia con cefalea» e la visita di oggi in cronologia con «6 → 3» e «Chiusa».
  await bar.getByRole("link", { name: "Marco Bellandi" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  const history = page.getByRole("region", { name: "Cronologia" });
  await expect(history.getByRole("heading", { name: "Cervicalgia con cefalea" })).toBeVisible();
  const today = history.getByRole("listitem").filter({ hasText: "mer 4 nov" });
  await expect(today).toContainText("Dolore 0-10: 6 → 3");
  await expect(today).toContainText("Chiusa");
  // Accanto c'è la prima visita del seed, P(10) venerdì 23/10, chiusa: le sedute di Marco hanno tutte la visita.
  const firstVisit = history.getByRole("listitem").filter({ has: page.locator('time[datetime="2026-10-23"]') });
  await expect(firstVisit).toHaveCount(1);
  await expect(firstVisit).toContainText("Chiusa");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history.getByText("Seduta senza visita")).toHaveCount(0);

  // Lo stato dell'appuntamento è salvato: il blocco dice "Fatto" anche dopo aver ricaricato l'agenda.
  await page.goto("/agenda?vista=giorno&data=2026-11-04");
  const marco = block(page, "Bellandi Marco");
  await expect(marco).toHaveAccessibleName("09:00-09:45, Bellandi Marco, Seduta osteopatica, Fatto");

  // Su Oggi la seduta è fatturata e non c'è più la visita da compilare; la seduta di Matteo del passo 2 è la sesta.
  await page.goto("/oggi");
  await expect(page.getByRole("region", { name: "Fatture da emettere (2)" })).toBeVisible();
  const marcoRow = page
    .getByRole("region", { name: "Appuntamenti di oggi (6)" })
    .getByRole("listitem")
    .filter({ hasText: "Bellandi Marco" });
  await expect(marcoRow).toContainText("Fatto");
  await expect(marcoRow).not.toContainText("Visita da compilare");
  // Nessuna riga di oggi aspetta una visita: il passo non si appoggia a un appuntamento senza visita di altri.
  await expect(
    page.getByRole("region", { name: "Appuntamenti di oggi (6)" }).getByText("Visita da compilare"),
  ).toHaveCount(0);
});

test("da Oggi, Segna come fatta su Anna tiene aperto il pannello dopo l'aggiornamento della riga", async ({ page }) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const annaRow = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Morelli Anna" });

  // Alle 08:30 la seduta delle 10:00 non è iniziata: prima la domanda, poi il pannello.
  await annaRow.getByRole("button", { name: "Segna come fatta" }).click();
  const question = page.getByRole("alertdialog", { name: "Inizia alle 10:00. Segnarlo comunque come fatto?" });
  const marked = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined,
  );
  await question.getByRole("button", { name: "Segna come fatta" }).click();
  const panel = page.getByRole("dialog", { name: "Seduta fatta: Anna Morelli" });
  await expect(panel).toBeVisible();

  // La risposta dell'azione porta la pagina rinnovata: la riga di Anna è già "Fatto" e non ha più i suoi
  // pulsanti, ma il pannello resta aperto con i suoi passi. Il pannello è modale, quindi la riga si legge
  // dopo averlo chiuso.
  expect((await marked).status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Incasso e fattura" })).toBeVisible();

  await panel.getByRole("button", { name: "Compila più tardi" }).click();
  await expect(panel).toBeHidden();
  await expect(annaRow.getByText("Fatto", { exact: true })).toBeVisible();
  await expect(annaRow.getByRole("button", { name: "Segna come fatta" })).toHaveCount(0);
});

test("Fissa nel pannello di Sofia resta disattivato finché il pannello non si rilegge: prenota una volta", async ({
  page,
}) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const sofiaRow = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Rinaldi Sofia" });
  await sofiaRow.getByRole("button", { name: "Segna come fatta" }).click();
  await page
    .getByRole("alertdialog", { name: "Inizia alle 11:00. Segnarlo comunque come fatto?" })
    .getByRole("button", { name: "Segna come fatta" })
    .click();
  const panel = page.getByRole("dialog", { name: "Seduta fatta: Sofia Rinaldi" });
  const next = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Prossima seduta" }) });
  await expect(next).toContainText("mercoledì 18 novembre alle 11:00");
  await page.waitForLoadState("networkidle");

  // Dopo "Fissa" la prima azione prenota, la seconda rilegge il pannello: la seconda la trattengo, così
  // si vede il momento fra le due, in cui un secondo clic prenoterebbe di nuovo. "Fissa" resta disattivato
  // finché la rilettura non torna: la transizione del clic resta in corso insieme all'azione di lettura.
  let armed = false;
  let posts = 0;
  await page.route("**/oggi", async (route) => {
    const request = route.request();
    if (armed && request.method() === "POST" && request.headers()["next-action"] !== undefined) {
      posts += 1;
      if (posts === 2) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await route.continue();
  });
  const fissa = next.getByRole("button", { name: "Fissa" });
  const booked = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.request().headers()["next-action"] !== undefined,
  );
  armed = true;
  await fissa.click();
  expect((await booked).status()).toBe(200);
  await page.waitForTimeout(400);
  await expect(fissa).toBeDisabled();

  // Riletto il pannello, la prossima seduta è fatta e "Fissa" non c'è più.
  await expect(next.locator('[data-slot="step-status"]')).toHaveText("fatto");
  await expect(fissa).toHaveCount(0);
  await page.unroute("**/oggi");

  // La destinazione: un solo appuntamento di Sofia il 18/11 alle 11:00.
  await page.goto("/agenda?vista=giorno&data=2026-11-18");
  await expect(page.getByRole("button", { name: /^11:00-\d{2}:\d{2}, Rinaldi Sofia, / })).toHaveCount(1);
});

test("passo 5: Anna in terapia e la lettera di Roberto", async ({ page }) => {
  // Anna da Oggi: il menu della riga apre la visita in bozza, con lo screening già confermato dal seed.
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const annaRow = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Morelli Anna" });
  await annaRow.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Apri la visita" }).click();
  await expect(page).toHaveURL(EDITOR_URL);
  await expect(page.getByRole("heading", { level: 1, name: "mercoledì 4 novembre 2026" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Le pillole dicono la terapia anticoagulante; la nota è l'INR del giorno prima, calcolato dal 4/11.
  const b = sectionOf(page, "b");
  await expect(b.getByRole("list", { name: "Esiti dello screening" }).getByRole("listitem")).toHaveText([
    "Thrust: controindicato",
    "Dirette: con cautela",
    "Indirette: indicato",
  ]);
  const inr = b.getByLabel("Nota sull'esito");
  await expect(inr).toHaveValue("INR 2,5 del 03/11/2026 dal libretto TAO");
  await expect(inr).not.toHaveValue(/INR 2,4/);
  await expect(page.getByText("INR 2,4 di due giorni prima, dal libretto TAO")).toHaveCount(0);

  // Sezione D: scelta una regione, HVLA è disattivata con la frase del blocco.
  const d = sectionOf(page, "d");
  await d.getByRole("combobox", { name: "Aggiungi una regione" }).click();
  await page.getByRole("option", { name: "Lombare", exact: true }).click();
  const lumbar = d.getByRole("region", { name: "Lombare", exact: true });
  await expect(lumbar.getByRole("switch", { name: "HVLA", exact: true })).toBeDisabled();
  await expect(
    lumbar.getByText(
      "HVLA controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.",
      { exact: true },
    ),
  ).toBeVisible();

  // Roberto dalla lista: la Cartella, il riquadro "Rinvii al medico" e la lettera consegnata.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Esposito Roberto" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roberto Esposito" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  const referrals = page.getByRole("region", { name: "Rinvii al medico" });
  await expect(referrals).toContainText("Consegnata al paziente");
  await referrals.getByRole("link", { name: /^Lettera del 14\/10\/2026/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Lettera al medico" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByLabel(/^Sintesi/)).toHaveValue(/Calo di peso non spiegato/);
  await expect(page.getByText("Consegnata al paziente", { exact: false }).first()).toBeVisible();

  // "Stampa" apre il PDF: lo chiedo allo stesso indirizzo. Il file nasce a questa prima richiesta.
  const print = page.getByRole("link", { name: /^Stampa/ });
  const href = await print.getAttribute("href");
  expect(href).toMatch(/^\/api\/rinvii\/[0-9a-f-]+\/pdf$/);
  const pdf = await page.request.get(href ?? "");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toContain("lettera-medico-");
  expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
});

/** Il testo di un PDF con gli spazi (anche quelli non separabili) ridotti a uno. */
async function pdfLines(bytes: Uint8Array): Promise<string> {
  return (await pdfText(bytes)).text.replace(/\s+/g, " ");
}

test("passo 6: le fatture di Marco, la prima visita col bollo e la seduta di oggi senza", async ({ page }) => {
  // La prima visita di Marco è a D0-10, il 25/10/2026: ottobre.
  await page.goto("/fatture?tab=emesse&mese=2026-10");
  await page.waitForLoadState("networkidle");
  const first = page
    .getByRole("table", { name: "Fatture" })
    .getByRole("row")
    .filter({ hasText: "Marco Bellandi" })
    .filter({ hasText: "Prima visita osteopatica" });
  await expect(first).toHaveCount(1);
  await expect(first).toContainText("82,00 €");
  await expect(first.getByRole("cell", { name: "Sì", exact: true })).toBeVisible();
  // Il seed emette i numeri da 280 a 302.
  const firstLink = first.getByRole("link", { name: /^\d+\/2026$/ });
  const firstNumber = ((await firstLink.textContent()) ?? "").trim();
  expect(firstNumber).toMatch(/^(2[89]\d|30[0-2])\/2026$/);

  // Il dettaglio: la copia di cortesia ha la riga della prima visita e il rimborso del bollo, entrambi in N2.2.
  await firstLink.click();
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${firstNumber}` })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const preview = page.locator('iframe[title="Anteprima della fattura"]');
  const previewSrc = await preview.getAttribute("src");
  expect(previewSrc).toMatch(/^\/api\/fatture\/[0-9a-f-]{36}\/pdf$/);
  const firstPdf = await page.request.get(previewSrc ?? "");
  expect(firstPdf.status()).toBe(200);
  const firstText = await pdfLines(await firstPdf.body());
  expect(firstText).toMatch(/Prima visita osteopatica \d{2}\/\d{2}\/2026 1 80,00 € 80,00 € Non soggetta/);
  expect(firstText).toMatch(/Rimborso imposta di bollo (?:\d{2}\/\d{2}\/2026 )?1 2,00 € 2,00 € Non soggetta/);
  expect(firstText).toMatch(/Totale 82,00 €/);

  // "Scarica PDF" del dettaglio scarica il file.
  const download = page.waitForResponse((response) => /\/api\/fatture\/[0-9a-f-]{36}\/pdf\?download=1$/.test(response.url()));
  const pdfFile = page.waitForEvent("download", { predicate: (file) => file.suggestedFilename() === `Fattura_${firstNumber.replace("/", "-")}.pdf` });
  await page.getByRole("button", { name: "Scarica PDF" }).click();
  expect((await download).status()).toBe(200);
  await pdfFile;

  // La seduta di oggi, fatturata nel passo 4: 55,00 € senza bollo.
  await page.goto("/fatture?tab=emesse&mese=2026-11");
  await page.waitForLoadState("networkidle");
  const today = page
    .getByRole("table", { name: "Fatture" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "303/2026", exact: true }) });
  await expect(today).toContainText("Marco Bellandi");
  await expect(today).toContainText("Trattamento osteopatico");
  await expect(today).toContainText("55,00 €");
  await expect(today.getByRole("cell", { name: "No", exact: true })).toBeVisible();
  await expect(today).toContainText("Pagata");
});

// Passi 7 e 8: nessun invio e nessuna rete. L'apertura di wa.me è intercettata con una pagina finta, un documento
// vero: Playwright dà l'evento «popup» solo quando la scheda nuova carica un documento (una 204 non ne carica).
const WA_PAGE = { status: 200, contentType: "text/html", body: "<!doctype html><title>wa</title>" };
const COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
const CHIARA_BODY =
  "Ciao Chiara, ti ricordo l'appuntamento di domani, giovedì 5 novembre, alle 09:30, in Via delle Prove 7, Bologna. " +
  "Se non riesci a venire, avvisami qui: così posso dare l'orario a qualcun altro. A presto. " +
  "Laura Benedetti, Studio Osteopatico Borgo Tiglio";
const NO_WHATSAPP_REMINDER = "Manca il consenso WhatsApp: telefona o usa Copia per un SMS";

/** I cellulari di pazienti e genitori del seed, senza «+»: nessuno deve finire in un link. */
const SEED_PHONES = PATIENTS.flatMap((patient) => [patient.phone, patient.contactGuardian?.phone, patient.secondGuardian?.phone])
  .filter((phone): phone is string => phone !== null && phone !== undefined)
  .map((phone) => phone.replace(/\D/g, ""));

/** Nessun cellulare del seed nel link, né col 39 né senza, né nel percorso né nel testo. */
function expectNoSeedPhone(href: string): void {
  const digits = decodeURIComponent(href).replace(/[\s+]/g, "");
  for (const phone of SEED_PHONES) {
    expect(digits, href).not.toContain(phone);
    expect(digits, href).not.toContain(phone.slice(2));
  }
}

/** Gli argomenti di una Server Action: un array JSON, il primo è l'input. */
function actionInput(request: Request): Record<string, unknown> | null {
  if (request.method() !== "POST" || request.headers()["next-action"] === undefined) return null;
  try {
    const args: unknown = JSON.parse(request.postData() ?? "");
    const [first] = Array.isArray(args) ? args : [];
    return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Recorded = { id: string; body: string; action: string; source: unknown };

/** Le chiamate di recordMessageAction e setMessageOutcomeAction partite dalla pagina, in ordine. */
function watchMessages(page: Page): { records: Recorded[]; outcomes: unknown[] } {
  const records: Recorded[] = [];
  const outcomes: unknown[] = [];
  page.on("request", (request) => {
    const input = actionInput(request);
    if (input === null) return;
    if (typeof input.action === "string" && typeof input.body === "string" && typeof input.id === "string") {
      records.push({ id: input.id, body: input.body, action: input.action, source: input.source });
    } else if ("outcome" in input) {
      outcomes.push(input);
    }
  });
  return { records, outcomes };
}

/**
 * La risposta della prossima recordMessageAction con quell'azione, letta mentre passa: il server ha scritto la
 * riga di `message_log` (un ActionResult ok con quell'id). Il corpo non si chiede dopo a Chromium: la risposta di
 * una Server Action arriva in streaming e a volte non resta.
 */
async function storedReply(page: Page, action: "copiato" | "whatsapp_aperto"): Promise<{ reply: Promise<string> }> {
  let taken = false;
  let resolve: (text: string) => void = () => undefined;
  const reply = new Promise<string>((fulfill) => {
    resolve = fulfill;
  });
  await page.route("**/oggi", async (route: Route) => {
    if (taken || actionInput(route.request())?.action !== action) return route.fallback();
    taken = true;
    const response = await route.fetch();
    const text = await response.text();
    resolve(response.status() === 200 ? text : `status ${response.status()}`);
    await route.fulfill({ response });
  });
  // In un oggetto: una Promise restituita da una funzione async si aspetterebbe qui, prima del clic.
  return { reply };
}

function expectStored(reply: string, id: string | undefined): void {
  expect(reply).toContain('"ok":true');
  expect(reply).toContain(`"id":"${id}"`);
}

test("passo 7: il promemoria di Chiara copiato, aperto in WhatsApp e dichiarato inviato; Elisa solo con Copia", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const opened: string[] = [];
  await context.route("https://wa.me/**", (route) => {
    opened.push(route.request().url());
    return route.fulfill(WA_PAGE);
  });
  const external: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  const { records, outcomes } = watchMessages(page);

  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const reminders = page.getByRole("region", { name: "Promemoria per domani, giovedì 5 (3)" });
  const chiara = reminders.getByRole("listitem").filter({ hasText: "Chiara Valli" });
  await expect(chiara.locator("time")).toHaveText("09:30");
  await expect(chiara.locator("time")).toHaveAttribute("datetime", "2026-11-05T09:30");
  await expect(chiara.getByText("Da inviare", { exact: true })).toBeVisible();

  // Il link porta il testo col tu, codificato, e nella demo nessun numero: mai il cellulare di Chiara.
  const href = `https://wa.me/?text=${encodeURIComponent(CHIARA_BODY)}`;
  const anchor = chiara.getByRole("link", { name: "Apri WhatsApp" });
  await expect(anchor).toHaveAttribute("href", href);
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAccessibleDescription("Dati di prova: il messaggio va al numero per le prove.");
  expectNoSeedPhone((await anchor.getAttribute("href")) ?? "");

  // «Copia» mette negli appunti lo stesso testo e registra una riga «copiato», che non è un invio.
  await page.evaluate(() => navigator.clipboard.writeText("Appunti prima della copia"));
  const copied = await storedReply(page, "copiato");
  await chiara.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(chiara.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CHIARA_BODY);
  await expect.poll(() => records.length).toBe(1);
  expect(records[0]).toMatchObject({ body: CHIARA_BODY, action: "copiato", source: { kind: "appointment", templateKey: "promemoria" } });
  expectStored(await copied.reply, records[0]?.id);
  const copyQuestion = chiara.getByRole("group", { name: /inviato\?$/ });
  await expect(copyQuestion).toBeVisible();
  await expect(chiara.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  expect(outcomes).toEqual([]);

  // Il messaggio non è partito dalla copia: «No», e tornano «Apri WhatsApp» e «Copia».
  await copyQuestion.getByRole("button", { name: "No", exact: true }).click();
  await expect(chiara.getByText("Non inviato", { exact: true })).toBeVisible();
  await expect(anchor).toHaveAttribute("href", href);
  expect(outcomes).toEqual([{ id: records[0]?.id, outcome: "non_inviato" }]);

  // Il vero anchor: la scheda nuova apre l'indirizzo del link (il parser URL scrive l'apostrofo %27) e il
  // server scrive una riga «whatsapp_aperto» con quel testo.
  const openedRow = await storedReply(page, "whatsapp_aperto");
  const [popup] = await Promise.all([page.waitForEvent("popup"), anchor.click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(new URL(href).href);
  expect(new URL(popup.url()).searchParams.get("text")).toBe(CHIARA_BODY);
  await expect.poll(() => opened).toEqual([new URL(href).href]);
  await expect.poll(() => records.length).toBe(2);
  expect(records[1]).toMatchObject({ body: CHIARA_BODY, action: "whatsapp_aperto", source: { kind: "appointment", templateKey: "promemoria" } });
  expectStored(await openedRow.reply, records[1]?.id);
  await popup.close();

  // Tornata sulla pagina, la riga chiede: niente diventa «Inviato» da solo. Il «Sì» lo dichiara l'osteopata.
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const openQuestion = chiara.getByRole("group", { name: "Aperto alle 08:30, inviato?" });
  await expect(openQuestion).toBeVisible();
  expect(outcomes).toHaveLength(1);
  await openQuestion.getByRole("button", { name: "Sì", exact: true }).click();
  await expect(chiara.getByText("Inviato alle 08:30", { exact: true })).toBeVisible();
  await expect(chiara.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  expect(outcomes).toEqual([
    { id: records[0]?.id, outcome: "non_inviato" },
    { id: records[1]?.id, outcome: "inviato" },
  ]);

  // Elisa: senza consenso WhatsApp nessun link, solo «Copia» (che qui non si preme).
  const elisa = reminders.getByRole("listitem").filter({ hasText: "Elisa Fontana" });
  await expect(elisa.getByText(NO_WHATSAPP_REMINDER, { exact: true })).toBeVisible();
  await expect(elisa.locator('a[href^="https://wa.me/"]')).toHaveCount(0);
  await expect(elisa.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  await expect(elisa.getByRole("button", { name: "Apri WhatsApp" })).toHaveCount(0);
  await expect(elisa.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();

  // La destinazione: riletta la pagina, la riga di Chiara resta «Inviato alle 08:30»; la cronologia
  // dell'appuntamento ha le due righe, l'apertura inviata e la copia non inviata.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(chiara.getByText("Inviato alle 08:30", { exact: true })).toBeVisible();
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^09:30-\d{2}:\d{2}, Valli Chiara, / }).click();
  const detail = page.getByRole("dialog", { name: "Chiara Valli", exact: true });
  await expect(detail).toBeVisible();
  const history = detail.getByRole("region", { name: "Messaggi dell'appuntamento" });
  const entries = history.locator("[data-message-id]");
  await expect(entries).toHaveCount(2);
  const openEntry = history.locator(`[data-message-id="${records[1]?.id}"]`);
  await expect(openEntry).toContainText("Aperto in WhatsApp");
  await expect(openEntry).toContainText("Inviato il 04/11/2026 alle 08:30");
  await expect(openEntry).toContainText(CHIARA_BODY);
  const copyEntry = history.locator(`[data-message-id="${records[0]?.id}"]`);
  await expect(copyEntry).toContainText("Copiato");
  await expect(copyEntry).toContainText("Non inviato");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // Nessuna rete fuori dallo studio, tranne wa.me intercettato.
  expect(external.length).toBeGreaterThan(0);
  expect(external.every((url) => url.startsWith("https://wa.me/"))).toBe(true);
  expect(records).toHaveLength(2);
});

test("passo 8: il richiamo di Davide copiato senza invio presunto, Martina esclusa per la revoca della madre", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.route("https://wa.me/**", (route) => route.fulfill(WA_PAGE));
  const external: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  const { records, outcomes } = watchMessages(page);

  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const recalls = page.getByRole("region", { name: "Da richiamare (2)" });
  const davide = recalls.getByRole("listitem").filter({ hasText: "Davide Conti" });
  await expect(davide).toContainText("Scaduto da 11 giorni");
  await expect(davide).toContainText("ogni 8 settimane");
  // Il testo del richiamo è quello del link: nella demo nessun numero, mai il cellulare di Davide.
  const href = (await davide.getByRole("link", { name: "Apri WhatsApp" }).getAttribute("href")) ?? "";
  expect(href).toMatch(/^https:\/\/wa\.me\/\?text=/);
  expectNoSeedPhone(href);
  const body = new URL(href).searchParams.get("text") ?? "";
  expect(body).toMatch(/^Ciao Davide, sono Laura Benedetti\. Sono passate \d+ settimane dall'ultima seduta: se ti va, fissiamo un controllo\./);

  // «Copia»: negli appunti c'è il testo, il server scrive la riga «copiato» del richiamo; nessun esito dichiarato.
  await page.evaluate(() => navigator.clipboard.writeText("Appunti prima della copia"));
  const copied = await storedReply(page, "copiato");
  await davide.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(davide.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await expect.poll(() => records.length).toBe(1);
  expect(records[0]).toMatchObject({ body, action: "copiato", source: { kind: "recall", templateKey: "richiamo" } });
  expectStored(await copied.reply, records[0]?.id);
  await expect(davide.getByRole("group", { name: "Hai inviato il messaggio?" })).toBeVisible();
  await expect(davide).not.toContainText("In attesa di risposta");
  expect(outcomes).toEqual([]);

  // La copia non è un invio: riletta Oggi, Davide resta primo, scaduto e senza attesa di risposta.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(recalls.getByRole("listitem").first()).toContainText("Davide Conti");
  await expect(davide).toContainText("Scaduto da 11 giorni");
  await expect(davide).not.toContainText("In attesa di risposta");

  // Il gruppo chiuso: aperto, Martina con la ragione della revoca della madre e nessun pulsante di messaggio.
  const group = recalls.getByRole("button", { name: "Senza consenso ai richiami (1)" });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(recalls.getByText("Martina De Luca")).toHaveCount(0);
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const martina = recalls.getByRole("listitem").filter({ hasText: "Martina De Luca" });
  await expect(martina).toBeVisible();
  await expect(martina).toContainText("Consenso ai richiami revocato dalla madre il 01/11");
  await expect(martina.getByRole("button")).toHaveCount(0);
  await expect(martina.getByRole("link")).toHaveCount(0);
  await expect(martina.locator('a[href^="https://wa.me/"], a[href^="tel:"]')).toHaveCount(0);

  expect(outcomes).toEqual([]);
  expect(records).toHaveLength(1);
  expect(external).toEqual([]);
});

test("rettifica della visita di Marco", async ({ page }) => {
  // I numeri di Oggi prima: la rettifica non li cambia.
  const todayCounts = async () => {
    await page.goto("/oggi");
    await page.waitForLoadState("networkidle");
    return page.getByRole("heading", { level: 2 }).allInnerTexts();
  };
  const before = await todayCounts();
  // Le sedute fatte e non fatturate sono 4: Matteo e Valentina di prima, Anna e Sofia (i test dopo il passo 4).
  // Marco è fatturato nel passo 4.
  expect(before).toContain("Appuntamenti di oggi (6)");
  expect(before).toContain("Fatture da emettere (4)");
  // Sofia è `fatto` e senza visita: la sua riga porta ancora "Visita da compilare".
  await expect(
    page.getByRole("region", { name: "Appuntamenti di oggi (6)" }).getByRole("listitem").filter({ hasText: "Rinaldi Sofia" }),
  ).toContainText("Visita da compilare");

  // Dalla Cartella di Marco, la visita di oggi (chiusa nel passo 4).
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Bellandi Marco" }).click();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  const history = page.getByRole("region", { name: "Cronologia" });
  await history.getByRole("listitem").filter({ hasText: "mer 4 nov" }).getByRole("link", { name: "Vedi la visita" }).click();
  await expect(page).toHaveURL(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await expect(painValue(page, PAIN_END, 3)).toHaveAttribute("aria-checked", "true");
  await expect(painValue(page, PAIN_END, 3)).toBeDisabled();

  // «Rettifica» chiede il motivo: 9 caratteri non bastano.
  await page.getByRole("button", { name: "Rettifica", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rettifica la visita" });
  const reason = dialog.getByLabel("Motivo della rettifica");
  await reason.fill("123456789");
  await dialog.getByRole("button", { name: "Inizia la rettifica" }).click();
  await expect(dialog.getByText("Scrivi almeno 10 caratteri.")).toBeVisible();
  await reason.fill("Dolore a fine seduta scritto male");
  await dialog.getByRole("button", { name: "Inizia la rettifica" }).click();
  await expect(dialog).toBeHidden();

  // La barra della rettifica elenca la modifica in attesa; il dolore a fine seduta passa a 2 e si salva.
  const amend = page.getByRole("region", { name: "Rettifica in corso" });
  await expect(amend).toContainText("Motivo della rettifica: Dolore a fine seduta scritto male");
  await painValue(page, PAIN_END, 2).click();
  await expect(amend.getByRole("list", { name: "Modifiche da salvare" }).getByRole("listitem")).toHaveCount(1);
  // Uscire con la rettifica non salvata dice che si perde tutta la rettifica; «Torna indietro» resta qui.
  await page.locator("header").getByRole("link", { name: "Marco Bellandi" }).click();
  const leave = page.getByRole("alertdialog", { name: "Uscire senza salvare?" });
  await expect(leave).toContainText("La rettifica non è ancora salvata: le modifiche andranno perse.");
  await leave.getByRole("button", { name: "Torna indietro" }).click();
  await expect(leave).toHaveCount(0);
  await expect(page).toHaveURL(EDITOR_URL);
  await amend.getByRole("button", { name: "Salva la rettifica" }).click();
  await expect(page.getByText("Rettifica salvata.")).toBeVisible();

  // L'editor torna in sola lettura con il 2; la cronologia dice «6 → 2» e «Rettificata il 04/11/2026».
  await expect(painValue(page, PAIN_END, 2)).toHaveAttribute("aria-checked", "true");
  await expect(painValue(page, PAIN_END, 2)).toBeDisabled();
  await expect(page.getByRole("region", { name: "Rettifica in corso" })).toHaveCount(0);
  await expect(page.getByText("Rettificata il 04/11/2026", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Marco Bellandi" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  const today = page
    .getByRole("region", { name: "Cronologia" })
    .getByRole("listitem")
    .filter({ hasText: "mer 4 nov" });
  await expect(today).toContainText("Dolore 0-10: 6 → 2");
  await expect(today).toContainText("Rettificata il 04/11/2026");

  // Oggi ha gli stessi conteggi di prima.
  expect(await todayCounts()).toEqual(before);
});

test("passo 9: l'export per l'elenco speciale di ottobre non rivela nessun dato degli assistiti", async ({ page }) => {
  await page.goto("/fatture?tab=emesse&mese=2026-10");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Esporta per l'elenco speciale" }).click();
  const dialog = page.getByRole("dialog", { name: "Esporta per l'elenco speciale" });
  await expect(dialog.getByLabel("Da", { exact: true })).toHaveValue("2026-10");
  await expect(dialog.getByLabel("A", { exact: true })).toHaveValue("2026-10");
  await expect(dialog.getByRole("status")).toContainText(/Documenti: [1-9]\d*/);
  const counted = Number(/Documenti: (\d+)/.exec((await dialog.getByRole("status").textContent()) ?? "")?.[1]);

  // Chromium senza interfaccia può scaricare anche il PDF dell'anteprima nell'iframe: si aspetta lo ZIP.
  const download = page.waitForEvent("download", { predicate: (file) => file.suggestedFilename().endsWith(".zip") });
  await dialog.getByRole("button", { name: "Scarica ZIP" }).click();
  const zipFile = await download;
  // Chromium senza interfaccia interrompe la navigazione dell'iframe dell'anteprima (requestfailed ERR_ABORTED,
  // poi download «anteprima-oscurata.pdf»); dopo, ogni richiesta ha il suo requestfinished o requestfailed ma
  // `networkidle` non torna, mentre un download `blob:` senza quell'iframe (passo 6) non lo blocca: la pagina si
  // ricarica per il controllo di afterEach.
  await dialog.getByRole("button", { name: "Torna indietro" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const files = unzipSync(new Uint8Array(await readFile((await zipFile.path()) ?? "")));
  const names = Object.keys(files);
  expect(names).toContain("LEGGIMI.txt");
  expect(names).toContain("indice.csv");
  const pdfs = names.filter((name) => name.endsWith(".pdf"));
  expect(pdfs.length).toBeGreaterThan(0);
  // Il conteggio del dialogo, quello del LEGGIMI, i PDF e le righe dell'indice (più l'intestazione) sono uguali.
  const readme = strFromU8(files["LEGGIMI.txt"] ?? new Uint8Array());
  expect(Number(/^Documenti: (\d+)\./m.exec(readme)?.[1])).toBe(pdfs.length);
  expect(pdfs).toHaveLength(counted);
  const index = strFromU8(files["indice.csv"] ?? new Uint8Array());
  expect(index.trim().split("\n")).toHaveLength(pdfs.length + 1);

  const needles = seedForbidden("2026-11-04");
  expect(needles.length).toBeGreaterThan(0);
  expect(findForbidden(names.join("\n"), needles)).toEqual([]);
  expect(findForbidden(readme, needles)).toEqual([]);
  expect(findForbidden(index, needles)).toEqual([]);
  let redacted = 0;
  for (const name of pdfs) {
    const { text, info } = await pdfText(files[name] ?? new Uint8Array());
    expect(findForbidden(text, needles), name).toEqual([]);
    expect(findForbidden(Object.values(info).join("\n"), needles), `${name} (Info)`).toEqual([]);
    if (text.includes("Dati dell'assistito oscurati")) redacted += 1;
  }
  expect(redacted).toBeGreaterThan(0);
});

test("passo 10: Fisco con l'esempio in ordinario, il forfettario salvato, il Listino e il tema", async ({ page }) => {
  await page.goto("/impostazioni/fisco");
  await page.waitForLoadState("networkidle");
  const main = page.locator("main#contenuto");
  const flat = main.getByRole("radio", { name: "Forfettario", exact: true });
  await expect(flat).toBeChecked();
  const example = main.getByRole("status", { name: "Esempio dal vivo" });

  // In ordinario i 55,00 € della seduta comprendono l'IVA: 45,08 € di compenso e 9,92 € di IVA, niente bollo.
  await main.getByRole("radio", { name: "Ordinario con IVA 22%", exact: true }).check();
  await expect(example).toContainText("55,00");
  await expect(example).toContainText("45,08");
  await expect(example).toContainText("9,92");
  await expect(example).toContainText("niente bollo");
  await expect(example).not.toContainText("più bollo");

  // Tornato al forfettario, "Salva" non chiede conferma: il regime è quello salvato.
  await flat.check();
  await expect(example).toContainText("compenso 55,00 €, niente IVA");
  await main.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: "Cambiare il regime fiscale?" })).toHaveCount(0);
  await page.reload();
  await expect(flat).toBeChecked();

  await page.goto("/listino");
  await expect(page.getByRole("paragraph").filter({ hasText: /^Regime forfettario:/ })).toHaveText(
    "Regime forfettario: le fatture non hanno IVA e riportano il bollo da 2 € sopra 77,47 €. Si cambia in Impostazioni, Fisco.",
  );

  // Il tema scuro e quello chiaro senza errori in console (li controlla afterEach), anche su una pagina con le fatture.
  const html = page.locator("html");
  await page.goto("/impostazioni/aspetto");
  await page.locator("main#contenuto").getByRole("button", { name: "Scuro" }).click();
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await page.goto("/fatture?tab=emesse&mese=2026-11");
  await page.waitForLoadState("networkidle");
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await page.goto("/impostazioni/aspetto");
  await page.locator("main#contenuto").getByRole("button", { name: "Chiaro" }).click();
  await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
});
