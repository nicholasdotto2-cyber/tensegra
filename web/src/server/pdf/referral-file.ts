import { randomUUID } from "node:crypto";
import { LETTER_CHANGED } from "@/lib/clinical/labels";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError } from "@/server/domain/errors";
import { getStoredFile, type StoredFileRow } from "@/server/domain/files/queries";
import { attachReferralLetter } from "@/server/domain/referrals/commands";
import { getReferralLetter, type ReferralLetter } from "@/server/domain/referrals/queries";
import { getConsentSettings } from "@/server/domain/settings/queries";
import { readVerified } from "@/server/files/consents";
import { storageKey } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import type { FileStore } from "@/server/files/store";
import type { StoreContext } from "@/server/files/upload";
import { renderReferralPdf } from "./render";

// Il PDF della lettera al medico, generato e congelato alla prima richiesta.
// Come `storePhoto`: prima una transazione legge la lettera; se ha già il suo file lo si prende dallo
// store; altrimenti il PDF si genera fuori da ogni transazione, si scrive nello store e una seconda
// transazione salva `files` e `letter_file_id`, solo se il testo stampato è ancora quello letto. Se la
// seconda fallisce il file si toglie; se nel frattempo un'altra richiesta ha salvato la lettera, si serve
// quella, altrimenti l'errore risale. Questo helper apre le sue transazioni: riceve `db`, mai `tx`, e non
// si chiama dentro un'altra `asUser`.

interface SavedLetter {
  letter: ReferralLetter;
  file: StoredFileRow | null;
  signature: { storageKey: string; sha256: string } | null;
}

async function readLetter(tx: Tx, practiceId: string, referralId: string): Promise<SavedLetter | null> {
  const letter = await getReferralLetter(tx, practiceId, referralId);
  if (!letter) return null;
  const file = letter.letterFileId === null ? null : await getStoredFile(tx, practiceId, letter.letterFileId);
  const signature = letter.letterFileId === null ? (await getConsentSettings(tx, practiceId))?.signature ?? null : null;
  return { letter, file, signature };
}

/** Il testo della lettera che il PDF stampa: la lettera salvata vale solo se questo non è cambiato. */
function printedContent(letter: ReferralLetter, signatureHash: string | null): string {
  return JSON.stringify([
    letter.studio,
    letter.recipient.text,
    letter.dayText,
    letter.patient,
    letter.summaryText,
    letter.requestText,
    letter.signature,
    letter.demo,
    signatureHash,
  ]);
}

/** La lettera è cambiata fra la lettura e il salvataggio due volte di seguito: la richiesta si ripete (il testo sta in `labels.ts`: lo mostra anche la pagina). */
export { LETTER_CHANGED };

/** Quante volte si rigenera il PDF se la lettera cambia durante il rendering. */
const RENDER_ATTEMPTS = 2;

type Attach = { kind: "attached" } | { kind: "changed" };

/**
 * La seconda transazione: salva il file solo se la lettera stampa ancora il testo da cui il PDF è nato.
 * Una lettera che nel frattempo ha già il suo file o non c'è più arriva ad `attachReferralLetter`, che
 * risponde con il suo errore.
 */
async function attachIfUnchanged(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  rendered: ReferralLetter,
  signatureHash: string | null,
  file: { id: string; storageKey: string; size: number; sha256: string },
): Promise<Attach> {
  // Il lock impedisce un cambio firma fra il confronto e il collegamento del PDF.
  await tx.query("select practice_id from public.practice_settings where practice_id=$1 for update", [practiceId]);
  const now = await readLetter(tx, practiceId, rendered.id);
  if (now && now.letter.letterFileId === null && printedContent(now.letter, now.signature?.sha256 ?? null) !== printedContent(rendered, signatureHash)) return { kind: "changed" };
  await attachReferralLetter(tx, practiceId, clock, { referralId: rendered.id, file });
  return { kind: "attached" };
}

/** I byte del file salvato della lettera; null se il file non è più nello store. */
async function savedBytes(store: FileStore, saved: SavedLetter): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const bytes = saved.file === null ? null : await store.get(saved.file.storageKey);
  return bytes === null ? null : { bytes, fileName: saved.letter.fileName };
}

/**
 * I byte del PDF della lettera e il nome da scaricare; null se il rinvio non c'è, è di un altro studio, o
 * il suo file salvato non è più nello store. Se la lettera cambia fra il rendering e il salvataggio (un
 * "Salva" del modulo arrivato nel frattempo) il file si toglie e il PDF si rigenera sul testo nuovo; alla
 * seconda volta risponde «La lettera è cambiata mentre preparavo il PDF: riprova.» senza salvare niente.
 */
export async function ensureReferralPdf(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  referralId: string,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  let saved = await ctx.db.asUser(ctx.actor, (tx) => readLetter(tx, ctx.practiceId, referralId));
  for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt += 1) {
    if (!saved) return null;
    if (saved.letter.letterFileId !== null) return savedBytes(store, saved);

    const letter = saved.letter;
    const signatureHash = saved.signature?.sha256 ?? null;
    const signaturePng = saved.signature ? await readVerified(store, saved.signature) : null;
    // Una firma configurata ma mancante o alterata non si congela come lettera senza firma.
    if (saved.signature && !signaturePng) throw new DomainError("Non riesco a leggere la firma dell'osteopata. Salvala di nuovo e riprova.");
    const bytes = new Uint8Array(await renderReferralPdf(letter, signaturePng));
    const fileId = randomUUID();
    const key = storageKey(ctx.practiceId, "referral_pdf", fileId, "application/pdf");
    const file = { id: fileId, storageKey: key, size: bytes.length, sha256: sha256Of(bytes) };
    await store.put(key, bytes);
    let result: Attach;
    try {
      result = await ctx.db.asUser(ctx.actor, (tx) => attachIfUnchanged(tx, ctx.practiceId, clock, letter, signatureHash, file));
    } catch (error) {
      // Un errore della pulizia non nasconde quello della transazione: al più resta un orfano.
      await store.remove(key).catch(() => {});
      const again = await ctx.db.asUser(ctx.actor, (tx) => readLetter(tx, ctx.practiceId, referralId)).catch(() => null);
      const other = again?.file ? await savedBytes(store, again).catch(() => null) : null;
      if (other) return other;
      throw error;
    }
    if (result.kind === "attached") return { bytes, fileName: letter.fileName };
    // La lettera è cambiata: questo PDF non vale, si rilegge e si rigenera.
    await store.remove(key);
    saved = await ctx.db.asUser(ctx.actor, (tx) => readLetter(tx, ctx.practiceId, referralId));
  }
  throw new DomainError(LETTER_CHANGED);
}
