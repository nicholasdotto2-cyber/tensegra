import { describe, expect, it } from "vitest";
import { taxCodeCheckChar, taxCodeProblem } from "@/lib/patients/tax-code";
import { taxCode } from "../../seed/codes";

// Codice fiscale: 16 caratteri, carattere di controllo del DM 12/03/1974 e
// omocodie (posizioni 7, 8, 10, 11, 13, 14, 15 con le lettere LMNPQRSTUV al posto delle cifre 0-9).
// I valori attesi sono calcolati a mano con le tabelle del DM, non con la funzione provata.
//
// Tabella dei caratteri dispari (posizioni 1, 3, ... 15): 0/A 1, 1/B 0, 2/C 5, 3/D 7, 4/E 9, 5/F 13,
// 6/G 15, 7/H 17, 8/I 19, 9/J 21, K 2, L 4, M 18, N 20, O 11, P 3, Q 6, R 8, S 12, T 14, U 16, V 10,
// W 22, X 25, Y 24, Z 23. Tabella dei pari: cifre 0-9 il loro valore, lettere A 0 ... Z 25.
// Il carattere di controllo è la lettera di posizione (somma mod 26), con A = 0.

const INVALID_TAX_CODE = "Il codice fiscale non è valido: controlla lettere e cifre.";

describe("taxCodeCheckChar", () => {
  it("omocodia: RSSMRA80A01H50M dà M", () => {
    // R S S M R A 8 0 A 0 1 H 5 0 M
    // dispari: R 8, S 12, R 8, 8 19, A 1, 1 0, 5 13, M 18 = 79
    // pari:    S 18, M 12, A 0, 0 0, 0 0, H 7, 0 0     = 37
    // 79 + 37 = 116; 116 mod 26 = 12 = M
    expect(taxCodeCheckChar("RSSMRA80A01H50M")).toBe("M");
  });

  it("Bellandi Marco del seed: BLLMRC79C09X999 dà H, lo stesso carattere di seed/codes.ts", () => {
    // B L L M R C 7 9 C 0 9 X 9 9 9
    // dispari: B 0, L 4, R 8, 7 17, C 5, 9 21, 9 21, 9 21 = 97
    // pari:    L 11, M 12, C 2, 9 9, 0 0, X 23, 9 9       = 66
    // 97 + 66 = 163; 163 mod 26 = 7 = H
    expect(taxCodeCheckChar("BLLMRC79C09X999")).toBe("H");
    const seed = taxCode({ lastName: "Bellandi", firstName: "Marco", birthDate: "1979-03-09", sex: "m", comune: "X999" });
    expect(seed).toBe(`BLLMRC79C09X999${taxCodeCheckChar("BLLMRC79C09X999")}`);
  });

  it("rifiuta un testo che non è di 15 lettere maiuscole o cifre", () => {
    expect(() => taxCodeCheckChar("RSSMRA80A01H50")).toThrow(RangeError);
    expect(() => taxCodeCheckChar("rssmra80a01h501")).toThrow(RangeError);
  });
});

describe("taxCodeProblem", () => {
  it("un codice valido non ha problemi", () => {
    // R S S M R A 8 0 A 0 1 H 5 0 1
    // dispari: R 8, S 12, R 8, 8 19, A 1, 1 0, 5 13, 1 0 = 61
    // pari:    S 18, M 12, A 0, 0 0, 0 0, H 7, 0 0     = 37
    // 61 + 37 = 98; 98 mod 26 = 20 = U
    expect(taxCodeProblem("RSSMRA80A01H501U")).toBeNull();
  });

  it("un carattere di controllo sbagliato", () => {
    expect(taxCodeProblem("RSSMRA80A01H501A")).toBe(INVALID_TAX_CODE);
  });

  it("un codice corto", () => {
    expect(taxCodeProblem("RSSMRA80A01H50")).toBe(INVALID_TAX_CODE);
  });

  it("omocodia: la cifra 1 in posizione 15 scritta M, con il controllo M", () => {
    expect(taxCodeProblem("RSSMRA80A01H50MM")).toBeNull();
  });

  it("una lettera di omocodia fuori da LMNPQRSTUV, o una cifra dove va una lettera", () => {
    // A in posizione 15 al posto della cifra 1: con A (dispari 1) la somma è 61 - 0 + 1 + 37 = 99,
    // 99 mod 26 = 21 = V, quindi il controllo torna; A però non è una lettera di omocodia.
    expect(taxCodeProblem("RSSMRA80A01H50AV")).toBe(INVALID_TAX_CODE);
    expect(taxCodeProblem("RSSMR180A01H501U")).toBe(INVALID_TAX_CODE);
  });

  it("un mese che non è una delle 12 lettere", () => {
    // R S S M R A 8 0 F 0 1 X 9 9 9, con il comune inventato X999 come nel seed
    // dispari: R 8, S 12, R 8, 8 19, F 13, 1 0, 9 21, 9 21 = 102
    // pari:    S 18, M 12, A 0, 0 0, 0 0, X 23, 9 9      = 62
    // 102 + 62 = 164; 164 mod 26 = 8 = I, quindi il controllo torna; F però non è una lettera dei mesi
    // (ABCDEHLMPRST).
    expect(taxCodeProblem("RSSMRA80F01X999I")).toBe(INVALID_TAX_CODE);
  });

  it("minuscole e spazi non passano: il modulo li toglie prima", () => {
    expect(taxCodeProblem("rssmra80a01h501u")).toBe(INVALID_TAX_CODE);
    expect(taxCodeProblem(" RSSMRA80A01H501U")).toBe(INVALID_TAX_CODE);
  });
});
