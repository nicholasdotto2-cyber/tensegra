import { expect, type Page, test } from "@playwright/test";

// La pagina della lettera al medico sulla demo dei test: seed creato il
// 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts). Il file crea una bozza di rinvio per Giulia
// Ferrante da «Nuovo rinvio» (a ogni ripetizione ne nasce un'altra: nessun altro file conta i rinvii di Giulia)
// e non salva il PDF né consegna la lettera: la bozza resta modificabile e lo stato di Giulia non cambia.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REQUEST_TEXT =
  "Le chiedo di valutare il paziente e, se lo ritiene, di indicarmi se proseguire il trattamento osteopatico.";

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

/** Dalla lista alla Cartella di Giulia e da «Nuovo rinvio» alla lettera, cliccando come fa chi la usa. */
async function openLetter(page: Page): Promise<{ patientId: string; referralId: string }> {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Ferrante Giulia" }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Giulia Ferrante" })).toBeVisible();
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Cartella" }).click();
  await expect(page).toHaveURL(/\?tab=cartella$/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo rinvio" }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}/rinvii/${UUID}$`));
  const match = new RegExp(`/pazienti/(${UUID})/rinvii/(${UUID})$`).exec(page.url());
  const patientId = match?.[1];
  const referralId = match?.[2];
  if (patientId === undefined || referralId === undefined) throw new Error(`Indirizzo inatteso: ${page.url()}`);
  await expect(page.getByRole("heading", { level: 1, name: "Lettera al medico" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  return { patientId, referralId };
}

test("la lettera ha il modulo a sinistra, l'anteprima A4 a destra, «Stampa» apre il PDF in un'altra scheda e una lettera che non c'è dà 404", async ({
  page,
}) => {
  const { patientId, referralId } = await openLetter(page);

  // Titolo, strada per tornare alla Cartella e stato.
  await expect(page.getByRole("link", { name: "Torna alla cartella" })).toHaveAttribute(
    "href",
    `/pazienti/${patientId}?tab=cartella`,
  );
  await expect(page.getByText("Bozza", { exact: true })).toBeVisible();

  // A sinistra: destinatario dalla rubrica o scritto, motivo, urgenza, sintesi, richiesta e assenso.
  const form = page.getByRole("form", { name: "Contenuto della lettera" });
  await expect(form.getByRole("combobox", { name: "Destinatario" })).toBeVisible();
  await form.getByRole("combobox", { name: "Destinatario" }).click();
  await expect(page.getByRole("option", { name: "Scrivi il destinatario" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form.getByRole("combobox", { name: "Motivo" })).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Urgenza" })).toBeVisible();
  const summary = form.getByRole("textbox", { name: /^Sintesi/ });
  await expect(summary).toBeVisible();
  expect(await summary.inputValue()).toMatch(/^Segnalo/);
  // Per l'osteopata la parola «diagnosi» non esiste: la sintesi generata non la usa.
  expect((await summary.inputValue()).toLowerCase()).not.toContain("diagnosi");
  await expect(form.getByRole("textbox", { name: /^Richiesta/ })).toHaveValue(REQUEST_TEXT);
  const agreement = form.getByRole("checkbox", { name: "Il paziente è d'accordo a condividere queste informazioni" });
  await expect(agreement).toBeVisible();
  await expect(agreement).not.toBeChecked();

  // A destra: la lettera come uscirà, con lo studio, il paziente e il giorno della lettera.
  const preview = page.getByRole("region", { name: "Anteprima della lettera" });
  await expect(preview.getByText("Studio Osteopatico Borgo Tiglio")).toBeVisible();
  await expect(preview.getByText("Paziente: Giulia Ferrante", { exact: false })).toBeVisible();
  await expect(preview).toContainText("04/11/2026");
  await expect(preview).toContainText(REQUEST_TEXT);
  expect((await preview.textContent()) ?? "").toContain(await summary.inputValue());

  // «Stampa» è un link alla route del PDF, in una nuova scheda; la pagina non lo apre (la bozza resta modificabile).
  const print = page.getByRole("link", { name: "Stampa" });
  await expect(print).toHaveAttribute("href", `/api/rinvii/${referralId}/pdf`);
  await expect(print).toHaveAttribute("target", "_blank");
  await expect(print).toContainText("si apre in una nuova scheda");
  await expect(page.getByRole("button", { name: "Salva PDF in cartella" })).toBeVisible();

  // Una lettera che non c'è, un id che non è un uuid e una lettera di un altro paziente: «Lettera non trovata.» con la
  // strada per la Cartella del paziente dell'indirizzo. Il 404 non si legge come errore di console (`loading.tsx`).
  const notFound = page.getByRole("heading", { level: 1, name: "Lettera non trovata." });
  await page.goto(`/pazienti/${patientId}/rinvii/00000000-0000-4000-8000-000000000000`);
  await expect(notFound).toBeVisible();
  await page.getByRole("link", { name: "Torna alla cartella" }).click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${patientId}\\?tab=cartella$`));
  await page.goto(`/pazienti/${patientId}/rinvii/boh`);
  await expect(notFound).toBeVisible();

  await page.goto("/pazienti");
  const other = await page.getByRole("link", { name: "Longo Francesca" }).getAttribute("href");
  expect(other).toMatch(new RegExp(`^/pazienti/${UUID}$`));
  await page.goto(`${other}/rinvii/${referralId}`);
  await expect(notFound).toBeVisible();
  await expect(page.getByRole("link", { name: "Torna alla cartella" })).toHaveAttribute("href", `${other}?tab=cartella`);
});

test("senza l'assenso del paziente la lettera non si consegna, e il testo salvato si rilegge e va in anteprima", async ({ page }) => {
  await openLetter(page);
  const form = page.getByRole("form", { name: "Contenuto della lettera" });
  const preview = page.getByRole("region", { name: "Anteprima della lettera" });

  // Consegna senza assenso: la frase del comando sotto il campo, la lettera resta in bozza.
  await page.getByRole("button", { name: "Segna come consegnata al paziente" }).click();
  const agreement = form.getByRole("checkbox", { name: "Il paziente è d'accordo a condividere queste informazioni" });
  await expect(page.getByText("Serve l'assenso del paziente a condividere queste informazioni.")).toBeVisible();
  await expect(agreement).toHaveAccessibleDescription("Serve l'assenso del paziente a condividere queste informazioni.");
  await expect(page.getByText("Bozza", { exact: true })).toBeVisible();

  // Destinatario scritto a mano, richiesta cambiata, assenso dato: il «Salva» scrive e l'anteprima segue il salvato.
  await form.getByRole("combobox", { name: "Destinatario" }).click();
  await page.getByRole("option", { name: "Scrivi il destinatario" }).click();
  await form.getByRole("textbox", { name: "Nome del destinatario" }).fill("Dott. Mario Verdi, ortopedico");
  const request = form.getByRole("textbox", { name: /^Richiesta/ });
  await request.fill("Le chiedo una valutazione ortopedica e un parere sul proseguimento.");
  await agreement.check();
  // Spuntare l'assenso toglie l'errore sotto la casella.
  await expect(page.getByText("Serve l'assenso del paziente a condividere queste informazioni.")).toHaveCount(0);
  await expect(preview).not.toContainText("Dott. Mario Verdi");

  // Con modifiche non salvate «Stampa» non apre il PDF vecchio: resta qui e dice di salvare (nessuna scheda nuova).
  let opened = 0;
  page.context().on("page", () => (opened += 1));
  await page.getByRole("link", { name: "Stampa" }).click();
  await expect(page.getByText("Salva le modifiche prima di stampare.")).toBeVisible();
  expect(opened).toBe(0);
  await form.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(preview).toContainText("Dott. Mario Verdi, ortopedico");
  await expect(page.getByText("Salva le modifiche prima di stampare.")).toHaveCount(0);
  await expect(preview).toContainText("Le chiedo una valutazione ortopedica e un parere sul proseguimento.");

  // Dopo un ricaricamento il modulo rilegge ciò che è nel database.
  await page.reload();
  const again = page.getByRole("form", { name: "Contenuto della lettera" });
  await expect(again.getByRole("textbox", { name: "Nome del destinatario" })).toHaveValue("Dott. Mario Verdi, ortopedico");
  await expect(again.getByRole("textbox", { name: /^Richiesta/ })).toHaveValue(
    "Le chiedo una valutazione ortopedica e un parere sul proseguimento.",
  );
  await expect(
    again.getByRole("checkbox", { name: "Il paziente è d'accordo a condividere queste informazioni" }),
  ).toBeChecked();
  await expect(page.getByText("Bozza", { exact: true })).toBeVisible();
});
