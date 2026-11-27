import { isMinor } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getRegistry } from "@/server/domain/patients/card";
import { saveGuardian, updatePatientGroup } from "@/server/domain/patients/commands";
import { RecipientFieldsInput, type RecipientInput } from "./schemas";

/** La proposta usa l'età alla seduta, senza salvare una bozza. */
export async function defaultInvoiceRecipient(
  tx: Tx, practiceId: string, patientId: string, serviceDate: string,
): Promise<RecipientInput> {
  const registry = await getRegistry(tx, practiceId, patientId);
  if (!registry) throw new DomainError(NOT_ALLOWED);
  const payer = registry.guardians.find((guardian) => guardian.isPayer);
  return isMinor(registry.personali.birthDate, serviceDate) && payer
    ? { kind: "tutore", patientId, guardianId: payer.id }
    : { kind: "paziente", patientId };
}

/** Rilegge e riscrive i gruppi tramite i comandi dell'anagrafica. */
export async function saveRecipientFiscalFields(
  tx: Tx, practiceId: string, clock: Clock, input: unknown,
): Promise<void> {
  const fields = RecipientFieldsInput.parse(input);
  const address = Object.fromEntries(Object.entries(fields.address ?? {}).filter(([, value]) => value !== undefined));
  const registry = await getRegistry(tx, practiceId, fields.patientId);
  if (!registry) throw new DomainError(NOT_ALLOWED);
  if (fields.kind === "tutore") {
    const guardian = registry.guardians.find((g) => g.id === fields.guardianId);
    if (!guardian) throw new DomainError(NOT_ALLOWED);
    const { id: guardianId, ...current } = guardian;
    await saveGuardian(tx, practiceId, clock, {
      ...current, patientId: fields.patientId, guardianId,
      ...(fields.taxCode === undefined ? {} : { taxCode: fields.taxCode }), ...address,
    });
    return;
  }
  if (fields.taxCode !== undefined) {
    await updatePatientGroup(tx, practiceId, clock, {
      ...registry.personali, group: "personali", patientId: fields.patientId, taxCode: fields.taxCode,
    });
  }
  if (Object.keys(address).length > 0) {
    await updatePatientGroup(tx, practiceId, clock, {
      ...registry.indirizzo, ...address, group: "indirizzo", patientId: fields.patientId,
    });
  }
}
