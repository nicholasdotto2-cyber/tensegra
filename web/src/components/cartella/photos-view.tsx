"use client";

import { type RefObject, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { removeAttachmentAction } from "@/app/(app)/pazienti/[id]/actions";
import { PhotoCompare } from "@/components/cartella/photo-compare";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { photoAltTexts, VIEW_CODES } from "@/lib/files/photo-views";
import type { PhotoRow } from "@/server/domain/attachments/queries";

// La vista Foto della Cartella: le foto raggruppate per data, dalla più
// recente, e dentro il giorno nell'ordine delle viste; "Carica foto", "Confronta" e «Togli la foto» (con la sua
// conferma: nell'interfaccia non si ripristina). Il dialogo di caricamento lo monta la Cartella.

const NO_PHOTOS = "Nessuna foto.";
const REMOVED = "Foto tolta.";

const ORDER: readonly string[] = VIEW_CODES;

interface DayGroup {
  takenOn: string;
  dateText: string;
  photos: PhotoRow[];
}

/** Le foto per giorno (l'ordine di arrivo è dal più recente) e, nel giorno, per vista. */
function groupByDay(photos: PhotoRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const photo of photos) {
    const last = groups.at(-1);
    if (last !== undefined && last.takenOn === photo.takenOn) last.photos.push(photo);
    else groups.push({ takenOn: photo.takenOn, dateText: photo.dateText, photos: [photo] });
  }
  for (const group of groups) {
    // Un sort stabile: a parità di vista resta l'ordine di arrivo.
    group.photos.sort((a, b) => ORDER.indexOf(a.view) - ORDER.indexOf(b.view));
  }
  return groups;
}

function Tile({ photo, alt, onRemove }: { photo: PhotoRow; alt: string; onRemove: (photo: PhotoRow) => void }) {
  const label = `${photo.viewLabel.toLowerCase()} del ${photo.dateText}`;
  return (
    <li className="flex flex-col gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element -- file privato servito con il cookie di sessione: next/image non lo carica */}
      <img
        src={`/api/files/${photo.fileId}`}
        alt={alt}
        width={photo.widthPx ?? undefined}
        height={photo.heightPx ?? undefined}
        className="aspect-[2/3] w-full rounded-lg bg-muted object-cover"
      />
      <p className="text-sm font-medium">{photo.viewLabel}</p>
      {photo.caption === null ? null : <p className="text-sm text-muted-foreground">{photo.caption}</p>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        aria-label={`Togli la foto ${label}`}
        onClick={() => onRemove(photo)}
      >
        Togli la foto
      </Button>
    </li>
  );
}

function RemoveDialog({
  photo,
  onClose,
  headingRef,
}: {
  /** La foto da togliere; null tiene chiusa la conferma. */
  photo: PhotoRow | null;
  onClose: () => void;
  /** Tolta la foto, il pulsante che ha aperto la conferma non c'è più: il focus va al titolo della vista. */
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [pending, startPending] = useTransition();
  const removedRef = useRef(false);
  // Ogni conferma riparte da "non ancora tolta": il focus torna al pulsante se si cambia idea.
  useEffect(() => {
    if (photo !== null) removedRef.current = false;
  }, [photo]);

  const remove = (target: PhotoRow) => {
    startPending(async () => {
      const result = await removeAttachmentAction(target.id);
      if (result.ok) {
        removedRef.current = true;
        toast.success(REMOVED);
      } else {
        toast.error(result.message);
      }
      onClose();
    });
  };

  return (
    <AlertDialog
      open={photo !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent finalFocus={() => (removedRef.current ? headingRef.current : true)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Togliere la foto?</AlertDialogTitle>
          <AlertDialogDescription>
            La foto esce dalla cartella e dal confronto. Da qui non si ripristina.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Torna indietro</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={pending} onClick={() => photo !== null && remove(photo)}>
            Togli la foto
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PhotosView({
  photos,
  onUpload,
}: {
  photos: PhotoRow[];
  /** "Carica foto": chi monta il dialogo di caricamento lo apre da qui. Senza, il pulsante non c'è. */
  onUpload?: () => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [comparing, setComparing] = useState(false);
  const [removing, setRemoving] = useState<PhotoRow | null>(null);
  const groups = groupByDay(photos);
  const alts = photoAltTexts(photos);

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-medium outline-none">
          Foto
        </h2>
        <div className="flex flex-wrap gap-2">
          {photos.length === 0 ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={comparing}
              onClick={() => setComparing((open) => !open)}
            >
              Confronta
            </Button>
          )}
          {onUpload === undefined ? null : (
            <Button type="button" size="sm" onClick={onUpload}>
              Carica foto
            </Button>
          )}
        </div>
      </div>

      {comparing && photos.length > 0 ? <PhotoCompare photos={photos} /> : null}

      {photos.length === 0 ? (
        <p className="text-muted-foreground">{NO_PHOTOS}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.takenOn} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                <time dateTime={group.takenOn}>{group.dateText}</time>
              </h3>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-4">
                {group.photos.map((photo) => (
                  <Tile key={photo.id} photo={photo} alt={alts.get(photo.id) ?? ""} onRemove={setRemoving} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <RemoveDialog photo={removing} onClose={() => setRemoving(null)} headingRef={headingRef} />
    </section>
  );
}
