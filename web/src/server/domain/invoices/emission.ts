import { lateIssueWarning, PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import { toFatturaModel } from "@/lib/fiscal/model";
import { numberLabel, progressive, xmlFileName } from "@/lib/fiscal/numbering";
import { emissionProblems, XML_MISSING_TAX_CODE } from "@/lib/fiscal/problems";
import { buildSnapshot, type InvoiceSnapshot, type SnapshotInput } from "@/lib/fiscal/snapshot";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getRegistry } from "@/server/domain/patients/card";
import { getFiscalSettings, getPracticeSettings } from "@/server/domain/settings/queries";
import { buildXml, xmlSha256 } from "@/server/fatturapa/build-xml";
import { loadDraft, loadRecipient } from "./queries";
import { provisionalSnapshotInput } from "./provisional-snapshot";

export const ALREADY_ISSUED = "La fattura è già emessa.";
export const ISSUED_BACKWARDS = "Un'altra fattura della serie risulta emessa dopo quest'ora: controlla data e ora del computer.";
export const DATE_BACKWARDS_WARNING = "La data della fattura viene prima di quella dell'ultima fattura emessa.";
export const NUMBERING_MISMATCH = "La numerazione delle fatture non torna con il contatore: non emetto. Controlla le fatture dell'anno.";

export interface IssuedInvoice {
  id: string;
  numberLabel: string;
  status: "emessa" | "pagata";
  hasXml: boolean;
  warnings: string[];
}

/** Il chiamante possiede la transazione: ogni errore deve risalire fino al suo rollback. */
export async function emitDraft(
  tx: Tx, practiceId: string, clock: Clock, invoiceId: string,
  credited: { numberLabel: string; issueDate: string } | null,
): Promise<IssuedInvoice> {
  const draft = await loadDraft(tx, practiceId, invoiceId);
  if (draft.status !== "bozza") throw new DomainError(ALREADY_ISSUED);
  const now = clock.now();
  const today = clock.today();
  const fiscal = await getFiscalSettings(tx, practiceId);
  const practice = await getPracticeSettings(tx, practiceId);
  if (!practice) throw new DomainError(NOT_ALLOWED);

  let input: SnapshotInput;
  let withholdingAgent = draft.withholdingAgent;
  if (draft.docType === "TD04") {
    // Lo storno conserva il calcolo originale anche se il regime è cambiato.
    const [original] = await tx.query<{ snapshot: InvoiceSnapshot }>(
      `select i.snapshot from public.invoices d
         join public.invoices i on i.practice_id = d.practice_id and i.id = d.credited_invoice_id
        where d.practice_id = $1 and d.id = $2 and i.status <> 'bozza'`, [practiceId, invoiceId],
    );
    if (!original?.snapshot || !credited) throw new DomainError(NOT_ALLOWED);
    const s = original.snapshot;
    input = { ...s, docType: "TD04", numberLabel: "", issueDate: today, credited, transmission: null,
      lines: s.lines.filter((line) => line.kind === "prestazione"),
      payment: { ...s.payment, paidOn: null, dueDate: null }, paperStampAuthorization: fiscal.paperStampAuthorization };
  } else {
    if (draft.paidOn !== null && draft.paidOn > today) throw new DomainError(PAID_IN_FUTURE);
    const recipient = await loadRecipient(tx, practiceId,
      draft.recipientKind === "committente" ? { kind: "committente", billingPartyId: draft.billingPartyId! }
        : draft.recipientKind === "tutore" ? { kind: "tutore", patientId: draft.patientId!, guardianId: draft.guardianId! }
          : { kind: "paziente", patientId: draft.patientId! });
    withholdingAgent = recipient.withholdingAgent;
    const lines = draft.lines.filter((line) => line.lineKind === "prestazione").map((line) => ({
      serviceId: line.serviceId, appointmentId: line.appointmentId, description: line.description,
      serviceDate: line.serviceDate, quantity: line.quantity, unitPriceCents: line.unitPriceCents,
    }));
    input = provisionalSnapshotInput({
      practice, fiscal, recipient, lines, today, docType: draft.docType, credited,
      payment: { method: draft.paymentMethod, paidOn: draft.paidOn }, stampMarkCode: draft.stampMarkCode,
    });
    const minor = recipient.kind === "tutore" ? await getRegistry(tx, practiceId, recipient.patientId!) : null;
    input.recipient.minorName = minor ? `${minor.personali.firstName} ${minor.personali.lastName}` : null;
  }
  // Il modello provvisorio esegue anche i controlli SdI prima di consumare qualsiasi numero.
  const provisional = buildSnapshot(input);
  const [problem] = emissionProblems(provisional);
  if (problem) {
    const missingTaxCode = provisional.electronic && problem.field === "recipient.taxCode"
      && !provisional.recipient.taxCode?.trim() && !provisional.recipient.vatNumber?.trim();
    throw new DomainError(missingTaxCode ? XML_MISSING_TAX_CODE : problem.message, { field: problem.field });
  }
  const year = Number(input.issueDate.slice(0, 4));
  const warnings: string[] = [];
  const late = provisional.electronic ? lateIssueWarning(input.payment.paidOn, today) : null;
  if (late) warnings.push(late);
  const checkOrder = async () => {
    const [last] = await tx.query<{ issuedAt: Date; issueDate: string }>(
      `select issued_at as "issuedAt", issue_date as "issueDate" from public.invoices
        where practice_id = $1 and doc_type = $2 and year = $3 and status <> 'bozza'
        order by number desc limit 1`, [practiceId, draft.docType, year],
    );
    if (last && now < last.issuedAt) throw new DomainError(ISSUED_BACKWARDS);
    return last && input.issueDate < last.issueDate;
  };
  await checkOrder();
  const [allocated] = await tx.query<{ n: number }>("select app.next_number($1,$2,$3) as n", [practiceId, draft.docType, year]);
  const [series] = await tx.query<{ lastNumber: number; conflict: boolean }>(
    `select last_number as "lastNumber",
            exists (select 1 from public.invoices where practice_id = $1 and doc_type = $2
                     and year = $3 and status <> 'bozza' and number >= $4) as conflict
       from public.number_series where practice_id = $1 and series = $2 and year = $3`,
    [practiceId, draft.docType, year, allocated?.n ?? null],
  );
  if (!allocated || !series || series.lastNumber !== allocated.n || series.conflict) throw new DomainError(NUMBERING_MISMATCH);
  // next_number serializza anche emissioni di bozze diverse nella medesima serie.
  if (await checkOrder()) warnings.push(DATE_BACKWARDS_WARNING);
  const label = numberLabel(draft.docType, allocated.n, year);
  let transmission: InvoiceSnapshot["transmission"] = null;
  if (provisional.electronic) {
    const [sent] = await tx.query<{ n: number }>("select app.next_number($1,'INVIO',0) as n", [practiceId]);
    if (!sent) throw new DomainError(NUMBERING_MISMATCH);
    const id = progressive(sent.n);
    transmission = { progressive: id, fileName: xmlFileName(input.supplier.taxCode, id) };
  }
  const snapshot = buildSnapshot({ ...input, numberLabel: label, transmission });
  const xml = snapshot.electronic ? buildXml(toFatturaModel(snapshot)) : null;
  const c = snapshot.computation;
  if (draft.docType === "TD01") {
    // Le righe devono essere aggiornate mentre la testata è ancora una bozza.
    await tx.query("delete from public.invoice_lines where practice_id = $1 and invoice_id = $2 and line_kind = 'rimborso_bollo'", [practiceId, invoiceId]);
    for (const line of snapshot.lines) {
      if (line.kind === "prestazione") {
        const source = draft.lines.filter((l) => l.lineKind === "prestazione")[line.lineNumber - 1]!;
        await tx.query(`update public.invoice_lines set line_number = $4, vat_rate_bp = $5, nature = $6, subject_to_withholding = $7
          where practice_id = $1 and invoice_id = $2 and id = $3`,
        [practiceId, invoiceId, source.id, line.lineNumber, line.vatRateBp, line.nature, line.subjectToWithholding]);
      } else {
        await tx.query(`insert into public.invoice_lines (practice_id, invoice_id, line_number, line_kind,
          description, quantity, unit_price_cents, line_total_cents, vat_rate_bp, nature, subject_to_withholding)
          values ($1,$2,$3,'rimborso_bollo',$4,1,$5,$5,$6,$7,$8)`,
        [practiceId, invoiceId, line.lineNumber, line.description, line.unitPriceCents, line.vatRateBp, line.nature, line.subjectToWithholding]);
      }
    }
  }
  const status = draft.docType === "TD01" && draft.paidOn !== null ? "pagata" : "emessa";
  const saved = await tx.query(`update public.invoices set status = $3, year = $4, number = $5, number_label = $6,
      issue_date = $7, issued_at = $8, paid_at = $9, regime = $10, withholding_agent = $11,
      surcharge_applied = $12, withholding_applied = $13, stamp_due = $14, stamp_charged = $15,
      fees_cents = $16, surcharge_cents = $17, taxable_cents = $18, vat_cents = $19, stamp_charged_cents = $20,
      total_cents = $21, withholding_cents = $22, net_cents = $23, due_date = $24,
      transmission_id = $25, xml_file_name = $26, snapshot = $27, xml = $28, xml_sha256 = $29
    where practice_id = $1 and id = $2 and status = 'bozza' returning id`,
  [practiceId, invoiceId, status, year, allocated.n, label, snapshot.issueDate, now, status === "pagata" ? now : null,
    snapshot.regime, withholdingAgent,
    c.surchargeApplied, c.withholdingApplied, c.stampDue, c.stampCharged, c.feesCents, c.surchargeCents, c.taxableCents,
    c.vatCents, c.stampChargedCents, c.totalCents, c.withholdingCents, c.netCents, snapshot.payment.dueDate,
    transmission?.progressive ?? null, transmission?.fileName ?? null, JSON.stringify(snapshot), xml, xml === null ? null : xmlSha256(xml)]);
  if (saved.length !== 1) throw new DomainError(NOT_ALLOWED);
  for (const event of status === "pagata" ? ["emessa", "pagamento_registrato"] : ["emessa"]) {
    await tx.query("insert into public.invoice_events (practice_id, invoice_id, event_type, at) values ($1,$2,$3,$4)", [practiceId, invoiceId, event, now]);
  }
  return { id: invoiceId, numberLabel: label, status, hasXml: xml !== null, warnings };
}
