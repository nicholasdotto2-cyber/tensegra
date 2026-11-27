import { expect, type Locator, type Page, type Request, test } from "@playwright/test";

// D0 dei test: 4/11/2026 alle 08:30. Pazienti inventati propri; niente scritture sui pazienti del seed.
// Le date future sono fuori dalla settimana della demo. Gli appuntamenti senza log si eliminano,
// quelli con log si annullano (anche le successive della serie). Nessun invio o apertura esterna.
const FUTURE = "2026-11-16";
const PAST = "2026-11-04";
const QUESTION = "L'orario è già passato. Lo segno già come fatto?";
const SENTINEL = "Appunti prima della conferma";
const COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
type Input = Record<string, unknown>;
type Write = { input: Input; reply: string };

function actionInput(request: Request): Input | null {
  if (request.method() !== "POST" || request.headers()["next-action"] === undefined) return null;
  try {
    const args: unknown = JSON.parse(request.postData() ?? "");
    const first: unknown = Array.isArray(args) ? args[0] : null;
    return first !== null && typeof first === "object" ? first as Input : null;
  } catch { return null; }
}

/** Risposte reali delle azioni di scrittura, lette nello stream mentre passa, senza simulare il server. */
async function watchWrites(page: Page) {
  const started: Input[] = [];
  const writes: Write[] = [];
  const previews: Write[] = [];
  page.on("request", (request) => {
    const input = actionInput(request);
    if (input && ("patient" in input || "expectedUpdatedAt" in input || "action" in input)) started.push(input);
  });
  await page.route("**/agenda**", async (route) => {
    const input = actionInput(route.request());
    if (!input || !("patient" in input || "expectedUpdatedAt" in input || "action" in input || "durationMin" in input)) return route.fallback();
    const response = await route.fetch();
    const write = { input, reply: await response.text() };
    if ("patient" in input || "expectedUpdatedAt" in input || "action" in input) writes.push(write);
    else previews.push(write);
    await route.fulfill({ response });
  });
  return { started, writes, previews };
}
function createdId(writes: Write[]): string {
  const reply = writes.find((w) => "patient" in w.input)?.reply ?? "";
  expect(reply).toContain('"ok":true');
  const id = reply.match(/"appointments":\[\{"id":"([0-9a-f-]+)"/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}
const composerOf = (page: Page) => page.getByRole("dialog", { name: "Prepara il messaggio" });
const detailOf = (page: Page, surname: string) => page.getByRole("dialog", { name: `Ada ${surname}`, exact: true });
function block(page: Page, surname: string, time = "18:00") {
  return page.getByRole("button", { name: new RegExp(`^${time}-[0-9:]+, ${surname} Ada, `) });
}
async function chooseTime(page: Page, dialog: Locator, time: string) {
  await dialog.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: time, exact: true }).click();
}
async function booking(page: Page, surname: string, day = FUTURE) {
  await page.goto(`/agenda?vista=giorno&data=${day}`);
  await page.getByRole("button", { name: "Nuovo appuntamento", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento", exact: true });
  await dialog.getByLabel("Paziente").fill(surname);
  await page.getByRole("option", { name: `Nuovo paziente: ${surname}`, exact: true }).click();
  await dialog.getByLabel(/^Nome/).fill("Ada");
  await dialog.getByLabel("Data di nascita").fill("1990-01-01");
  await expect(dialog.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText("Prima visita osteopatica");
  await dialog.getByLabel("Data", { exact: true }).fill(day);
  await chooseTime(page, dialog, "18:00");
  return dialog;
}
async function openDetail(page: Page, surname: string, day = FUTURE, time = "18:00") {
  await page.goto(`/agenda?vista=giorno&data=${day}`);
  await block(page, surname, time).click();
  const detail = detailOf(page, surname);
  await expect(detail).toBeVisible();
  return detail;
}
async function cancelOwn(page: Page, surname: string, day = FUTURE, time = "18:00", series = false) {
  const detail = await openDetail(page, surname, day, time);
  await detail.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
  const question = page.getByRole("alertdialog", { name: "Annullare l'appuntamento?" });
  await question.getByRole("radio", { name: "Altro", exact: true }).check();
  if (series) await question.getByRole("checkbox", { name: /Annulla anche/ }).check();
  await question.getByRole("button", { name: "Annulla appuntamento", exact: true }).click();
  await expect(block(page, surname, time)).toHaveCount(0);
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 204, body: "" }));
});

for (const done of [false, true]) {
  test(`salva_prima_del_debounce entro300ms: ${done ? "Sì fatto" : "No prenotato"}`, async ({ page }) => {
    const surname = done ? "TaskDiciassetteFatto" : "TaskDiciassettePrenotato";
    const watched = await watchWrites(page);
    const dialog = await booking(page, surname, PAST);
    // La vecchia anteprima deve esistere, ma la nuova non deve arrivare prima di Salva.
    await expect.poll(() => watched.previews.some((p) => p.input.day === PAST && p.input.time === "18:00")).toBe(true);
    expect(watched.previews.find((p) => p.input.day === PAST && p.input.time === "18:00")?.reply).toContain('"pastStart":false');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let previews = 0;
    await page.route("**/agenda**", async (route) => {
      const input = actionInput(route.request());
      if (input?.day !== PAST || input.time !== "07:00" || "patient" in input) return route.fallback();
      previews += 1;
      await gate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.evaluate(() => {
      document.addEventListener("pointerdown", (event) => {
        if (event.target instanceof Element && event.target.closest('[role="option"]')) {
          document.documentElement.dataset.lastOptionClick = String(performance.now());
        }
      }, { capture: true });
    });
    try {
      await chooseTime(page, dialog, "07:00");
      // Nessuna attesa artificiale: il clic parte nello stesso giro del browser, con misura del tempo reale.
      const elapsed = await dialog.evaluate((element) => {
        const elapsed = performance.now() - Number(document.documentElement.dataset.lastOptionClick);
        const save = Array.from(element.querySelectorAll("button")).find((button) => button.textContent === "Salva");
        if (!save) throw new Error("Salva assente");
        save.click();
        return elapsed;
      });
      expect(elapsed).toBeLessThan(300);
      await expect.poll(() => previews).toBeGreaterThan(0);
      await expect(dialog.getByRole("button", { name: "Salva", exact: true })).toBeDisabled();
      expect(watched.started.filter((input) => "patient" in input)).toEqual([]);
    } finally { release(); }
    const question = page.getByRole("alertdialog", { name: QUESTION, exact: true });
    await expect(question).toBeVisible();
    expect(watched.started.filter((input) => "patient" in input)).toEqual([]);
    await question.getByRole("button", { name: done ? "Sì, è fatto" : "No, lascia prenotato" }).click();
    await expect(dialog).toBeHidden();
    if (done) {
      await page.getByRole("dialog", { name: `Seduta fatta: Ada ${surname}`, exact: true }).getByRole("button", { name: "Chiudi", exact: true }).click();
    }
    await expect(block(page, surname, "07:00")).toHaveAttribute("data-status", done ? "fatto" : "prenotato");
    const create = watched.started.filter((input) => "patient" in input);
    expect(create).toHaveLength(1);
    expect(create[0]?.status).toBe(done ? "fatto" : "prenotato");
    // Rilettura dopo reload: l'esito è persistito, non soltanto nel payload del browser.
    const detail = await openDetail(page, surname, PAST, "07:00");
    await expect(detail.getByText(done ? "Fatto" : "Prenotato", { exact: true })).toBeVisible();
    if (done) await detail.getByRole("button", { name: "Annulla 'fatto'", exact: true }).click();
    await detail.getByRole("button", { name: "Elimina", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Eliminare l'appuntamento?" }).getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(block(page, surname, "07:00")).toHaveCount(0);
  });
}

for (const series of [false, true]) {
  test(`salva_copia_conferma: secondo clic, nuovo id e una riga persistita${series ? ", solo il primo della serie" : ""}`, async ({ page }) => {
    const surname = series ? "TaskDiciassetteSerie" : "TaskDiciassetteConferma";
    const watched = await watchWrites(page);
    const dialog = await booking(page, surname);
    if (series) {
      await dialog.getByRole("checkbox", { name: "Ripeti ogni", exact: true }).check();
      await dialog.getByLabel("Numero di sedute in totale").click();
      await page.getByRole("option", { name: "2", exact: true }).click();
      await expect(dialog.getByText("Conferma del primo appuntamento", { exact: true })).toBeVisible();
    }
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
    await dialog.getByRole("button", { name: "Salva e copia la conferma", exact: true }).click();
    const composer = composerOf(page);
    await expect(composer).toBeVisible();
    const message = composer.getByRole("textbox", { name: "Testo del messaggio" });
    await expect(message).toHaveValue(/confermo l'appuntamento di lunedì 16 novembre alle 18:00/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SENTINEL);
    expect(watched.started.filter((input) => "action" in input)).toEqual([]);
    const id = createdId(watched.writes);
    const body = "Conferma di prova per lunedì 16 novembre alle 18:00.";
    await message.fill(body);
    await composer.getByRole("button", { name: "Copia", exact: true }).click();
    await expect(composer.getByText(COPIED, { exact: true })).toBeVisible();
    await expect(composer.getByRole("group", { name: "Hai inviato il messaggio?" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
    const records = watched.started.filter((input) => "action" in input);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: "copiato", body, source: { kind: "appointment", appointmentId: id, templateKey: "conferma" } });
    if (series) await composer.press("Escape");
    else await composer.getByRole("button", { name: "Chiudi", exact: true }).and(composer.locator("[data-slot=button]")).click();
    await expect(block(page, surname)).toBeFocused();
    const detail = await openDetail(page, surname);
    const history = detail.getByRole("region", { name: "Messaggi dell'appuntamento" });
    await expect(history.locator("[data-message-id]")).toHaveCount(1);
    await expect(history).toContainText(body);
    await expect(history).toContainText("Da confermare");
    if (series) {
      // La serie usa l'intervallo predefinito del seed, 2 settimane: la seconda seduta è il 30 novembre.
      const second = await openDetail(page, surname, "2026-11-30");
      await expect(second.getByRole("region", { name: "Messaggi dell'appuntamento" }).locator("[data-message-id]")).toHaveCount(0);
      await expect(second.getByText("Nessun messaggio preparato per questo appuntamento.")).toBeVisible();
    }
    await cancelOwn(page, surname, FUTURE, "18:00", series);
  });
}

test("salvataggio rifiutato: nessuna copia, nessun compositore o log", async ({ page }) => {
  const watched = await watchWrites(page);
  const dialog = await booking(page, "TaskDiciassetteRifiuto");
  await dialog.getByLabel("Prezzo concordato").fill("abc");
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  await dialog.getByRole("button", { name: "Salva e copia la conferma", exact: true }).click();
  await expect(dialog.getByLabel("Prezzo concordato")).toHaveAttribute("aria-invalid", "true");
  await expect.poll(() => watched.writes.length).toBe(1);
  expect(watched.writes[0]?.reply).toContain('"ok":false');
  expect(watched.started.filter((input) => "action" in input)).toEqual([]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SENTINEL);
  await expect(composerOf(page)).toBeHidden();
  await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
  await expect(block(page, "TaskDiciassetteRifiuto")).toHaveCount(0);
});

test("salva e copia su orario passato, Sì fatto: solo Seduta fatta, nessuna conferma o log", async ({ page }) => {
  const surname = "TaskDiciassetteFattoSenzaConferma";
  const watched = await watchWrites(page);
  const dialog = await booking(page, surname, PAST);
  await chooseTime(page, dialog, "07:00");
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  await dialog.getByRole("button", { name: "Salva e copia la conferma", exact: true }).click();
  await page.getByRole("alertdialog", { name: QUESTION, exact: true }).getByRole("button", { name: "Sì, è fatto", exact: true }).click();
  await expect(dialog).toBeHidden();
  const panel = page.getByRole("dialog", { name: `Seduta fatta: Ada ${surname}`, exact: true });
  await expect(panel).toBeVisible();
  await expect(composerOf(page)).toBeHidden();
  expect(watched.started.filter((input) => "patient" in input)).toHaveLength(1);
  expect(watched.started.filter((input) => "action" in input)).toEqual([]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SENTINEL);
  await panel.getByRole("button", { name: "Chiudi", exact: true }).click();
  const detail = await openDetail(page, surname, PAST, "07:00");
  await expect(detail.getByText("Fatto", { exact: true })).toBeVisible();
  await expect(detail.getByRole("region", { name: "Messaggi dell'appuntamento" }).locator("[data-message-id]")).toHaveCount(0);
  await detail.getByRole("button", { name: "Annulla 'fatto'", exact: true }).click();
  await detail.getByRole("button", { name: "Elimina", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Eliminare l'appuntamento?" }).getByRole("button", { name: "Elimina", exact: true }).click();
  await expect(block(page, surname, "07:00")).toHaveCount(0);
});

for (const confirm of [false, true]) {
  test(`errore di salvataggio: focus restituito a ${confirm ? "Salva e copia la conferma" : "Salva"}`, async ({ page }) => {
    const surname = confirm ? "TaskDiciassetteFocusConferma" : "TaskDiciassetteFocusSalva";
    const dialog = await booking(page, surname);
    // Il trasporto fallisce prima dell'INSERT: nessun esito di commit ambiguo e nessun dato da ripulire.
    await page.route("**/agenda**", async (route) => {
      const input = actionInput(route.request());
      if (input && "patient" in input) return route.abort("failed");
      return route.fallback();
    });
    const save = dialog.getByRole("button", { name: confirm ? "Salva e copia la conferma" : /^Salva( comunque)?$/, exact: true });
    await save.click();
    await expect(dialog.getByText("Non ho salvato l'appuntamento. Riprova.", { exact: true })).toBeVisible();
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await expect(composerOf(page)).toBeHidden();
    await dialog.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(block(page, surname)).toHaveCount(0);
  });
}

test("spostato_confermato: false non propone, true propone il testo con nuova data e ora e lascia prenotato", async ({ page }) => {
  const surname = "TaskDiciassetteSpostamento";
  const watched = await watchWrites(page);
  const dialog = await booking(page, surname);
  await dialog.getByRole("button", { name: /^Salva( comunque)?$/, exact: true }).click();
  await expect(dialog).toBeHidden();
  const id = createdId(watched.writes);
  const detail = await openDetail(page, surname);
  await detail.getByRole("button", { name: "Segna confermato", exact: true }).click();
  await expect(detail.getByText("Confermato", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Modifica", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Modifica appuntamento", exact: true });
  await edit.getByLabel("Note", { exact: true }).fill("Nota di prova");
  await edit.getByRole("button", { name: /^Salva( comunque)?$/ }).click();
  await expect(edit).toBeHidden();
  await expect.poll(() => watched.writes.filter((w) => "expectedUpdatedAt" in w.input).length).toBe(1);
  expect(watched.writes.find((w) => "expectedUpdatedAt" in w.input)?.reply).toContain('"movedFromConfirmed":false');
  await expect(detail.getByRole("button", { name: "Copia il messaggio di spostamento", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "Modifica", exact: true }).click();
  await edit.getByLabel("Data", { exact: true }).fill("2026-11-17");
  await chooseTime(page, edit, "18:15");
  await edit.getByRole("button", { name: /^Salva( comunque)?$/ }).click();
  await expect(edit).toBeHidden();
  await expect(detail.getByText("Prenotato", { exact: true })).toBeVisible();
  expect(watched.writes.filter((w) => "expectedUpdatedAt" in w.input).at(-1)?.reply).toContain('"movedFromConfirmed":true');
  await detail.getByRole("button", { name: "Copia il messaggio di spostamento", exact: true }).click();
  const composer = composerOf(page);
  await expect(composer.getByRole("textbox", { name: "Testo del messaggio" })).toHaveValue(/spostato[\s\S]*martedì 17 novembre alle 18:15/);
  expect(watched.started.filter((input) => "action" in input)).toEqual([]);
  await composer.getByRole("button", { name: "Copia", exact: true }).click();
  await expect(composer.getByRole("group", { name: "Hai inviato il messaggio?" })).toBeVisible();
  expect(watched.started.filter((input) => "action" in input)).toHaveLength(1);
  expect(watched.started.find((input) => "action" in input)).toMatchObject({ source: { appointmentId: id, templateKey: "spostamento" } });
  await composer.getByRole("button", { name: "Chiudi", exact: true }).and(composer.locator("[data-slot=button]")).click();
  const reread = await openDetail(page, surname, "2026-11-17", "18:15");
  await expect(reread.getByRole("region", { name: "Messaggi dell'appuntamento" }).locator("[data-message-id]")).toHaveCount(1);
  await expect(reread.getByText("Prenotato", { exact: true })).toBeVisible();
  await cancelOwn(page, surname, "2026-11-17", "18:15");
});
