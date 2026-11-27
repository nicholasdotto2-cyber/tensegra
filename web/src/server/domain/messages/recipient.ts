import { firstLast, isMinor } from "@/lib/format";
import { whatsappPhoneProblem, type LinkRecipient } from "@/lib/messages/links";
import type { Variant } from "@/lib/messages/templates";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { getChannelConsent } from "@/server/domain/consents/queries";
import { getPracticeSettings } from "@/server/domain/settings/queries";

export type MessageRecipient = LinkRecipient & {
  kind: "paziente" | "genitore" | "tutore";
  name: string;
  firstName: string;
  patientFirstName: string;
  addressing: Variant;
  preferredChannel: "whatsapp" | "telefono" | "nessuno";
  whatsappConsent: boolean;
  recallConsent: boolean;
  whatsappDisabledReason: string | null;
};

interface Person { firstName: string; lastName: string; phone: string | null }

/** Identità e permessi sono riletti sotto RLS, mai ricevuti dal browser. */
export async function getMessageRecipient(tx: Tx, practiceId: string, clock: Clock, patientId: string): Promise<MessageRecipient | null> {
  const [patient] = await tx.query<Person & { birthDate: string; addressing: Variant; preferredChannel: MessageRecipient["preferredChannel"] }>(
    `select first_name as "firstName", last_name as "lastName", birth_date as "birthDate",
            phone, addressing, preferred_channel as "preferredChannel"
       from public.patients where practice_id = $1 and id = $2`,
    [practiceId, patientId],
  );
  if (!patient) return null;
  const practice = await getPracticeSettings(tx, practiceId);
  if (!practice) return null;
  let kind: MessageRecipient["kind"] = "paziente";
  let person: Person = patient;
  if (isMinor(patient.birthDate, clock.today() < patient.birthDate ? patient.birthDate : clock.today())) {
    const [contact] = await tx.query<Person & { relationship: string }>(
      `select first_name as "firstName", last_name as "lastName", phone, relationship
         from public.patient_guardians
        where practice_id = $1 and patient_id = $2 and is_contact`,
      [practiceId, patientId],
    );
    kind = contact?.relationship === "tutore" ? "tutore" : "genitore";
    person = contact ?? { firstName: "", lastName: "", phone: null };
  }
  const whatsappConsent = await getChannelConsent(tx, practiceId, patientId, "whatsapp");
  const recallConsent = await getChannelConsent(tx, practiceId, patientId, "richiami");
  const whatsappDisabledReason = whatsappPhoneProblem(person.phone)
    ?? (patient.preferredChannel === "telefono" ? "Preferisce una telefonata"
      : patient.preferredChannel === "nessuno" ? "Nessun promemoria"
        : !whatsappConsent ? "Manca il consenso WhatsApp" : null);
  return {
    kind, name: firstLast(person).trim(), firstName: person.firstName, patientFirstName: patient.firstName,
    phone: person.phone, addressing: patient.addressing, preferredChannel: patient.preferredChannel,
    whatsappConsent, recallConsent, whatsappDisabledReason,
    isDemo: practice.isDemo, demoTestPhone: practice.demoTestPhone,
  };
}
