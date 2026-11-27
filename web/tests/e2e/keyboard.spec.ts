import { expect, type Locator, type Page, test } from "@playwright/test";

// L'agenda con la sola tastiera: niente mouse in questo file.
// Sulla demo dei test, D0 = mercoledì 4/11/2026 alle 08:30 (APP_FIXED_NOW in playwright.config.ts).
// Crea un solo appuntamento, di Elisa Fontana il 10/12/2026 alle 09:00, che non cambia nessun conteggio
// dei passi della demo; legge l'ordine dei blocchi del 5/11, giorno che nessun e2e cambia.

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

/** Il testo scelto in un campo a scelta (un pulsante con l'elenco), senza la freccia. */
function chosen(select: Locator): Locator {
  return select.locator('[data-slot="select-value"]');
}

/** Preme Tab finché il focus arriva su `target`; fallisce se non ci arriva entro `max` pressioni. */
async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let presses = 0; presses < max; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
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

/**
 * Sceglie un orario di "Ora di inizio" con le frecce: Freccia giù apre l'elenco sull'orario scelto,
 * le frecce lo spostano a passi di 15 minuti, Invio sceglie.
 */
async function pickTimeWithArrows(page: Page, time: string): Promise<void> {
  await page.keyboard.press("ArrowDown");
  const highlighted = page.getByRole("listbox").locator("[role='option'][data-highlighted]");
  await expect(highlighted).toHaveCount(1);
  for (let presses = 0; presses < 60; presses += 1) {
    const current = (await highlighted.textContent())?.trim() ?? "";
    if (current === time) break;
    // "HH:MM" in ordine di testo è in ordine di orario.
    await page.keyboard.press(current > time ? "ArrowUp" : "ArrowDown");
    await expect(highlighted).not.toHaveText(current);
  }
  await expect(highlighted).toHaveText(time);
  await page.keyboard.press("Enter");
}

test("si crea un appuntamento dalla barra dell'agenda senza mouse", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-12-07");
  await page.waitForLoadState("networkidle");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Vai al contenuto" })).toBeFocused();

  // La settimana è vuota: "Nuovo appuntamento" c'è anche sotto la barra. Il primo è quello della barra.
  const opener = page.getByRole("button", { name: "Nuovo appuntamento" }).first();
  await tabTo(page, opener);
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  const patient = dialog.getByLabel("Paziente");
  await expect(patient).toBeFocused();
  await page.keyboard.type("Font");
  await expect(page.getByRole("option", { name: "Fontana Elisa" })).toBeVisible();
  await expect(page.getByRole("option").last()).toHaveText("Nuovo paziente: Font");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(patient).toHaveValue("Fontana Elisa");
  // La prima visita di Elisa: 60 minuti dal listino.
  await expect(chosen(dialog.getByLabel("Durata"))).toHaveText("60 min");

  const date = dialog.getByLabel("Data", { exact: true });
  await tabTo(page, date);
  await page.keyboard.type("10122026");
  await expect(date).toHaveValue("2026-12-10");

  const time = dialog.getByLabel("Ora di inizio");
  await tabTo(page, time);
  await pickTimeWithArrows(page, "09:00");
  await expect(chosen(time)).toHaveText("09:00");
  await expect(time).toBeFocused();

  const save = dialog.getByRole("button", { name: "Salva", exact: true });
  await tabTo(page, save);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Il blocco nuovo del giovedì 10/12 si raggiunge con Tab.
  const elisa = page.locator('[data-day="2026-12-10"]').getByRole("button", { name: /^09:00-10:00, Fontana Elisa, / });
  await tabTo(page, elisa);
});

test("Esc chiude il dialogo e il focus torna su Nuovo appuntamento", async ({ page }) => {
  await page.goto("/agenda?vista=settimana&data=2026-12-07");
  await page.waitForLoadState("networkidle");

  const opener = page.getByRole("button", { name: "Nuovo appuntamento" }).first();
  await tabTo(page, opener);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(dialog.getByLabel("Paziente")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Anche con un paziente scelto Esc chiude il dialogo, senza prima svuotare il campo.
  await page.keyboard.press("Enter");
  const patient = dialog.getByLabel("Paziente");
  await expect(patient).toBeFocused();
  await page.keyboard.type("Font");
  await expect(page.getByRole("option", { name: "Fontana Elisa" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(patient).toHaveValue("Fontana Elisa");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("nella vista Giorno i Tab dopo la barra portano ai blocchi in ordine di orario", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");

  // "Nuovo appuntamento" è l'ultimo controllo della barra; come ogni pulsante ha il bordo `ring` pieno.
  const opener = page.getByRole("button", { name: "Nuovo appuntamento" });
  await tabTo(page, opener);
  await expect.poll(() => solidRingFocus(opener)).toBe(true);
  for (const patient of ["Valli Chiara", "Fontana Elisa", "Neri Paolo"]) {
    await page.keyboard.press("Tab");
    const block = page.getByRole("button", { name: new RegExp(`^\\d{2}:\\d{2}-\\d{2}:\\d{2}, ${patient}, `) });
    await expect(block).toBeFocused();
    // Il focus si vede con un contorno pieno, anche sul colore della prestazione.
    await expect.poll(() => solidRingFocus(block)).toBe(true);
  }
});

test("Invio sul blocco apre il dettaglio col focus dentro, Esc lo chiude e il focus torna sul blocco", async ({ page }) => {
  await page.goto("/agenda?vista=giorno&data=2026-11-05");
  await page.waitForLoadState("networkidle");

  const elisa = page.getByRole("button", { name: /^\d{2}:\d{2}-\d{2}:\d{2}, Fontana Elisa, / });
  await tabTo(page, elisa);
  await page.keyboard.press("Enter");

  const detail = page.getByRole("dialog", { name: "Elisa Fontana" });
  await expect(detail).toBeVisible();
  await expect.poll(() => detail.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(elisa).toBeFocused();
});
