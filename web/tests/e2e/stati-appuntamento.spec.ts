import { expect, type Locator, type Page, test } from "@playwright/test";

// I cambi di stato dalle righe di Oggi e dal dettaglio dell'agenda sulla demo
// dei test: D0 = mercoledì 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Ogni test crea
// il suo appuntamento di Paolo Neri (consensi firmati, nessun segnale) e lo elimina alla fine: i conteggi
// dei passi 1 e 2 della demo tornano quelli di prima. Il file è seriale. Le righe di oggi
// esistono solo dentro un test; se un test si ferma a metà ne resta una, quindi il nome tiene il file dopo
// demo.spec.ts nell'ordine alfabetico in cui Playwright li prende con un solo worker.
test.describe.configure({ mode: "serial" });

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

/** Il testo scelto in un campo a scelta (un pulsante con l'elenco), senza la freccia. */
function chosen(select: Locator): Locator {
  return select.locator('[data-slot="select-value"]');
}

/** Una seduta di Paolo Neri dal dialogo "Nuovo appuntamento" già aperto, al giorno e all'ora dati. */
async function fillPaolo(page: Page, dialog: Locator, day: string, time: string): Promise<void> {
  await dialog.getByLabel("Paziente").fill("Neri");
  await page.getByRole("option", { name: "Neri Paolo" }).click();
  await expect(chosen(dialog.getByLabel("Prestazione"))).toHaveText("Seduta osteopatica");
  await dialog.getByLabel("Data", { exact: true }).fill(day);
  await dialog.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: time, exact: true }).click();
  await expect(chosen(dialog.getByLabel("Ora di inizio"))).toHaveText(time);
}

/**
 * Le 07:00 sono fuori dagli orari: l'avviso dice che l'anteprima (300 ms dopo l'ultimo cambio) è
 * arrivata, con l'orario passato. Senza aspettarla "Salva" non farebbe la domanda.
 */
async function waitOutsideHoursPreview(dialog: Locator): Promise<void> {
  await expect(dialog.getByText("Fuori dagli orari dello studio.")).toBeVisible();
}

/** Il blocco di Paolo Neri in un giorno dell'agenda, all'ora data. */
function paoloBlock(page: Page, day: string, range: string): Locator {
  return page.locator(`[data-day="${day}"]`).getByRole("button", { name: new RegExp(`^${range}, Neri Paolo, `) });
}

/** Elimina dal dettaglio l'appuntamento del blocco: il dettaglio si chiude e il blocco sparisce. */
async function deleteFromDetail(page: Page, block: Locator): Promise<void> {
  await block.click();
  const detail = page.getByRole("dialog", { name: "Paolo Neri", exact: true });
  await detail.getByRole("button", { name: "Elimina" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Eliminare l'appuntamento?" });
  await expect(confirm).toContainText("Se il paziente ha disdetto, usa Annulla: resta traccia.");
  await confirm.getByRole("button", { name: "Elimina" }).click();
  await expect(detail).toBeHidden();
  // Il dettaglio si chiude insieme all'azione, non dopo: si aspetta che l'agenda abbia riletto prima di ricaricare,
  // altrimenti il reload può arrivare prima della cancellazione e rileggere il blocco.
  await expect(block).toHaveCount(0);
  await page.reload();
  await expect(block).toHaveCount(0);
}

test("un Saltato dato per errore si annulla da Oggi e dal dettaglio, senza conferma", async ({ page }) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");

  // Alle 07:00 di oggi, già passate: il dialogo chiede se è fatta, resta prenotata.
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await fillPaolo(page, dialog, "2026-11-04", "07:00");
  await waitOutsideHoursPreview(dialog);
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "L'orario è già passato. Lo segno già come fatto?" })
    .getByRole("button", { name: "No, lascia prenotato" })
    .click();
  await expect(dialog).toBeHidden();

  const row = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Neri Paolo" })
    .filter({ hasText: "07:00-07:45" });
  await expect(row.getByText("Prenotato", { exact: true })).toBeVisible();

  // Su Oggi: "Saltato", poi "Annulla 'saltato'" la riporta a confermata, con i suoi pulsanti.
  await row.getByRole("button", { name: "Saltato" }).click();
  await expect(row.getByText("Saltato", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Segna come fatta" })).toHaveCount(0);
  await row.getByRole("button", { name: "Annulla 'saltato'" }).click();
  await expect(row.getByText("Confermato", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Annulla 'saltato'" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Segna come fatta" })).toBeVisible();
  // Nessuna domanda: si torna indietro.
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // Nel dettaglio dell'agenda lo stesso, e lo stato resta dopo aver ricaricato.
  await page.goto("/agenda?vista=giorno&data=2026-11-04");
  await page.waitForLoadState("networkidle");
  const block = paoloBlock(page, "2026-11-04", "07:00-07:45");
  await expect(block).toHaveAccessibleName("07:00-07:45, Neri Paolo, Seduta osteopatica, Confermato");
  await block.click();
  const detail = page.getByRole("dialog", { name: "Paolo Neri", exact: true });
  await detail.getByRole("button", { name: "Saltato" }).click();
  await expect(detail.getByRole("button", { name: "Annulla 'saltato'" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Ripristina" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Annulla 'saltato'" }).click();
  await expect(detail.getByRole("button", { name: "Segna come fatta" })).toBeVisible();
  await expect(detail.getByText("Confermato", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await page.reload();
  await expect(block).toHaveAccessibleName("07:00-07:45, Neri Paolo, Seduta osteopatica, Confermato");

  await deleteFromDetail(page, block);
});

test("Sposta da Oggi, poi Modifica, Annulla, Ripristina ed Elimina dal dettaglio", async ({ page }) => {
  await page.goto("/oggi");
  await page.waitForLoadState("networkidle");

  // Oggi alle 20:00, dopo la chiusura delle 19:30: non ancora iniziato, quindi nessuna domanda.
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await fillPaolo(page, dialog, "2026-11-04", "20:00");
  await expect(dialog.getByText("Fuori dagli orari dello studio.")).toBeVisible();
  await dialog.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = page
    .getByRole("region", { name: /^Appuntamenti di oggi/ })
    .getByRole("listitem")
    .filter({ hasText: "Neri Paolo" })
    .filter({ hasText: "20:00-20:45" });
  await expect(row.getByText("Prenotato", { exact: true })).toBeVisible();

  // "Sposta" apre la modifica con paziente e ciclo fermi; il 16/12 alle 10:00 la riga lascia Oggi.
  await row.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("menuitem", { name: "Sposta" }).click();
  const move = page.getByRole("dialog", { name: "Modifica appuntamento" });
  await expect(move.getByLabel("Paziente")).toHaveValue("Neri Paolo");
  await move.getByLabel("Data", { exact: true }).fill("2026-12-16");
  await move.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "10:00", exact: true }).click();
  await move.getByRole("button", { name: /^Salva/ }).click();
  await expect(move).toBeHidden();
  await expect(row).toHaveCount(0);

  // Nell'agenda del 16/12: "Modifica" porta alle 11:00 con una nota, e resta dopo aver ricaricato.
  await page.goto("/agenda?vista=giorno&data=2026-12-16");
  await page.waitForLoadState("networkidle");
  await paoloBlock(page, "2026-12-16", "10:00-10:45").click();
  const detail = page.getByRole("dialog", { name: "Paolo Neri", exact: true });
  await detail.getByRole("button", { name: "Modifica" }).click();
  const edit = page.getByRole("dialog", { name: "Modifica appuntamento" });
  await edit.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: "11:00", exact: true }).click();
  await edit.getByLabel("Note").fill("Porta la risonanza");
  await edit.getByRole("button", { name: /^Salva/ }).click();
  await expect(edit).toBeHidden();
  await expect(detail.getByText("Porta la risonanza")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await page.reload();
  const block = paoloBlock(page, "2026-12-16", "11:00-11:45");
  await expect(block).toHaveAccessibleName("11:00-11:45, Neri Paolo, Seduta osteopatica, Prenotato");

  // "Annulla appuntamento": senza motivo l'errore sotto il campo, col focus sul campo; poi "Paziente".
  await block.click();
  await detail.getByRole("button", { name: "Annulla appuntamento" }).click();
  const cancel = page.getByRole("alertdialog", { name: "Annullare l'appuntamento?" });
  await cancel.getByRole("button", { name: "Annulla appuntamento" }).click();
  await expect(cancel.getByText("Scegli il motivo.")).toBeVisible();
  await expect(cancel.getByRole("radio", { name: "Paziente" })).toBeFocused();
  await cancel.getByRole("radio", { name: "Paziente" }).click();
  await cancel.getByRole("button", { name: "Annulla appuntamento" }).click();
  await expect(cancel).toBeHidden();
  await expect(detail.getByText("Annullato", { exact: true })).toBeVisible();

  // "Ripristina" su un annullato futuro: torna prenotato.
  await detail.getByRole("button", { name: "Ripristina" }).click();
  await expect(detail.getByText("Prenotato", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Annulla appuntamento" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await page.reload();
  await expect(block).toHaveAccessibleName("11:00-11:45, Neri Paolo, Seduta osteopatica, Prenotato");

  await deleteFromDetail(page, block);
});
