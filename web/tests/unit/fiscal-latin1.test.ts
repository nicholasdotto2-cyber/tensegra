import { describe, expect, it } from "vitest";
import { latin1Message, latin1Offender, toLatin1 } from "@/lib/fiscal/latin1";

describe("Conversione dei caratteri per la fattura elettronica", () => {
  it.each([
    ["D’Amico", "D'Amico"],
    ["“Studio”", '"Studio"'],
    ["55 €", "55 EUR"],
    ["Cervicale – dorsale", "Cervicale - dorsale"],
    ["a\u2014b", "a-b"],
    ["Attendere…", "Attendere..."],
    ["a\u00a0b\u202fc", "a b c"],
    ["Città", "Città"],
    ["Lasègue", "Lasègue"],
    ["«nota»", "«nota»"],
    ["\u2018\u2019\u201a\u201b\u2032", "'''''"],
    ["\u201c\u201d\u201e\u2033", '""""'],
    ["\u2010\u2011\u2012\u2013\u2014\u2015\u2212", "-------"],
    ["\u00a0\u2007\u2009\u202f", "    "],
  ])("converte %j in %j", (text, expected) => {
    expect(toLatin1(text)).toBe(expected);
  });

  it.each([
    ["Nguyễn", "ễ"],
    ["Žanna", "Ž"],
  ])("segnala il primo carattere fuori da Latin-1 in %s", (text, offender) => {
    expect(latin1Offender(text)).toBe(offender);
  });

  it("la conversione dell'apostrofo produce testo accettato", () => {
    expect(latin1Offender(toLatin1("D’Amico"))).toBeNull();
  });

  it.each([
    ["anagrafica", "in anagrafica"],
    ["fattura", "nella fattura"],
    ["impostazioni", "in Impostazioni"],
  ] as const)("il messaggio indica dove correggere: %s", (where, location) => {
    expect(latin1Message("Il cognome del paziente", where)).toBe(
      `Il cognome del paziente contiene una lettera che la fattura elettronica non accetta: correggila ${location}`,
    );
  });
});
