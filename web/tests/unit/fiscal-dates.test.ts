import { describe, expect, it } from "vitest";
import {
  addDays, daysBetween, easterSunday, isItalianHoliday, isoWeekday, monthOf, quarterOf,
} from "@/lib/fiscal/calendar";
import {
  documentDate, dueDate, LATE_ISSUE, lateIssueWarning, PAID_IN_FUTURE,
} from "@/lib/fiscal/issue-date";
import {
  downloadXmlName, numberLabel, pdfFileName, progressive, xmlFileName,
} from "@/lib/fiscal/numbering";

describe("Numeri e nomi dei documenti", () => {
  it("distingue fatture e note di credito", () => {
    expect(numberLabel("TD01", 14, 2026)).toBe("14/2026");
    expect(numberLabel("TD04", 1, 2026)).toBe("NC-1/2026");
  });

  it.each([
    [1, "00001"], [35, "0000Z"], [36, "00010"], [280, "0007S"],
    [60466175, "ZZZZZ"],
  ])("progressivo %i in base 36: %s", (n, expected) => {
    expect(progressive(n)).toBe(expected);
  });

  it("rifiuta un progressivo che supera cinque caratteri", () => {
    expect(() => progressive(60466176)).toThrow(RangeError);
  });

  it("compone il nome XML e aggiunge PROVA_ solo al download demo", () => {
    const fileName = xmlFileName("SMPCHR85M41X999B", "00002");
    expect(fileName).toBe("ITSMPCHR85M41X999B_00002.xml");
    expect(downloadXmlName(fileName, true)).toBe("PROVA_ITSMPCHR85M41X999B_00002.xml");
    expect(downloadXmlName(fileName, false)).toBe(fileName);
  });

  it("compone il nome PDF senza barre", () => {
    expect(pdfFileName("TD01", "2/2026")).toBe("Fattura_2-2026.pdf");
    expect(pdfFileName("TD04", "NC-1/2026")).toBe("NotaCredito_NC-1-2026.pdf");
  });
});

describe("Data del documento e del pagamento", () => {
  it("usa l'incasso di tre giorni prima per la fattura elettronica", () => {
    expect(documentDate({ paidOn: "2026-10-09", today: "2026-10-12", electronic: true }))
      .toBe("2026-10-09");
  });

  it("usa oggi per la fattura senza XML anche se già incassata", () => {
    expect(documentDate({ paidOn: "2026-10-09", today: "2026-10-12", electronic: false }))
      .toBe("2026-10-12");
  });

  it.each([true, false])("usa oggi senza incasso, electronic %s", (electronic) => {
    expect(documentDate({ paidOn: null, today: "2026-10-12", electronic })).toBe("2026-10-12");
  });

  it.each([true, false])("rifiuta l'incasso di domani, electronic %s", (electronic) => {
    expect(PAID_IN_FUTURE).toBe("La data dell'incasso non può essere nel futuro.");
    expect(() => documentDate({ paidOn: "2026-10-13", today: "2026-10-12", electronic }))
      .toThrow(new RangeError(PAID_IN_FUTURE));
  });

  it("mantiene la data dell'incasso dell'anno precedente", () => {
    expect(documentDate({ paidOn: "2026-12-30", today: "2027-01-02", electronic: true }))
      .toBe("2026-12-30");
  });

  it("avvisa solo oltre dodici giorni dall'incasso", () => {
    expect(LATE_ISSUE).toBe("Fattura emessa oltre 12 giorni dopo l'incasso");
    expect(lateIssueWarning("2026-10-01", "2026-10-13")).toBeNull();
    expect(lateIssueWarning("2026-10-01", "2026-10-14")).toBe(LATE_ISSUE);
    expect(lateIssueWarning(null, "2026-10-14")).toBeNull();
  });

  it("calcola la scadenza del pagamento dalla data della fattura", () => {
    expect(dueDate("2026-10-12", 15)).toBe("2026-10-27");
    expect(dueDate("2026-12-30", 15)).toBe("2027-01-14");
  });

  it.each([
    ["2026-12-30", "2027-01-11", "2027-01-12"],
    ["2028-02-28", "2028-03-11", "2028-03-12"],
  ])("avvisa oltre dodici giorni anche passando da %s", (paidOn, twelfthDay, thirteenthDay) => {
    expect(lateIssueWarning(paidOn, twelfthDay)).toBeNull();
    expect(lateIssueWarning(paidOn, thirteenthDay)).toBe(LATE_ISSUE);
  });
});

describe("Calendario fiscale", () => {
  it.each([
    ["2026-02-28", "2026-03-01"], ["2028-02-28", "2028-02-29"],
    ["2026-12-31", "2027-01-01"],
  ])("aggiunge un giorno a %s: %s", (day, expected) => {
    expect(addDays(day, 1)).toBe(expected);
  });

  it("conta i giorni di calendario", () => {
    expect(daysBetween("2026-01-01", "2026-08-04")).toBe(215);
  });

  it("espone giorno ISO, trimestre e mese", () => {
    expect(isoWeekday("2026-10-12")).toBe(1);
    expect(isoWeekday("2026-10-18")).toBe(7);
    expect(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"].map(quarterOf))
      .toEqual([1, 2, 3, 4]);
    expect(monthOf("2026-10-12")).toBe("2026-10");
  });

  it.each([[2026, "2026-04-05"], [2027, "2027-03-28"]])(
    "calcola la Pasqua gregoriana del %i: %s", (year, expected) => {
      expect(easterSunday(year)).toBe(expected);
    },
  );

  it.each([
    "2026-01-01", "2026-01-06", "2026-04-06", "2026-04-25", "2026-05-01",
    "2026-06-02", "2026-08-15", "2026-11-01", "2026-12-08", "2026-12-25", "2026-12-26",
    "2027-03-29",
  ])("riconosce la festività nazionale %s", (day) => {
    expect(isItalianHoliday(day)).toBe(true);
  });

  it("il martedì dopo Pasqua non è festivo", () => {
    expect(isItalianHoliday("2027-03-30")).toBe(false);
  });
});
