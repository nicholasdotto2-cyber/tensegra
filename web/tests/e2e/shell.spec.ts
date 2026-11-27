import { expect, type Page, test } from "@playwright/test";

// La shell sulla demo dei test: studio "Studio Osteopatico Borgo Tiglio",
// seed creato oggi alle 08:30 (APP_FIXED_NOW in playwright.config.ts).

const BANNER_TEXT = "Dati di prova: studio, pazienti e fatture sono inventati. Non inserire dati di persone reali.";
const LABELS = ["Oggi", "Agenda", "Pazienti", "Fatture", "Listino", "Impostazioni"];
const STUDIO = "Studio Osteopatico Borgo Tiglio";

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

test("la home porta a Oggi, con il titolo e senza il nome dello studio nella pagina", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/oggi$/);
  await expect(page.getByRole("heading", { level: 1, name: "Oggi" })).toBeVisible();
  await expect(page.locator("main#contenuto").getByText(STUDIO)).toHaveCount(0);
});

test("il primo Tab porta su Vai al contenuto e Invio sul contenuto", async ({ page }) => {
  await page.goto("/oggi");

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Vai al contenuto" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.locator("main#contenuto")).toBeFocused();
});

test("il banner dei dati di prova è una regione, alta 36 px, e dice quando sono stati creati", async ({ page }) => {
  await page.goto("/oggi");

  const banner = page.getByRole("region", { name: "Avviso dati di prova" });
  await expect(banner).toBeVisible();
  await expect(banner.getByText(BANNER_TEXT)).toBeVisible();
  await expect(banner.getByText("Creati oggi alle 08:30")).toBeVisible();
  // Mai un avviso: non deve interrompere chi legge (l'annuncio di rotta di Next è fuori dal banner).
  await expect(banner.locator('[role="alert"]')).toHaveCount(0);

  // Il banner sta in cima, la sidebar parte sotto di lui e il documento non scorre: lo scorrimento
  // sta nel contenuto, così il banner non copre mai l'elemento col focus (WCAG 2.4.11).
  const bannerBox = await banner.boundingBox();
  expect(bannerBox?.y).toBe(0);
  expect(bannerBox?.height).toBe(36);
  const sidebarBox = await page.locator('[data-slot="sidebar-container"]').boundingBox();
  expect(sidebarBox?.y).toBe(36);
  expect((sidebarBox?.y ?? 0) + (sidebarBox?.height ?? 0)).toBe(page.viewportSize()?.height);
  const geometry = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    contentOverflowY: getComputedStyle(document.querySelector("main#contenuto") as Element).overflowY,
  }));
  expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.contentOverflowY).toBe("auto");
});

test("la sidebar ha le sei voci in ordine e Oggi è la voce attiva", async ({ page }) => {
  await page.goto("/oggi");

  const links = page.getByRole("navigation", { name: "Menu" }).getByRole("link");
  await expect(links).toHaveCount(6);
  for (const [index, label] of LABELS.entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(new RegExp(`^${label}\\b`));
  }
  await expect(links.nth(0)).toHaveAttribute("aria-current", "page");
  await expect(links.nth(1)).not.toHaveAttribute("aria-current", "page");

  // Il numero accanto a Fatture lo cambia solo demo.spec.ts: qui conta che, se c'è, abbia il suo
  // testo nascosto. Il seed ha dati fiscali e sede, quindi Impostazioni è senza punto e senza il suo testo.
  await expect(links.nth(0)).toHaveAccessibleName("Oggi");
  await expect(links.nth(3)).toHaveAccessibleName(/^Fatture(\s+\d+\s+da emettere)?$/);
  await expect(links.nth(5)).toHaveAccessibleName("Impostazioni");
});

test("il nome dello studio compare una volta, nella sidebar", async ({ page }) => {
  await page.goto("/oggi");

  await expect(page.getByText(STUDIO)).toHaveCount(1);
  await expect(page.locator('[data-slot="sidebar-container"]').getByText(STUDIO)).toBeVisible();
});

test("un indirizzo sconosciuto mostra Pagina non trovata e Torna a Oggi porta a Oggi", async ({ page }) => {
  const response = await page.goto("/pagina-che-non-esiste");
  expect(response?.status()).toBe(404);
  // Chrome scrive in console il 404 del documento stesso: è la risposta attesa, e l'unica.
  await expect
    .poll(() => consoleErrors)
    .toEqual([`Failed to load resource: the server responded with a status of 404 (Not Found) @ ${page.url()}`]);
  consoleErrors = [];

  await expect(page.getByRole("heading", { level: 1, name: "Pagina non trovata" })).toBeVisible();
  await page.getByRole("link", { name: "Torna a Oggi" }).click();

  await expect(page).toHaveURL(/\/oggi$/);
  await expect(page.getByRole("heading", { level: 1, name: "Oggi" })).toBeVisible();
});

test("a 1024 x 768 la sidebar è a icone, con il tooltip di ogni voce, e la pagina non scorre di lato", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/oggi");

  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-collapsible", "icon");
  // Finita la transizione la sidebar è larga 3 rem (48 px), non 16 rem.
  await expect
    .poll(async () => (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.width)
    .toBeLessThanOrEqual(56);
  await expect(page.getByText(STUDIO)).toBeHidden();

  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Agenda" }).hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("Agenda");

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});

test("Ctrl+B apre e chiude la sidebar", async ({ page }) => {
  await page.goto("/oggi");
  const sidebar = page.locator('[data-slot="sidebar"]');
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

test("cambiando fascia la sidebar torna a seguire la finestra, anche dopo Ctrl+B", async ({ page }) => {
  await page.goto("/oggi");
  const sidebar = page.locator('[data-slot="sidebar"]');
  const wide = () => page.evaluate(() => window.matchMedia("(min-width: 1280px)").matches);

  // Larga: chiusa a mano, resta chiusa passando alla fascia a icone.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(wide).toBe(false);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // Stretta: Ctrl+B la apre e la richiude finché la fascia resta la stessa.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  // Tornando larga si riapre da sola, anche se l'ultima scelta era "chiusa".
  await page.setViewportSize({ width: 1400, height: 800 });
  await expect.poll(wide).toBe(true);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

/** La durata più lunga fra quelle di una proprietà calcolata ("0.2s, 0.2s"), in secondi. */
function longest(durations: string): number {
  return Math.max(...durations.split(",").map((value) => parseFloat(value)));
}

async function motionOf(page: Page, slot: string) {
  return page.locator(`[data-slot="${slot}"]`).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { animation: style.animationDuration, transition: style.transitionDuration };
  });
}

test.describe("con le animazioni ridotte dal sistema", () => {
  test.use({ reducedMotion: "reduce" });

  test("sidebar, dialogo e pannello laterale non si animano", async ({ page }) => {
    await page.goto("/agenda?vista=giorno&data=2026-11-05");
    await page.waitForLoadState("networkidle");

    expect(longest((await motionOf(page, "sidebar-gap")).transition)).toBeLessThan(0.001);
    expect(longest((await motionOf(page, "sidebar-container")).transition)).toBeLessThan(0.001);

    await page.getByRole("button", { name: "Nuovo appuntamento" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
    await expect(dialog).toBeVisible();
    expect(longest((await motionOf(page, "dialog-content")).animation)).toBeLessThan(0.001);
    expect(longest((await motionOf(page, "dialog-overlay")).animation)).toBeLessThan(0.001);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: /^\d{2}:\d{2}-\d{2}:\d{2}, Valli Chiara, / }).click();
    const detail = page.getByRole("dialog", { name: "Chiara Valli" });
    await expect(detail).toBeVisible();
    expect(longest((await motionOf(page, "sheet-content")).transition)).toBeLessThan(0.001);
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  });
});

test("senza preferenza il dialogo si anima: il controllo sopra legge durate vere", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).first().click();
  await expect(page.getByRole("dialog", { name: "Nuovo appuntamento" })).toBeVisible();
  expect(longest((await motionOf(page, "dialog-content")).animation)).toBeGreaterThan(0.05);
  expect(longest((await motionOf(page, "sidebar-gap")).transition)).toBeGreaterThan(0.05);
  await page.keyboard.press("Escape");
});
