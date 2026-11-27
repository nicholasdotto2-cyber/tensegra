import { expect, test, type Page } from "@playwright/test";

// D0 = 4/11/2026. Il seed si legge soltanto; le scritture usano una nuova seduta di Prova Editor,
// paziente creato da fattura-editor.spec.ts. La sua fattura precedente è pagata: qui ne emettiamo una nostra.
let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
});
test.afterEach(async ({ page }) => {
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});

async function open(page: Page, url = "/fatture?tab=emesse&mese=2026-10") {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test("intestazione, sedute da emettere, emesse, filtri, bozze e schede sotto 1024 px", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1, name: "Fatture" })).toBeVisible();
  await expect(page.getByLabel("Anno", { exact: true })).toHaveValue("2026");
  await expect(page.getByRole("button", { name: "Nuova fattura", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Esporta per l'elenco speciale" })).toBeVisible();
  await expect(page.getByText("Questa versione crea PDF e XML ma non li invia allo SdI.")).toBeVisible();
  await page.getByRole("link", { name: /^Da emettere \(/ }).click();
  for (const name of ["Matteo Ricci", "Valentina Greco"]) {
    const row = page.getByRole("listitem").filter({ hasText: name });
    await expect(row.getByRole("button", { name: "Emetti", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Non fatturare", exact: true })).toBeVisible();
  }
  await page.getByRole("listitem").filter({ hasText: "Matteo Ricci" }).getByRole("button", { name: "Emetti", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Nuova fattura" });
  await expect(editor.getByRole("group", { name: "Riga 1" }).getByLabel("Descrizione")).toHaveValue("Prima visita osteopatica");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByRole("link", { name: "Emesse", exact: true }).click();
  await expect(page.getByLabel("Mese", { exact: true })).toHaveValue("2026-10");
  for (const name of ["Emesso", "Incassato", "Da incassare", "Bolli del trimestre"]) {
    const tile = page.getByRole("region", { name, exact: true });
    await expect(tile).toContainText(/\d+[,.]\d{2}\s*€/);
  }
  await expect(page.getByRole("region", { name: "Bolli del trimestre" })).toContainText(/\d+ bolli/);
  await expect(page.getByText("Prossima scadenza: 01/03/2027")).toBeVisible();
  await expect(page.getByText("Trimestre stimato con la data della fattura; per l'Agenzia conta la data di consegna.")).toBeVisible();
  for (const name of ["Numero", "Data", "Intestatario", "Prestazione", "Totale", "Bollo", "Stato"]) {
    await expect(page.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  await page.getByLabel("Stato", { exact: true }).selectOption("annullate");
  // Con "Tutte" le righe con Lorenzo sono tre (la fattura giusta al padre "per Lorenzo", quella annullata e la nota):
  // il filtro, quando arriva, lascia solo l'annullata.
  const lorenzo = page.getByRole("row").filter({ hasText: "Lorenzo Gatti" });
  await expect(lorenzo).toHaveCount(1);
  await expect(lorenzo).toContainText("Annullata");
  await expect(lorenzo.getByRole("link", { name: "NC-1/2026", exact: true })).toHaveAttribute("href", /^\/fatture\//);
  await page.getByLabel("Stato", { exact: true }).selectOption("tutte");
  await page.getByLabel("Cerca per numero o nome").fill("Bellandi");
  await expect(page).toHaveURL(/q=Bellandi/);
  const marco = page.getByRole("row").filter({ hasText: "Marco Bellandi" });
  await expect(marco).toContainText("Prima visita osteopatica");
  await expect(marco).toContainText(/82,00\s*€/);
  await expect(marco.getByRole("cell", { name: "Sì", exact: true })).toBeVisible();
  await expect(marco).toContainText("Pagata");
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.getByRole("table")).toBeHidden();
  await expect(page.getByRole("list", { name: "Fatture" }).getByRole("listitem")).toContainText("Marco Bellandi");
  await page.setViewportSize({ width: 1280, height: 900 });
  // Le tre fatture intestate a Simona per Martina sono di agosto (sedute a D0-89, D0-77 e D0-65 nel seed).
  await open(page, "/fatture?tab=emesse&mese=2026-08");
  const simona = page.getByRole("row").filter({ hasText: "Simona De Luca" });
  await expect(simona).toHaveCount(3);
  for (const row of await simona.all()) await expect(row).toContainText("per Martina");
  await open(page, "/fatture?tab=emesse&anno=2025&mese=2025-10");
  await expect(page.getByText("Nessuna fattura emessa a ottobre.")).toBeVisible();
  await page.getByLabel("Mese", { exact: true }).fill("2025-01");
  await expect(page.getByText("Nessuna fattura emessa a gennaio.")).toBeVisible();
  await page.getByRole("link", { name: /^Bozze \(/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "Polisportiva Esempio SSD a r.l." })).toContainText("Bozza");
});

test("filtri_rapidi_router: due cambi senza aspettare il router restano entrambi; Indietro e Avanti rileggono l'URL", async ({ page }) => {
  await open(page, "/fatture?tab=emesse&mese=2026-11");
  // La risposta alla prima navigazione (stato) resta ferma finché non parte la seconda (mese): il secondo cambio
  // avviene prima che la pagina abbia i parametri del primo. Le prefetch dei link non contano.
  let navigations = 0;
  let releaseFirst: () => void = () => undefined;
  const secondSent = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/fatture?**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || request.headers()["rsc"] !== "1" || request.headers()["next-router-prefetch"] !== undefined) {
      return route.fallback();
    }
    navigations += 1;
    if (navigations === 1) await Promise.race([secondSent, new Promise((resolve) => setTimeout(resolve, 5000))]);
    else releaseFirst();
    // Il router può lasciar cadere la richiesta superata: allora non c'è più niente da continuare.
    await route.continue().catch(() => undefined);
  });
  await page.getByLabel("Stato", { exact: true }).selectOption("pagate");
  await page.getByLabel("Mese", { exact: true }).fill("2026-10");
  await expect(page).toHaveURL(/[?&]stato=pagate(&|$)/);
  await expect(page).toHaveURL(/[?&]mese=2026-10(&|$)/);
  await page.unroute("**/fatture?**");
  await expect(page.getByLabel("Stato", { exact: true })).toHaveValue("pagate");
  await expect(page.getByLabel("Mese", { exact: true })).toHaveValue("2026-10");
  // Seed di ottobre: Marco Bellandi pagata e l'annullata di Lorenzo Gatti, che con "Tutte" comparirebbe.
  await expect(page.getByRole("row").filter({ hasText: "Marco Bellandi" })).toContainText("Pagata");
  await expect(page.getByRole("row").filter({ hasText: "Annullata" })).toHaveCount(0);
  // Un link aggiunge una voce alla cronologia; Indietro e Avanti portano i parametri dell'URL, non quelli chiesti prima.
  await page.getByRole("link", { name: /^Da emettere \(/ }).click();
  await expect(page).toHaveURL(/[?&]tab=da_emettere(&|$)/);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]tab=emesse(&|$)/);
  await expect(page.getByLabel("Stato", { exact: true })).toHaveValue("pagate");
  await page.goForward();
  await expect(page.getByRole("link", { name: /^Da emettere \(/ })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page.getByLabel("Mese", { exact: true })).toHaveValue("2026-10");
  await page.getByLabel("Stato", { exact: true }).selectOption("annullate");
  await expect(page).toHaveURL(/[?&]tab=emesse(&|$)/);
  await expect(page).toHaveURL(/[?&]mese=2026-10(&|$)/);
  await expect(page).toHaveURL(/[?&]stato=annullate(&|$)/);
  const lorenzo = page.getByRole("row").filter({ hasText: "Lorenzo Gatti" });
  await expect(lorenzo).toHaveCount(1);
  await expect(lorenzo).toContainText("Annullata");
});

test("tab_filtro_in_attesa: il link di una tab tiene lo stato scelto e la ricerca scritta prima che il router risponda", async ({ page }) => {
  await open(page, "/fatture?tab=emesse&mese=2026-10");
  // La risposta al cambio di stato resta ferma finché non parte la navigazione della tab.
  let navigations = 0;
  let releaseFirst: () => void = () => undefined;
  const secondSent = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/fatture?**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || request.headers()["rsc"] !== "1" || request.headers()["next-router-prefetch"] !== undefined) {
      return route.fallback();
    }
    navigations += 1;
    if (navigations === 1) await Promise.race([secondSent, new Promise((resolve) => setTimeout(resolve, 5000))]);
    else releaseFirst();
    await route.continue().catch(() => undefined);
  });
  await page.getByLabel("Stato", { exact: true }).selectOption("pagate");
  await page.getByLabel("Cerca per numero o nome").fill("Bellandi");
  await page.getByRole("link", { name: /^Da emettere \(/ }).click();
  await expect(page).toHaveURL(/[?&]tab=da_emettere(&|$)/);
  await expect(page).toHaveURL(/[?&]stato=pagate(&|$)/);
  await expect(page).toHaveURL(/[?&]q=Bellandi(&|$)/);
  await expect(page).toHaveURL(/[?&]mese=2026-10(&|$)/);
  await page.unroute("**/fatture?**");
  await expect(page.getByRole("link", { name: /^Da emettere \(/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Emesse", exact: true }).click();
  await expect(page.getByLabel("Stato", { exact: true })).toHaveValue("pagate");
  await expect(page.getByLabel("Cerca per numero o nome")).toHaveValue("Bellandi");
  await expect(page.getByRole("row").filter({ hasText: "Marco Bellandi" })).toContainText("Pagata");
  // Un link della tab aggiunge una voce alla cronologia, come prima.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]tab=da_emettere(&|$)/);
});

test("export: periodo, conteggio, anteprima oscurata, mese corrente e periodo vuoto", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Esporta per l'elenco speciale" }).click();
  const dialog = page.getByRole("dialog", { name: "Esporta per l'elenco speciale" });
  await expect(dialog.getByLabel("Da", { exact: true })).toHaveValue("2026-10");
  await expect(dialog.getByLabel("A", { exact: true })).toHaveValue("2026-10");
  await expect(dialog.getByRole("status")).toContainText(/Documenti: [1-9]\d*/);
  await expect(dialog.getByText("Per la domanda all'Ordine servono le fatture con i dati dei pazienti oscurati.")).toBeVisible();
  await expect(dialog.locator("iframe")).toHaveAttribute("src", /\/api\/fatture\/export\/anteprima\?da=2026-10&a=2026-10/);
  const preview = await page.request.get((await dialog.locator("iframe").getAttribute("src"))!);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toBe("application/pdf");
  expect((await preview.body()).subarray(0, 5).toString()).toBe("%PDF-");
  // Chromium senza interfaccia scarica anche il PDF dell'anteprima nell'iframe ("anteprima-oscurata.pdf"), quando
  // arriva: si aspetta il download che non è quello.
  const download = page.waitForEvent("download", { predicate: (file) => file.suggestedFilename() !== "anteprima-oscurata.pdf" });
  await dialog.getByRole("button", { name: "Scarica ZIP" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  await dialog.getByRole("button", { name: "Solo questo mese" }).click();
  await expect(dialog.getByLabel("Da", { exact: true })).toHaveValue("2026-11");
  await expect(dialog.getByLabel("A", { exact: true })).toHaveValue("2026-11");
  await dialog.getByLabel("Da", { exact: true }).fill("2026-01");
  await dialog.getByLabel("A", { exact: true }).fill("2026-01");
  await expect(dialog.getByText("Nessuna fattura nel periodo scelto.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Scarica ZIP" })).toBeDisabled();
});

test("nuova fattura propria non incassata: incasso, annullamento, nota di credito e non fatturare", async ({ page }) => {
  await open(page, "/agenda?data=2026-11-03&vista=giorno");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await booking.getByLabel("Paziente").fill("Editor");
  await page.getByRole("option", { name: "Editor Prova" }).click();
  await expect(booking.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText(/\S/);
  await booking.getByLabel("Data", { exact: true }).fill("2026-11-03");
  await booking.getByLabel("Ora di inizio").click();
  // La domanda sull'orario passato arriva solo con l'anteprima (300 ms dopo l'ultimo cambio). Alle 13:00,
  // nella pausa fra le 13:00 e le 14:30, l'anteprima porta «Fuori dagli orari dello studio.», che dice che è arrivata
  // (come in stati-appuntamento.spec.ts); dentro gli orari non ci sarebbe niente da aspettare sullo schermo.
  await page.getByRole("option", { name: "13:00", exact: true }).click();
  await expect(booking.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await booking.getByRole("button", { name: /^Salva(?: comunque)?$/ }).click();
  await page.getByRole("alertdialog", { name: "L'orario è già passato. Lo segno già come fatto?" }).getByRole("button", { name: "Sì, è fatto" }).click();
  await expect(page.getByRole("dialog", { name: "Seduta fatta: Prova Editor" })).toBeVisible();
  await page.keyboard.press("Escape");
  await open(page, "/fatture?tab=da_emettere&mese=2026-11");
  await page.getByRole("listitem").filter({ hasText: "Prova Editor" }).getByRole("button", { name: "Emetti", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Nuova fattura" });
  await expect(editor.getByRole("checkbox", { name: "Già incassata" })).not.toBeChecked();
  await editor.getByRole("button", { name: "Emetti", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Emettere la fattura?" });
  const number = /numero (\d+\/2026)/.exec((await confirm.textContent())!)![1];
  await confirm.getByRole("button", { name: "Emetti fattura", exact: true }).click();
  await expect(editor.getByRole("heading", { name: `Fattura ${number} emessa` })).toBeVisible();
  await editor.getByRole("button", { name: "Chiudi", exact: true }).last().click();
  await page.getByRole("link", { name: "Emesse", exact: true }).click();
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: number, exact: true }) });
  await expect(row).toContainText("Da incassare");
  const menu = async (name: string) => {
    await row.getByRole("button", { name: "Altre azioni" }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  await menu("Registra incasso");
  const payment = page.getByRole("dialog", { name: `Registrare l'incasso della fattura ${number}?` });
  await expect(payment.getByLabel("Importo")).toHaveAttribute("readonly", "");
  await payment.getByLabel("Data dell'incasso").fill("2026-11-05");
  await payment.getByRole("button", { name: "Registra incasso", exact: true }).click();
  await expect(payment.getByText("La data dell'incasso non può essere nel futuro.")).toBeVisible();
  await payment.getByLabel("Data dell'incasso").fill("2026-11-04");
  await payment.getByRole("button", { name: "Registra incasso", exact: true }).click();
  await expect(payment).toBeHidden();
  await expect(row).toContainText("Pagata");
  await menu("Annulla incasso");
  const undo = page.getByRole("alertdialog", { name: `Annullare l'incasso della fattura ${number}?` });
  await expect(undo).toContainText("La fattura torna da incassare.");
  await undo.getByRole("button", { name: "Annulla incasso", exact: true }).click();
  await expect(undo).toBeHidden();
  await expect(row).toContainText("Da incassare");
  await menu("Annulla con nota di credito");
  const cancel = page.getByRole("alertdialog", { name: `Annullare la fattura ${number}?` });
  await expect(cancel).toContainText("Verrà emessa una nota di credito che la storna per intero. La fattura resta nell'archivio.");
  await cancel.getByLabel("Motivo interno (facoltativo)").fill("Prova di annullamento");
  await cancel.getByRole("button", { name: "Emetti la nota di credito" }).click();
  await expect(page.getByText("Nota di credito NC-2/2026 emessa.")).toBeVisible();
  await page.getByRole("link", { name: /^Da emettere \(/ }).click();
  const session = page.getByRole("listitem").filter({ hasText: "Prova Editor" });
  await session.getByRole("button", { name: "Non fatturare", exact: true }).click();
  const skip = page.getByRole("alertdialog", { name: "Non fatturare questa seduta?" });
  await skip.getByRole("button", { name: "Non fatturare", exact: true }).click();
  await expect(skip.getByText("Scegli un motivo.")).toBeVisible();
  await skip.getByLabel("Motivo", { exact: false }).click();
  await page.getByRole("option", { name: "Gratuita", exact: true }).click();
  await skip.getByRole("button", { name: "Non fatturare", exact: true }).click();
  await expect(skip).toBeHidden();
  await expect(session).toHaveCount(0);
});
