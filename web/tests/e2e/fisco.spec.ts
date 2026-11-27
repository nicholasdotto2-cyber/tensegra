import { expect, test } from "@playwright/test";

test("Fisco aggiorna l'esempio, conferma il regime e salva anche con avvisi fiscali", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/impostazioni/fisco");
  const main = page.locator("main#contenuto");
  await expect(main.getByRole("heading", { level: 2, name: "Fisco", exact: true })).toBeVisible();
  const ordinary = main.getByRole("radio", { name: "Ordinario con IVA 22%", exact: true });
  const flat = main.getByRole("radio", { name: "Forfettario", exact: true });
  const exempt = main.getByRole("radio", { name: "Esente sanitario", exact: true });
  await expect(flat).toBeChecked();
  for (const text of [
    "Il prezzo del listino comprende l'IVA: la fattura al paziente la scorpora.",
    "Niente bollo; ritenuta del 20% verso i sostituti d'imposta.",
    "Niente IVA: il paziente paga il prezzo del listino.",
    "Bollo di 2 euro sopra 77,47 euro, niente ritenuta.",
    "Niente IVA, bollo di 2 euro sopra 77,47 euro.",
    "Al paziente la fattura è cartacea o PDF, senza XML.",
  ]) await expect(main.getByText(text, { exact: true })).toBeVisible();

  await ordinary.check();
  const example = main.getByRole("status", { name: "Esempio dal vivo" });
  await expect(example).toContainText("45,08");
  await expect(example).toContainText("9,92");
  await expect(example).toContainText("55,00");
  await exempt.check();
  await expect(main.getByText("Oggi l'osteopata non è esente (risoluzione 9/E/2026). Usa questo stato solo se cambia la norma.", { exact: true })).toBeVisible();
  await expect(main.getByText("Invio al Sistema TS: non attivo in questa versione", { exact: true })).toBeVisible();
  await expect(main.getByLabel("Autorizzazione al bollo virtuale per i documenti cartacei", { exact: true })).toBeVisible();
  const save = main.getByRole("button", { name: "Salva", exact: true });
  await save.click();
  const dialog = page.getByRole("alertdialog", { name: "Cambiare il regime fiscale?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dalle prossime fatture: esenti da IVA, bollo di 2 euro sopra 77,47 euro, ai pazienti solo PDF. Le fatture già emesse non cambiano.");
  await dialog.getByRole("button", { name: "Torna indietro" }).click();
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();
  await flat.check();
  await save.click();
  await expect(page.getByText("Modifiche salvate.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(flat).toBeChecked();
  await expect(main.getByText("Invio al Sistema TS: non attivo in questa versione", { exact: true })).toHaveCount(0);

  const vat = main.getByRole("textbox", { name: "Partita IVA", exact: true });
  try {
    await vat.fill("01234560008");
    await save.click();
    await expect(page.getByText("Modifiche salvate.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(vat).toHaveValue("01234560008");
    const warning = main.getByRole("note").filter({ hasText: "La partita IVA non è valida: controlla le cifre" });
    await expect(warning).toHaveCount(1);
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText("La partita IVA non è valida: controlla le cifre", { useInnerText: true });
    const warningId = await warning.getAttribute("id");
    expect(warningId).toBeTruthy();
    const describedBy = (await vat.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
    expect(describedBy).toContain(warningId);
  } finally {
    await vat.fill("00000000000");
    await save.click();
    await expect(page.getByText("Modifiche salvate.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(vat).toHaveValue("00000000000");
    await expect(flat).toBeChecked();
  }

  const references = main.getByRole("group", { name: "Riferimenti normativi", exact: true });
  await expect(references.getByRole("textbox")).toHaveCount(0);
  for (const text of [
    "Operazione in franchigia da IVA, art. 1 c. 54-89 L. 190/2014",
    "Operazione effettuata ai sensi dell'art. 1, commi da 54 a 89, L. 190/2014, regime forfettario.",
    "Compenso non soggetto a ritenuta d'acconto ai sensi dell'art. 1, c. 67, L. 190/2014.",
    "Esente IVA art. 10 c. 1 n. 18 DPR 633/1972",
    "Imposta di bollo assolta in modo virtuale ai sensi dell'art. 6 del DM 17 giugno 2014.",
    "Imposta di bollo assolta sull'originale, contrassegno n. {stamp_mark_code}.",
    "Imposta di bollo assolta in modo virtuale, autorizzazione {paper_stamp_authorization} (art. 15 DPR 642/1972).",
    "Copia di cortesia. L'originale della fattura elettronica è a disposizione nella sua area riservata del sito web dell'Agenzia delle Entrate.",
    "Dal 1/01/2027 cambiano i riferimenti: il gestionale li aggiorna da solo per le fatture datate 2027",
  ]) await expect(references.getByText(text, { exact: true })).toBeVisible();
  await expect(main.getByText("Le modifiche valgono per le nuove fatture. Quelle già emesse non cambiano.", { exact: true })).toBeVisible();
  await expect(main.getByText("Il bollo è dovuto dallo studio; puoi chiederne il rimborso al paziente", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});
