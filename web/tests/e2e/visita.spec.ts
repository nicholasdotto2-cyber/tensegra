import { expect, type Locator, type Page, test } from "@playwright/test";

import { createOwnPatientWithSession } from "./support/own-patient";

// L'editor della visita sulla demo dei test: seed
// creato il 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Ogni blocco lavora sulla
// stessa visita: la prima visita di «Editor Prova», un paziente inventato che `beforeAll` crea dall'interfaccia
// (con il seed della demo nessun appuntamento `fatto` del seed resta senza visita), con la seduta di
// ieri, martedì 3 novembre, fatta e segnata "Non fatturare" e i consensi firmati, quindi una bozza non cambia i
// conteggi di Oggi né della lista. La visita non si chiude mai. Il file gira dopo tutti gli altri
// (ordine alfabetico, un worker), e ogni blocco regge una seconda corsa sullo stesso database: il paziente si riusa,
// la prima volta la Cartella offre "Compila ora", poi "Apri la visita", e un dolore già scritto da una corsa prima si
// toglie con «Togli» prima di provarlo.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EDITOR_URL = new RegExp(`/pazienti/(${UUID})/visite/${UUID}$`);

const OWN = { firstName: "Editor", lastName: "Prova" } as const;
const OWN_NAME = `${OWN.firstName} ${OWN.lastName}`;
const VISIT_DAY_TITLE = "martedì 3 novembre 2026";
/** Il titolo del ciclo nato dall'agenda: provvisorio, poi quello della regione principale. */
const CYCLE_TITLE = /^(?:Nuovo ciclo|Arto inferiore), novembre 2026$/;
const CYCLE_TITLE_LEG = "Arto inferiore, novembre 2026";

let ownPatientId = "";

test.beforeAll(async ({ browser }, testInfo) => {
  // Il paziente nasce dall'interfaccia: nuovo paziente, consensi firmati col mouse, seduta fatta e "Non fatturare".
  test.setTimeout(120_000);
  const { baseURL, locale, timezoneId } = testInfo.project.use;
  const page = await browser.newPage({ baseURL, locale, timezoneId });
  try {
    ownPatientId = (await createOwnPatientWithSession(page, OWN)).patientId;
  } finally {
    await page.close();
  }
});

const PAIN_START = "Dolore 0-10 (NRS) a inizio seduta";
const PAIN_END = "Dolore 0-10 (NRS) a fine seduta";
const PAIN_MISSING = "Manca il dolore 0-10 a inizio seduta.";

// Un errore di una risorsa o un'eccezione della pagina arriva dopo il titolo: lo controlla afterEach. Le righe che un
// test provoca apposta (la risposta 500, la pagina 404) le dichiara in `expectedErrors`, una per riga attesa.
let consoleErrors: string[] = [];
let expectedErrors: RegExp[] = [];

const failedResource = (status: string): RegExp =>
  new RegExp(`^Failed to load resource: the server responded with a status of ${status} @ `);

test.beforeEach(({ page }) => {
  consoleErrors = [];
  expectedErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  // Un'eccezione non gestita della pagina non passa dal canale "console".
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle");
  const rest = [...consoleErrors];
  for (const expected of expectedErrors) {
    const index = rest.findIndex((line) => expected.test(line));
    expect(index, `nella console manca la riga attesa ${expected}`).toBeGreaterThanOrEqual(0);
    rest.splice(index, 1);
  }
  expect(rest).toEqual([]);
});

/**
 * Dalla scheda alla Cartella del paziente proprio, poi l'editor della sua prima visita: "Compila ora" la prima volta,
 * poi "Apri la visita". Restituisce l'id del paziente.
 */
async function openVisit(page: Page): Promise<string> {
  await page.goto(`/pazienti/${ownPatientId}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1, name: OWN_NAME })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  const history = page.getByRole("region", { name: "Cronologia" });
  const entry = history
    .getByRole("button", { name: "Compila ora" })
    .or(history.getByRole("link", { name: "Apri la visita" }));
  await expect(entry).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  await entry.click();
  await expect(page).toHaveURL(EDITOR_URL);
  await expect(page.getByRole("heading", { level: 1, name: VISIT_DAY_TITLE })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const patientId = EDITOR_URL.exec(new URL(page.url()).pathname)?.[1];
  if (patientId === undefined) throw new Error("l'indirizzo dell'editor non ha l'id del paziente");
  return patientId;
}

const painGroup = (page: Page, name: string): Locator => page.getByRole("radiogroup", { name });
const saveStatus = (page: Page): Locator => page.getByRole("status").filter({ hasText: /Salvato|Non ho salvato/ });

/**
 * Toglie il dolore `label` se una corsa prima l'ha scritto, e aspetta "Salvato". Va chiamata subito dopo l'apertura,
 * con lo stato del salvataggio ancora vuoto: così "Salvato" è quello di questa modifica.
 */
async function clearPain(page: Page, label: string): Promise<void> {
  const clear = page.getByRole("button", { name: `Togli il valore: ${label}` });
  if ((await clear.count()) === 0) return;
  await clear.click();
  await expect(saveStatus(page)).toHaveText("Salvato");
}

test("l'editor apre la prima visita del paziente proprio con la barra, le cinque sezioni e la colonna destra, e salva il dolore da tastiera", async ({
  page,
}) => {
  await openVisit(page);

  // Barra: data nel formato dei titoli, tipo e ciclo; nessuna copia alla prima visita di un paziente senza visite.
  // Il titolo è quello provvisorio dell'agenda finché il blocco della sezione A non sceglie la regione principale.
  const bar = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(bar.getByText("Prima visita", { exact: true })).toBeVisible();
  await expect(bar.getByText(CYCLE_TITLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copia dalla visita precedente" })).toHaveCount(0);

  // Le cinque sezioni richiudibili: l'intestazione è un pulsante con `aria-expanded`, aperta all'inizio.
  for (const title of ["A. Come sta", "B. Screening", "C. Valutazione", "D. Trattamento", "E. Chiusura"]) {
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveAttribute("aria-expanded", "true");
  }

  // Colonna destra: le due scale del dolore, gli avvisi e "Per chiudere" con il link allo screening.
  const column = page.getByRole("complementary");
  await expect(column.getByRole("radiogroup", { name: PAIN_START })).toBeVisible();
  await expect(column.getByRole("radiogroup", { name: PAIN_END })).toBeVisible();
  const closing = column.getByRole("region", { name: "Per chiudere" });
  const screeningLink = closing.getByRole("link", { name: "Conferma lo screening." });
  // Una corsa prima (il blocco dello screening) può aver confermato lo screening: "Nessun'altra voce" toglie la conferma,
  // così il link torna in "Per chiudere".
  const sectionBox = page.locator("#sezione-b");
  if ((await sectionBox.getByRole("list", { name: "Esiti dello screening" }).count()) > 0) {
    await sectionBox.getByRole("region", { name: "Red flag del rachide" }).getByRole("button", { name: "Nessun'altra voce" }).click();
  }
  await expect(screeningLink).toHaveAttribute("href", "#sezione-b");

  // Il link di "Per chiudere" apre la sezione chiusa e ci porta il focus.
  const sectionB = page.getByRole("button", { name: "B. Screening", exact: true });
  await sectionB.click();
  await expect(sectionB).toHaveAttribute("aria-expanded", "false");
  await screeningLink.click();
  await expect(sectionB).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sezione-b")).toBeFocused();

  // Senza dolore a inizio seduta l'avviso c'è (una corsa prima l'aveva scritto: si toglie).
  await clearPain(page, PAIN_START);
  const warnings = column.getByRole("region", { name: "Avvisi" });
  const painWarning = warnings.getByRole("link", { name: PAIN_MISSING });
  await expect(painWarning).toBeVisible();

  // Dal link dell'avviso, il focus sul gruppo (la voce che tiene il punto d'ingresso), poi il tasto 4.
  const start = painGroup(page, PAIN_START);
  await painWarning.click();
  await expect(start.locator('[role="radio"][tabindex="0"]')).toBeFocused();
  await page.keyboard.press("4");
  await expect(start.getByRole("radio", { name: "4", exact: true })).toHaveAttribute("aria-checked", "true");
  // L'avviso sparisce con la vista che torna dal server: il salvataggio è finito.
  await expect(painWarning).toHaveCount(0);
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(saveStatus(page)).toHaveAttribute("aria-live", "polite");

  await page.reload();
  await expect(painGroup(page, PAIN_START).getByRole("radio", { name: "4", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("un salvataggio che fallisce ferma la coda con «Riprova», uscire chiede conferma, e «Riprova» lo rimanda", async ({
  page,
}) => {
  await openVisit(page);
  await clearPain(page, PAIN_END);

  // La prossima Server Action della pagina risponde 500; le altre passano.
  let failed = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!failed && request.method() === "POST" && (await request.headerValue("next-action")) !== null) {
      failed = true;
      expectedErrors = [failedResource("500 \\(Internal Server Error\\)")];
      await route.fulfill({ status: 500, contentType: "text/plain", body: "Errore di prova" });
      return;
    }
    await route.fallback();
  });

  const end = painGroup(page, PAIN_END);
  await end.getByRole("radio", { name: "3", exact: true }).click();
  await expect(saveStatus(page)).toHaveText("Non ho salvato l'ultima modifica.");
  const retry = page.getByRole("button", { name: "Riprova" });
  await expect(retry).toBeVisible();
  expect(failed).toBe(true);
  // La scelta resta visibile finché non è salvata.
  await expect(end.getByRole("radio", { name: "3", exact: true })).toHaveAttribute("aria-checked", "true");

  // Con la modifica non salvata, un link che porta fuori dall'editor chiede conferma (nessun dato perso).
  const editorUrl = page.url();
  await page.locator("header").getByRole("link", { name: OWN_NAME }).click();
  const leave = page.getByRole("alertdialog", { name: "Uscire senza salvare?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Torna indietro" }).click();
  await expect(leave).toHaveCount(0);
  expect(page.url()).toBe(editorUrl);

  await retry.click();
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(retry).toHaveCount(0);
  await expect(end.getByRole("radio", { name: "3", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.unroute("**/*");

  await page.reload();
  await expect(painGroup(page, PAIN_END).getByRole("radio", { name: "3", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("una visita che non c'è sotto il paziente proprio dà «Visita non trovata.» con la strada per la sua scheda", async ({ page }) => {
  const patientId = ownPatientId;
  // `loading.tsx` apre lo streaming prima di `notFound()`: la risposta resta 200 (come la scheda del paziente) e
  // nella console non arriva nessuna riga.
  await page.goto(`/pazienti/${patientId}/visite/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { level: 1, name: "Visita non trovata." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Torna alla scheda" })).toHaveAttribute("href", `/pazienti/${patientId}`);
});

// Secondo blocco: la sezione A della prima visita del paziente proprio. Una seconda corsa sullo
// stesso database trova i valori della prima: ogni campo che ha già il valore da provare si svuota o si cambia prima,
// così "Salvato" è quello della modifica di questa corsa, e alla fine la pagina riletta mostra i valori salvati.

const sectionA = (page: Page): Locator => page.locator("#sezione-a");

/** Scrive `value` in un campo di testo e passa al campo dopo: il testo si salva alla perdita del focus. */
async function writeText(page: Page, field: Locator, value: string): Promise<void> {
  if ((await field.inputValue()) !== "") {
    await field.fill("");
    await field.blur();
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  await field.fill(value);
  await field.blur();
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(field).toHaveValue(value);
}

/** Scrive una data; se il campo ha già quel giorno passa prima da `other`. */
async function writeDate(page: Page, field: Locator, value: string, other: string): Promise<void> {
  for (const day of (await field.inputValue()) === value ? [other, value] : [value]) {
    await field.fill(day);
    await field.blur();
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  await expect(field).toHaveValue(value);
}

/** Sceglie una voce di un gruppo di pulsanti; se è già quella scelta passa prima da `other`. */
async function chooseRadio(page: Page, group: Locator, name: string, other: string): Promise<void> {
  const click = async (label: string) => {
    await group.getByRole("radio", { name: label, exact: true }).click();
    await expect(group.getByRole("radio", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(saveStatus(page)).toHaveText("Salvato");
  };
  if ((await group.getByRole("radio", { name, exact: true }).getAttribute("aria-checked")) === "true") await click(other);
  await click(name);
}

/** Sceglie una voce di un elenco a discesa; se è già quella scelta, passa prima da `other`. */
async function chooseOption(page: Page, trigger: Locator, option: string, other: string): Promise<void> {
  const pick = async (name: string) => {
    await trigger.click();
    await page.getByRole("option", { name, exact: true }).click();
    await expect(trigger).toContainText(name);
    await expect(saveStatus(page)).toHaveText("Salvato");
  };
  if ((await trigger.textContent())?.includes(option)) await pick(other);
  await pick(option);
}

test("la sezione A della prima visita chiede apertura del ciclo, PSFS e anamnesi, e ogni campo salva da solo", async ({
  page,
}) => {
  await openVisit(page);
  const a = sectionA(page);
  const bar = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(bar.getByText(CYCLE_TITLE)).toBeVisible();

  // I campi d'apertura, nell'ordine fissato, con i loro testi.
  await expect(a.getByRole("heading", { level: 3, name: "Apertura del ciclo" })).toBeVisible();
  const motive = a.getByLabel("Motivo della visita, con le parole del paziente");
  const region = a.getByRole("combobox", { name: /^Regione principale/ });
  const since = a.getByLabel("Da quando");
  const onset = a.getByRole("radiogroup", { name: "Come è iniziato" });
  const goal = a.getByLabel("Obiettivo");
  const sessions = a.getByLabel("Sedute previste");
  const referring = a.getByRole("combobox", { name: "Medico inviante" });
  const diagnosis = a.getByLabel("Diagnosi medica di riferimento");
  const source = a.getByRole("radiogroup", { name: "Fonte della diagnosi medica" });
  for (const field of [motive, region, since, goal, sessions, referring, diagnosis]) await expect(field).toBeVisible();
  await expect(onset.getByRole("radio")).toHaveText(["Acuto", "Graduale", "Dopo un trauma", "Ricorrente"]);
  await expect(source.getByRole("radio")).toHaveText(["Referto allegato", "Riferita dal paziente", "Assente"]);
  // Il paziente proprio non ha un medico inviante abituale: il campo è su «Nessuno» e non propone nessuno.
  await expect(referring).toContainText("Nessuno");
  await expect(a.getByText("Medico inviante abituale del paziente")).toHaveCount(0);
  await expect(a.getByRole("heading", { level: 3, name: "Attività importanti per il paziente (PSFS)" })).toBeVisible();
  await expect(a.getByText("0 = non riesco a farla, 10 = la faccio come prima del problema")).toBeVisible();

  // La regione principale salva subito; il titolo provvisorio del ciclo diventa quello della regione,
  // controllato sulla pagina riletta in fondo.
  await chooseOption(page, region, "Arto inferiore", "Lombare");

  // Il motivo e l'obiettivo si salvano alla perdita del focus; la data e le scelte subito.
  await writeText(page, motive, "Dolore al ginocchio in salita");
  await writeText(page, goal, "Salire le scale senza dolore");
  await writeDate(page, since, "2026-10-01", "2026-10-02");
  await chooseRadio(page, onset, "Graduale", "Acuto");
  await writeText(page, diagnosis, "Gonartrosi lieve");
  await chooseRadio(page, source, "Riferita dal paziente", "Assente");

  // Un valore che il server rifiuta resta scritto, con la frase sotto il campo, `aria-invalid` e il focus sul campo.
  await sessions.fill("21");
  await sessions.blur();
  await expect(sessions).toHaveAttribute("aria-invalid", "true");
  await expect(sessions).toBeFocused();
  await expect(sessions).toHaveAccessibleDescription("Valore non valido");
  await expect(sessions).toHaveValue("21");
  await sessions.fill("4");
  await sessions.blur();
  await expect(sessions).not.toHaveAttribute("aria-invalid", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(sessions).toHaveValue("4");

  // PSFS: l'attività «Pedalare 30 minuti» con il punteggio iniziale 3 (una corsa prima l'ha già scritta).
  const activity = "Pedalare 30 minuti";
  const score = a.getByRole("radiogroup", { name: `Punteggio iniziale: ${activity}` });
  if ((await score.count()) === 0) {
    await a.getByLabel("Nuova attività").fill(activity);
    await a.getByRole("button", { name: "Aggiungi attività" }).click();
    await expect(score).toBeVisible();
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  await score.getByRole("radio", { name: "3", exact: true }).click();
  await expect(score.getByRole("radio", { name: "3", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");

  // Anamnesi remota: «Ibuprofene 400 mg» come farmaco, senza il badge TAO (una corsa prima l'ha già aggiunto: «Togli»).
  const drug = "Ibuprofene 400 mg";
  const removeDrug = a.getByRole("button", { name: `Togli: ${drug}` });
  if ((await removeDrug.count()) > 0) {
    await removeDrug.click();
    await expect(removeDrug).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  await a.getByRole("button", { name: "Aggiungi farmaco" }).click();
  await a.getByRole("textbox", { name: /^Farmaco/ }).fill(drug);
  // I segnali di rischio partono dal nome del farmaco: l'ibuprofene non è un anticoagulante.
  const taoBox = a.getByRole("checkbox", { name: /^TAO/ });
  await expect(taoBox).not.toBeChecked();
  await a.getByRole("button", { name: "Salva il farmaco" }).click();
  await expect(removeDrug).toBeVisible();
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(page.getByText("TAO", { exact: true })).toHaveCount(0);

  // «Coumadin 5 mg» accende da solo il segnale TAO e il badge in testata; toglierlo a mano resta (una corsa prima lo
  // ha già aggiunto: «Togli», così il blocco si ripete).
  const tao = "Coumadin 5 mg";
  const removeTao = a.getByRole("button", { name: `Togli: ${tao}` });
  if ((await removeTao.count()) > 0) {
    await removeTao.click();
    await expect(removeTao).toHaveCount(0);
  }
  const badge = page.getByRole("complementary").getByText("TAO", { exact: true });
  await expect(badge).toHaveCount(0);
  await a.getByRole("button", { name: "Aggiungi farmaco" }).click();
  await a.getByRole("textbox", { name: /^Farmaco/ }).fill(tao);
  await expect(taoBox).toBeChecked();
  await a.getByRole("button", { name: "Salva il farmaco" }).click();
  await expect(badge).toBeVisible();
  await a.getByRole("button", { name: `Modifica: ${tao}` }).click();
  await expect(taoBox).toBeChecked();
  await taoBox.click();
  await a.getByRole("button", { name: "Salva il farmaco" }).click();
  await expect(badge).toHaveCount(0);
  await expect(removeTao).toBeVisible();
  await removeTao.click();
  await expect(removeTao).toHaveCount(0);

  // Apparati: 8 righe con «Niente da segnalare» già scelto; stile di vita presente; la perinatale resta chiusa (adulto).
  const noReport = a.getByRole("radio", { name: "Niente da segnalare" });
  await expect(noReport).toHaveCount(8);
  for (const radio of await noReport.all()) await expect(radio).toHaveAttribute("aria-checked", "true");
  await expect(a.getByRole("heading", { level: 3, name: "Stile di vita" })).toBeVisible();
  await expect(a.getByRole("heading", { level: 3, name: "Anamnesi perinatale" })).toHaveCount(0);
  await expect(a.getByRole("button", { name: "Apri l'anamnesi perinatale" })).toBeVisible();

  // Riletta la pagina, i valori sono quelli salvati e la barra ha il titolo della regione principale.
  await page.reload();
  const again = sectionA(page);
  const barAgain = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  await expect(barAgain.getByText(CYCLE_TITLE_LEG, { exact: true })).toBeVisible();
  await expect(barAgain.getByText(/^Nuovo ciclo/)).toHaveCount(0);
  await expect(again.getByRole("combobox", { name: /^Regione principale/ })).toContainText("Arto inferiore");
  await expect(again.getByLabel("Motivo della visita, con le parole del paziente")).toHaveValue("Dolore al ginocchio in salita");
  await expect(again.getByLabel("Sedute previste")).toHaveValue("4");
  await expect(again.getByLabel("Obiettivo")).toHaveValue("Salire le scale senza dolore");
  await expect(again.getByLabel("Da quando")).toHaveValue("2026-10-01");
  await expect(again.getByRole("radiogroup", { name: "Come è iniziato" }).getByRole("radio", { name: "Graduale" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(again.getByLabel("Diagnosi medica di riferimento")).toHaveValue("Gonartrosi lieve");
  await expect(
    again.getByRole("radiogroup", { name: "Fonte della diagnosi medica" }).getByRole("radio", { name: "Riferita dal paziente" }),
  ).toHaveAttribute("aria-checked", "true");
  const savedScore = again.getByRole("radiogroup", { name: `Punteggio iniziale: ${activity}` });
  await expect(savedScore.getByRole("radio", { name: "3", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(again.getByText(drug, { exact: true })).toBeVisible();
});

test("un rifiuto non toglie il focus al campo dove si scrive, e una battuta non ancora partita fa chiedere conferma", async ({
  page,
}) => {
  await openVisit(page);
  const a = sectionA(page);
  const sessions = a.getByLabel("Sedute previste");
  const goal = a.getByLabel("Obiettivo");

  // Il rifiuto arriva dopo la perdita del focus: il campo scelto nel frattempo resta quello col focus.
  await sessions.fill("21");
  await goal.click();
  await expect(sessions).toHaveAttribute("aria-invalid", "true");
  await expect(goal).toBeFocused();
  await sessions.fill("4");
  await sessions.blur();
  await expect(sessions).not.toHaveAttribute("aria-invalid", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");

  // Ricaricare con un testo scritto da meno di 800 ms chiede conferma; il testo non partito si perde solo se lo si accetta.
  let asked = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") asked = true;
    void dialog.accept();
  });
  await goal.click();
  await goal.pressSequentially("x");
  await page.reload();
  expect(asked).toBe(true);
});

// Terzo blocco: lo screening (sezione B) e il body chart (sezione C)
// della prima visita del paziente proprio, con la regione principale «Arto inferiore» scritta dal blocco prima (se manca,
// `openVisitWithRegion` la scrive). Una seconda corsa trova lo screening e la regione della prima: "Nessun'altra voce"
// toglie la conferma e la regione si toglie con «Togli la regione» prima di provarla.

/**
 * L'editor della prima visita con la regione principale «Arto inferiore»: il paziente proprio nasce senza, e la scrive
 * il blocco della sezione A; se quel blocco non è girato, la sceglie qui.
 */
async function openVisitWithRegion(page: Page): Promise<string> {
  const patientId = await openVisit(page);
  const region = sectionA(page).getByRole("combobox", { name: /^Regione principale/ });
  if (!((await region.textContent()) ?? "").includes("Arto inferiore")) {
    await region.click();
    await page.getByRole("option", { name: "Arto inferiore", exact: true }).click();
    await expect(region).toContainText("Arto inferiore");
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  return patientId;
}

const SCREENING_GROUPS_SHOWN = ["Controindicazioni sistemiche", "Controindicazioni locali", "Red flag del rachide"];
const PILLS = ["Thrust: indicato", "Dirette: indicato", "Indirette: indicato"];
const LEG_EMPTY = "Arto inferiore, nessuna disfunzione";
const LEG_SAVED = "Arto inferiore dx, severità 2, Primaria";

const sectionB = (page: Page): Locator => page.locator("#sezione-b");
const sectionC = (page: Page): Locator => page.locator("#sezione-c");
const pillsOf = (page: Page): Locator => sectionB(page).getByRole("list", { name: "Esiti dello screening" });
const screeningTodo = (page: Page): Locator =>
  page.getByRole("complementary").getByRole("region", { name: "Per chiudere" }).getByRole("link", { name: "Conferma lo screening." });

/** Preme Tab finché `target` ha il focus (al massimo `max` volte): la strada da tastiera, senza clic. */
async function tabTo(page: Page, target: Locator, max = 20): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("lo screening chiede i tre gruppi di sempre, «Nessun'altra voce» li completa e «Conferma lo screening» dà le tre pillole", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  const b = sectionB(page);

  // Regione principale «Arto inferiore»: niente gruppo cervicale, niente gravidanza.
  for (const name of SCREENING_GROUPS_SHOWN) await expect(b.getByRole("region", { name, exact: true })).toBeVisible();
  await expect(b.getByRole("region", { name: "Red flag cervicali" })).toHaveCount(0);
  await expect(b.getByRole("region", { name: "Gravidanza" })).toHaveCount(0);
  // Ogni voce ha i tre pulsanti.
  const firstItem = b.getByRole("region", { name: "Controindicazioni sistemiche" }).getByRole("radiogroup").first();
  await expect(firstItem.getByRole("radio")).toHaveText(["No", "Sì", "Non so"]);

  // "Nessun'altra voce" sui tre gruppi scrive «No» sulle voci senza risposta; su uno screening già confermato (una corsa
  // prima) toglie la conferma e le pillole.
  for (const name of SCREENING_GROUPS_SHOWN) {
    await b.getByRole("region", { name, exact: true }).getByRole("button", { name: "Nessun'altra voce" }).click();
  }
  await expect(b.getByText(/senza risposta$/)).toHaveCount(0);
  await expect(pillsOf(page)).toHaveCount(0);
  await expect(screeningTodo(page)).toBeVisible();
  await expect(firstItem.getByRole("radio", { name: "No", exact: true })).toHaveAttribute("aria-checked", "true");

  // Un esito scelto e non ancora confermato fa chiedere conferma prima di uscire; si resta sulla pagina con la
  // scelta, poi si torna a «Indicato».
  const direct = b.getByRole("radiogroup", { name: "Dirette", exact: true });
  await direct.getByRole("radio", { name: "Con cautela" }).click();
  await expect(direct.getByRole("radio", { name: "Con cautela" })).toHaveAttribute("aria-checked", "true");
  let asked = false;
  page.once("dialog", (dialog) => {
    asked = dialog.type() === "beforeunload";
    void dialog.dismiss();
  });
  // Rifiutata la domanda, la ricarica non avviene: la sua attesa finisce per tempo.
  await page.reload({ timeout: 2_000 }).catch(() => null);
  expect(asked).toBe(true);
  await expect(direct.getByRole("radio", { name: "Con cautela" })).toHaveAttribute("aria-checked", "true");
  await direct.getByRole("radio", { name: "Indicato", exact: true }).click();

  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await expect(screeningTodo(page)).toHaveCount(0);
  await expect(saveStatus(page)).toHaveText("Salvato");

  await page.reload();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await expect(screeningTodo(page)).toHaveCount(0);
});

test("il body chart dalla sola tastiera: severità 2, lato dx e «Primaria» sull'arto inferiore, e il 2 nella sagoma", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  const c = sectionC(page);
  await expect(c.getByRole("heading", { level: 3, name: "Disfunzioni somatiche (TART)" })).toBeVisible();
  const regions = c.getByRole("list", { name: "Regioni" });
  const panel = c.getByRole("region", { name: "Arto inferiore", exact: true });

  // Una corsa prima ha salvato l'arto inferiore: si toglie, così la regione riparte senza disfunzione.
  const previous = regions.getByRole("button", { name: /^Arto inferiore.*severità/ });
  if ((await previous.count()) > 0) {
    await previous.click();
    await panel.getByRole("button", { name: "Togli la regione" }).click();
    await expect(regions.getByRole("button", { name: LEG_EMPTY })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  }

  // Dall'elenco delle regioni, solo tastiera: Tab fino all'arto inferiore, Invio apre il pannello col focus dentro.
  const leg = regions.getByRole("button", { name: LEG_EMPTY });
  await regions.getByRole("button").first().focus();
  await tabTo(page, leg);
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  const severity = panel.getByRole("radiogroup", { name: "Severità" });
  await expect(severity.getByRole("radio", { name: "0 Assente o di fondo" })).toBeFocused();

  // La severità con le frecce fino a «2 Evidente»; ogni passo salva.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const two = severity.getByRole("radio", { name: "2 Evidente" });
  await expect(two).toBeFocused();
  await expect(two).toHaveAttribute("aria-checked", "true");

  // I quattro interruttori TART con l'etichetta nel nome accessibile.
  for (const name of ["Tessitura dei tessuti", "Asimmetria", "Restrizione di movimento", "Dolorabilità"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  }

  // Il lato «dx» e "Primaria" con Spazio.
  const dx = panel.getByRole("radiogroup", { name: "Lato" }).getByRole("radio", { name: "dx", exact: true });
  await tabTo(page, dx);
  await page.keyboard.press("Space");
  await expect(dx).toHaveAttribute("aria-checked", "true");
  const primary = panel.getByRole("button", { name: "Primaria", exact: true });
  await tabTo(page, primary);
  await page.keyboard.press("Space");
  await expect(primary).toHaveAttribute("aria-pressed", "true");

  // L'elenco dice la riga salvata (la vista torna dal server), "Salvato" è annunciato e la sagoma scrive il 2 solo a dx.
  const saved = regions.getByRole("button", { name: LEG_SAVED });
  await expect(saved).toBeVisible();
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(saveStatus(page)).toHaveAttribute("aria-live", "polite");
  const legRight = c.locator('[data-region="lower_extremity"][data-side="dx"] text');
  await expect(legRight).toHaveCount(2);
  for (const text of await legRight.all()) await expect(text).toContainText("2");
  await expect(c.locator('[data-region="lower_extremity"][data-side="sx"] text')).toHaveCount(0);

  // Esc chiude il pannello e il focus torna sul pulsante della regione.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(saved).toBeFocused();

  await page.reload();
  await expect(sectionC(page).getByRole("list", { name: "Regioni" }).getByRole("button", { name: LEG_SAVED })).toBeVisible();
});

// Quarto blocco: i test e il trattamento (sezioni C e D) della prima visita del paziente proprio, con la
// regione principale «Arto inferiore» (blocco 2) e lo screening confermato (blocco 3). Ogni test prepara da sé ciò che gli
// serve: lo screening confermato e la disfunzione dell'arto inferiore (una corsa prima o un test prima possono averli
// tolti). Una seconda corsa trova i valori della prima, quindi un interruttore già acceso si spegne prima di provare
// l'accensione, e i test del trattamento rimettono a posto ciò che accendono.

const THOMAS = "Test di Thomas modificato";
const OBER = "Test di Ober";
const SLR = "Test di Lasègue (sollevamento passivo della gamba tesa)";
const LUNGE = "Lunge test in carico (distanza dal muro)";
const SPURLING = "Test di Spurling (compressione foraminale)";
const FACE_HINT = "Inquadra dal collo in giù quando il volto non serve";
const TECHNIQUE_NAMES = [
  "Tessuti molli",
  "Articolatoria",
  "HVLA",
  "Energia muscolare",
  "TOG",
  "Inibizione",
  "Fasciale",
  "Craniale",
  "Viscerale",
  "Tecnica di Still",
  "Funzionale",
  "Strain-counterstrain",
  "Tensione legamentosa bilanciata",
  "Pompa linfatica",
  "Neuromuscolare e punti riflessi",
  "Altra tecnica",
];
const BLOCK_SENTENCE =
  "HVLA controindicata in questa visita: anestesia a sella. Cambia l'esito dello screening se hai nuove informazioni.";
const SCREENING_FIRST = "Conferma lo screening prima di scrivere il trattamento.";
const SOFT_SENTENCE =
  "Tecnica tessuti molli controindicata in questa visita: anestesia a sella. Cambia l'esito dello screening se hai nuove informazioni.";
const CONFLICT_HINT = "Se l'hai eseguita prima che comparisse il sintomo segnalato nello screening, scrivilo qui.";
const TART_WARNING = "Regione trattata senza disfunzioni somatiche (TART)";
const ADD_REGIONS = "Aggiungi le regioni con disfunzioni";

const sectionD = (page: Page): Locator => page.locator("#sezione-d");

/** Lo screening confermato con tutte le risposte «No»: se un test prima l'ha tolto, lo si rifà. */
async function ensureScreeningConfirmed(page: Page): Promise<void> {
  if ((await screeningTodo(page).count()) === 0) return;
  const b = sectionB(page);
  for (const name of SCREENING_GROUPS_SHOWN) {
    await b.getByRole("region", { name, exact: true }).getByRole("button", { name: "Nessun'altra voce" }).click();
  }
  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await expect(screeningTodo(page)).toHaveCount(0);
}

/** La disfunzione dell'arto inferiore (severità 2, dx): se non c'è, si scrive dal pannello della regione. */
async function ensureLegFinding(page: Page): Promise<void> {
  const c = sectionC(page);
  const empty = c.getByRole("list", { name: "Regioni" }).getByRole("button", { name: LEG_EMPTY });
  if ((await empty.count()) === 0) return;
  await empty.click();
  const panel = c.getByRole("region", { name: "Arto inferiore", exact: true });
  await panel.getByRole("radiogroup", { name: "Severità" }).getByRole("radio", { name: "2 Evidente" }).click();
  await panel.getByRole("radiogroup", { name: "Lato" }).getByRole("radio", { name: "dx", exact: true }).click();
  await expect(c.getByRole("list", { name: "Regioni" }).getByRole("button", { name: /^Arto inferiore dx, severità 2/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
}

/** La riga «Arto inferiore» della sezione D: la prima volta si aggiunge con «Aggiungi le regioni con disfunzioni». */
async function openLegRow(page: Page): Promise<Locator> {
  const d = sectionD(page);
  const row = d.getByRole("region", { name: "Arto inferiore", exact: true });
  if ((await row.count()) === 0) {
    await d.getByRole("button", { name: "Aggiungi le regioni con disfunzioni" }).click();
  }
  await expect(row).toBeVisible();
  return row;
}

/** Accende un interruttore: se è già acceso (una corsa prima) lo spegne e aspetta il salvataggio, poi lo accende. */
async function switchOn(page: Page, toggle: Locator): Promise<void> {
  if ((await toggle.getAttribute("aria-checked")) === "true") {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");
}

async function switchOff(page: Page, toggle: Locator): Promise<void> {
  if ((await toggle.getAttribute("aria-checked")) !== "true") return;
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(saveStatus(page)).toHaveText("Salvato");
}

test("la sezione C apre i test attivi della regione principale, salva un risultato e un test libero, e il dialogo della foto si chiude con Esc", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  const c = sectionC(page);
  const tests = c.getByRole("region", { name: "Test", exact: true });

  // I test attivi di «Arto inferiore» sono aperti, ognuno con i suoi due lati; quelli delle altre regioni stanno nell'elenco.
  for (const side of ["dx", "sx"]) {
    await expect(tests.getByRole("radiogroup", { name: `${THOMAS} ${side}`, exact: true })).toBeVisible();
    await expect(tests.getByRole("radiogroup", { name: `${OBER} ${side}`, exact: true })).toBeVisible();
    await expect(tests.getByLabel(`${SLR} ${side} (°)`, { exact: true })).toBeVisible();
    await expect(tests.getByLabel(`${LUNGE} ${side} (cm)`, { exact: true })).toBeVisible();
  }
  await expect(tests.getByRole("radiogroup", { name: /Spurling/ })).toHaveCount(0);
  const others = tests.getByRole("list", { name: "Altri test" });
  await tests.getByLabel("Cerca un test", { exact: true }).fill("spurling");
  await expect(others.getByRole("button")).toHaveCount(1);
  await others.getByRole("button", { name: /^Test di Spurling/ }).click();
  await expect(tests.getByRole("radiogroup", { name: `${SPURLING} dx`, exact: true })).toBeVisible();
  await expect(tests.getByRole("radiogroup", { name: `${SPURLING} sx`, exact: true })).toBeVisible();
  // Un test aperto dall'elenco e senza risultato si richiude.
  await tests.getByRole("button", { name: `Chiudi: ${SPURLING}`, exact: true }).click();
  await expect(tests.getByRole("radiogroup", { name: /Spurling/ })).toHaveCount(0);

  // Thomas modificato, dx, «Positivo»: "Salvato" (una corsa prima l'ha già scritto: passa da «Negativo»).
  const thomasDx = tests.getByRole("radiogroup", { name: `${THOMAS} dx`, exact: true });
  await chooseRadio(page, thomasDx, "Positivo", "Negativo");
  await expect(saveStatus(page)).toHaveAttribute("aria-live", "polite");

  // Un valore numerico fuori dai limiti del test resta scritto con la frase del server sotto il campo.
  const slrDx = tests.getByLabel(`${SLR} dx (°)`, { exact: true });
  await slrDx.fill("181");
  await slrDx.blur();
  await expect(slrDx).toHaveAttribute("aria-invalid", "true");
  await expect(slrDx).toHaveAccessibleDescription("Valore fuori dai limiti del test (0-180).");
  await slrDx.fill("");
  await slrDx.blur();
  await expect(slrDx).not.toHaveAttribute("aria-invalid", "true");

  // Test libero: nome, valore, unità e lato fanno una riga che si rilegge.
  const free = tests.getByRole("group", { name: "Test libero", exact: true });
  await free.getByLabel(/^Nome del test/).fill("Prova libera");
  await free.getByLabel(/^Valore/).fill("12");
  await free.getByLabel(/^Unità/).fill("cm");
  await free.getByRole("radiogroup", { name: "Lato" }).getByRole("radio", { name: "dx", exact: true }).click();
  await free.getByRole("button", { name: "Aggiungi il test" }).click();
  const freeRow = tests.getByLabel("Prova libera dx (cm)", { exact: true });
  await expect(freeRow).toHaveValue("12");
  await expect(freeRow).toHaveCount(1);
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(free.getByLabel(/^Nome del test/)).toHaveValue("");

  // Nessuna irradiazione e gruppo cervicale chiuso: l'esame neurologico non compare.
  await expect(c.getByRole("region", { name: "Esame neurologico" })).toHaveCount(0);

  // Osservazione e ipotesi di lavoro si salvano come ogni testo.
  await writeText(page, c.getByLabel("Osservazione"), "Gonfiore lieve al ginocchio destro");
  await writeText(page, c.getByLabel("Ipotesi di lavoro"), "Sovraccarico del quadricipite");

  // Foto del giorno: il dialogo porta la riga sul volto, Esc lo chiude senza caricare e il focus torna sul pulsante.
  await expect(c.getByRole("heading", { level: 3, name: "Foto del giorno" })).toBeVisible();
  const upload = c.getByRole("button", { name: "Carica foto", exact: true });
  await upload.click();
  const dialog = page.getByRole("dialog", { name: "Carica foto" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(FACE_HINT)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(upload).toBeFocused();
  await expect(page.getByText("Foto salvata.")).toHaveCount(0);

  await page.reload();
  const again = sectionC(page).getByRole("region", { name: "Test", exact: true });
  await expect(
    again.getByRole("radiogroup", { name: `${THOMAS} dx`, exact: true }).getByRole("radio", { name: "Positivo", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(again.getByLabel("Prova libera dx (cm)", { exact: true })).toHaveValue("12");
  await expect(sectionC(page).getByLabel("Osservazione")).toHaveValue("Gonfiore lieve al ginocchio destro");
  await expect(sectionC(page).getByLabel("Ipotesi di lavoro")).toHaveValue("Sovraccarico del quadricipite");
});

test("la sezione D ha una riga per regione con le tecniche come interruttori, l'approccio dove serve e la risposta al trattamento", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  await ensureScreeningConfirmed(page);
  await ensureLegFinding(page);
  const d = sectionD(page);

  // «Aggiungi le regioni con disfunzioni» aggiunge la riga dell'arto inferiore (severità 2) senza scrivere niente.
  const row = await openLegRow(page);
  await expect(row.getByRole("switch")).toHaveCount(16);
  for (const name of TECHNIQUE_NAMES) await expect(row.getByRole("switch", { name, exact: true })).toBeVisible();
  // L'etichetta intera della tecnica è la descrizione dell'interruttore.
  await expect(row.getByRole("switch", { name: "HVLA", exact: true })).toHaveAccessibleDescription(
    "HVLA (thrust ad alta velocità e bassa ampiezza)",
  );
  await expect(row.getByRole("switch", { name: "TOG", exact: true })).toHaveAccessibleDescription(
    "TOG (trattamento osteopatico generale)",
  );

  // Tessuti molli: "Salvato" e, nel suo pannello, «Buona» già scelta.
  const soft = row.getByRole("switch", { name: "Tessuti molli", exact: true });
  await switchOn(page, soft);
  const softPanel = row.getByRole("region", { name: "Tessuti molli", exact: true });
  await expect(softPanel.getByRole("radiogroup", { name: "Tolleranza" }).getByRole("radio", { name: "Buona" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Tolleranza e risposta della riga salvano insieme alla riga intera.
  await chooseRadio(page, softPanel.getByRole("radiogroup", { name: "Tolleranza", exact: true }), "Fastidio", "Buona");
  await chooseRadio(page, softPanel.getByRole("radiogroup", { name: "Risposta", exact: true }), "Migliorato", "Invariato");

  // Craniale: "Salvato" con «Indiretto» già scelto.
  const cranial = row.getByRole("switch", { name: "Craniale", exact: true });
  await switchOn(page, cranial);
  const cranialPanel = row.getByRole("region", { name: "Craniale", exact: true });
  await expect(cranialPanel.getByRole("radiogroup", { name: "Approccio" }).getByRole("radio", { name: "Indiretto", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Fasciale senza approccio: la frase accanto all'interruttore e nessuna riga (lo prova la pagina riletta più sotto).
  const fascial = row.getByRole("switch", { name: "Fasciale", exact: true });
  await switchOff(page, fascial);
  await fascial.click();
  await expect(row.getByText("Scegli l'approccio.")).toBeVisible();
  await expect(fascial).toHaveAttribute("aria-checked", "false");
  await expect(fascial).toHaveAttribute("aria-invalid", "true");
  await expect(fascial).toHaveAccessibleDescription(/Scegli l'approccio\./);
  await expect(
    row.getByRole("radiogroup", { name: "Approccio di Fasciale" }).locator('[role="radio"][tabindex="0"]'),
  ).toBeFocused();
  await expect(row.getByRole("button", { name: "Dettagli: Fasciale", exact: true })).toHaveCount(0);

  // Risposta al trattamento: un solo campo per la visita.
  const response = d.getByRole("radiogroup", { name: "Risposta al trattamento", exact: true });
  await chooseRadio(page, response, "Migliorato", "Invariato");

  await page.reload();
  const again = await openLegRow(page);
  // La riga riletta: Tessuti molli e Craniale accesi, Fasciale spento (la frase non ha scritto niente).
  await expect(again.getByRole("switch", { name: "Tessuti molli", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(again.getByRole("switch", { name: "Craniale", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(again.getByRole("switch", { name: "Fasciale", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(
    sectionD(page).getByRole("radiogroup", { name: "Risposta al trattamento", exact: true }).getByRole("radio", { name: "Migliorato" }),
  ).toHaveAttribute("aria-checked", "true");

  // I dettagli si aprono dal pulsante, col focus dentro, e Esc li chiude riportando il focus sul pulsante.
  const details = again.getByRole("button", { name: "Dettagli: Tessuti molli", exact: true });
  await details.click();
  const panel = again.getByRole("region", { name: "Tessuti molli", exact: true });
  await expect(panel.getByRole("radiogroup", { name: "Tolleranza" }).getByRole("radio", { name: "Fastidio" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(panel.getByRole("radiogroup", { name: "Tolleranza" }).locator('[role="radio"][tabindex="0"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(details).toBeFocused();

  // Fasciale con l'approccio scelto: la riga nasce, con «Diretto» nel pannello; poi si toglie.
  const fascialAgain = again.getByRole("switch", { name: "Fasciale", exact: true });
  await fascialAgain.click();
  await again.getByRole("radiogroup", { name: "Approccio di Fasciale" }).getByRole("radio", { name: "Diretto", exact: true }).click();
  await expect(fascialAgain).toHaveAttribute("aria-checked", "true");
  await expect(
    again.getByRole("region", { name: "Fasciale", exact: true }).getByRole("radiogroup", { name: "Approccio" }).getByRole("radio", { name: "Diretto", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");
  await switchOff(page, fascialAgain);

  // «Altra tecnica» vuole il nome e l'approccio, senza default.
  const other = again.getByRole("switch", { name: "Altra tecnica", exact: true });
  await other.click();
  const otherName = again.getByLabel(/^Nome della tecnica/);
  await expect(otherName).toBeFocused();
  await again.getByRole("button", { name: "Aggiungi la tecnica" }).click();
  await expect(again.getByText("Scrivi il nome della tecnica.")).toBeVisible();
  await otherName.fill("Mobilizzazione di prova");
  await again.getByRole("button", { name: "Aggiungi la tecnica" }).click();
  await expect(again.getByText("Scegli l'approccio.")).toBeVisible();
  await again.getByRole("radiogroup", { name: "Approccio della tecnica" }).getByRole("radio", { name: "Indiretto", exact: true }).click();
  await again.getByRole("button", { name: "Aggiungi la tecnica" }).click();
  const added = again.getByRole("switch", { name: "Mobilizzazione di prova", exact: true });
  await expect(added).toHaveAttribute("aria-checked", "true");
  await expect(again.getByLabel(/^Nome della tecnica/)).toHaveCount(0);
  await expect(other).toBeFocused();
  await expect(saveStatus(page)).toHaveText("Salvato");
  await switchOff(page, added);
  await expect(added).toHaveCount(0);

  // Rimessa a posto la riga: le tecniche accese da questo test si spengono e la risposta si toglie.
  await switchOff(page, again.getByRole("switch", { name: "Tessuti molli", exact: true }));
  await switchOff(page, again.getByRole("switch", { name: "Craniale", exact: true }));
  await d.getByRole("button", { name: "Togli il valore: Risposta al trattamento" }).click();
  await expect(saveStatus(page)).toHaveText("Salvato");
});

test("lo screening dà «Con cautela», blocca le tecniche con la frase e lascia in conflitto una riga già salvata finché non ha la sua nota", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  await ensureScreeningConfirmed(page);
  await ensureLegFinding(page);
  const row = await openLegRow(page);
  const hvla = row.getByRole("switch", { name: "HVLA", exact: true });
  const soft = row.getByRole("switch", { name: "Tessuti molli", exact: true });
  const b = sectionB(page);
  // Un interruttore acceso resta libero (si può spegnere); questo test parte da quelli spenti.
  await switchOff(page, soft);
  await expect(hvla).toBeEnabled();
  await expect(soft).toBeEnabled();
  await expect(sectionD(page).getByText(SCREENING_FIRST)).toHaveCount(0);

  // «Con cautela» sulle dirette: l'etichetta gialla sulle tecniche dirette (non su HVLA), e a parole anche nella descrizione.
  const direct = b.getByRole("radiogroup", { name: "Dirette", exact: true });
  await direct.getByRole("radio", { name: "Con cautela", exact: true }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(["Thrust: indicato", "Dirette: con cautela", "Indirette: indicato"]);
  await expect(soft).toHaveAccessibleDescription(/Con cautela/);
  await expect(row.getByText("Con cautela", { exact: true }).first()).toBeVisible();
  await expect(hvla).not.toHaveAccessibleDescription(/Con cautela/);
  await direct.getByRole("radio", { name: "Indicato", exact: true }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await expect(row.getByText("Con cautela", { exact: true })).toHaveCount(0);

  // «Sì» sull'anestesia a sella toglie la conferma: la sezione D si legge e basta, con la frase in cima.
  const saddle = b.locator("#voce-rf_ces_saddle");
  await saddle.getByRole("radio", { name: "Sì", exact: true }).click();
  await expect(screeningTodo(page)).toBeVisible();
  await expect(sectionD(page).getByText(SCREENING_FIRST)).toBeVisible();
  await expect(hvla).toBeDisabled();
  await expect(soft).toBeDisabled();
  await expect(sectionD(page).getByRole("button", { name: ADD_REGIONS })).toBeDisabled();
  await expect(sectionD(page).getByRole("combobox", { name: "Aggiungi una regione" })).toBeDisabled();

  // Riconfermato, le tre famiglie sono controindicate: ogni interruttore è spento con la frase del blocco sotto la riga.
  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText([
    "Thrust: controindicato",
    "Dirette: controindicato",
    "Indirette: controindicato",
  ]);
  await expect(sectionD(page).getByText(SCREENING_FIRST)).toHaveCount(0);
  await expect(hvla).toBeDisabled();
  await expect(soft).toBeDisabled();
  await expect(row.getByText(BLOCK_SENTENCE, { exact: true })).toBeVisible();
  await expect(hvla).toHaveAccessibleDescription(new RegExp(BLOCK_SENTENCE.slice(0, 40)));
  // «Altra tecnica»: gli approcci che lo screening blocca sono disattivati, col motivo scritto sotto la scelta.
  await row.getByRole("switch", { name: "Altra tecnica", exact: true }).click();
  const otherApproach = row.getByRole("radiogroup", { name: "Approccio della tecnica" });
  await expect(otherApproach.getByRole("radio", { name: "Diretto", exact: true })).toBeDisabled();
  await expect(otherApproach.getByRole("radio", { name: "Indiretto", exact: true })).toBeDisabled();
  await expect(otherApproach).toHaveAccessibleDescription(/^Altra tecnica controindicata in questa visita: anestesia a sella\./);
  await row.getByRole("button", { name: "Torna indietro" }).click();
  await expect(row.getByRole("radiogroup", { name: "Approccio della tecnica" })).toHaveCount(0);

  // Tolta la controindicazione e riconfermato, le tecniche tornano libere.
  await saddle.getByRole("radio", { name: "No", exact: true }).click();
  await expect(screeningTodo(page)).toBeVisible();
  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await expect(hvla).toBeEnabled();
  await expect(soft).toBeEnabled();
  await expect(row.getByText(BLOCK_SENTENCE, { exact: true })).toHaveCount(0);

  // Una riga già salvata resta quando arriva il red flag, e la visita non chiude finché non ha la nota.
  await switchOn(page, soft);
  const conflict = page
    .getByRole("complementary")
    .getByRole("region", { name: "Per chiudere" })
    .getByRole("link", { name: /^Una tecnica è in contrasto con lo screening/ });
  await expect(conflict).toHaveCount(0);
  await saddle.getByRole("radio", { name: "Sì", exact: true }).click();
  await expect(screeningTodo(page)).toBeVisible();
  // Con lo screening non confermato la riga già accesa si può ancora spegnere, e non si accende altro.
  await expect(soft).toBeEnabled();
  await expect(hvla).toBeDisabled();
  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText([
    "Thrust: controindicato",
    "Dirette: controindicato",
    "Indirette: controindicato",
  ]);
  await expect(soft).toHaveAttribute("aria-checked", "true");
  await expect(row.getByText(SOFT_SENTENCE, { exact: true })).toBeVisible();
  await expect(conflict).toBeVisible();
  await expect(conflict).toHaveAttribute("href", "#riga-tecnica-lower_extremity");

  // La nota della riga dice che la tecnica è venuta prima del sintomo: il blocco di chiusura sparisce.
  // Il pannello si è aperto da solo quando l'interruttore si è acceso, e resta aperto.
  const panel = row.getByRole("region", { name: "Tessuti molli", exact: true });
  if ((await panel.count()) === 0) await row.getByRole("button", { name: "Dettagli: Tessuti molli", exact: true }).click();
  await expect(panel.getByText(CONFLICT_HINT)).toBeVisible();
  await writeText(page, panel.getByLabel(/^Nota/), "Eseguita prima della comparsa del sintomo");
  await expect(conflict).toHaveCount(0);

  // Rimessa a posto la visita: «No» sul red flag, lo screening riconfermato, la riga spenta.
  await saddle.getByRole("radio", { name: "No", exact: true }).click();
  await expect(screeningTodo(page)).toBeVisible();
  await b.getByRole("button", { name: "Conferma lo screening" }).click();
  await expect(pillsOf(page).getByRole("listitem")).toHaveText(PILLS);
  await switchOff(page, soft);
});

test("una tecnica diretta sulla cervicale apre subito il gruppo cervicale e l'esame neurologico, e la regione senza disfunzioni dà l'avviso", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  await ensureScreeningConfirmed(page);
  await ensureLegFinding(page);
  const d = sectionD(page);
  const b = sectionB(page);
  const c = sectionC(page);
  const cervicalGroup = b.getByRole("region", { name: "Red flag cervicali" });
  const neuro = c.getByRole("region", { name: "Esame neurologico" });

  // La regione «Cervicale» si aggiunge dall'elenco: senza tecniche il gruppo cervicale e l'esame neurologico non ci sono.
  const row = d.getByRole("region", { name: "Cervicale", exact: true });
  if ((await row.count()) === 0) {
    await d.getByRole("combobox", { name: "Aggiungi una regione" }).click();
    await page.getByRole("option", { name: "Cervicale", exact: true }).click();
  }
  await expect(row).toBeVisible();
  await expect(cervicalGroup).toHaveCount(0);
  await expect(neuro).toHaveCount(0);
  await expect(row.getByText(TART_WARNING)).toHaveCount(0);

  // Tessuti molli (diretta) sulla cervicale: senza ricaricare compaiono il gruppo, la voce in "Per chiudere" e l'esame.
  const soft = row.getByRole("switch", { name: "Tessuti molli", exact: true });
  await switchOn(page, soft);
  await expect(cervicalGroup).toBeVisible();
  await expect(screeningTodo(page)).toBeVisible();
  await expect(d.getByText(SCREENING_FIRST)).toBeVisible();
  await expect(row.getByRole("switch", { name: "HVLA", exact: true })).toBeDisabled();
  await expect(neuro).toBeVisible();
  await expect(neuro.getByRole("group", { name: "Arto superiore" })).toBeVisible();
  await expect(neuro.getByRole("radiogroup", { name: "Hoffmann dx" })).toBeVisible();
  // Con la sola cervicale l'arto inferiore porta il solo segno di Babinski.
  await expect(neuro.getByRole("group", { name: "Arto inferiore" }).getByRole("radiogroup")).toHaveCount(2);
  await expect(neuro.getByRole("radiogroup", { name: "Babinski dx" })).toBeVisible();
  await expect(neuro.getByRole("radiogroup", { name: "Riflesso rotuleo dx" })).toHaveCount(0);

  // L'avviso della regione senza disfunzioni e «Apri la regione» col pannello della cervicale nella sezione C.
  await expect(row.getByText(TART_WARNING)).toBeVisible();
  await row.getByRole("button", { name: "Apri la regione Cervicale" }).click();
  await expect(c.getByRole("region", { name: "Cervicale", exact: true })).toBeVisible();
  await expect(c.getByRole("radiogroup", { name: "Severità" }).locator('[role="radio"][tabindex="0"]')).toBeFocused();
  await page.keyboard.press("Escape");

  // Un risultato dell'esame si salva; tolto, e spenta la tecnica (ancora possibile senza screening confermato), il gruppo
  // e l'esame spariscono di nuovo.
  const forceC5 = neuro.getByRole("radiogroup", { name: "Forza C5 dx" });
  await chooseRadio(page, forceC5, "4", "3");
  await neuro.getByRole("button", { name: "Togli il valore: Forza C5 dx" }).click();
  await expect(forceC5.getByRole("radio", { name: "4", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(saveStatus(page)).toHaveText("Salvato");
  await switchOff(page, soft);
  await expect(cervicalGroup).toHaveCount(0);
  await expect(neuro).toHaveCount(0);
  await expect(row.getByText(TART_WARNING)).toHaveCount(0);
  await ensureScreeningConfirmed(page);
});

// Quinto blocco: la sezione E, la barra con "Chiudi la visita" e la colonna "Per chiudere"
// sulla prima visita del paziente proprio, con la disfunzione dell'arto inferiore dei blocchi prima. La visita non si
// chiude: «Chiudi la visita» parte con l'obiettivo vuoto, il comando la ferma, e l'obiettivo torna. Una
// seconda corsa trova il consiglio e il piano già spuntati: si tolgono prima di provarli. La copia, "Conferma tutti i
// copiati e chiudi" e la rettifica dall'interfaccia li prova `demo.spec.ts`, su Marco.

const OPENING_MISSING = "Per la prima visita servono motivo, regione principale, obiettivo e sedute previste.";
const PLAN_WARNING = "Piano non segnato come spiegato e accettato.";
const sectionE = (page: Page): Locator => page.locator("#sezione-e");

/** Spunta una casella; se una corsa prima l'ha già spuntata la toglie e aspetta il salvataggio, poi la spunta. */
async function tick(page: Page, box: Locator): Promise<void> {
  if ((await box.getAttribute("aria-checked")) === "true") {
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "false");
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  await box.click();
  await expect(box).toHaveAttribute("aria-checked", "true");
}

test("la sezione E spunta un consiglio «A voce» e il piano accettato, offre il prossimo passo, e «Chiudi la visita» senza obiettivo porta alla sezione A", async ({
  page,
}) => {
  await openVisitWithRegion(page);
  await ensureScreeningConfirmed(page);
  await ensureLegFinding(page);
  const e = sectionE(page);

  // I consigli proposti dall'arto inferiore, non spuntati finché non si spuntano.
  const walk = e.getByRole("checkbox", { name: "Camminata quotidiana", exact: true });
  await expect(walk).toBeVisible();
  await expect(e.getByRole("checkbox", { name: "Allungamento dei flessori dell'anca", exact: true })).toBeVisible();

  // La spunta scrive il consiglio col testo del modello e il canale «A voce» già scelto.
  await tick(page, walk);
  const channels = e.getByRole("group", { name: "Canale: Camminata quotidiana" });
  await expect(channels.getByRole("button", { name: "A voce", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(channels.getByRole("button", { name: "Foglio stampato", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(e.getByLabel("Testo: Camminata quotidiana")).not.toHaveValue("");
  // "Copia il messaggio": un solo pulsante per la sezione E.
  await expect(page.getByRole("button", { name: "Copia il messaggio" })).toHaveCount(1);

  // Un testo appena scritto e subito un canale: il canale manda il testo scritto, non quello di prima.
  const adviceText = "Cammina 30 minuti, anche in due volte";
  await e.getByLabel("Testo: Camminata quotidiana").fill(adviceText);
  await channels.getByRole("button", { name: "Foglio stampato", exact: true }).click();
  await expect(channels.getByRole("button", { name: "Foglio stampato", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(saveStatus(page)).toHaveText("Salvato");
  await page.reload();
  await expect(e.getByLabel("Testo: Camminata quotidiana")).toHaveValue(adviceText);
  await expect(channels.getByRole("button", { name: "Foglio stampato", exact: true })).toHaveAttribute("aria-pressed", "true");

  // Alla prima visita il piano spiegato e accettato: salvato, l'avviso giallo se ne va.
  const warnings = page.getByRole("complementary").getByRole("region", { name: "Avvisi" });
  await tick(page, e.getByRole("checkbox", { name: "Piano spiegato e accettato dal paziente", exact: true }));
  await expect(saveStatus(page)).toHaveText("Salvato");
  await expect(warnings.getByRole("link", { name: PLAN_WARNING })).toHaveCount(0);

  // Il prossimo passo: ci sono, e non si premono (il rinvio apre la sua lettera).
  for (const name of ["Fissa il prossimo appuntamento", "Chiudi il ciclo", "Prepara rinvio"]) {
    await expect(e.getByRole("button", { name, exact: true })).toBeVisible();
  }

  // La barra: "Chiudi la visita", e nessuna copia alla prima visita di un paziente senza visite.
  const bar = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  const close = bar.getByRole("button", { name: "Chiudi la visita", exact: true });
  await expect(close).toBeVisible();
  await expect(page.getByRole("button", { name: "Copia dalla visita precedente" })).toHaveCount(0);

  // Con l'obiettivo vuoto la prima voce di "Per chiudere" è il link ai campi d'apertura; la chiusura risponde con la
  // stessa frase e il focus va alla sezione A. La visita resta in bozza.
  const goal = sectionA(page).getByLabel("Obiettivo");
  if ((await goal.inputValue()) !== "") {
    await goal.fill("");
    await goal.blur();
    await expect(saveStatus(page)).toHaveText("Salvato");
  }
  const closing = page.getByRole("complementary").getByRole("region", { name: "Per chiudere" });
  await expect(closing.getByRole("link").first()).toHaveText(OPENING_MISSING);
  await expect(closing.getByRole("link", { name: OPENING_MISSING })).toHaveAttribute("href", "#apertura-ciclo");
  await close.click();
  await expect(bar.getByRole("status")).toHaveText(OPENING_MISSING);
  await expect(page.locator("#apertura-ciclo")).toBeFocused();
  await expect(bar.getByText("Bozza", { exact: true })).toBeVisible();
  await expect(close).toBeEnabled();

  // L'obiettivo torna: la visita resta una bozza per i blocchi che seguono.
  await writeText(page, goal, "Salire le scale senza dolore");
});
