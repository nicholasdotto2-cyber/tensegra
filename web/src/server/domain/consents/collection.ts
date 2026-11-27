import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { z } from "zod";
import { NO_GUARDIAN } from "@/lib/consents/messages";
import { firstLast, isMinor } from "@/lib/format";
import { getRegistry } from "@/server/domain/patients/card";
import { getConsentPreview, type ConsentPreview } from "./preview";
import { consentTarget, loadConsentGuardians } from "./queries";
import { ConsentTargetSchema, type ConsentTarget } from "./schemas";

export type ConsentCollection = {
  target: ConsentTarget;
  preview: ConsentPreview | null;
  guardians: { id: string; name: string }[];
  problem: string | null;
};

/** Risolve la raccolta all'età della firma, senza cambiare paziente, ciclo o appuntamento autorizzati. */
export async function getConsentCollection(tx: Tx, practiceId: string, clock: Clock, input: ConsentTarget, signedOn?: string, guardianId?: string): Promise<ConsentCollection | null> {
  const original = ConsentTargetSchema.parse(input);
  const day = signedOn === undefined ? clock.today() : z.iso.date().parse(signedOn);
  const patient = await getRegistry(tx, practiceId, original.patientId);
  if (!patient) return null;
  if (original.cycleId !== null) {
    const [cycle] = await tx.query("select id from public.treatment_cycles where practice_id=$1 and id=$2 and patient_id=$3 and status='open'", [practiceId, original.cycleId, original.patientId]);
    if (!cycle) return null;
  }
  if (original.appointmentId !== null) {
    const [appointment] = await tx.query<{ cycleId: string }>('select cycle_id as "cycleId" from public.appointments where practice_id=$1 and id=$2 and patient_id=$3', [practiceId, original.appointmentId, original.patientId]);
    if (!appointment || (original.cycleId !== null && appointment.cycleId !== original.cycleId)) return null;
  }
  const eligible = patient.guardians.filter(g => g.relationship === "tutore" || (["madre", "padre"].includes(g.relationship) && g.hasParentalAuthority));
  if (guardianId !== undefined && !eligible.some(g => g.id === guardianId)) return null;
  const defaultId = (await loadConsentGuardians(tx, practiceId, [original.patientId])).get(original.patientId) ?? null;
  const signer = guardianId ?? (eligible.some(g => g.id === original.guardianId) ? original.guardianId : defaultId);
  const birthDate = patient.personali.birthDate;
  const minor = isMinor(birthDate, day < birthDate ? birthDate : day);
  const target = consentTarget({ id: original.patientId, birthDate }, day, signer,
    original.moduleKey === "informativa" ? { kind: "informativa" } : { kind: "trattamento", cycleId: original.cycleId }, original.appointmentId);
  const guardians = minor ? eligible.map(g => ({ id: g.id, name: firstLast(g) })) : [];
  // Stesso ordine del default: il contatto selezionato si mostra per primo.
  guardians.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  if (minor && signer === null) return { target, preview: null, guardians, problem: NO_GUARDIAN };
  const preview = await getConsentPreview(tx, practiceId, clock, target, day);
  return preview === null ? null : { target, preview, guardians, problem: null };
}
