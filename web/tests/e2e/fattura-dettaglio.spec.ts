import { expect, test, type Page } from "@playwright/test";

// Il dettaglio della fattura emessa. D0 = 4/11/2026. Sola lettura sul seed: la
// prima visita di Marco (pagata, ottobre) e la prima visita di Lorenzo, intestata per errore a lui, annullata
// con la nota NC-1/2026. Solo i download scrivono gli eventi `pdf_scaricato` e `xml_scaricato`
// (l'anteprima no), che nessun altro file conta.
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

const NUMBER = /^\d+\/2026$/;
const DETAIL_URL = /\/fatture\/[0-9a-f-]{36}$/;
const DATED = /\d{2}\/\d{2}\/2026 alle \d{2}:\d{2}/;

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

test("la prima visita di Marco: anteprima, stato, file XML, cronologia, download e XML in chiaro", async ({ page }) => {
  await open(page, "/fatture?tab=emesse&mese=2026-10&q=Bellandi");
  const link = page.getByRole("row").filter({ hasText: "Prima visita osteopatica" }).getByRole("link", { name: NUMBER });
  const number = (await link.textContent())!.trim();
  await link.click();
  await expect(page).toHaveURL(DETAIL_URL);
  const id = /\/fatture\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${number}` })).toBeVisible();

  const preview = page.locator('iframe[title="Anteprima della fattura"]');
  await expect(preview).toHaveAttribute("src", `/api/fatture/${id}/pdf`);

  const panel = page.getByRole("region", { name: "Dati della fattura" });
  await expect(panel).toContainText("Pagata");
  await expect(panel).toContainText(number);
  await expect(panel).toContainText(/\d{2}\/\d{2}\/2026/);
  await expect(panel).toContainText(/IT[0-9A-Z]+_[0-9A-Z]{5}\.xml/);
  const history = panel.getByRole("list", { name: "Cronologia" });
  await expect(history.getByRole("listitem").filter({ hasText: "Emessa" })).toContainText(DATED);
  await expect(history.getByRole("listitem").filter({ hasText: "Incasso registrato" })).toContainText(DATED);

  await expect(page.getByRole("button", { name: "Registra incasso" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Annulla incasso", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Annulla con nota di credito" })).toBeVisible();

  // Chromium senza interfaccia può scaricare anche il PDF dell'iframe, con lo stesso nome: il download del pulsante
  // è quello che chiede `?download=1` (l'unico che scrive «PDF scaricato»).
  const pdfResponse = page.waitForResponse((response) => response.url().endsWith(`/api/fatture/${id}/pdf?download=1`));
  const pdf = page.waitForEvent("download");
  await page.getByRole("button", { name: "Scarica PDF" }).click();
  expect((await pdfResponse).status()).toBe(200);
  expect((await pdf).suggestedFilename()).toBe(`Fattura_${number.replace("/", "-")}.pdf`);
  const xml = page.waitForEvent("download", { predicate: (file) => file.suggestedFilename().endsWith(".xml") });
  await page.getByRole("button", { name: "Scarica XML" }).click();
  expect((await xml).suggestedFilename()).toMatch(/^PROVA_IT[0-9A-Z]+_[0-9A-Z]{5}\.xml$/);

  await page.getByRole("button", { name: "Vedi XML" }).click();
  const dialog = page.getByRole("dialog", { name: `XML della fattura ${number}` });
  await expect(dialog.locator("pre")).toContainText("<FatturaElettronica");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Vedi XML" })).toBeFocused();
});

test("la fattura annullata di Lorenzo porta alla nota di credito e la nota alla fattura", async ({ page }) => {
  await open(page, "/fatture?tab=emesse&mese=2026-10&stato=annullate&q=Gatti");
  const link = page.getByRole("row").filter({ hasText: "Lorenzo Gatti" }).getByRole("link", { name: NUMBER });
  const number = (await link.textContent())!.trim();
  await link.click();
  await expect(page).toHaveURL(DETAIL_URL);
  const invoiceUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${number}` })).toBeVisible();
  const panel = page.getByRole("region", { name: "Dati della fattura" });
  await expect(panel).toContainText("Annullata");
  await expect(page.getByRole("button", { name: "Registra incasso" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Annulla con nota di credito" })).toHaveCount(0);

  await panel.getByRole("link", { name: "Nota di credito NC-1/2026", exact: true }).click();
  await expect(page).toHaveURL(DETAIL_URL);
  await expect(page.getByRole("heading", { level: 1, name: "Nota di credito n. NC-1/2026" })).toBeVisible();
  const back = page.getByRole("region", { name: "Dati della fattura" }).getByRole("link", { name: `Fattura ${number}`, exact: true });
  await expect(back).toHaveAttribute("href", invoiceUrl);
  await back.click();
  await expect(page.getByRole("heading", { level: 1, name: `Fattura n. ${number}` })).toBeVisible();
});

test("un id che non esiste o non è un uuid dà «Fattura non trovata.» con la strada per tornare alle fatture", async ({ page }) => {
  const notFound = page.getByRole("heading", { level: 1, name: "Fattura non trovata." });
  await page.goto("/fatture/00000000-0000-4000-8000-000000000000");
  await expect(notFound).toBeVisible();
  await page.getByRole("link", { name: "Torna alle fatture" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fatture" })).toBeVisible();
  await page.goto("/fatture/abc");
  await expect(notFound).toBeVisible();
  await expect(page.getByRole("link", { name: "Torna alle fatture" })).toHaveAttribute("href", "/fatture");
});
