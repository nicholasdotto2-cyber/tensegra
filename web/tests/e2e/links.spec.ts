import { expect, type Page, test } from "@playwright/test";
import { PATIENTS } from "../../seed/people";

// Nel browser: le pagine dello scenario (Oggi, Agenda, la
// lista Pazienti e le 15 schede in ogni tab, Fatture, Impostazioni Messaggi, Consensi e Dati di prova, gli editor
// delle visite chiuse di Matteo, Francesca e Valentina) non hanno nessun link
// `wa.me` o `tel:` con il cellulare di un paziente o di un genitore del seed: prima senza numero per le prove,
// poi con un numero di prova inventato. Il file gira dopo impostazioni.spec: il numero per le prove torna quello
// che c'era prima, anche se il test si ferma a metà. Solo letture: nessun clic su un link, nessuna rete esterna.

// Inventato: nessun cellulare del seed è 399 000 0042.
const TEST_PHONE = "399 000 0042";
const TEST_E164 = "393990000042";

/** I cellulari di pazienti e genitori del seed, senza «+». */
const SEED_PHONES = PATIENTS.flatMap((patient) => [patient.phone, patient.contactGuardian?.phone, patient.secondGuardian?.phone])
  .filter((phone): phone is string => phone !== null && phone !== undefined)
  .map((phone) => phone.replace(/\D/g, ""));

const LINKS = 'a[href*="wa.me"], a[href*="whatsapp"], a[href^="tel:"]';
const TABS = ["riepilogo", "cartella", "appuntamenti", "consensi", "fatture", "messaggi", "anagrafica"] as const;
const PAGES = [
  "/oggi",
  "/agenda",
  "/agenda?vista=giorno&data=2026-11-04",
  "/agenda?vista=giorno&data=2026-11-05",
  "/agenda?vista=settimana&data=2026-11-04",
  "/pazienti",
  "/pazienti?filtro=da_richiamare",
  "/pazienti?filtro=consensi_mancanti",
  "/fatture",
  "/fatture?tab=emesse&mese=2026-10",
  "/fatture?tab=emesse&mese=2026-11",
  "/impostazioni/messaggi",
  "/impostazioni/consensi",
  "/impostazioni/dati-di-prova",
];

/** Le visite chiuse del seed che le schermate della demo aprono: paziente, quante. */
const CLOSED_VISITS = [
  { lastName: "Ricci", firstName: "Matteo", count: 1 },
  { lastName: "Longo", firstName: "Francesca", count: 1 },
  { lastName: "Greco", firstName: "Valentina", count: 2 },
] as const;

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

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("main#contenuto")).toBeVisible();
}

/** Il numero per le prove WhatsApp di Impostazioni, Dati di prova; vuoto lo toglie. */
async function setTestPhone(page: Page, phone: string): Promise<void> {
  await open(page, "/impostazioni/dati-di-prova");
  await page.getByLabel(/^Numero per le prove WhatsApp/).fill(phone);
  await page.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Modifiche salvate.")).toBeVisible();
}

/** Le schede dei 15 pazienti del seed, cercate per cognome: altri file creano pazienti loro. */
async function seedCards(page: Page): Promise<string[]> {
  const urls: string[] = [];
  for (const patient of PATIENTS) {
    await open(page, `/pazienti?q=${encodeURIComponent(patient.lastName)}`);
    const link = page.getByRole("link", { name: `${patient.lastName} ${patient.firstName}`, exact: true });
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/pazienti\/[0-9a-f-]{36}$/);
    urls.push(href ?? "");
  }
  return urls;
}

/** Gli editor delle visite chiuse di Matteo, Francesca e Valentina, presi dai «Vedi la visita» della Cronologia. */
async function closedVisitEditors(page: Page, cards: readonly string[]): Promise<string[]> {
  const editors: string[] = [];
  for (const { lastName, firstName, count } of CLOSED_VISITS) {
    const card = cards[PATIENTS.findIndex((patient) => patient.lastName === lastName && patient.firstName === firstName)];
    if (card === undefined) throw new Error(`Scheda di ${lastName} ${firstName} non trovata.`);
    await open(page, `${card}?tab=cartella`);
    const links = page
      .getByRole("region", { name: "Cronologia" })
      .getByRole("link", { name: "Vedi la visita", exact: true });
    await expect(links).toHaveCount(count);
    const hrefs = await links.evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
    for (const href of hrefs) expect(href).toMatch(new RegExp(`^${card}/visite/[0-9a-f-]{36}$`));
    editors.push(...hrefs);
  }
  return editors;
}

/** Ogni link WhatsApp o telefono delle pagine: indirizzo, pagina. */
async function collectLinks(
  page: Page,
  cards: readonly string[],
  editors: readonly string[],
): Promise<{ href: string; url: string }[]> {
  const found: { href: string; url: string }[] = [];
  const urls = [...PAGES, ...editors, ...cards.flatMap((card) => TABS.map((tab) => `${card}?tab=${tab}`))];
  for (const url of urls) {
    // I link nascono nell'HTML del server: basta la pagina caricata, senza aspettare che la rete si fermi.
    await page.goto(url);
    await expect(page.locator("main#contenuto")).toBeVisible();
    const hrefs = await page.locator(LINKS).evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href") ?? ""));
    for (const href of hrefs) found.push({ href, url });
  }
  return found;
}

/** Nessun cellulare del seed, né col 39 né senza, né nel percorso né nel testo; il destinatario è quello atteso. */
function expectProtected(links: readonly { href: string; url: string }[], routed: string | null): void {
  const whatsapp = links.filter((link) => link.href.startsWith("https://wa.me/"));
  // Oggi ha il promemoria di Paolo e i richiami di Davide e Giorgio: il controllo non gira a vuoto.
  expect(whatsapp.length).toBeGreaterThan(0);
  for (const { href, url } of links) {
    const where = `${href} (${url})`;
    const digits = decodeURIComponent(href).replace(/[\s+]/g, "");
    for (const phone of SEED_PHONES) {
      expect(digits, where).not.toContain(phone);
      expect(digits, where).not.toContain(phone.slice(2));
    }
    if (routed === null) {
      expect(href.startsWith("https://wa.me/?text="), where).toBe(true);
    } else {
      expect(href.startsWith(`https://wa.me/${routed}?text=`) || href === `tel:+${routed}`, where).toBe(true);
    }
  }
}

test("links_demo_protetti: nessun link wa.me o tel: porta il telefono di un paziente o di un genitore del seed, con e senza numero per le prove", async ({
  page,
}) => {
  test.setTimeout(480_000);
  expect(SEED_PHONES.length).toBeGreaterThan(10);
  expect(SEED_PHONES).not.toContain(TEST_E164);

  await open(page, "/impostazioni/dati-di-prova");
  const previous = await page.getByLabel(/^Numero per le prove WhatsApp/).inputValue();
  const cards = await seedCards(page);
  expect(cards).toHaveLength(15);
  expect(new Set(cards).size).toBe(15);
  const editors = await closedVisitEditors(page, cards);
  expect(editors).toHaveLength(4);
  expect(new Set(editors).size).toBe(4);

  try {
    // Senza numero per le prove la demo apre WhatsApp senza destinatario e non scrive nessun `tel:`.
    await setTestPhone(page, "");
    expectProtected(await collectLinks(page, cards, editors), null);

    // Con un numero di prova i link vanno lì, mai al paziente.
    await setTestPhone(page, TEST_PHONE);
    const routed = await collectLinks(page, cards, editors);
    expectProtected(routed, TEST_E164);
    expect(routed.some((link) => link.href.startsWith(`https://wa.me/${TEST_E164}?text=`))).toBe(true);
  } finally {
    await setTestPhone(page, previous);
  }
  await open(page, "/impostazioni/dati-di-prova");
  await expect(page.getByLabel(/^Numero per le prove WhatsApp/)).toHaveValue(previous);
});
