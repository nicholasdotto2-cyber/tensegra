import { describe, expect, it } from "vitest";
import { photoAltTexts, VIEW_CODES } from "@/lib/files/photo-views";
import type { PhotoRow } from "@/server/domain/attachments/queries";

// Il testo alternativo delle miniature: una foto sola dice vista e data; due della stessa vista nello
// stesso giorno si distinguono con «, foto N».

function photo(id: string, view: string, viewLabel: string, dateText: string): PhotoRow {
  return { id, fileId: id, view, viewLabel, takenOn: "2026-11-04", dateText, caption: null, widthPx: null, heightPx: null };
}

describe("photoAltTexts", () => {
  it("dice vista e giorno, e distingue le foto della stessa vista nello stesso giorno", () => {
    const texts = photoAltTexts([
      photo("a", "posteriore", "Posteriore", "mer 4 nov"),
      photo("b", "posteriore", "Posteriore", "mer 4 nov"),
      photo("c", "anteriore", "Anteriore", "mer 4 nov"),
      photo("d", "posteriore", "Posteriore", "lun 2 nov"),
    ]);
    expect(texts.get("a")).toBe("Foto posteriore del mer 4 nov, foto 1");
    expect(texts.get("b")).toBe("Foto posteriore del mer 4 nov, foto 2");
    expect(texts.get("c")).toBe("Foto anteriore del mer 4 nov");
    expect(texts.get("d")).toBe("Foto posteriore del lun 2 nov");
  });

  it("senza foto non ha testi", () => {
    expect(photoAltTexts([]).size).toBe(0);
  });
});

describe("VIEW_CODES", () => {
  it("elenca le cinque viste nell'ordine delle etichette", () => {
    expect(VIEW_CODES).toEqual(["anteriore", "posteriore", "laterale_dx", "laterale_sx", "altro"]);
  });
});
