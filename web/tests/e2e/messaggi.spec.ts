import path from "node:path";
import { expect, type Locator, type Page, type Request, type Route, test } from "@playwright/test";

// Il compositore dei messaggi e la riga del promemoria sulla demo
// dei test: seed del 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts, l'ora di ogni riga). Il promemoria
// è per gli appuntamenti di domani: il file crea il suo appuntamento di Valentina Greco (tu, cellulare,
// consenso WhatsApp firmato) giovedì 5/11 alle 20:00, fuori orario e dopo le righe del seed che altri file contano,
// e lo annulla alla fine: le righe del registro restano (non si cancellano mai), su un appuntamento annullato, che
// esce dai promemoria. Chiara, Elisa e Paolo del 5/11 non si toccano. Il canale preferito e il numero per le prove
// tornano come prima dentro il test che li cambia.
// Nessun invio e nessuna rete: ogni apertura di wa.me è intercettata con una pagina finta (WA_PAGE). Il file prova anche
// la cronologia visibile e la testata su un minore proprio; l'appuntamento si annulla e le impostazioni si ripristinano.
test.describe.configure({ mode: "serial" });

const DAY = "2026-11-05";
const RANGE = "20:00-20:45";
const BODY =
  "Ciao Valentina, ti ricordo l'appuntamento di domani, giovedì 5 novembre, alle 20:00, in Via delle Prove 7, Bologna. " +
  "Se non riesci a venire, avvisami qui: così posso dare l'orario a qualcun altro. A presto. " +
  "Laura Benedetti, Studio Osteopatico Borgo Tiglio";
const DEMO_NOTICE = "Dati di prova: il messaggio va al numero per le prove.";
const COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
const COPY_FAILED = "Copia non riuscita: premi Ctrl+C per copiare il testo selezionato.";
const COPY_NOT_LOGGED = "Messaggio copiato, ma non registrato. Riprova a registrarlo.";
const TOO_LONG = "Il messaggio supera i 700 caratteri: accorcialo prima di copiare.";
const TEST_PHONE = "333 000 0099";
// La pagina finta di wa.me è un documento vero: Playwright dà l'evento «popup» solo quando la scheda nuova ha
// caricato un documento, e una risposta 204 non ne carica nessuno. L'icona inline evita la richiesta della favicon.
const WA_PAGE = { status: 200, contentType: "text/html", body: '<!doctype html><link rel="icon" href="data:,"><title>WhatsApp</title>' };

// Un errore di una risorsa o un'eccezione della pagina arriva dopo il titolo: lo controlla afterEach.
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

type Recorded = { id: string; body: string; action: string };

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

/** Le chiamate di recordMessageAction e setMessageOutcomeAction partite dalla pagina, in ordine. */
function watchActions(page: Page): { records: Recorded[]; outcomes: unknown[] } {
  const records: Recorded[] = [];
  const outcomes: unknown[] = [];
  page.on("request", (request) => {
    const input = actionInput(request);
    if (input === null) return;
    if (typeof input.action === "string" && typeof input.body === "string" && typeof input.id === "string") {
      records.push({ id: input.id, body: input.body, action: input.action });
    } else if ("outcome" in input) {
      outcomes.push(input);
    }
  });
  return { records, outcomes };
}

type Reply = { status: number; text: string };

/**
 * La risposta della prossima recordMessageAction con quell'azione, letta da Playwright mentre passa. Il corpo
 * non si chiede a Chromium dopo (`response.text()`): la risposta di una Server Action arriva in streaming e
 * Chromium a volte non la conserva («No data found for resource with given identifier»).
 */
async function recordReply(page: Page, action: "copiato" | "whatsapp_aperto"): Promise<{ reply: Promise<Reply> }> {
  let taken = false;
  let resolve: (reply: Reply) => void = () => undefined;
  const reply = new Promise<Reply>((fulfill) => {
    resolve = fulfill;
  });
  await page.route("**/agenda**", async (route: Route) => {
    if (taken || actionInput(route.request())?.action !== action) return route.fallback();
    taken = true;
    const response = await route.fetch();
    resolve({ status: response.status(), text: await response.text() });
    await route.fulfill({ response });
  });
  // In un oggetto: una Promise restituita da una funzione async si aspetterebbe qui, prima del clic.
  return { reply };
}

/** Il server ha scritto la riga: un ActionResult ok con quell'id, non un rifiuto. */
function expectStored(reply: Reply, id: string | undefined): void {
  expect(reply.status).toBe(200);
  expect(reply.text).toContain('"ok":true');
  expect(reply.text).toContain(`"id":"${id}"`);
}

/** Il blocco dell'appuntamento del file nell'agenda del giorno. */
function block(page: Page): Locator {
  return page.locator(`[data-day="${DAY}"]`).getByRole("button", { name: new RegExp(`^${RANGE}, Greco Valentina, `) });
}

function detailOf(page: Page): Locator {
  return page.getByRole("dialog", { name: "Valentina Greco", exact: true });
}

function composerOf(page: Page): Locator {
  return page.getByRole("dialog", { name: "Prepara il messaggio" });
}

/** Il dettaglio dell'appuntamento del file, dall'agenda del 5/11. */
async function openDetail(page: Page): Promise<Locator> {
  await page.goto(`/agenda?vista=giorno&data=${DAY}`);
  await page.waitForLoadState("networkidle");
  await block(page).click();
  const detail = detailOf(page);
  await expect(detail).toBeVisible();
  return detail;
}

/** «Promemoria per domani» di Oggi; il conteggio lo cambiano altri file. */
async function remindersOf(page: Page): Promise<Locator> {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");
  const region = page.getByRole("region", { name: /^Promemoria per domani, giovedì 5 \(\d+\)$/ });
  await expect(region).toBeVisible();
  return region;
}

/** La riga di Valentina in «Promemoria per domani». */
async function reminderRowOf(page: Page): Promise<Locator> {
  return (await remindersOf(page)).getByRole("listitem").filter({ hasText: "Valentina Greco" });
}

/** Dall'agenda del 5/11 al compositore del promemoria, come fa chi la usa. */
async function openComposer(page: Page): Promise<Locator> {
  const detail = await openDetail(page);
  await detail.getByRole("button", { name: "Prepara il promemoria" }).click();
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Testo del messaggio" })).toHaveValue(BODY);
  return composer;
}

/** Il canale preferito di Valentina dalla sua Anagrafica, in un'altra scheda. */
async function setChannel(page: Page, channel: "Telefono" | "WhatsApp"): Promise<void> {
  await page.goto("/pazienti?q=Greco");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Greco Valentina" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Valentina Greco" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Anagrafica" }).click();
  await expect(page).toHaveURL(/tab=anagrafica/);
  await page.waitForLoadState("networkidle");
  const group = page.getByRole("region", { name: "Contatti e preferenze" });
  await group.getByLabel(/^Canale preferito/).click();
  await page.getByRole("option", { name: channel, exact: true }).click();
  await group.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
}

/** Il numero per le prove WhatsApp di Impostazioni, Dati di prova; vuoto lo toglie. */
async function setTestPhone(page: Page, phone: string): Promise<void> {
  await page.goto("/impostazioni/dati-di-prova");
  await page.waitForLoadState("networkidle");
  await page.getByLabel(/^Numero per le prove WhatsApp/).fill(phone);
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
}

/** Il ritorno sulla scheda dopo WhatsApp o un'altra finestra: l'evento che il browser manda alla finestra. */
async function returnToPage(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test("il promemoria dal dettaglio dell'agenda: testo compilato, «Copia» predefinita e WhatsApp col suo avviso", async ({
  page,
}) => {
  await page.goto(`/agenda?vista=giorno&data=${DAY}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await dialog.getByLabel("Paziente").fill("Greco");
  await page.getByRole("option", { name: "Greco Valentina" }).click();
  await dialog.getByLabel("Data", { exact: true }).fill(DAY);
  await dialog.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "20:00", exact: true }).click();
  await expect(dialog.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(block(page)).toBeVisible();

  const composer = await openComposer(page);
  await expect(composer.getByText("A Valentina Greco", { exact: true })).toBeVisible();
  await expect(composer.getByText(`${Array.from(BODY).length} di 700 caratteri`)).toBeVisible();
  await expect(composer.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();

  // Esc chiude il compositore e il focus torna al pulsante che l'ha aperto.
  await page.keyboard.press("Escape");
  await expect(composer).toBeHidden();
  await expect(detailOf(page).getByRole("button", { name: "Prepara il promemoria" })).toBeFocused();
});

/** Ogni link WhatsApp in `scope` porta il prefisso atteso e ha accanto, e come descrizione, l'avviso della demo. */
async function expectDemoNotice(scope: Locator, prefix: string): Promise<void> {
  const anchors = scope.locator('a[href^="https://wa.me/"]');
  await expect(anchors).not.toHaveCount(0);
  for (const anchor of await anchors.all()) {
    expect(await anchor.getAttribute("href")).toMatch(new RegExp(`^${prefix.replace(/[.?/]/g, "\\$&")}`));
    await expect(anchor).toHaveAccessibleDescription(DEMO_NOTICE);
    await expect(anchor.locator("xpath=following-sibling::*[1]")).toHaveText(DEMO_NOTICE);
  }
}

// Le due prove della riga del promemoria vengono subito dopo la creazione: la riga parte «Da inviare».
test("esito_riga_e_dettaglio: dopo WhatsApp o la copia la riga chiede se è stato inviato, e Sì o No valgono sulla riga e sul dettaglio", async ({
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
  const { records, outcomes } = watchActions(page);

  // Nessuna riga: «Da inviare», con il vero link del testo compilato e la copia.
  let row = await reminderRowOf(page);
  await expect(row).toContainText("20:00");
  await expect(row.getByText("Da inviare", { exact: true })).toBeVisible();
  const anchor = row.getByRole("link", { name: "Apri WhatsApp" });
  await expect(anchor).toHaveAttribute("href", `https://wa.me/?text=${encodeURIComponent(BODY)}`);
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAttribute("rel", "noopener");
  await expect(row.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();

  // L'apertura registra «whatsapp_aperto»; al ritorno sulla pagina la riga chiede, e niente parte da solo.
  const [popup] = await Promise.all([page.waitForEvent("popup"), anchor.click()]);
  await expect.poll(() => opened.length).toBe(1);
  await expect.poll(() => records.length).toBe(1);
  expect(records[0]).toMatchObject({ body: BODY, action: "whatsapp_aperto" });
  await popup.close();
  await returnToPage(page);
  const openedQuestion = row.getByRole("group", { name: "Aperto alle 08:30, inviato?" });
  await expect(openedQuestion).toBeVisible();
  await expect(row.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  await expect(row.getByText(/^Inviato alle/)).toHaveCount(0);
  expect(outcomes).toEqual([]);

  // Il dettaglio mostra la stessa domanda; «Sì» lì vale anche sulla riga di Oggi.
  let detail = await openDetail(page);
  const detailQuestion = detail.getByRole("group", { name: "Aperto alle 08:30, inviato?" });
  await expect(detailQuestion).toBeVisible();
  expect(outcomes).toEqual([]);
  await detailQuestion.getByRole("button", { name: "Sì" }).click();
  await expect(detail.getByText("Inviato alle 08:30", { exact: true })).toBeVisible();
  await expect(detail.getByRole("group", { name: /inviato\?$/ })).toHaveCount(0);
  await expect(detail.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  expect(outcomes).toEqual([{ id: records[0]?.id, outcome: "inviato" }]);
  row = await reminderRowOf(page);
  await expect(row.getByText("Inviato alle 08:30", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);

  // Una copia dal compositore del dettaglio è un'altra riga, da confermare: «Copiato», non «Aperto».
  detail = await openDetail(page);
  await detail.getByRole("button", { name: "Prepara il promemoria" }).click();
  const composer = composerOf(page);
  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(composer.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  await expect.poll(() => records.length).toBe(2);
  expect(records[1]).toMatchObject({ body: BODY, action: "copiato" });
  // Il pulsante «Chiudi» in fondo al compositore, non la crocetta del dialogo che ha lo stesso nome.
  await composer.getByRole("button", { name: "Chiudi" }).and(composer.locator("[data-slot=button]")).click();
  await expect(composer).toBeHidden();
  const copiedQuestion = detail.getByRole("group", { name: "Copiato alle 08:30, inviato?" });
  await expect(copiedQuestion).toBeVisible();

  // «No» nel dettaglio: «Non inviato» e di nuovo le azioni, qui e su Oggi.
  await copiedQuestion.getByRole("button", { name: "No" }).click();
  await expect(detail.locator("dl").getByText("Non inviato", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: "Apri WhatsApp" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();
  row = await reminderRowOf(page);
  await expect(row.getByText("Non inviato", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Apri WhatsApp" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();

  // Solo le due dichiarazioni dell'osteopata, sulle due righe; nessun invio e nessuna rete fuori da wa.me.
  expect(outcomes).toEqual([
    { id: records[0]?.id, outcome: "inviato" },
    { id: records[1]?.id, outcome: "non_inviato" },
  ]);
  expect(records).toHaveLength(2);
  expect(external.every((url) => url.startsWith("https://wa.me/"))).toBe(true);
});

test("avviso_demo_riga_promemoria: accanto a ogni link WhatsApp dei promemoria di Oggi e del dettaglio c'è l'avviso dei dati di prova, anche col numero per le prove", async ({
  page,
}) => {
  // Senza numero per le prove: nessun numero nel link, mai quello del paziente.
  await expectDemoNotice(await remindersOf(page), "https://wa.me/?text=");
  await expectDemoNotice(await openDetail(page), "https://wa.me/?text=");

  await setTestPhone(page, TEST_PHONE);
  try {
    await expectDemoNotice(await remindersOf(page), "https://wa.me/393330000099?text=");
    const detail = await openDetail(page);
    await expectDemoNotice(detail, "https://wa.me/393330000099?text=");
    expect(await detail.getByRole("link", { name: "Apri WhatsApp" }).getAttribute("href")).not.toContain("393350000015");
  } finally {
    await setTestPhone(page, "");
  }
});

test("copia_e_registro: la copia mette negli appunti il testo e registra una riga «copiato» con quel testo", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { records, outcomes } = watchActions(page);
  const composer = await openComposer(page);

  const stored = await recordReply(page, "copiato");
  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(composer.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(BODY);
  // Prima la risposta del server, poi i controlli negativi: un rifiuto non passa per buono.
  expectStored(await stored.reply, records[0]?.id);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ body: BODY, action: "copiato" });
  await expect(composer.getByText(COPY_NOT_LOGGED)).toHaveCount(0);
  await expect(composer.getByRole("alert")).toHaveCount(0);
  // Una copia non è un invio: nessuna dichiarazione parte da sola.
  expect(outcomes).toEqual([]);

  // La riga c'è sul server: l'esito di quell'id si dichiara (setMessageOutcome rifiuta un id che non esiste).
  const question = composer.getByRole("group", { name: "Hai inviato il messaggio?" });
  await question.getByRole("button", { name: "No" }).click();
  await expect(question.getByRole("status")).toHaveText("Segnato come non inviato.");
  expect(outcomes).toEqual([{ id: records[0]?.id, outcome: "non_inviato" }]);

  // Un ritocco dopo la copia toglie «Messaggio copiato» e la domanda: parlavano del testo di prima.
  await composer.getByRole("textbox", { name: "Testo del messaggio" }).fill(`${BODY} Grazie.`);
  await expect(composer.getByText(COPIED)).toHaveCount(0);
  await expect(question).toHaveCount(0);
});

test("clipboard_negata: copia rifiutata, testo selezionato e nessuna riga fino a «Ho copiato il testo»", async ({ page }) => {
  const { records } = watchActions(page);
  const composer = await openComposer(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Permesso negato", "NotAllowedError")),
    });
  });

  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  const manual = composer.getByRole("textbox", { name: COPY_FAILED });
  await expect(manual).toBeVisible();
  await expect(manual).toBeFocused();
  await expect(manual).toHaveValue(BODY);
  const selected = await manual.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    return area.value.slice(area.selectionStart, area.selectionEnd);
  });
  expect(selected).toBe(BODY);
  // Nessun falso «copiato»: né il messaggio, né la riga.
  await expect(composer.getByText(COPIED)).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(records).toEqual([]);

  // La dichiarazione della copia manuale registra quel testo, una volta; il focus passa a «Apri WhatsApp».
  const stored = await recordReply(page, "copiato");
  await composer.getByRole("button", { name: "Ho copiato il testo" }).click();
  await expect(composer.getByRole("link", { name: "Apri WhatsApp" })).toBeFocused();
  expectStored(await stored.reply, records[0]?.id);
  await expect(composer.getByRole("status").filter({ hasText: "Copia registrata." })).toBeVisible();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ body: BODY, action: "copiato" });
});

test("log_fallito: il registro non arrivato si riprova con lo stesso id, senza ricopiare", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { records } = watchActions(page);
  const composer = await openComposer(page);

  // La prima richiesta del registro non arriva al server.
  let dropped = false;
  await page.route("**/agenda**", async (route) => {
    const input = actionInput(route.request());
    if (!dropped && input !== null && input.action === "copiato") {
      dropped = true;
      await route.abort();
      return;
    }
    await route.fallback();
  });

  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(composer.getByText(COPY_NOT_LOGGED)).toBeVisible();
  // L'unico errore atteso è la richiesta interrotta di proposito, una volta: si toglie qui, così un errore che
  // arriva dopo resta, e afterEach non scambia questo per un difetto se il test si ferma prima della fine.
  const aborted = (entry: string) =>
    entry.startsWith("Failed to load resource: net::ERR_FAILED @ ") && entry.endsWith(`/agenda?vista=giorno&data=${DAY}`);
  await expect.poll(() => consoleErrors.filter(aborted)).toHaveLength(1);
  consoleErrors = consoleErrors.filter((entry) => !aborted(entry));
  // La copia è riuscita: il messaggio resta nel compositore per il retry.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(BODY);
  await expect(composer.getByRole("textbox", { name: "Testo del messaggio" })).toHaveValue(BODY);

  const stored = await recordReply(page, "copiato");
  await composer.getByRole("button", { name: "Riprova" }).click();
  // Prima la risposta del retry, poi i record letti e il controllo che l'errore è sparito.
  const reply = await stored.reply;
  const [first, retry] = records;
  expect(retry?.id).toBe(first?.id);
  expect(retry).toMatchObject({ body: BODY, action: "copiato" });
  expectStored(reply, first?.id);
  await expect(composer.getByText(COPY_NOT_LOGGED)).toBeHidden();
  expect(records).toHaveLength(2);

  // La riga del primo id c'è: la sua dichiarazione va a buon fine.
  const question = composer.getByRole("group", { name: "Hai inviato il messaggio?" });
  await question.getByRole("button", { name: "Sì" }).click();
  await expect(question.getByRole("status")).toHaveText("Segnato come inviato.");
});

test("ritocco_durante_preview: una rilettura lenta non sovrascrive il testo ritoccato; oltre 700 caratteri blocca", async ({
  page,
}) => {
  const composer = await openComposer(page);
  const text = composer.getByRole("textbox", { name: "Testo del messaggio" });

  // La rilettura del ritorno sulla scheda arriva dopo il ritocco.
  let slow: Promise<unknown> | null = null;
  await page.route("**/agenda**", async (route) => {
    const input = actionInput(route.request());
    if (slow === null && input !== null && input.kind === "appointment") {
      slow = new Promise((resolve) => setTimeout(resolve, 1500));
      await slow;
    }
    await route.fallback();
  });
  const answered = page.waitForResponse((response) => {
    const input = actionInput(response.request());
    return input !== null && input.kind === "appointment";
  });
  await returnToPage(page);
  const edited = `${BODY} Grazie.`;
  await text.fill(edited);
  await answered;
  await page.waitForLoadState("networkidle");
  await expect(text).toHaveValue(edited);

  // 701 caratteri: né copia né WhatsApp, con il motivo sotto il campo; 700 tornano a posto.
  await text.fill("a".repeat(701));
  await expect(composer.getByText("701 di 700 caratteri")).toBeVisible();
  await expect(composer.getByText(TOO_LONG).first()).toBeVisible();
  await expect(text).toHaveAttribute("aria-invalid", "true");
  await expect(composer.getByRole("button", { name: "Copia", exact: true })).toBeDisabled();
  await expect(composer.getByRole("link", { name: "Apri WhatsApp" })).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Apri WhatsApp" })).toBeDisabled();
  await text.fill("a".repeat(700));
  await expect(composer.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();
  await expect(composer.getByRole("link", { name: "Apri WhatsApp" })).toHaveAttribute(
    "href",
    `https://wa.me/?text=${"a".repeat(700)}`,
  );
});

test("anchor_reale: il vero link apre WhatsApp col testo, registra «whatsapp_aperto» e chiede se è stato inviato", async ({
  page,
  context,
}) => {
  const opened: string[] = [];
  await context.route("https://wa.me/**", (route) => {
    opened.push(route.request().url());
    return route.fulfill(WA_PAGE);
  });
  const external: string[] = [];
  context.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  const { records, outcomes } = watchActions(page);
  const composer = await openComposer(page);

  // Testo ritoccato: il link porta quello, codificato, e nella demo nessun numero.
  const edited = `${BODY} A giovedì & grazie!`;
  await composer.getByRole("textbox", { name: "Testo del messaggio" }).fill(edited);
  const href = `https://wa.me/?text=${encodeURIComponent(edited)}`;
  const anchor = composer.getByRole("link", { name: "Apri WhatsApp" });
  await expect(anchor).toHaveAttribute("href", href);
  await expect(anchor).toHaveAttribute("target", "_blank");
  await expect(anchor).toHaveAttribute("rel", "noopener");

  const [popup] = await Promise.all([page.waitForEvent("popup"), anchor.click()]);
  // Il browser apre l'indirizzo nella forma del parser URL, che nella query scrive l'apostrofo come %27: è lo
  // stesso testo. Il valore esatto dell'attributo l'ha già controllato toHaveAttribute.
  await expect.poll(() => opened).toEqual([new URL(href).href]);
  expect(new URL(opened[0] ?? "").searchParams.get("text")).toBe(edited);
  await expect.poll(() => records.length).toBe(1);
  expect(records[0]).toMatchObject({ body: edited, action: "whatsapp_aperto" });
  await popup.close();
  await returnToPage(page);

  // Da confermare: la domanda, mai «Inviato» da solo.
  const question = composer.getByRole("group", { name: "Hai inviato il messaggio?" });
  await expect(question).toBeVisible();
  await expect(composer.getByText("Segnato come inviato.")).toHaveCount(0);
  expect(outcomes).toEqual([]);

  // «Inviato» solo dalla dichiarazione dell'osteopata, sulla stessa riga.
  await question.getByRole("button", { name: "Sì" }).click();
  await expect(question.getByRole("status")).toHaveText("Segnato come inviato.");
  expect(outcomes).toEqual([{ id: records[0]?.id, outcome: "inviato" }]);
  expect(records).toHaveLength(1);

  // Il clic centrale apre un'altra scheda senza onClick: anche quella apertura si registra.
  const middle = await recordReply(page, "whatsapp_aperto");
  await anchor.click({ button: "middle" });
  await expect.poll(() => records.length).toBe(2);
  expect(records[1]).toMatchObject({ body: edited, action: "whatsapp_aperto" });
  expectStored(await middle.reply, records[1]?.id);
  for (const other of context.pages()) if (other !== page) await other.close();
  expect(external.every((url) => url.startsWith("https://wa.me/"))).toBe(true);
});

test("avviso_demo_ogni_anchor: accanto a ogni link WhatsApp del compositore c'è l'avviso dei dati di prova, anche col numero per le prove", async ({
  page,
}) => {
  const check = async (composer: Locator, prefix: string) => {
    const anchors = composer.locator('a[href^="https://wa.me/"]');
    await expect(anchors).not.toHaveCount(0);
    for (const anchor of await anchors.all()) {
      expect(await anchor.getAttribute("href")).toMatch(new RegExp(`^${prefix.replace(/[.?/]/g, "\\$&")}`));
      await expect(anchor).toHaveAccessibleDescription(DEMO_NOTICE);
      await expect(anchor.locator("xpath=following-sibling::*[1]")).toHaveText(DEMO_NOTICE);
    }
  };

  // Senza numero per le prove WhatsApp chiede a chi inviare: nessun numero, mai quello di Valentina.
  await check(await openComposer(page), "https://wa.me/?text=");

  // Con il numero per le prove il link va lì, e l'avviso resta.
  await setTestPhone(page, TEST_PHONE);
  try {
    const composer = await openComposer(page);
    await check(composer, "https://wa.me/393330000099?text=");
    expect(await composer.getByRole("link", { name: "Apri WhatsApp" }).getAttribute("href")).not.toContain("393350000015");
  } finally {
    await setTestPhone(page, "");
  }
});

test("canale_cambiato_al_focus: un canale cambiato altrove fa rifiutare il link vecchio e al ritorno il link sparisce", async ({
  page,
  context,
}) => {
  await context.route("https://wa.me/**", (route) => route.fulfill(WA_PAGE));
  const { records } = watchActions(page);
  const composer = await openComposer(page);
  const anchor = composer.getByRole("link", { name: "Apri WhatsApp" });
  await expect(anchor).toBeVisible();

  const other = await context.newPage();
  try {
    // Valentina ora preferisce una telefonata. Il link ancora mostrato si apre, ma il server non lo registra.
    // Senza tornare sulla scheda: il compositore non si è riletto e mostra ancora il link.
    await setChannel(other, "Telefono");
    const [popup] = await Promise.all([page.waitForEvent("popup"), anchor.click()]);
    await popup.close();
    await expect(composer.getByRole("alert")).toHaveText("Preferisce una telefonata");
    expect(records.map((r) => r.action)).toEqual(["whatsapp_aperto"]);
    await expect(composer.getByRole("group", { name: "Hai inviato il messaggio?" })).toHaveCount(0);
    await expect(anchor).toHaveCount(0);

    // Di nuovo WhatsApp: al ritorno sulla scheda il link torna; poi di nuovo telefono, e al ritorno sparisce.
    await setChannel(other, "WhatsApp");
    await returnToPage(page);
    await expect(anchor).toBeVisible();
    await setChannel(other, "Telefono");
    await returnToPage(page);
    await expect(anchor).toHaveCount(0);
    const disabled = composer.getByRole("button", { name: "Apri WhatsApp" });
    await expect(disabled).toBeDisabled();
    await expect(disabled).toHaveAccessibleDescription("Preferisce una telefonata");
    // La copia resta, per un SMS o una telefonata.
    await expect(composer.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();
  } finally {
    await setChannel(other, "WhatsApp");
    await other.close();
  }
});

// I consigli della prima visita di Marco Bellandi, chiusa nel seed con «Pause attive al computer» a voce (consenso
// WhatsApp firmato, Tu). La copia aggiunge «Messaggio copiato» con una rettifica: nessun file dopo questo legge i
// canali o le rettifiche di quella visita.
const ADVICE_BODY =
  "Ciao Marco, come promesso ecco i consigli di oggi: Ogni 45 minuti alzati, cammina un minuto e muovi spalle e collo. " +
  "Se nei prossimi giorni noti qualcosa di insolito, scrivimi. Laura Benedetti, Studio Osteopatico Borgo Tiglio";
const ADVICE_REASON = "Registrata la preparazione del messaggio con i consigli.";

test("consigli_lettura_chiusa: dalla visita chiusa in lettura «Copia il messaggio» avvisa della rettifica, apre il compositore con «Copia» e aggiunge il canale", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { records } = watchActions(page);
  await page.goto("/pazienti?q=Bellandi");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Bellandi Marco" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Marco Bellandi" })).toBeVisible();
  // Il messaggio con i consigli porta dati sanitari: si prepara solo dalla visita, non dalla scheda.
  await expect(page.getByRole("button", { name: "Copia il messaggio" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  // La prima visita; quella di oggi (mer 4 nov) c'è solo dopo demo.spec.ts.
  const first = page
    .getByRole("region", { name: "Cronologia" })
    .getByRole("listitem")
    .filter({ hasNotText: "mer 4 nov" })
    .getByRole("link", { name: "Vedi la visita" });
  await expect(first).toHaveCount(1);
  await first.click();
  await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]{36}\/visite\/[0-9a-f-]{36}$/);
  await page.waitForLoadState("networkidle");

  // In lettura il canale non si sceglie a mano (serve la rettifica), ma il messaggio si prepara.
  await expect(page.getByRole("button", { name: "Rettifica", exact: true })).toBeVisible();
  const channels = page.getByRole("group", { name: "Canale: Pause attive al computer" });
  const copiedChannel = channels.getByRole("button", { name: "Messaggio copiato" });
  await expect(copiedChannel).toHaveAttribute("aria-pressed", "false");
  await expect(copiedChannel).toBeDisabled();
  const prepare = page.getByRole("button", { name: "Copia il messaggio", exact: true });
  await expect(prepare).toBeEnabled();

  // Prima la spiegazione della rettifica automatica; «Torna indietro» non apre niente e non registra niente.
  await prepare.click();
  const confirm = page.getByRole("alertdialog", { name: "La visita è chiusa" });
  await expect(confirm).toContainText(`«${ADVICE_REASON}»`);
  await confirm.getByRole("button", { name: "Torna indietro" }).click();
  await expect(confirm).toBeHidden();
  await expect(composerOf(page)).toHaveCount(0);
  await prepare.click();
  await confirm.getByRole("button", { name: "Prepara il messaggio" }).click();
  const composer = composerOf(page);
  await expect(composer).toBeVisible();
  await expect(composer.getByText("Consigli", { exact: true })).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Testo del messaggio" })).toHaveValue(ADVICE_BODY);
  expect(records).toEqual([]);

  // «Copia» è l'azione predefinita: copia il testo e registra la riga, che aggiunge il canale con la rettifica.
  await expect(composer.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();
  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(composer.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADVICE_BODY);
  await expect(composer.getByRole("group", { name: "Hai inviato il messaggio?" })).toBeVisible();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ body: ADVICE_BODY, action: "copiato" });

  // Chiuso il compositore l'editor rilegge la visita: resta in lettura, con il canale e la rettifica di oggi.
  await composer.getByRole("button", { name: "Chiudi" }).and(composer.locator("[data-slot=button]")).click();
  await expect(composer).toBeHidden();
  await expect(copiedChannel).toHaveAttribute("aria-pressed", "true");
  await expect(copiedChannel).toBeDisabled();
  await expect(channels.getByRole("button", { name: "A voce" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Rettificata il 04/11/2026", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rettifica", exact: true })).toBeVisible();
});

test("cronologia_e_testata: vuoto, genitore, link senza testo, esito correggibile e corpo espandibile", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.route("https://wa.me/**", (route) => route.fulfill(WA_PAGE));
  const { records, outcomes } = watchActions(page);
  const empty = "Nessun messaggio preparato per questo paziente.";
  const historicalBody = "Messaggio storico per il genitore.";
  await page.goto("/impostazioni/dati-di-prova");
  await page.waitForLoadState("networkidle");
  const previousTestPhone = await page.getByLabel(/^Numero per le prove WhatsApp/).inputValue();
  let ownAppointment = false;
  try {
    await setTestPhone(page, "");
    // Paziente proprio: nessuna dipendenza dai log o dai consensi dei pazienti del seed.
    await page.goto("/pazienti");
    await page.getByRole("button", { name: "Nuovo paziente" }).click();
    const create = page.getByRole("dialog", { name: "Nuovo paziente" });
    await create.getByLabel(/^Nome/).first().fill("Minore");
    await create.getByLabel(/^Cognome/).first().fill("Cronologia");
    await create.getByLabel(/^Data di nascita/).fill("2017-06-15");
    // Il cellulare del minore non deve diventare il destinatario del messaggio.
    await create.getByLabel(/^Telefono/).first().fill("333 000 0088");
    const guardian = create.getByRole("group", { name: "Genitore o tutore" });
    await guardian.getByLabel(/^Nome/).fill("Elena");
    await guardian.getByLabel(/^Cognome/).fill("Cronologia");
    await create.getByRole("button", { name: "Salva e apri la scheda" }).click();
    await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]{36}$/);
    const patientUrl = new URL(page.url()).pathname;
    const nav = page.getByRole("navigation", { name: "Sezioni della scheda" });
    await expect(page.getByRole("button", { name: "Apri WhatsApp", exact: true })).toBeDisabled();
    await expect(page.getByText("Numero mancante", { exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Messaggi", exact: true }).click();
    await expect(page).toHaveURL(/tab=messaggi/);
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveText(["Riepilogo", "Cartella", "Appuntamenti", "Consensi", "Fatture", "Messaggi", "Anagrafica"]);

    // Il genitore diventa madre con cellulare: prima del consenso il link resta fermo.
    await nav.getByRole("link", { name: "Anagrafica" }).click();
    const mother = page.getByRole("region", { name: "Genitori o tutori" }).getByRole("form", { name: /Elena Cronologia/ });
    await mother.getByLabel(/^Relazione/).click();
    await page.getByRole("option", { name: "Madre", exact: true }).click();
    await mother.getByLabel(/^Telefono/).fill("333 000 0077");
    await mother.getByLabel(/^Indirizzo/).fill("Via della Prova 5");
    await mother.getByLabel(/^CAP/).fill("40100");
    await mother.getByLabel(/^Città/).fill("Bologna");
    await mother.getByLabel(/^Provincia/).fill("BO");
    await mother.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(page.getByText("Modifiche salvate.").last()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Apri WhatsApp", exact: true })).toBeDisabled();
    await expect(page.getByText("Manca il consenso WhatsApp", { exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Consensi" }).click();
    await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
    const consent = page.getByRole("dialog", { name: "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)" });
    await consent.getByRole("radio", { name: "Firma su carta e carico il modulo" }).click();
    await consent.getByRole("radiogroup", { name: "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp." }).getByRole("radio", { name: "Sì" }).click();
    await consent.getByRole("radiogroup", { name: "Acconsento a essere ricontattato/a per i controlli periodici." }).getByRole("radio", { name: "No" }).click();
    await consent.getByLabel(/^Modulo firmato/).setInputFiles(path.join(import.meta.dirname, "fixtures", "foto-prova.jpg"));
    await consent.getByLabel(/^Data della firma/).fill("2026-11-04");
    await consent.getByRole("button", { name: "Carica il modulo firmato" }).click();
    await expect(consent).toBeHidden();

    await nav.getByRole("link", { name: "Messaggi", exact: true }).click();
    const headerLink = page.getByRole("link", { name: "Apri WhatsApp", exact: true });
    await expect(headerLink).toHaveAttribute("href", "https://wa.me/?text=");
    await expect(headerLink).toHaveAttribute("target", "_blank");
    await expect(headerLink).toHaveAttribute("rel", "noopener");
    await expect(headerLink).toHaveAccessibleDescription(DEMO_NOTICE);
    await expect(page.getByText("A Elena Cronologia (genitore)", { exact: true })).toBeVisible();
    const [headerPopup] = await Promise.all([page.waitForEvent("popup"), headerLink.click()]);
    await headerPopup.close();
    await page.reload();
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    expect(records).toHaveLength(0);

    // Un appuntamento proprio, fuori dalle ore del seed, dà la sorgente al compositore.
    await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
    const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
    await booking.getByLabel("Data", { exact: true }).fill(DAY);
    await booking.getByLabel("Ora di inizio").click();
    await page.getByRole("option", { name: "21:00", exact: true }).click();
    await booking.getByLabel(/^Durata/).click();
    await page.getByRole("option", { name: "60 min", exact: true }).click();
    await booking.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(booking).toBeHidden();
    ownAppointment = true;
    await page.goto(`/agenda?vista=giorno&data=${DAY}`);
    await page.locator(`[data-day="${DAY}"]`).getByRole("button", { name: /21:00-22:00, Cronologia Minore,/ }).click();
    const detail = page.getByRole("dialog", { name: "Minore Cronologia", exact: true });
    await detail.getByRole("button", { name: "Prepara il promemoria" }).click();
    const composer = composerOf(page);
    await composer.getByRole("textbox", { name: "Testo del messaggio" }).fill(historicalBody);
    await composer.getByRole("button", { name: "Copia", exact: true }).click();
    await expect(composer.getByRole("status").filter({ hasText: COPIED })).toBeVisible();
    await expect.poll(() => records.length).toBe(1);
    const [messagePopup] = await Promise.all([page.waitForEvent("popup"), composer.getByRole("link", { name: "Apri WhatsApp" }).click()]);
    await messagePopup.close();
    await expect.poll(() => records.length).toBe(2);
    await composer.getByRole("button", { name: "Chiudi" }).and(composer.locator("[data-slot=button]")).click();
    const detailHistory = detail.getByRole("region", { name: "Messaggi dell'appuntamento" });
    await expect(detailHistory.getByRole("listitem")).toHaveCount(2);
    await page.goto(`${patientUrl}?tab=messaggi`);
    const history = page.getByRole("list", { name: "Cronologia messaggi" });
    await expect(history.getByRole("listitem")).toHaveCount(2);
    const copied = history.locator(`[data-message-id="${records[0]?.id}"]`);
    const opened = history.locator(`[data-message-id="${records[1]?.id}"]`);
    await expect(copied.getByText("Copiato", { exact: true })).toBeVisible();
    await expect(opened.getByText("Aperto in WhatsApp", { exact: true })).toBeVisible();
    await expect(copied).toContainText("04/11/2026 alle 08:30");
    await expect(copied).toContainText("A Elena Cronologia, +393330000077");
    await expect(copied.getByText("Da confermare", { exact: true })).toBeVisible();
    await expect(copied.getByText(historicalBody, { exact: true })).toBeHidden();
    await copied.locator("summary").click();
    await expect(copied.getByText(historicalBody, { exact: true })).toBeVisible();
    await copied.getByRole("button", { name: "Sì", exact: true }).click();
    await expect(copied.getByText("Inviato", { exact: true })).toBeVisible();
    await expect(copied).toContainText("il 04/11/2026 alle 08:30");
    await copied.getByRole("button", { name: "No", exact: true }).click();
    await expect(copied.getByText("Non inviato", { exact: true })).toBeVisible();
    expect(outcomes).toEqual([{ id: records[0]?.id, outcome: "inviato" }, { id: records[0]?.id, outcome: "non_inviato" }]);
    await page.reload();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(copied.getByText("Non inviato", { exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: /elimina|cancella/i })).toHaveCount(0);
    await nav.getByRole("link", { name: "Riepilogo" }).click();
    const latest = page.getByRole("region", { name: "Ultimi messaggi" });
    await expect(latest.getByRole("listitem")).toHaveCount(2);
    await expect(latest.getByRole("link", { name: "Vedi tutti" })).toHaveAttribute("href", `${patientUrl}?tab=messaggi`);
    await latest.getByRole("link", { name: "Vedi tutti" }).click();
    await expect(page).toHaveURL(/tab=messaggi/);
  } finally {
    if (ownAppointment) {
      await page.goto(`/agenda?vista=giorno&data=${DAY}`);
      await page.locator(`[data-day="${DAY}"]`).getByRole("button", { name: /21:00-22:00, Cronologia Minore,/ }).click();
      const detail = page.getByRole("dialog", { name: "Minore Cronologia", exact: true });
      await detail.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
      const cancel = page.getByRole("alertdialog", { name: "Annullare l'appuntamento?" });
      await cancel.getByRole("radio", { name: "Paziente", exact: true }).click();
      await cancel.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
      await expect(cancel).toBeHidden();
    }
    await setTestPhone(page, previousTestPhone);
  }
});

test("alla fine l'appuntamento del file si annulla: le righe del registro restano", async ({ page }) => {
  await page.goto(`/agenda?vista=giorno&data=${DAY}`);
  await page.waitForLoadState("networkidle");
  await block(page).click();
  const detail = detailOf(page);
  await detail.getByRole("button", { name: "Annulla appuntamento" }).click();
  const cancel = page.getByRole("alertdialog", { name: "Annullare l'appuntamento?" });
  await cancel.getByRole("radio", { name: "Paziente" }).click();
  await cancel.getByRole("button", { name: "Annulla appuntamento" }).click();
  await expect(cancel).toBeHidden();
  await expect(detail.getByText("Annullato", { exact: true })).toBeVisible();
  // Un appuntamento annullato non offre più il promemoria.
  await expect(detail.getByRole("button", { name: "Prepara il promemoria" })).toHaveCount(0);
});

test("Oggi rilegge il consenso WhatsApp revocato in una seconda scheda", async ({ page, context }) => {
  // Paziente e appuntamento propri: la revoca resta nello storico senza cambiare il seed.
  await page.goto("/pazienti");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const create = page.getByRole("dialog", { name: "Nuovo paziente" });
  await create.getByLabel(/^Nome/).first().fill("Ritorno");
  await create.getByLabel(/^Cognome/).first().fill("Permessi");
  await create.getByLabel(/^Data di nascita/).fill("1990-06-15");
  await create.getByLabel(/^Telefono/).first().fill("333 000 0066");
  await create.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]{36}$/);
  const patientUrl = new URL(page.url()).pathname;
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Consensi" }).click();
  await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
  const consent = page.getByRole("dialog", { name: "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)" });
  await consent.getByRole("radio", { name: "Firma su carta e carico il modulo" }).click();
  await consent.getByRole("radiogroup", { name: "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp." }).getByRole("radio", { name: "Sì" }).click();
  await consent.getByRole("radiogroup", { name: "Acconsento a essere ricontattato/a per i controlli periodici." }).getByRole("radio", { name: "No" }).click();
  await consent.getByLabel(/^Modulo firmato/).setInputFiles(path.join(import.meta.dirname, "fixtures", "foto-prova.jpg"));
  await consent.getByLabel(/^Data della firma/).fill("2026-11-04");
  await consent.getByRole("button", { name: "Carica il modulo firmato" }).click();
  await expect(consent).toBeHidden();
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Data", { exact: true }).fill(DAY);
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "21:00", exact: true }).click();
  await booking.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(booking).toBeHidden();
  const other = await context.newPage();
  try {
    const row = (await remindersOf(page)).getByRole("listitem").filter({ hasText: "Ritorno Permessi" });
    const anchor = row.getByRole("link", { name: "Apri WhatsApp" });
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveAttribute("target", "_blank");
    await other.goto(`${patientUrl}?tab=consensi`);
    await other.bringToFront();
    const whatsapp = other.getByRole("region", { name: "Scelte dell'informativa" }).getByRole("listitem").filter({ hasText: "Promemoria e comunicazioni su WhatsApp" });
    await whatsapp.getByRole("button", { name: "Revoca la scelta" }).click();
    const revoke = other.getByRole("alertdialog", { name: "Registrare la revoca della scelta?" });
    await revoke.getByRole("radio", { name: "Con un messaggio" }).click();
    await revoke.getByRole("button", { name: "Registra revoca" }).click();
    await expect(revoke).toBeHidden();
    await expect(whatsapp).toContainText("No, dal 04/11/2026");
    // Nessuna navigazione o reload di Oggi: il ritorno deve togliere il vecchio anchor nello stesso giorno.
    await returnToPage(page);
    await expect(anchor).toHaveCount(0);
    // La rilettura è conclusa: la copia organizzativa torna disponibile, il link resta assente.
    await expect(row.getByRole("button", { name: "Copia", exact: true })).toBeEnabled();
    await expect(anchor).toHaveCount(0);
  } finally {
    await other.close();
    await page.goto(`/agenda?vista=giorno&data=${DAY}`);
    await page.locator(`[data-day="${DAY}"]`).getByRole("button", { name: /21:00-.*Permessi Ritorno,/ }).click();
    const detail = page.getByRole("dialog", { name: "Ritorno Permessi", exact: true });
    await detail.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
    const cancel = page.getByRole("alertdialog", { name: "Annullare l'appuntamento?" });
    await cancel.getByRole("radio", { name: "Paziente", exact: true }).click();
    await cancel.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
    await expect(cancel).toBeHidden();
  }
});
