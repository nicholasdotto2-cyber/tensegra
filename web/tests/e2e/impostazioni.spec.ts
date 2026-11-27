import { expect, type Locator, type Page, type Request, test } from "@playwright/test";

// Le Impostazioni sulla demo dei test: il sottomenu con le nove sezioni
// costruite, i moduli con i dati del seed, gli errori degli orari sotto il campo, l'uscita con modifiche non
// salvate, il tema e i dati di prova. Nessun valore diverso viene salvato: gli errori
// fermano il "Salva" prima di scrivere. Il describe Messaggi personalizza un modello e lo ripristina.

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

const SECTIONS = ["Studio", "Orari", "Fisco", "Iscrizione e polizza", "Cartella", "Messaggi", "Consensi", "Aspetto", "Dati di prova"];

function content(page: Page) {
  return page.locator("main#contenuto");
}

/**
 * Il focus visibile dell'elemento col focus: un bordo o un contorno pieno nel colore
 * `ring` (4,34:1 sul bianco). L'alone `ring-ring/50` da solo (circa 2:1) non basta. I controlli hanno una transizione
 * sui colori: il valore si legge con `expect.poll`.
 */
async function solidRingFocus(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ring)";
    document.body.append(probe);
    const ring = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    const border = style.borderTopStyle === "solid" && parseFloat(style.borderTopWidth) >= 1 && style.borderTopColor === ring;
    const outline = style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 1 && style.outlineColor === ring;
    return border || outline;
  });
}

test("con la tastiera il focus sulle voci del sottomenu è pieno, non solo l'alone", async ({ page }) => {
  await page.goto("/impostazioni/studio");
  await page.waitForLoadState("networkidle");

  const links = page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link");
  for (const name of ["Studio", "Orari"]) {
    const link = links.filter({ hasText: name });
    for (let presses = 0; presses < 40; presses += 1) {
      if (await link.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(link).toBeFocused();
    await expect.poll(() => solidRingFocus(link)).toBe(true);
  }
});

test("Impostazioni porta a Studio e il sottomenu ha le nove sezioni costruite", async ({ page }) => {
  await page.goto("/impostazioni");

  await expect(page).toHaveURL(/\/impostazioni\/studio$/);
  await expect(page.getByRole("heading", { level: 1, name: "Impostazioni" })).toBeVisible();
  const links = page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link");
  await expect(links).toHaveText(SECTIONS);
  await expect(links.first()).toHaveAttribute("aria-current", "page");
});

test("Studio mostra i dati del seed e si salva senza cambiarli", async ({ page }) => {
  await page.goto("/impostazioni/studio");

  const main = content(page);
  await expect(main.getByRole("textbox", { name: /^Nome dello studio/ })).toHaveValue("Studio Osteopatico Borgo Tiglio");
  await expect(main.getByRole("textbox", { name: /^Telefono/ })).toHaveValue("+39 051 000 0000");
  await expect(main.getByRole("textbox", { name: /^Titolo/ })).toHaveValue("Osteopata");

  // Il telefono scritto senza prefisso e con spazi resta lo stesso numero: si salva in E.164 e torna a schermo.
  await main.getByRole("textbox", { name: /^Telefono/ }).fill("051 000 0000");
  await main.getByRole("button", { name: "Salva" }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
  await expect(main.getByRole("textbox", { name: /^Telefono/ })).toHaveValue("+39 051 000 0000");

  // La destinazione: ricaricata, la pagina mostra ancora i dati dello studio.
  await page.reload();
  await expect(main.getByRole("textbox", { name: /^Nome dello studio/ })).toHaveValue("Studio Osteopatico Borgo Tiglio");
  await expect(main.getByRole("textbox", { name: /^Telefono/ })).toHaveValue("+39 051 000 0000");
});

test("Orari mostra le fasce del seed e la domenica chiusa", async ({ page }) => {
  await page.goto("/impostazioni/orari");

  const monday = page.getByRole("group", { name: "Lunedì" });
  await expect(monday.getByLabel("Inizio della prima fascia")).toHaveValue("09:00");
  await expect(monday.getByLabel("Fine della prima fascia")).toHaveValue("13:00");
  await expect(monday.getByLabel("Inizio della seconda fascia")).toHaveValue("14:30");
  await expect(monday.getByLabel("Fine della seconda fascia")).toHaveValue("19:30");
  await expect(monday.getByRole("switch")).toBeChecked();
  await expect(monday.getByText("Chiuso")).toHaveCount(0);

  const sunday = page.getByRole("group", { name: "Domenica" });
  await expect(sunday.getByText("Chiuso")).toBeVisible();
  await expect(sunday.getByRole("switch")).not.toBeChecked();
  await expect(sunday.getByLabel("Inizio della prima fascia")).toHaveCount(0);
});

test("Orari: una fine prima dell'inizio e due fasce sovrapposte si fermano sotto il campo, col focus", async ({
  page,
}) => {
  await page.goto("/impostazioni/orari");
  const monday = page.getByRole("group", { name: "Lunedì" });

  await monday.getByLabel("Fine della prima fascia").selectOption("08:00");
  await content(page).getByRole("button", { name: "Salva" }).click();
  const end = monday.getByLabel("Fine della prima fascia");
  await expect(monday.getByText("L'ora di fine deve venire dopo l'inizio.")).toBeVisible();
  await expect(end).toHaveAttribute("aria-invalid", "true");
  await expect(end).toBeFocused();
  await expect(end).toHaveAccessibleDescription("L'ora di fine deve venire dopo l'inizio.");

  // Corretta la prima fascia, la seconda 12:00-15:00 entra nella prima (09:00-13:00).
  await end.selectOption("13:00");
  await monday.getByLabel("Inizio della seconda fascia").selectOption("12:00");
  await monday.getByLabel("Fine della seconda fascia").selectOption("15:00");
  await content(page).getByRole("button", { name: "Salva" }).click();
  await expect(monday.getByText("Le due fasce si sovrappongono.")).toBeVisible();
  await expect(monday.getByLabel("Inizio della seconda fascia")).toHaveAttribute("aria-invalid", "true");
  await expect(monday.getByLabel("Inizio della seconda fascia")).toBeFocused();
  await expect(monday.getByText("L'ora di fine deve venire dopo l'inizio.")).toHaveCount(0);

  // Niente è stato scritto: ricaricata, la pagina ha ancora le fasce del seed.
  await page.reload();
  await expect(page.getByRole("group", { name: "Lunedì" }).getByLabel("Inizio della seconda fascia")).toHaveValue(
    "14:30",
  );
});

test("Orari: con modifiche non salvate chi esce dalla sezione vede «Uscire senza salvare?»", async ({ page }) => {
  await page.goto("/impostazioni/orari");
  const nav = page.getByRole("navigation", { name: "Menu" });

  await page.getByRole("group", { name: "Lunedì" }).getByLabel("Fine della prima fascia").selectOption("12:00");
  await nav.getByRole("link", { name: /^Agenda/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Uscire senza salvare?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Le modifiche di questa sezione andranno perse.")).toBeVisible();

  await dialog.getByRole("button", { name: "Torna indietro" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/impostazioni\/orari$/);
  // La modifica è ancora lì.
  await expect(page.getByRole("group", { name: "Lunedì" }).getByLabel("Fine della prima fascia")).toHaveValue("12:00");

  await nav.getByRole("link", { name: /^Agenda/ }).click();
  await dialog.getByRole("button", { name: "Esci senza salvare" }).click();
  await expect(page).toHaveURL(/\/agenda/);

  // La destinazione: tornati su Orari, il valore è quello salvato, non quello abbandonato.
  await page.goto("/impostazioni/orari");
  await expect(page.getByRole("group", { name: "Lunedì" }).getByLabel("Fine della prima fascia")).toHaveValue("13:00");
});

test("Orari: senza modifiche si lascia la sezione senza domande", async ({ page }) => {
  await page.goto("/impostazioni/orari");

  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: /^Agenda/ }).click();

  await expect(page).toHaveURL(/\/agenda/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("a 1280 x 720 il campo col focus non finisce sotto il banner (WCAG 2.4.11)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/impostazioni/orari");
  const save = content(page).getByRole("button", { name: "Salva" });

  // Tab fino all'ultimo campo: a ogni passo il campo col focus sta sotto il banner alto 36 px.
  await page.getByRole("group", { name: "Lunedì" }).getByRole("switch").focus();
  let lastTop = Number.NaN;
  for (let presses = 0; presses < 80; presses += 1) {
    lastTop = await page.evaluate(() => document.activeElement?.getBoundingClientRect().top ?? Number.NaN);
    expect(lastTop).toBeGreaterThanOrEqual(36);
    if (await save.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(save).toBeFocused();
  expect(lastTop).toBeGreaterThanOrEqual(36);
});

test("Iscrizione e polizza mostra i dati del seed senza avviso", async ({ page }) => {
  await page.goto("/impostazioni/iscrizione-e-polizza");

  const main = content(page);
  await expect(main.getByRole("combobox", { name: /^Tipo di iscrizione/ })).toContainText("Elenco speciale");
  await expect(main.getByRole("textbox", { name: /^Compagnia/ })).toHaveValue("Compagnia Esempio Assicurazioni");
  await expect(main.getByRole("textbox", { name: /^Massimale in euro/ })).toHaveValue("2.000.000");
  // La polizza scade fra 200 giorni: niente avviso.
  await expect(main.getByText(/La polizza (è scaduta|scade) il/)).toHaveCount(0);
});

test("Cartella mostra i default e i tre promemoria di rinvio accesi", async ({ page }) => {
  await page.goto("/impostazioni/cartella");

  const main = content(page);
  await expect(main.getByRole("spinbutton", { name: /^Cadenza di richiamo predefinita/ })).toHaveValue("6");
  await expect(main.getByRole("spinbutton", { name: /^Sedute previste predefinite/ })).toHaveValue("4");
  await expect(main.getByRole("combobox", { name: /^Intervallo fra le sedute/ })).toContainText("2 settimane");
  for (const label of ["R1 Red flag", "R2 Peggioramento", "R3 Persistenza oltre i tempi previsti"]) {
    await expect(main.getByRole("switch", { name: label })).toBeChecked();
  }
});

test("Aspetto cambia il tema subito e non ha un Salva", async ({ page }) => {
  await page.goto("/impostazioni/aspetto");

  const main = content(page);
  await expect(main.getByRole("button", { name: "Salva" })).toHaveCount(0);
  await main.getByRole("button", { name: "Scuro" }).click();
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  await main.getByRole("button", { name: "Chiaro" }).click();
  await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
});

test("Dati di prova dice quando sono stati creati e spiega il numero per le prove", async ({ page }) => {
  await page.goto("/impostazioni/dati-di-prova");

  const main = content(page);
  await expect(main.getByText("Dati creati il 04/11/2026 alle 08:30 (versione 1).")).toBeVisible();
  await expect(main.locator("time")).toHaveAttribute("datetime", "2026-11-04T08:30");
  await expect(main.getByLabel(/^Numero per le prove WhatsApp/)).toBeVisible();
  await expect(
    main.getByText(
      "Se lo compili, i messaggi della demo si aprono verso questo numero (per esempio il tuo). Se lo lasci vuoto, WhatsApp ti chiede a chi inviarli.",
    ),
  ).toBeVisible();
  // C'è anche "Ricrea i dati di prova per oggi" (ricrea.spec.ts lo prova fino in fondo).
  await expect(main.getByRole("button", { name: "Ricrea i dati di prova per oggi", exact: true })).toBeVisible();
});

test("Le sezioni future e uno slug sconosciuto danno Pagina non trovata", async ({ page }) => {
  for (const slug of ["boh"]) {
    // Con il `loading.tsx` della sezione la risposta parte già in streaming con 200: il not-found di Next
    // arriva nel corpo e il browser non scrive nessun 404 in console.
    await page.goto(`/impostazioni/${slug}`);
    await expect(page.getByRole("heading", { level: 1, name: "Pagina non trovata" })).toBeVisible();
    // La sidebar resta: è la pagina dentro la shell.
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
  }
});

// La conservazione torna al valore iniziale. La firma disegnata è inventata e resta nella demo,
// come i documenti di consensi.spec.ts; non si cancellano firme o PDF già raccolti.
test.describe("Consensi", () => {
  let retention: string;
  let releaseReply: (() => void) | undefined;
  const years = (page: Page) => page.getByRole("spinbutton", { name: "Conservazione della documentazione clinica (anni)" });
  test.beforeEach(async ({ page }) => {
    releaseReply = undefined;
    await page.goto("/impostazioni/consensi");
    await page.waitForLoadState("networkidle");
    retention = await years(page).inputValue();
  });
  test.afterEach(async ({ page }) => {
    releaseReply?.();
    await page.unroute("**/impostazioni/consensi**");
    await page.goto("/impostazioni/consensi");
    await page.waitForLoadState("networkidle");
    await years(page).fill(retention);
    await page.getByRole("button", { name: "Salva conservazione", exact: true }).click();
    await expect(page.getByText("Conservazione salvata.", { exact: true })).toBeVisible();
  });

  test("tre moduli readonly/versionati, anteprima con Esc e focus restituito, guardia uscita", async ({ page }) => {
    // Un valore dello studio compilato nel testo di ogni modulo: il modulo del minore non nomina lo studio.
    for (const [title, studioValue] of [
      ["Consenso informato al trattamento osteopatico", "Studio Osteopatico Borgo Tiglio"],
      ["Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)", "Studio Osteopatico Borgo Tiglio"],
      ["Consenso informato al trattamento osteopatico di persona minore", "Polizza di responsabilità civile professionale Compagnia Esempio Assicurazioni"],
    ] as const) {
      const consentModule = page.getByRole("group", { name: title, exact: true });
      await expect(consentModule.getByText("Versione 2026.1", { exact: true })).toBeVisible();
      await expect(consentModule.getByRole("textbox")).toHaveCount(0);
      const preview = consentModule.getByRole("button", { name: "Anteprima" });
      await preview.click();
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog.getByText("Testo di esempio, da far verificare prima dell'uso con pazienti reali.", { exact: true })).toBeVisible();
      await expect(dialog).toContainText(studioValue);
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(preview).toBeFocused();
    }
    await years(page).fill(retention === "1" ? "2" : "1");
    await page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "Uscire senza salvare?" })).toBeVisible();
    await page.getByRole("button", { name: "Torna indietro" }).click();
  });

  test("conservazione 1-30, errore sparisce al cambio campo, risposta lenta conserva la bozza", async ({ page }) => {
    const save = page.getByRole("button", { name: "Salva conservazione", exact: true });
    for (const invalid of ["0", "31"]) {
      await years(page).fill(invalid);
      await save.click();
      await expect(page.getByText("Scrivi un numero di anni da 1 a 30.", { exact: true })).toBeVisible();
      await expect(years(page)).toBeFocused();
      await years(page).fill("10");
      await expect(page.getByText("Scrivi un numero di anni da 1 a 30.", { exact: true })).toHaveCount(0);
    }
    for (const valid of ["1", "30"]) {
      await years(page).fill(valid);
      await save.click();
      await expect(page.getByText("Conservazione salvata.", { exact: true })).toBeVisible();
      await page.reload();
      await expect(years(page)).toHaveValue(valid);
    }
    let reached = () => {};
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { releaseReply = resolve; });
    await page.route("**/impostazioni/consensi**", async route => {
      const input = settingsActionInput(route.request());
      if (input?.section !== "consensi") return route.fallback();
      const response = await route.fetch();
      reached(); await held;
      await route.fulfill({ response });
    });
    await years(page).fill("1");
    await save.click(); await ready;
    await years(page).fill("20");
    releaseReply?.();
    await expect(page.getByText("Conservazione salvata. Restano modifiche non salvate.", { exact: true })).toBeVisible();
    await expect(years(page)).toHaveValue("20");
  });

  test("canvas e salvataggio della firma, guardia uscita e persistenza dopo ricarica", async ({ page }) => {
    const canvas = page.getByRole("img", { name: "Firma dell'osteopata", exact: true });
    await expect(canvas).toHaveCSS("width", "560px");
    await expect(canvas).toHaveCSS("height", "200px");
    await canvas.scrollIntoViewIfNeeded();
    const box = (await canvas.boundingBox())!;
    for (let stroke = 0; stroke < 2; stroke++) {
      await page.mouse.move(box.x + 35, box.y + 55 + stroke * 40);
      await page.mouse.down();
      for (let i = 1; i <= 22; i++) {
        await page.mouse.move(box.x + 35 + i * 10, box.y + 55 + stroke * 40 + Math.sin(i) * 15);
        await page.waitForTimeout(18); // signature_pad acquisisce i punti ogni 16 ms.
      }
      await page.mouse.up();
    }
    await page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "Uscire senza salvare?" })).toBeVisible();
    await page.getByRole("button", { name: "Torna indietro" }).click();
    await page.getByRole("button", { name: "Salva firma", exact: true }).click();
    await expect(page.getByText("Firma salvata.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Firma salvata dell'osteopata" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("img", { name: "Firma salvata dell'osteopata" })).toBeVisible();
  });

  test("rifiuto server: errore sparisce al cambio campo e una risposta obsoleta non lo ripresenta", async ({ page }) => {
    const error = page.getByText("Scrivi un numero di anni da 1 a 30.", { exact: true });
    const save = page.getByRole("button", { name: "Salva conservazione", exact: true });
    let reached = () => {};
    let delayed = false;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { releaseReply = resolve; });
    await page.route("**/impostazioni/consensi**", async route => {
      const input = settingsActionInput(route.request());
      if (input?.section !== "consensi") return route.fallback();
      // Rifiuto vero dello schema server, senza alterare il database o simulare una risposta Flight.
      const response = await route.fetch({ postData: JSON.stringify([{ ...input, retentionYears: 31 }]) });
      if (delayed) { reached(); await held; }
      await route.fulfill({ response });
    });
    await years(page).fill("10");
    await save.click();
    await expect(error).toBeVisible();
    await expect(years(page)).toBeFocused();
    await years(page).fill("20");
    await expect(error).toHaveCount(0);
    delayed = true;
    await save.click(); await ready;
    await years(page).fill("21");
    releaseReply?.();
    await expect(save).toBeEnabled();
    await expect(years(page)).toHaveValue("21");
    await expect(error).toHaveCount(0);
  });
});

// Paziente proprio, modelli e tono ripristinati anche se un'asserzione fallisce.
let heldSettingsReplies: (() => void)[] = [];
test.describe("Messaggi", () => {
  let patientUrl: string;
  let initialTone: string;
  const original = "Ciao {nome}, ti confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se hai un imprevisto, scrivimi pure qui. {osteopata}, {studio}";
  const editor = (page: Page) => page.getByRole("group", { name: "Conferma (Tu)", exact: true });

  test.beforeEach(async ({ page }) => {
    heldSettingsReplies = [];
    patientUrl = "";
    await page.goto("/pazienti");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Nuovo paziente" }).click();
    const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
    await dialog.getByLabel(/^Nome/).fill("Prova");
    await dialog.getByLabel(/^Cognome/).fill("Modelli");
    await dialog.getByLabel(/^Data di nascita/).fill("1990-01-01");
    await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();
    await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]+$/);
    patientUrl = new URL(page.url()).pathname;
    await page.goto("/impostazioni/messaggi");
    await page.waitForLoadState("networkidle");
    initialTone = await page.getByLabel("Tono abituale per i nuovi pazienti").inputValue();
  });

  test.afterEach(async ({ page }) => {
    for (const release of heldSettingsReplies) release();
    // Ricaricare abbandona solo le bozze, poi il ripristino annulla l'unica personalizzazione salvata.
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/impostazioni/messaggi");
    await page.waitForLoadState("networkidle");
    const group = editor(page);
    if (await group.getByText("Personalizzato", { exact: true }).count()) {
      await group.getByRole("button", { name: "Ripristina il testo originale" }).click();
      await page.getByRole("alertdialog", { name: "Ripristinare il testo originale?" }).getByRole("button", { name: "Ripristina" , exact: true }).click();
      await expect(group.getByLabel(/^Testo del modello/)).toHaveValue(original);
      await expect(group.getByText("Testo originale", { exact: true })).toBeVisible();
    }
    await page.getByLabel("Tono abituale per i nuovi pazienti").selectOption(initialTone);
    await page.getByRole("button", { name: "Salva tono abituale" }).click();
    await expect(page.getByText("Tono abituale salvato.")).toBeVisible();
    if (patientUrl) {
      await page.goto(patientUrl);
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Altre azioni" }).click();
      await page.getByRole("menuitem", { name: "Elimina definitivamente" }).click();
      await page.getByRole("alertdialog", { name: "Eliminare definitivamente Prova Modelli?" }).getByRole("button", { name: "Elimina definitivamente" }).click();
      await expect(page).toHaveURL(/\/pazienti$/);
    }
  });

  test("anteprima_ricerca_paziente: si cerca il paziente per nome, nessun elenco intero, scelta da tastiera", async ({ page }) => {
    // Al posto di una tendina con tutti i pazienti attivi in ognuno dei 10 editor.
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toHaveCount(0);
    const group = editor(page);
    const field = group.getByLabel("Paziente per l'anteprima");
    await group.getByRole("button", { name: "Mostra anteprima" }).click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toBeFocused();
    await expect(group.getByText("Scegli un paziente per l'anteprima.", { exact: true })).toBeVisible();
    await page.keyboard.type("Mo");
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toHaveCount(0);
    await page.keyboard.type("dell");
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toBeVisible();
    // % e _ restano lettere: nessun paziente le contiene.
    await page.keyboard.type("x_%");
    await expect(page.getByText("Nessun paziente trovato.", { exact: true })).toBeVisible();
    await field.fill("");
    await page.keyboard.type("modelli prova");
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(field).toHaveValue("Modelli Prova");
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await group.getByLabel(/^Testo del modello/).fill("Ciao {nome}");
    await group.getByRole("button", { name: "Mostra anteprima" }).click();
    await expect(group.getByLabel("Anteprima del messaggio")).toHaveValue("Ciao Prova");
    // Riscrivere il nome cerca un altro paziente: l'anteprima diventa vecchia, Esc chiude l'elenco.
    await field.fill("Modell");
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toBeVisible();
    await expect(group.getByText("Il testo o il paziente sono cambiati: aggiorna l'anteprima.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option", { name: "Modelli Prova" })).toHaveCount(0);
  });

  test("5 x 2 editor, segnaposto, contatore, anteprima in sola lettura, ripristino e tono", async ({ page }) => {
    for (const name of ["Conferma", "Promemoria", "Spostamento", "Richiamo", "Consigli"]) {
      for (const tone of ["Tu", "Lei"]) {
        const group = page.getByRole("group", { name: `${name} (${tone})`, exact: true });
        await expect(group.getByLabel(/^Testo del modello/)).toBeVisible();
      }
    }
    const group = editor(page);
    const body = group.getByLabel(/^Testo del modello/);
    await body.fill("Ciao ");
    await body.focus();
    await body.press("End");
    await group.getByRole("button", { name: "Inserisci {nome}", exact: true }).click();
    await expect(body).toHaveValue("Ciao {nome}");
    await expect(group.getByText("11 / 700 caratteri", { exact: true })).toBeVisible();
    await choosePreviewPatient(group);
    await group.getByRole("button", { name: "Mostra anteprima" }).click();
    const preview = group.getByLabel("Anteprima del messaggio");
    await expect(preview).toHaveValue("Ciao Prova");
    await expect(preview).toHaveAttribute("readonly", "");
    await expect(group.getByRole("button", { name: /Copia|WhatsApp/ })).toHaveCount(0);
    await expect(group.locator('a[href*="wa.me"]')).toHaveCount(0);
    await group.getByRole("button", { name: "Salva modello" }).click();
    await expect(group.getByText("Modello salvato.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(body).toHaveValue("Ciao {nome}");
    const restore = group.getByRole("button", { name: "Ripristina il testo originale" });
    await restore.click();
    const confirm = page.getByRole("alertdialog", { name: "Ripristinare il testo originale?" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(restore).toBeFocused();
    await restore.click();
    await confirm.getByRole("button", { name: "Ripristina", exact: true }).click();
    await expect(body).toHaveValue(original);
    await expect(group.getByText("Testo originale", { exact: true })).toBeVisible();
    await expect(restore).toBeDisabled();
    await page.reload();
    await expect(body).toHaveValue(original);
    const nextTone = initialTone === "tu" ? "lei" : "tu";
    await page.getByLabel("Tono abituale per i nuovi pazienti").selectOption(nextTone);
    await page.getByRole("button", { name: "Salva tono abituale" }).click();
    await expect(page.getByText("Tono abituale salvato.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Tono abituale per i nuovi pazienti")).toHaveValue(nextTone);
    await page.goto(`${patientUrl}?tab=messaggi`);
    await expect(page.getByText("Nessun messaggio preparato per questo paziente.", { exact: true })).toBeVisible();
  });

  test("impostazioni_risposta_lenta: salva e anteprima conservano i ritocchi e il guard", async ({ page }) => {
    const group = editor(page);
    const body = group.getByLabel(/^Testo del modello/);
    await body.fill("Ciao {nome}, prima versione.");
    const saved = await holdSettingsReply(page, (input) => input.body === "Ciao {nome}, prima versione." && !("patientId" in input));
    await group.getByRole("button", { name: "Salva modello" }).click();
    await saved.reached;
    await body.fill("Ciao {nome}, ritocco durante il salvataggio.");
    saved.release();
    await expect(group.getByText("Modello salvato. Restano modifiche non salvate.", { exact: true })).toBeVisible();
    await expect(body).toHaveValue("Ciao {nome}, ritocco durante il salvataggio.");
    await choosePreviewPatient(group);
    const preview = await holdSettingsReply(page, (input) => input.body === "Ciao {nome}, ritocco durante il salvataggio." && "patientId" in input);
    await group.getByRole("button", { name: "Mostra anteprima" }).click();
    await preview.reached;
    await body.fill("Ciao {nome}, ultima modifica conservata.");
    preview.release();
    await expect(group.getByLabel("Anteprima del messaggio")).toHaveValue("Ciao Prova, ritocco durante il salvataggio.");
    await expect(group.getByText("Il testo o il paziente sono cambiati: aggiorna l'anteprima.")).toBeVisible();
    await expect(body).toHaveValue("Ciao {nome}, ultima modifica conservata.");
    await page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "Uscire senza salvare?" })).toBeVisible();
    await page.getByRole("button", { name: "Torna indietro" }).click();
    await expect(body).toHaveValue("Ciao {nome}, ultima modifica conservata.");
  });

  test("modificare il campo rimuove il suo errore, conta gli astrali e segnala i mancanti", async ({ page }) => {
    const group = editor(page);
    const body = group.getByLabel(/^Testo del modello/);
    await body.fill("{nme}");
    await group.getByRole("button", { name: "Salva modello" }).click();
    await expect(body).toHaveAttribute("aria-invalid", "true");
    await expect(body).toBeFocused();
    await expect(body).toHaveAccessibleDescription(/Segnaposto non riconosciuto: \{nme\}\./);
    await body.fill("\u{1D11E}".repeat(700));
    await expect(body).not.toHaveAttribute("aria-invalid", "true");
    await expect(group.getByText("Segnaposto non riconosciuto: {nme}.", { exact: true })).toHaveCount(0);
    await expect(group.getByText("700 / 700 caratteri", { exact: true })).toBeVisible();
    await body.fill("{quando}|{ora}");
    await choosePreviewPatient(group);
    await group.getByRole("button", { name: "Mostra anteprima" }).click();
    await expect(group.getByLabel("Anteprima del messaggio")).toHaveValue("|");
    await expect(group.getByRole("link", { name: "Manca la data dell'appuntamento" })).toHaveAttribute("href", "/agenda");
    await expect(group.getByRole("link", { name: "Manca l'ora dell'appuntamento" })).toHaveAttribute("href", "/agenda");
    await page.getByRole("navigation", { name: "Sezioni di Impostazioni" }).getByRole("link", { name: "Studio", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "Uscire senza salvare?" })).toBeVisible();
    await page.getByRole("button", { name: "Torna indietro" }).click();
  });
});

/** Il paziente del test, cercato per nome nel campo dell'anteprima e scelto dall'elenco. */
async function choosePreviewPatient(group: Locator) {
  await group.getByLabel("Paziente per l'anteprima").fill("Modelli");
  await group.page().getByRole("option", { name: "Modelli Prova" }).click();
  await expect(group.getByLabel("Paziente per l'anteprima")).toHaveValue("Modelli Prova");
}

/** Ritarda la risposta vera dopo il commit/lettura, con una barriera esplicita, senza timeout arbitrari. */
async function holdSettingsReply(page: Page, matches: (input: Record<string, unknown>) => boolean) {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  heldSettingsReplies.push(release);
  let reached = () => {};
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  let taken = false;
  await page.route("**/impostazioni/messaggi**", async (route) => {
    const input = settingsActionInput(route.request());
    if (taken || !input || !matches(input)) return route.fallback();
    taken = true;
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  return { reached: ready, release };
}

function settingsActionInput(request: Request): Record<string, unknown> | null {
  if (request.method() !== "POST" || !request.headers()["next-action"]) return null;
  try {
    const args: unknown = JSON.parse(request.postData() ?? "");
    const [first] = Array.isArray(args) ? args : [];
    return first && typeof first === "object" ? first as Record<string, unknown> : null;
  } catch { return null; }
}

test("Cartella mostra i test attivi per regione e le red flag pediatriche spente", async ({ page }) => {
  await page.goto("/impostazioni/cartella");

  const main = content(page);
  const tests = main.getByRole("group", { name: "Test attivi" });
  await expect(tests).toBeVisible();
  // Una regione con i suoi test: dita-pavimento è acceso di default, Schober modificato no.
  const lumbar = tests.getByRole("group", { name: "Lombare" });
  await expect(lumbar).toBeVisible();
  await expect(lumbar.getByRole("switch", { name: "Distanza dita-pavimento" })).toBeChecked();
  await expect(lumbar.getByRole("switch", { name: "Schober modificato" })).not.toBeChecked();
  // I test accesi sono i 24 di default: 27 nel catalogo, meno i 3 spenti.
  await expect(tests.getByRole("switch", { checked: true })).toHaveCount(24);
  await expect(tests.getByRole("switch")).toHaveCount(27);

  // Le red flag pediatriche sono spente e bloccate finché un osteopata non le rivede.
  const pediatric = main.getByRole("switch", { name: "Red flag pediatriche" });
  await expect(pediatric).not.toBeChecked();
  await expect(pediatric).toBeDisabled();
  await expect(main.getByText("Spente finché un osteopata non le rivede.")).toBeVisible();
  // Nessun salvataggio: la demo dei test resta com'è.
});
