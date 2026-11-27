import { expect, type Locator, type Page } from "@playwright/test";

// Un paziente proprio di un file e2e con una seduta fatta senza visita: con le visite passate
// della demo tutte chiuse nessun appuntamento `fatto` del seed resta senza visita. Tutto passa dall'interfaccia, come fa
// chi usa l'app: il mini modulo "Nuovo paziente" (adulto, inventato), l'informativa firmata col mouse, una prima
// visita ieri alle 10:00 con «Sì, è fatto», il consenso al trattamento da «Raccogli ora» nel pannello "Seduta fatta"
// e "Non fatturare" in Fatture. Così "Fatture da emettere" e "Consensi mancanti" di Oggi non cambiano, e
// demo.spec.ts trova i conteggi della demo anche se il file gira prima di lui. Alla seconda corsa sullo stesso
// database il paziente c'è già: si riusa e non si crea niente.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATIENT_PATH = new RegExp(`^/pazienti/(${UUID})$`);

/** Ieri rispetto a D0 (mercoledì 4/11/2026, APP_FIXED_NOW in playwright.config.ts). */
const APPOINTMENT_DAY = "2026-11-03";
const APPOINTMENT_TIME = "10:00";
const BIRTH_DATE = "1988-05-12";

const INFORMATIVA = "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)";
const TRATTAMENTO = "Consenso informato al trattamento osteopatico";
const WHATSAPP = "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp.";
const RICHIAMI = "Acconsento a essere ricontattato/a per i controlli periodici.";
const PAST_QUESTION = "L'orario è già passato. Lo segno già come fatto?";
const CONSENT_MISSING = "Manca il consenso al trattamento per questo ciclo.";

export interface OwnPatient {
  patientId: string;
  /** "AAAA-MM-GG" della prima visita fatta. */
  appointmentDay: string;
}

function field(scope: Locator, label: string): Locator {
  return scope.getByLabel(new RegExp(`^${label}`));
}

function patientIdOf(page: Page): string {
  const id = PATIENT_PATH.exec(new URL(page.url()).pathname)?.[1];
  if (id === undefined) throw new Error("l'indirizzo della scheda non ha l'id del paziente");
  return id;
}

/**
 * La misura vera della tela: il dialogo si apre con un'animazione che la scala per un momento, e una misura presa
 * durante l'apertura esce più piccola.
 */
async function settledBox(canvas: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await canvas.evaluate((element) =>
    Promise.all(
      (element.closest('[role="dialog"]') ?? element)
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("Tela non visibile.");
  return box;
}

/** Due tratti orizzontali col mouse, da 20 punti ciascuno: la tela tiene un punto ogni 16 ms. */
async function sign(page: Page, canvas: Locator): Promise<void> {
  await canvas.scrollIntoViewIfNeeded();
  const box = await settledBox(canvas);
  for (let s = 0; s < 2; s++) {
    const y = box.y + 60 + s * 40;
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 40 + i * 12, y + (i % 2 === 0 ? 4 : -4));
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
  }
  await expect(canvas).toHaveAttribute("data-empty", "false");
}

/** La scheda del paziente se c'è già (una corsa prima); null se non c'è. */
async function findExisting(page: Page, listName: string, lastName: string): Promise<string | null> {
  await page.goto(`/pazienti?q=${encodeURIComponent(lastName)}`);
  await page.waitForLoadState("networkidle");
  const link = page.getByRole("link", { name: listName, exact: true });
  if ((await link.count()) === 0) return null;
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/pazienti/${UUID}$`));
  return patientIdOf(page);
}

/**
 * Crea il paziente `name` con la prima visita di ieri alle 10:00 fatta e senza visita, informativa e consenso al
 * trattamento firmati col mouse e la seduta segnata "Non fatturare". Se il paziente esiste già lo riusa senza creare
 * niente. Lascia la pagina su Fatture.
 */
export async function createOwnPatientWithSession(
  page: Page,
  name: { firstName: string; lastName: string },
): Promise<OwnPatient> {
  const { firstName, lastName } = name;
  const fullName = `${firstName} ${lastName}`;
  const existing = await findExisting(page, `${lastName} ${firstName}`, lastName);
  if (existing !== null) return { patientId: existing, appointmentDay: APPOINTMENT_DAY };

  // Il paziente, adulto, dal mini modulo della lista.
  await page.getByRole("button", { name: "Nuovo paziente", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Nuovo paziente", exact: true });
  await field(create, "Nome").fill(firstName);
  await field(create, "Cognome").fill(lastName);
  await field(create, "Data di nascita").fill(BIRTH_DATE);
  await create.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page.getByRole("heading", { level: 1, name: fullName })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const patientId = patientIdOf(page);
  const patientUrl = `/pazienti/${patientId}`;

  // L'informativa dalla tab Consensi: no a WhatsApp e ai richiami.
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Consensi" }).click();
  await expect(page).toHaveURL(/tab=consensi/);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Raccogli l'informativa" }).click();
  const informativa = page.getByRole("dialog", { name: INFORMATIVA });
  await informativa.getByRole("radiogroup", { name: WHATSAPP }).getByRole("radio", { name: "No" }).click();
  await informativa.getByRole("radiogroup", { name: RICHIAMI }).getByRole("radio", { name: "No" }).click();
  await sign(page, informativa.getByRole("img", { name: `Firma di ${fullName}` }));
  await informativa.getByRole("button", { name: "Firma e salva" }).click();
  await expect(informativa).toBeHidden();

  // La prima visita di ieri alle 10:00: l'orario è passato, «Sì, è fatto» la crea fatta e apre "Seduta fatta".
  await page.goto(patientUrl);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo appuntamento" }).click();
  const booking = page.getByRole("dialog", { name: "Nuovo appuntamento" });
  await expect(booking.getByLabel("Prestazione").locator('[data-slot="select-value"]')).toHaveText("Prima visita osteopatica");
  await booking.getByLabel("Data", { exact: true }).fill(APPOINTMENT_DAY);
  await booking.getByLabel("Ora di inizio").click();
  await page.getByRole("option", { name: APPOINTMENT_TIME, exact: true }).click();
  // Una seduta del seed alla stessa ora fa dire al pulsante «Salva comunque».
  await booking.getByRole("button", { name: /^Salva(?: comunque)?$/ }).click();
  await page.getByRole("alertdialog", { name: PAST_QUESTION }).getByRole("button", { name: "Sì, è fatto" }).click();
  const panel = page.getByRole("dialog", { name: `Seduta fatta: ${fullName}` });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(CONSENT_MISSING)).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Il consenso al trattamento del ciclo nuovo, da «Raccogli ora»; poi il pannello si chiude senza altri passi.
  await panel.getByRole("button", { name: "Raccogli ora" }).click();
  const treatment = page.getByRole("dialog", { name: TRATTAMENTO, exact: true });
  await sign(page, treatment.getByRole("img", { name: `Firma di ${fullName}` }));
  await treatment.getByRole("button", { name: "Firma e salva" }).click();
  await expect(treatment).toBeHidden();
  await expect(panel.getByText(CONSENT_MISSING)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // "Non fatturare": la seduta esce da "Fatture da emettere".
  await page.goto("/fatture?tab=da_emettere&mese=2026-11");
  await page.waitForLoadState("networkidle");
  const session = page
    .getByRole("list", { name: "Sedute da fatturare" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: fullName, exact: true }) });
  await expect(session).toHaveCount(1);
  await session.getByRole("button", { name: "Non fatturare", exact: true }).click();
  const skip = page.getByRole("alertdialog", { name: "Non fatturare questa seduta?" });
  await skip.getByLabel("Motivo", { exact: false }).click();
  await page.getByRole("option", { name: "Gratuita", exact: true }).click();
  await skip.getByRole("button", { name: "Non fatturare", exact: true }).click();
  await expect(skip).toBeHidden();
  await expect(session).toHaveCount(0);

  return { patientId, appointmentDay: APPOINTMENT_DAY };
}
