import { toE164 } from "@/lib/phone";

export type LinkRecipient = { phone: string | null; isDemo: boolean; demoTestPhone: string | null };

/** Numero effettivo del link: la demo non ricade mai sul telefono del paziente. */
function routedPhone(recipient: LinkRecipient): string | null {
  const phone = recipient.isDemo ? recipient.demoTestPhone : recipient.phone;
  return phone ? toE164(phone) : null;
}

/** Controllo del numero originale, prima di qualsiasi sostituzione demo. */
export function whatsappPhoneProblem(phone: string | null): string | null {
  const normalized = phone ? toE164(phone) : null;
  if (!normalized) return "Numero mancante";
  if (normalized.startsWith("+390")) return "Numero fisso: WhatsApp non disponibile";
  return null;
}

/** Il chiamante verifica anche preferenza e consensi con getMessageRecipient. */
export function whatsappHref(destinatario: LinkRecipient, testo: string): string {
  const problem = whatsappPhoneProblem(destinatario.phone);
  if (problem) throw new RangeError(problem);
  const phone = routedPhone(destinatario);
  if (!phone && !destinatario.isDemo) throw new RangeError("Numero mancante");
  return `https://wa.me/${phone?.slice(1) ?? ""}?text=${encodeURIComponent(testo)}`;
}

/** Stessa regola della demo; senza un numero del destinatario non c'è niente da sostituire. */
export function telHref(destinatario: LinkRecipient): string | null {
  if (!destinatario.phone || !toE164(destinatario.phone)) return null;
  const phone = routedPhone(destinatario);
  return phone ? `tel:${phone}` : null;
}
