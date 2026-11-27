import { TREATMENT_CONSENT_REVOKED } from "@/lib/clinical/labels";
import { consentFitsAge, type ModuleKey, missingModules } from "@/lib/consents/required";
import { isMinor } from "@/lib/format";
import type { Tx } from "@/server/db/db";
import { loadValidConsents } from "@/server/domain/consents/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import type { VisitRow } from "./screening";

// Consenso al trattamento revocato -----------------------------------------------------

// La frase sta in `src/lib/clinical/labels.ts`: l'editor la mostra uguale.
export { TREATMENT_CONSENT_REVOKED };

/**
 * Il consenso al trattamento del ciclo della visita è revocato: il modulo per l'età alla data
 * della visita non ha una riga valida e l'ultima riga del gruppo trattamento è revocata o rifiutata.
 * Il consenso genitoriale vale anche dopo i 18 anni nello stesso ciclo aperto da minore.
 * Un modulo mai firmato è "mancante", un avviso che non blocca.
 */
export async function treatmentConsentRevoked(tx: Tx, practiceId: string, visit: VisitRow): Promise<boolean> {
  const [patient] = await tx.query<{ birthDate: string; openedOn: string }>(
    `select p.birth_date as "birthDate", c.opened_on as "openedOn"
       from public.patients p
       join public.treatment_cycles c on c.practice_id = p.practice_id and c.patient_id = p.id
      where p.practice_id = $1 and p.id = $2 and c.id = $3`,
    [practiceId, visit.patientId, visit.cycleId],
  );
  if (!patient) throw new DomainError(NOT_ALLOWED);
  // Un giorno prima della nascita conta come la nascita: l'età non è mai negativa.
  const day = visit.visitDate < patient.birthDate ? patient.birthDate : visit.visitDate;
  const minor = isMinor(patient.birthDate, day);
  const minorAtOpening = isMinor(patient.birthDate, patient.openedOn < patient.birthDate ? patient.birthDate : patient.openedOn);
  const moduleKey = minor ? "trattamento_minore" : "trattamento";
  const keys = ["trattamento", "trattamento_minore"];

  const valid = (await loadValidConsents(tx, practiceId, [visit.patientId])).get(visit.patientId);
  if (!missingModules(valid, visit.cycleId, minor, minorAtOpening).includes(moduleKey)) return false;
  const rows = await tx.query<{ status: string; outcome: string; moduleKey: ModuleKey; signedOn: string }>(
    `select status, outcome, module_key as "moduleKey", signed_on as "signedOn"
       from public.consent_records
      where practice_id = $1 and patient_id = $2 and cycle_id = $3 and module_key = any($4::text[])
        and status <> 'sostituito'
      order by signed_on desc, record_order desc`,
    [practiceId, visit.patientId, visit.cycleId, keys],
  );
  const last = rows.find((r) => consentFitsAge(r.moduleKey, patient.birthDate, r.signedOn));
  return last?.status === "revocato" || (last?.status === "valido" && last.outcome === "rifiuta");
}

export async function requireTreatmentConsent(tx: Tx, practiceId: string, visit: VisitRow): Promise<void> {
  if (await treatmentConsentRevoked(tx, practiceId, visit)) throw new DomainError(TREATMENT_CONSENT_REVOKED);
}

/**
 * Togliere una tecnica: con il consenso revocato no per una riga registrata o confermata, sì
 * per una riga copiata mai confermata, che non è un trattamento di oggi. Altrimenti la visita con copiati
 * presi prima della revoca non chiuderebbe più: `conferma` e `togli_tecnica` li rifiuterebbero entrambi.
 */
export async function requireConsentToRemoveTechnique(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  treatmentId: string,
): Promise<void> {
  const [row] = await tx.query<{ copied: boolean }>(
    "select copied from public.visit_treatments where practice_id = $1 and visit_id = $2 and id = $3",
    [practiceId, visit.id, treatmentId],
  );
  if (row?.copied) return;
  await requireTreatmentConsent(tx, practiceId, visit);
}
