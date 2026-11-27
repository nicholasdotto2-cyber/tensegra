import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import type { StoredFileInput } from "@/server/domain/attachments/commands";
import { attachConsentDocument, signConsent, uploadConsent } from "@/server/domain/consents/commands";
import { type ConsentPreview, LABELS } from "@/server/domain/consents/preview";
import { type ConsentDocumentSource, type ConsentSourceFile, getConsentDocumentSource } from "@/server/domain/consents/queries";
import { ConsentFieldsSchema } from "@/server/domain/consents/schemas";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { checkConsentUpload, checkSignaturePng, readVerified } from "@/server/files/consents";
import { extensionFor, storageKey, type StoredMime } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import type { FileStore } from "@/server/files/store";
import type { StoreContext } from "@/server/files/upload";
import type { ConsentDocumentData } from "./consent";
import { renderConsentPdf } from "./render";

// I file dei consensi. Come `storePhoto` e `ensureReferralPdf`
// questi orchestratori aprono le loro transazioni: ricevono `db`, mai `tx`, e non si chiamano dentro
// un'altra `asUser`.
// - Firma: i PNG vanno prima nello store; la transazione 1 (`signConsent`) salva firma, testo e scelte; il
//   PDF si genera fuori e la transazione 2 (`attachConsentDocument`) lo collega. Se la transazione 1
//   fallisce i PNG nuovi si tolgono; se fallisce solo il PDF la firma resta e `pdfReady` è false.
// - Caricamento: il file va nello store così com'è, poi `uploadConsent`.
// - Documento: un consenso firmato senza PDF lo genera alla prima richiesta dalla fotografia
//   (testo, firme e istante salvati alla firma, non quelli del momento); poi si serve sempre lo stesso file.
//   Un file collegato che manca o il cui hash non torna è null (404), senza rigenerarlo.
// `deps.renderPdf ?? renderConsentPdf` è l'unico punto di rendering.

// La frase per l'osteopata quando la firma è salvata ma il PDF no sta in `@/lib/consents/messages`
// (`PDF_NOT_CREATED`): la mostra il client, che non deve importare react-pdf.

/** L'etichetta italiana di un dato mancante; un segnaposto senza etichetta non finisce grezzo nel PDF. */
function missingLabel(key: string): string {
  const label = LABELS[key];
  if (label === undefined) throw new Error(`Dato mancante senza etichetta: ${key}`);
  return label;
}

type RenderPdf = (data: ConsentDocumentData) => Promise<Buffer>;

export type ConsentDocumentFile = { bytes: Uint8Array; mimeType: StoredMime; fileName: string };

const consentIdSchema = z.uuid();

/** Il nome scaricato: il giorno della firma e l'estensione del file, mai il nome del paziente. */
function fileName(signedOn: string, mime: StoredMime): string {
  return `consenso-${signedOn}.${extensionFor(mime)}`;
}

/** Il file nello store e la sua riga: chiave, tipo, peso e hash dai byte veri. */
async function putFile(ctx: StoreContext, store: FileStore, kind: "signature" | "consent_upload", bytes: Uint8Array, checked: { mime: StoredMime; sha256: string; size: number }): Promise<StoredFileInput> {
  const id = randomUUID();
  const file = { id, storageKey: storageKey(ctx.practiceId, kind, id, checked.mime), mime: checked.mime, size: checked.size, sha256: checked.sha256 };
  await store.put(file.storageKey, bytes);
  return file;
}

/** Toglie i file nuovi che la transazione non ha registrato (un errore, o un retry che riusa i file salvati). */
async function removeUnregistered(store: FileStore, files: readonly StoredFileInput[], registered: ReadonlySet<string>): Promise<void> {
  // Un errore della pulizia non nasconde quello della transazione: al più resta un orfano.
  for (const file of files) if (!registered.has(file.id)) await store.remove(file.storageKey).catch(() => {});
}

async function registeredIds(tx: Tx, practiceId: string, files: readonly StoredFileInput[]): Promise<Set<string>> {
  const rows = await tx.query<{ id: string }>("select id from public.files where practice_id=$1 and id = any($2::uuid[])", [practiceId, files.map((f) => f.id)]);
  return new Set(rows.map((row) => row.id));
}

/** Firma sulla tela: firma, testo e scelte restano anche se il PDF non si crea (`pdfReady: false`). */
export async function storeConsent(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  input: { fields: unknown; signaturePng: Uint8Array; secondSignaturePng: Uint8Array | null },
  deps: { renderPdf?: RenderPdf } = {},
): Promise<{ id: string; pdfReady: boolean }> {
  // I campi e i byte prima di scrivere: un modulo sbagliato non scrive niente nello store.
  const { id } = ConsentFieldsSchema.parse(input.fields);
  const checks = [input.signaturePng, input.secondSignaturePng].map((bytes) => (bytes === null ? null : checkSignaturePng(bytes)));
  if (checks.some((checked) => checked !== null && !checked.ok)) throw new DomainError(NOT_ALLOWED, { field: "signature" });

  const files: StoredFileInput[] = [];
  let registered: Set<string>;
  try {
    for (const [index, bytes] of [input.signaturePng, input.secondSignaturePng].entries()) {
      const checked = checks[index];
      if (bytes !== null && checked?.ok) files.push(await putFile(ctx, store, "signature", bytes, checked));
    }
    const [signature, secondSignature = null] = files;
    registered = await ctx.db.asUser(ctx.actor, async (tx) => {
      await signConsent(tx, ctx.practiceId, clock, { fields: input.fields, signature, secondSignature });
      return registeredIds(tx, ctx.practiceId, files);
    });
  } catch (error) {
    await removeUnregistered(store, files, new Set());
    throw error;
  }
  await removeUnregistered(store, files, registered);

  try {
    return { id, pdfReady: (await ensureConsentDocument(ctx, clock, store, id, deps)) !== null };
  } catch (error) {
    // La firma è salvata: il PDF si riprova con «Scarica PDF» (PDF_NOT_CREATED). Nel log solo il messaggio
    // dell'errore, come `toActionFailure`: niente nomi, testi o byte del consenso.
    console.error(`[app] storeConsent: PDF del consenso non creato: ${error instanceof Error ? error.message : String(error)}`);
    return { id, pdfReady: false };
  }
}

/** Il modulo firmato su carta: PDF, JPG o PNG fino a 10 MB, salvato così com'è. */
export async function storeConsentUpload(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  input: { fields: unknown; signedOn: string; bytes: Uint8Array },
): Promise<{ id: string }> {
  const checked = checkConsentUpload(input.bytes);
  if (!checked.ok) throw new DomainError(checked.message, { field: "document" });
  ConsentFieldsSchema.parse(input.fields);

  const files: StoredFileInput[] = [];
  let result: { id: string; registered: Set<string> };
  try {
    files.push(await putFile(ctx, store, "consent_upload", input.bytes, checked));
    result = await ctx.db.asUser(ctx.actor, async (tx) => {
      const { id } = await uploadConsent(tx, ctx.practiceId, clock, { fields: input.fields, signedOn: input.signedOn, document: files[0] });
      return { id, registered: await registeredIds(tx, ctx.practiceId, files) };
    });
  } catch (error) {
    await removeUnregistered(store, files, new Set());
    throw error;
  }
  await removeUnregistered(store, files, result.registered);
  return { id: result.id };
}

/** I byte del file collegato, se ci sono e il loro hash torna. */
async function served(store: FileStore, source: ConsentDocumentSource, file: ConsentSourceFile): Promise<ConsentDocumentFile | null> {
  const bytes = await readVerified(store, file);
  return bytes === null ? null : { bytes, mimeType: file.mimeType, fileName: fileName(source.signedOn, file.mimeType) };
}

/** Le firme della fotografia: null se una firma salvata non è più nello store o è cambiata. */
async function signedData(store: FileStore, source: ConsentDocumentSource): Promise<ConsentDocumentData | null> {
  const read = async (id: string | null, file: ConsentSourceFile | null): Promise<Uint8Array | null | undefined> => {
    if (id === null) return null;
    if (file === null) return undefined;
    return (await readVerified(store, file)) ?? undefined;
  };
  const signature = await read(source.signatureFileId, source.signature);
  const secondSignature = await read(source.secondSignatureFileId, source.secondSignature);
  const practitioner = await read(source.practitionerSignatureFileId, source.practitionerSignature);
  if (!signature || secondSignature === undefined || practitioner === undefined) return null;
  // L'ultima riga del testo congelato è "GG/MM/AAAA, luogo" (freezeConsent).
  const place = /^\d{2}\/\d{2}\/\d{4}, (.+)$/.exec(source.text.slice(source.text.lastIndexOf("\n") + 1))?.[1] ?? "________";
  return {
    mode: "signed", text: source.text, signerName: source.signerName, secondGuardianName: source.secondGuardianName,
    signedOn: source.signedOn, signedAt: source.signedAt?.toISOString() ?? null, place,
    signaturePng: signature, secondSignaturePng: secondSignature, practitionerSignaturePng: practitioner,
    demo: source.demo, version: source.version, missingLabels: source.missingFields.map(missingLabel),
  };
}

/**
 * La stampa senza firma («Stampa il modulo»): gli stessi dati dell'anteprima, senza consent_records né
 * eventi. `day` è il giorno dell'anteprima.
 */
export function blankConsentData(preview: ConsentPreview, day: string): ConsentDocumentData {
  return {
    mode: "blank", text: preview.rendered.text, signerName: preview.signerName, secondGuardianName: null,
    signedOn: day, signedAt: null, place: preview.place, signaturePng: null, secondSignaturePng: null,
    practitionerSignaturePng: null, demo: preview.demo, version: preview.version,
    missingLabels: preview.rendered.missingFields.map(missingLabel),
  };
}

/**
 * Il documento di un consenso e il nome da scaricare; null se il consenso non c'è, è di un altro studio, o
 * un suo file salvato manca o è cambiato. Un consenso firmato sulla tela senza PDF lo genera e lo collega;
 * se nel frattempo un'altra richiesta l'ha collegato si serve quello e si toglie solo il file perdente.
 */
export async function ensureConsentDocument(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  consentId: string,
  deps: { renderPdf?: RenderPdf } = {},
): Promise<ConsentDocumentFile | null> {
  if (!consentIdSchema.safeParse(consentId).success) return null;
  const read = () => ctx.db.asUser(ctx.actor, (tx) => getConsentDocumentSource(tx, ctx.practiceId, consentId));
  const source = await read();
  if (!source) return null;
  if (source.documentFileId !== null) return source.document === null ? null : served(store, source, source.document);
  if (source.method !== "tela") return null;
  const data = await signedData(store, source);
  if (!data) return null;

  const bytes = new Uint8Array(await (deps.renderPdf ?? renderConsentPdf)(data));
  const id = randomUUID();
  const file = { id, storageKey: storageKey(ctx.practiceId, "consent_pdf", id, "application/pdf"), mime: "application/pdf" as const, size: bytes.length, sha256: sha256Of(bytes) };
  await store.put(file.storageKey, bytes);
  try {
    await ctx.db.asUser(ctx.actor, (tx) => attachConsentDocument(tx, ctx.practiceId, clock, { consentId, file }));
  } catch (error) {
    // Un errore della pulizia non nasconde quello della transazione: al più resta un orfano.
    await store.remove(file.storageKey).catch(() => {});
    const again = await read().catch(() => null);
    const other = again?.document ? await served(store, again, again.document).catch(() => null) : null;
    if (other) return other;
    throw error;
  }
  return { bytes, mimeType: "application/pdf", fileName: fileName(source.signedOn, "application/pdf") };
}
