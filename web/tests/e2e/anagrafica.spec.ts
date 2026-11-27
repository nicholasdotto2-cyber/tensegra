import { expect, type Locator, type Page, test } from "@playwright/test";

// La tab Anagrafica della scheda paziente sulla demo dei test: un paziente di 9 anni
// creato dalla lista (oggi, per i test, è il 4/11/2026), con il genitore del dialogo. Ogni gruppo si salva da solo,
// gli errori stanno sotto il campo, uscire con modifiche non salvate chiede conferma, un medico nuovo si aggiunge
// da un dialogo e il secondo genitore può prendere il posto del primo come contatto e intestatario. Il paziente
// si elimina nello stesso test, anche se fallisce a metà: a fine file la lista torna a
// «Tutti (15)». Il medico creato resta in rubrica (non ha un modo di essere tolto) con un nome che nessun altro
// file cerca.

const MINOR_BIRTH_DATE = "2017-06-15";
const TAX_CODE_ERROR = "Il codice fiscale non è valido: controlla lettere e cifre.";
const PAYER_ERROR = "Per l'intestatario servono indirizzo, CAP e città.";
const PHYSICIAN = "Dott.ssa Anna Prova";

// Un errore di una risorsa o un'eccezione della pagina arriva dopo il titolo: lo controlla afterEach.
let consoleErrors: string[] = [];
let createsPatient = false;

test.beforeEach(({ page }) => {
  consoleErrors = [];
  createsPatient = false;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  // Un'eccezione non gestita della pagina non passa dal canale "console".
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

// Se il test fallisce a metà il paziente resta: questo lo toglie lo stesso, così gli altri file trovano 15 pazienti.
test.afterEach(async ({ page }) => {
  if (createsPatient) {
    for (const url of ["/pazienti?q=Prova", "/pazienti?filtro=archiviati&q=Prova"]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const left = page.getByRole("link", { name: "Prova Minore" });
      if ((await left.count()) === 0) continue;
      await left.first().click();
      await expect(page.getByRole("heading", { level: 1, name: "Minore Prova" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await deleteOpenPatient(page);
    }
  }
  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
});

/** Dalla scheda aperta: menu, «Elimina definitivamente», conferma con il nome; poi la lista senza il paziente. */
async function deleteOpenPatient(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Altre azioni" }).click();
  await page.getByRole("menuitem", { name: "Elimina definitivamente" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Eliminare definitivamente Minore Prova?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Elimina definitivamente" }).click();

  await expect(page).toHaveURL(/\/pazienti$/);
  await expect(
    page.getByRole("navigation", { name: "Filtri" }).getByRole("link", { name: "Tutti (15)" }),
  ).toBeVisible();
}

/** Il campo "Nome" o "Cognome" di un gruppo: l'etichetta porta anche "(obbligatorio)". */
function field(group: Locator, label: string): Locator {
  return group.getByLabel(new RegExp(`^${label}`));
}

/** Sceglie una voce di un elenco a discesa: il pulsante porta il nome del campo. */
async function choose(group: Locator, label: string, option: string): Promise<void> {
  await field(group, label).click();
  await group.page().getByRole("option", { name: option }).click();
}

function region(page: Page, name: string): Locator {
  return page.getByRole("region", { name });
}

function saved(page: Page): Locator {
  return page.getByText("Modifiche salvate.");
}

test("l'anagrafica si modifica per gruppo, con un medico nuovo e il secondo genitore come contatto", async ({
  page,
}) => {
  createsPatient = true;

  // Il paziente nasce dalla lista, con il genitore del dialogo.
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuovo paziente" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuovo paziente" });
  await field(dialog, "Nome").fill("Minore");
  await field(dialog, "Cognome").fill("Prova");
  await dialog.getByLabel(/^Data di nascita/).fill(MINOR_BIRTH_DATE);
  const newGuardian = dialog.getByRole("group", { name: "Genitore o tutore" });
  await field(newGuardian, "Nome").fill("Elena");
  await field(newGuardian, "Cognome").fill("Prova");
  await dialog.getByRole("button", { name: "Salva e apri la scheda" }).click();
  await expect(page).toHaveURL(/\/pazienti\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "Minore Prova" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  await page
    .getByRole("navigation", { name: "Sezioni della scheda" })
    .getByRole("link", { name: "Anagrafica" })
    .click();
  await expect(page).toHaveURL(/tab=anagrafica/);

  // I sei gruppi, ognuno col suo «Salva» (i genitori ne hanno uno per genitore).
  const groups = [
    "Dati personali",
    "Contatti e preferenze",
    "Indirizzo (per la fattura)",
    "Medici",
    "Genitori o tutori",
    "Note amministrative",
  ];
  for (const name of groups) await expect(region(page, name)).toBeVisible();
  for (const name of groups.filter((g) => g !== "Genitori o tutori")) {
    await expect(region(page, name).getByRole("button", { name: "Salva", exact: true })).toBeVisible();
  }
  await expect(region(page, "Note amministrative").getByText("Solo dati amministrativi: niente dati clinici.")).toBeVisible();
  await expect(field(region(page, "Indirizzo (per la fattura)"), "Paese")).toHaveAccessibleDescription(
    "Sigla di 2 lettere, per esempio IT.",
  );
  await page.waitForLoadState("networkidle");

  // Un codice fiscale scritto male si ferma sotto il campo, con l'errore letto e il focus; il resto non parte.
  const personal = region(page, "Dati personali");
  const taxCode = personal.getByLabel("Codice fiscale");
  await taxCode.fill("AAAAAA00A00A000A");
  await personal.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(personal.getByText(TAX_CODE_ERROR)).toBeVisible();
  await expect(taxCode).toHaveAttribute("aria-invalid", "true");
  await expect(taxCode).toHaveAccessibleDescription(TAX_CODE_ERROR);
  await expect(taxCode).toBeFocused();

  // Con il campo modificato e non salvato, lasciare la sezione chiede conferma; «Torna indietro» resta.
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Riepilogo" }).click();
  const leave = page.getByRole("alertdialog", { name: "Uscire senza salvare?" });
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Torna indietro" }).click();
  await expect(leave).toHaveCount(0);
  await expect(page).toHaveURL(/tab=anagrafica/);
  await taxCode.fill("");

  // Un medico nuovo si scrive da un dialogo e finisce scelto nel campo, da salvare col gruppo.
  const doctors = region(page, "Medici");
  const newDoctor = doctors.getByRole("button", { name: "Nuovo medico" });
  await newDoctor.click();
  const physician = page.getByRole("dialog", { name: "Nuovo medico" });
  await expect(field(physician, "Nome e titolo")).toBeFocused();
  await field(physician, "Nome e titolo").fill(PHYSICIAN);
  await choose(physician, "Ruolo", "Pediatra");
  await physician.getByRole("button", { name: "Salva il medico" }).click();
  await expect(physician).toHaveCount(0);
  await expect(newDoctor).toBeFocused();
  const gp = field(doctors, "Medico curante o pediatra");
  await expect(gp).toContainText(PHYSICIAN);
  await doctors.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(saved(page)).toBeVisible();

  // Il medico è salvato nella scheda e resta dopo il ricaricamento.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(field(region(page, "Medici"), "Medico curante o pediatra")).toContainText(PHYSICIAN);

  // Il genitore del dialogo è contatto e intestatario senza indirizzo: chiamarlo madre non basta per salvarlo.
  const guardians = region(page, "Genitori o tutori");
  const mother = guardians.getByRole("form", { name: /Elena Prova/ });
  await choose(mother, "Relazione", "Madre");
  await mother.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(mother.getByText(PAYER_ERROR)).toBeVisible();
  const motherAddress = field(mother, "Indirizzo");
  await expect(motherAddress).toBeFocused();
  await expect(motherAddress).toHaveAccessibleDescription(PAYER_ERROR);
  await motherAddress.fill("Via Prova 1");
  await field(mother, "CAP").fill("40100");
  await field(mother, "Città").fill("Bologna");
  await field(mother, "Provincia").fill("bo");
  await mother.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(saved(page).last()).toBeVisible();
  await expect(guardians.getByRole("heading", { name: "Madre: Elena Prova" })).toBeVisible();

  // Il secondo genitore si aggiunge da tastiera: il focus va al primo campo del genitore nuovo.
  const add = guardians.getByRole("button", { name: "Aggiungi genitore o tutore" });
  await add.focus();
  await page.keyboard.press("Enter");
  const father = guardians.getByRole("form", { name: "Nuovo genitore o tutore" });
  await expect(father).toBeVisible();
  await expect(field(father, "Relazione")).toBeFocused();
  // La relazione proposta è «Padre» (la madre c'è già): con le frecce si sceglie un'altra voce, «Tutore».
  await expect(field(father, "Relazione")).toContainText("Padre");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  // L'elenco è visibile prima che la voce scelta («Padre») sia quella evidenziata: con ArrowDown troppo presto la
  // freccia parte dalla prima voce e arriva su «Madre». Si aspetta lo stato giusto, non un tempo.
  await expect(page.getByRole("option", { name: "Padre" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Tutore" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(field(father, "Relazione")).toContainText("Tutore");
  await expect(field(father, "Relazione")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field(father, "Nome")).toBeFocused();
  await page.keyboard.type("Paolo");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Prova");
  // «Genitore di contatto» e «Intestatario delle fatture» si accendono con la barra spaziatrice.
  for (const name of ["Genitore di contatto", "Intestatario delle fatture"]) {
    const toggle = father.getByRole("switch", { name });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
  }
  await field(father, "Indirizzo").fill("Via Prova 2");
  await field(father, "CAP").fill("40100");
  await field(father, "Città").fill("Bologna");
  await field(father, "Provincia").fill("BO");
  await page.keyboard.press("Enter");

  // Il secondo genitore ha preso il posto: dopo il ricaricamento è lui il contatto e l'intestatario, e la madre no.
  const fatherHeading = guardians.getByRole("heading", { name: "Tutore: Paolo Prova" });
  await expect(fatherHeading).toBeVisible();
  // Il genitore salvato prende il focus sul titolo: da tastiera non si resta nel vuoto.
  await expect(fatherHeading).toBeFocused();
  // La madre ha perso contatto e intestazione subito, senza ricaricare e senza perdere il resto.
  const motherNow = guardians.getByRole("form", { name: /Elena Prova/ });
  await expect(motherNow.getByRole("switch", { name: "Genitore di contatto" })).not.toBeChecked();
  await expect(field(motherNow, "Indirizzo")).toHaveValue("Via Prova 1");
  await page.reload();
  await page.waitForLoadState("networkidle");
  const fatherSaved = region(page, "Genitori o tutori").getByRole("form", { name: /Paolo Prova/ });
  const motherSaved = region(page, "Genitori o tutori").getByRole("form", { name: /Elena Prova/ });
  await expect(fatherSaved.getByRole("switch", { name: "Genitore di contatto" })).toBeChecked();
  await expect(fatherSaved.getByRole("switch", { name: "Intestatario delle fatture" })).toBeChecked();
  await expect(motherSaved.getByRole("switch", { name: "Genitore di contatto" })).not.toBeChecked();
  await expect(motherSaved.getByRole("switch", { name: "Intestatario delle fatture" })).not.toBeChecked();
  // Con due genitori non se ne aggiungono altri.
  await expect(
    region(page, "Genitori o tutori").getByRole("button", { name: "Aggiungi genitore o tutore" }),
  ).toHaveCount(0);

  // «Togli» sull'unico contatto di un minore è rifiutato, con la frase del comando nel modulo del genitore.
  await fatherSaved.getByRole("button", { name: "Togli" }).click();
  const refusal = fatherSaved.getByRole("alert");
  await expect(refusal).toContainText("Non ho tolto il genitore o tutore. Riprova.");
  await expect(refusal).toContainText("Per un minore serve un genitore di contatto.");
  await expect(fatherSaved).toBeVisible();

  // «Togli» sull'altro genitore lo toglie, e il focus resta nel gruppo, sul suo titolo.
  await motherSaved.getByRole("button", { name: "Togli" }).click();
  await expect(motherSaved).toHaveCount(0);
  await expect(region(page, "Genitori o tutori").getByRole("heading", { level: 2 })).toBeFocused();
  await expect(region(page, "Genitori o tutori").getByRole("button", { name: "Aggiungi genitore o tutore" })).toBeVisible();

  // Diventato maggiorenne il paziente non ha più bisogno di un contatto: togliere l'ultimo genitore fa sparire il
  // gruppo e il focus passa al titolo del gruppo che segue, non al vuoto.
  const personalAfter = region(page, "Dati personali");
  await personalAfter.getByLabel(/^Data di nascita/).fill("2000-01-01");
  await personalAfter.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(saved(page).last()).toBeVisible();
  await expect(
    region(page, "Genitori o tutori").getByRole("button", { name: "Aggiungi genitore o tutore" }),
  ).toHaveCount(0);
  await fatherSaved.getByRole("button", { name: "Togli" }).click();
  await expect(region(page, "Genitori o tutori")).toHaveCount(0);
  await expect(region(page, "Note amministrative").getByRole("heading", { level: 2 })).toBeFocused();

  // Alla fine il paziente si elimina; il medico resta in rubrica.
  await deleteOpenPatient(page);
});

test("un adulto non ha il gruppo dei genitori e i gruppi mostrano i suoi dati", async ({ page }) => {
  await page.goto("/pazienti");
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Morelli Anna" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Anna Morelli" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByRole("navigation", { name: "Sezioni della scheda" }).getByRole("link", { name: "Anagrafica" }).click();

  const personal = region(page, "Dati personali");
  await expect(field(personal, "Nome")).toHaveValue("Anna");
  await expect(field(personal, "Cognome")).toHaveValue("Morelli");
  await expect(field(region(page, "Contatti e preferenze"), "Telefono")).toHaveValue("+39 320 000 0004");
  await expect(region(page, "Medici")).toBeVisible();
  await expect(region(page, "Note amministrative")).toBeVisible();
  await expect(region(page, "Genitori o tutori")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Aggiungi genitore o tutore" })).toHaveCount(0);
});
