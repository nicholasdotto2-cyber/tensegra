import { describe, expect, it } from "vitest";
import { telHref, whatsappHref, type LinkRecipient } from "@/lib/messages/links";

const recipient: LinkRecipient = { phone: "+393330000077", isDemo: true, demoTestPhone: null };
describe("link messaggi", () => {
  it("link_demo_senza_numero_test", () => {
    expect(whatsappHref(recipient, "Ciao Chiara")).toBe("https://wa.me/?text=Ciao%20Chiara");
    expect(telHref(recipient)).toBeNull();
  });
  it("link_demo_con_numero_test_mai_seed", () => {
    const demo = { ...recipient, demoTestPhone: "+393330000099" };
    expect(whatsappHref(demo, "Ciao Chiara")).toBe("https://wa.me/393330000099?text=Ciao%20Chiara");
    expect(telHref(demo)).toBe("tel:+393330000099");
    expect(whatsappHref(demo, "")).not.toContain("393330000077");
  });
  it("fuori_demo_codifica_una_volta_e_preserva_fisso", () => {
    const real = { ...recipient, isDemo: false, demoTestPhone: "+393330000099" };
    expect(whatsappHref(real, "Caffè {nome} & 20%")).toBe("https://wa.me/393330000077?text=Caff%C3%A8%20%7Bnome%7D%20%26%2020%25");
    expect(telHref({ ...real, phone: "+39 051 000 0000" })).toBe("tel:+390510000000");
    expect(whatsappHref({ ...real, phone: "+442079460000" }, "")).toBe("https://wa.me/442079460000?text=");
  });
  it("senza_numero_non_elude_il_blocco_e_demo_invalida_non_usa_seed", () => {
    expect(() => whatsappHref({ ...recipient, phone: null }, "Ciao")).toThrow("Numero mancante");
    expect(() => whatsappHref({ ...recipient, isDemo: false, phone: "errato" }, "Ciao")).toThrow("Numero mancante");
    expect(() => whatsappHref({ ...recipient, phone: "+390510000000", demoTestPhone: "+393330000099" }, "Ciao")).toThrow("Numero fisso: WhatsApp non disponibile");
    expect(telHref({ ...recipient, isDemo: false, phone: null })).toBeNull();
    expect(telHref({ ...recipient, phone: null, demoTestPhone: "+393330000099" })).toBeNull();
    expect(whatsappHref({ ...recipient, demoTestPhone: "errato" }, "Ciao")).toBe("https://wa.me/?text=Ciao");
    expect(telHref({ ...recipient, demoTestPhone: "errato" })).toBeNull();
  });
});
