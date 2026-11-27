import { expect, type Locator, type Page, test } from "@playwright/test";

// Il Listino sulla demo dei test: la tabella con le sue colonne, il riquadro del regime e il
// giro di una voce nuova (creare, vedere la riga, eliminare). La voce di prova nasce e sparisce nello
// stesso test: nessun conteggio dei passi della demo cambia.

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

function chosen(select: Locator): Locator {
  return select.locator('[data-slot="select-value"]');
}

test("il listino mostra il riquadro del regime, le colonne e la seduta in uso e apre Fisco", async ({ page }) => {
  await page.goto("/listino");

  await expect(page.getByRole("heading", { level: 1, name: "Listino" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nuova prestazione" })).toBeVisible();
  const regimeNote = page.getByRole("paragraph").filter({ hasText: /^Regime forfettario:/ });
  await expect(regimeNote).toHaveText(
    "Regime forfettario: le fatture non hanno IVA e riportano il bollo da 2 € sopra 77,47 €. Si cambia in Impostazioni, Fisco.",
  );
  await expect(regimeNote).toBeVisible();
  const fiscoLink = regimeNote.getByRole("link", { name: "Impostazioni, Fisco", exact: true });
  await expect(fiscoLink).toHaveAttribute("href", "/impostazioni/fisco");

  for (const name of ["Colore", "Nome", "Tipo", "Durata", "Prezzo", "Usata", "Stato"]) {
    await expect(page.getByRole("columnheader", { name })).toBeVisible();
  }

  // La seduta è usata dagli appuntamenti della demo: si archivia, non si elimina.
  const seduta = page.getByRole("row", { name: /Seduta osteopatica/ });
  await expect(seduta).toContainText("Petrolio");
  await expect(seduta).toContainText("Seduta");
  await expect(seduta).toContainText("45 min");
  await expect(seduta).toContainText("55,00 €");
  await expect(seduta).toContainText("Attiva");
  await expect(seduta.getByRole("button", { name: /^Archivia/ })).toBeVisible();
  await expect(seduta.getByRole("button", { name: /^Elimina/ })).toHaveCount(0);

  await fiscoLink.click();
  await expect(page).toHaveURL(/\/impostazioni\/fisco$/);
  await expect(page.getByRole("heading", { level: 2, name: "Fisco", exact: true })).toBeVisible();
});

test("una voce nuova si crea e, mai usata, si elimina con la conferma", async ({ page }) => {
  await page.goto("/listino");

  await page.getByRole("button", { name: "Nuova prestazione" }).click();
  const sheet = page.getByRole("dialog", { name: "Nuova prestazione" });
  await expect(sheet).toBeVisible();

  await sheet.getByLabel("Nome").fill("Prova e2e");
  await sheet.getByRole("combobox", { name: "Tipo" }).click();
  await page.getByRole("option", { name: "Altro" }).click();
  // Il tipo porta durata e colore di partenza.
  await expect(chosen(sheet.getByRole("combobox", { name: "Durata" }))).toHaveText("30 min");
  await expect(sheet.getByRole("radio", { name: "Ardesia" })).toBeChecked();

  await sheet.getByRole("combobox", { name: "Durata" }).click();
  await page.getByRole("option", { name: "30 min" }).click();
  await sheet.getByLabel("Prezzo").fill("10,00");
  await sheet.getByRole("radio", { name: "Oceano" }).click();
  await sheet.getByLabel("Descrizione in fattura").fill("Prova e2e");
  await sheet.getByRole("button", { name: "Salva" }).click();

  const row = page.getByRole("row", { name: /Prova e2e/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Oceano");
  await expect(row).toContainText("Altro");
  await expect(row).toContainText("30 min");
  await expect(row).toContainText("10,00 €");
  await expect(row.getByRole("cell").nth(5)).toHaveText("0");
  await expect(row.getByRole("button", { name: /^Elimina/ })).toBeVisible();

  await row.getByRole("button", { name: /^Elimina/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Eliminare la prestazione Prova e2e?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText("La voce sparisce dal listino.")).toBeVisible();
  await confirm.getByRole("button", { name: "Elimina", exact: true }).click();

  await expect(page.getByRole("row", { name: /Prova e2e/ })).toHaveCount(0);
});


/**
 * Un clic fuori, poi il pannello è ancora aperto finita l'animazione di uscita (100-200 ms): durante
 * l'uscita il pannello resta visibile, quindi si guarda dopo.
 */
async function stillOpenAfterOutsideClick(page: Page, panel: Locator): Promise<void> {
  await page.mouse.click(10, 400);
  await page.waitForTimeout(500);
  await expect(panel).toBeVisible();
}

test("un clic fuori dal pannello non butta via una voce iniziata; Esc e Annulla chiudono", async ({ page }) => {
  await page.goto("/listino");
  await page.waitForLoadState("networkidle");
  const opener = page.getByRole("button", { name: "Nuova prestazione" });
  const sheet = page.getByRole("dialog", { name: "Nuova prestazione" });

  // Senza modifiche un clic fuori chiude, come prima.
  await opener.click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(10, 400);
  await expect(sheet).toBeHidden();

  // Con un campo scritto il clic fuori non fa niente, Esc chiude.
  await opener.click();
  await sheet.getByLabel("Nome").fill("Prova del clic fuori");
  await stillOpenAfterOutsideClick(page, sheet);
  await expect(sheet.getByLabel("Nome")).toHaveValue("Prova del clic fuori");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // Anche una scelta da un elenco conta come modifica; "Annulla" chiude.
  await opener.click();
  await sheet.getByLabel("Durata").click();
  await page.getByRole("option", { name: "60 min" }).click();
  await stillOpenAfterOutsideClick(page, sheet);
  await sheet.getByRole("button", { name: "Annulla" }).click();
  await expect(sheet).toBeHidden();
  // Niente è stato salvato.
  await expect(page.getByRole("row", { name: /Prova del clic fuori/ })).toHaveCount(0);
});
