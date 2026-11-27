import { describe, expect, it } from "vitest";
import {
  buildReferralSummary,
  DEFAULT_REQUEST_TEXT,
  type ReferralFacts,
  type ReferralReason,
  SUMMARY_MAX,
} from "@/lib/clinical/referral-summary";

// La sintesi della lettera al medico: una formula che chiede una
// valutazione, i fatti scritti dall'osteopata in ordine, mai "diagnosi" riferita all'osteopata, mai
// "terapia" per il trattamento, niente punti esclamativi, al più 3000 caratteri.

/** I fatti di Roberto Esposito: due red flag alla prima visita, dorsale e lombare. */
function roberto(extra: Partial<ReferralFacts> = {}): ReferralFacts {
  return {
    patientName: "Roberto Esposito",
    reason: "red_flag",
    startDay: "2026-10-14",
    chiefComplaint: "Dolore dorsale e lombare",
    diagnosis: null,
    redFlags: [
      { label: "Calo di peso non spiegato", subItems: [], visitDay: "2026-10-14" },
      {
        label: "Dolore costante e progressivo che non cambia con posizione e movimento",
        subItems: [],
        visitDay: "2026-10-14",
      },
    ],
    radiation: null,
    neuro: null,
    visits: [{ day: "2026-10-14", regions: ["Dorsale", "Lombare"], techniques: ["Tessuti molli"] }],
    pain: [6],
    changedTests: [],
    ...extra,
  };
}

const lines = (text: string) => text.split("\n");

describe("buildReferralSummary", () => {
  it("Roberto: la formula, le red flag della visita, le sedute e il dolore", () => {
    const text = buildReferralSummary(roberto());
    const [first, ...rest] = lines(text);
    expect(first).toBe(
      "Segnalo la comparsa di segni che richiedono una valutazione medica in Roberto Esposito, che seguo dal 14/10/2026 per Dolore dorsale e lombare, e chiedo una sua valutazione.",
    );
    expect(rest).toContain(
      "Nella visita del 14/10/2026 ho rilevato: Calo di peso non spiegato; Dolore costante e progressivo che non cambia con posizione e movimento.",
    );
    expect(rest).toContain("14/10/2026: regioni Dorsale, Lombare; tecniche Tessuti molli.");
    expect(rest).toContain("Dolore 0-10 a inizio seduta: 6.");
    expect(text).not.toContain("Diagnosi medica di riferimento");
    expect(text).not.toContain("Test variati");
    expect(text).not.toContain("Irradiazione");
    expect(text).not.toContain("Esame neurologico");
  });

  it("le frasi per motivo", () => {
    const phrases: Record<ReferralReason, string> = {
      red_flag: "la comparsa di segni che richiedono una valutazione medica",
      sintomi_persistenti: "sintomi che persistono oltre i tempi previsti",
      peggioramento: "un peggioramento dei sintomi",
      fuori_competenza: "un quadro che esce dalla mia competenza",
      richiesta_paziente: "la richiesta del paziente di un parere medico",
      altro: "un quadro che desidero condividere con lei",
    };
    for (const [reason, phrase] of Object.entries(phrases) as [ReferralReason, string][]) {
      const [first] = lines(buildReferralSummary(roberto({ reason })));
      expect(first).toBe(
        `Segnalo ${phrase} in Roberto Esposito, che seguo dal 14/10/2026 per Dolore dorsale e lombare, e chiedo una sua valutazione.`,
      );
    }
  });

  it("senza motivo della visita la formula non dice 'per', e un punto finale del motivo non si raddoppia", () => {
    expect(lines(buildReferralSummary(roberto({ chiefComplaint: null })))[0]).toBe(
      "Segnalo la comparsa di segni che richiedono una valutazione medica in Roberto Esposito, che seguo dal 14/10/2026, e chiedo una sua valutazione.",
    );
    expect(lines(buildReferralSummary(roberto({ chiefComplaint: "Dolore lombare." })))[0]).toContain(
      "per Dolore lombare, e chiedo",
    );
  });

  it("diagnosi medica con la fonte, sottovoci, irradiazione, esame neurologico e test variati", () => {
    const text = buildReferralSummary(
      roberto({
        diagnosis: { text: "Protrusione discale L4-L5", sourceLabel: "Referto allegato" },
        redFlags: [
          { label: "Sospetta frattura", subItems: ["Trauma importante", "Età avanzata"], visitDay: "2026-10-14" },
          { label: "Calo di peso non spiegato", subItems: [], visitDay: "2026-10-21" },
        ],
        radiation: { sites: ["gluteo", "coscia"], side: "dx" },
        neuro: ["Riflesso achilleo dx ridotto", "Forza L5 dx 4"],
        visits: [
          { day: "2026-10-14", regions: ["Lombare"], techniques: ["Tessuti molli", "Inibizione"] },
          { day: "2026-10-21", regions: [], techniques: [] },
        ],
        pain: [6, null],
        changedTests: [{ label: "Distanza dita-pavimento", change: "28 cm → 23 cm" }],
      }),
    );
    const rest = lines(text);
    expect(rest).toContain("Diagnosi medica di riferimento: Protrusione discale L4-L5 (referto allegato).");
    expect(rest).toContain("Nella visita del 14/10/2026 ho rilevato: Sospetta frattura (trauma importante, età avanzata).");
    expect(rest).toContain("Nella visita del 21/10/2026 ho rilevato: Calo di peso non spiegato.");
    expect(rest).toContain("Irradiazione: gluteo, coscia, lato dx.");
    expect(rest).toContain("Esame neurologico: Riflesso achilleo dx ridotto; Forza L5 dx 4.");
    expect(rest).toContain("Sedute del ciclo:");
    expect(rest).toContain("14/10/2026: regioni Lombare; tecniche Tessuti molli, Inibizione.");
    expect(rest).toContain("21/10/2026: nessuna tecnica registrata.");
    expect(rest).toContain("Dolore 0-10 a inizio seduta: 6, non rilevato.");
    expect(rest).toContain("Test variati: Distanza dita-pavimento 28 cm → 23 cm.");
  });

  it("una fonte assente non mette parentesi; irradiazione bilaterale o senza lato", () => {
    const text = buildReferralSummary(
      roberto({ diagnosis: { text: "Lombalgia", sourceLabel: "" }, radiation: { sites: ["coscia"], side: "bilaterale" } }),
    );
    expect(lines(text)).toContain("Diagnosi medica di riferimento: Lombalgia.");
    expect(lines(text)).toContain("Irradiazione: coscia, bilaterale.");
    expect(lines(buildReferralSummary(roberto({ radiation: { sites: ["mano"], side: "" } })))).toContain(
      "Irradiazione: mano.",
    );
  });

  it("senza dolori registrati non c'è la riga del dolore", () => {
    expect(buildReferralSummary(roberto({ pain: [null, null] }))).not.toContain("Dolore 0-10");
    expect(buildReferralSummary(roberto({ pain: [] }))).not.toContain("Dolore 0-10");
  });

  it("nessuna parola vietata dal glossario e nessun punto esclamativo", () => {
    const reasons: ReferralReason[] = ["red_flag", "sintomi_persistenti", "peggioramento", "fuori_competenza", "richiesta_paziente", "altro"];
    for (const reason of reasons) {
      const text = buildReferralSummary(roberto({ reason })).toLowerCase();
      expect(text).not.toContain("diagnosi osteopatica");
      expect(text).not.toContain("terapia");
      expect(text).not.toContain("!");
    }
    expect(DEFAULT_REQUEST_TEXT.toLowerCase()).not.toContain("terapia");
    expect(DEFAULT_REQUEST_TEXT).not.toContain("!");
  });

  it("oltre 3000 caratteri taglia le sedute più vecchie e tiene le più recenti", () => {
    const visits = Array.from({ length: 80 }, (_, i) => ({
      day: `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      regions: ["Cervicale", "Dorsale", "Lombare"],
      techniques: ["Tessuti molli", "Articolatoria", "Energia muscolare (MET)"],
    }));
    const text = buildReferralSummary(roberto({ visits, pain: visits.map(() => 5) }));
    expect(SUMMARY_MAX).toBe(3000);
    expect(text.length).toBeLessThanOrEqual(3000);
    const last = visits[visits.length - 1]!;
    expect(text).toContain(`${last.day.slice(8, 10)}/${last.day.slice(5, 7)}/2026: regioni`);
    expect(text).not.toContain("01/01/2026: regioni");
    expect(lines(text)).toContainEqual(expect.stringMatching(/^Ultime \d+ sedute del ciclo:$/));
    expect(lines(text)[0]).toMatch(/^Segnalo /);
  });
});

describe("buildReferralSummary, ultimo taglio", () => {
  it("con testi troppo lunghi anche senza sedute tronca a 3000 senza spazi né a capo finali", () => {
    // Ogni etichetta è una parola e 199 spazi: il taglio a 3000 cade dentro gli spazi.
    const redFlags = Array.from({ length: 40 }, (_, i) => ({
      label: `Voce${i}${" ".repeat(199)}`,
      subItems: [],
      visitDay: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`,
    }));
    const text = buildReferralSummary(roberto({ redFlags }));
    // Più corto di 3000: il taglio è caduto su spazi, e sono stati tolti.
    expect(text.length).toBeLessThan(3000);
    expect(text).toBe(text.trimEnd());
    expect(text).not.toContain("Sedute del ciclo");
  });
});

describe("DEFAULT_REQUEST_TEXT", () => {
  it("la richiesta predefinita", () => {
    expect(DEFAULT_REQUEST_TEXT).toBe(
      "Le chiedo di valutare il paziente e, se lo ritiene, di indicarmi se proseguire il trattamento osteopatico.",
    );
  });
});
