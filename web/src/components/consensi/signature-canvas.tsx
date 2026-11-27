"use client";

import { useEffect, useId, useRef, useState } from "react";
import SignaturePad from "signature_pad";

import { Button } from "@/components/ui/button";
import { clampStrokes, SIGNATURE_HEIGHT, SIGNATURE_WIDTH, type SignaturePoint } from "@/lib/consents/signature";

// La tela della firma: eventi pointer di `signature_pad` per mouse, penna e tocco, linea di base e
// «Firma qui», 560 x 200 pixel CSS fissi. Su uno schermo stretto scorre il contenitore: la tela non si
// rimpicciolisce, così le coordinate dei tratti restano nella stessa scala. Il disegno è alla densità dello
// schermo; a ogni cambio di misura o di densità i tratti si ridisegnano dai dati, non si perdono. Quando la tela
// sparisce dice al dialogo che la sua firma non c'è più; `disabled` ferma il disegno mentre si salva.

export type SignatureValue = { png: string; strokes: SignaturePoint[][] };

export function SignatureCanvas({
  onChange,
  label,
  error,
  disabled = false,
}: {
  onChange: (value: SignatureValue | null) => void;
  label: string;
  /** La frase sotto la tela (per esempio «La firma sembra incompleta»), collegata alla tela. */
  error?: string;
  /** Mentre si salva: niente tratti nuovi, che non partirebbero col salvataggio. */
  disabled?: boolean;
}): React.JSX.Element {
  const baseId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  // L'ultimo onChange senza ricreare la tela a ogni render del dialogo.
  const onChangeRef = useRef(onChange);
  const [empty, setEmpty] = useState(true);
  const disabledRef = useRef(disabled);
  // Se la tela ascolta il puntatore: `on()` due volte attaccherebbe due volte gli stessi listener.
  const listeningRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const pad = new SignaturePad(canvas, { penColor: "rgb(0, 0, 0)", minWidth: 0.8, maxWidth: 2.6 });
    padRef.current = pad;
    listeningRef.current = true;
    if (disabledRef.current) {
      pad.off();
      listeningRef.current = false;
    }

    const emit = () => {
      // signature_pad segue il puntatore anche oltre il bordo: i punti fuori si portano sul bordo.
      const strokes = clampStrokes(pad.toData().map((group) => group.points.map((point) => ({ x: point.x, y: point.y }))));
      const isEmpty = pad.isEmpty();
      setEmpty(isEmpty);
      onChangeRef.current(isEmpty ? null : { png: pad.toDataURL("image/png"), strokes });
    };

    // La densità dello schermo cambia con lo zoom o spostando la finestra su un altro schermo: la tela si
    // riscala e i tratti si ridisegnano dai dati (cambiare width/height la svuota).
    let ratio = 0;
    const fit = () => {
      const next = Math.max(window.devicePixelRatio || 1, 1);
      if (next === ratio) return;
      ratio = next;
      const data = pad.toData();
      canvas.width = Math.round(SIGNATURE_WIDTH * ratio);
      canvas.height = Math.round(SIGNATURE_HEIGHT * ratio);
      canvas.getContext("2d")?.scale(ratio, ratio);
      pad.fromData(data);
    };
    fit();

    pad.addEventListener("endStroke", emit);
    window.addEventListener("resize", fit);
    return () => {
      pad.removeEventListener("endStroke", emit);
      window.removeEventListener("resize", fit);
      if (listeningRef.current) pad.off();
      listeningRef.current = false;
      padRef.current = null;
      // La tela smontata non ha più una firma: il dialogo non deve mandarne una che non si vede.
      onChangeRef.current(null);
    };
  }, []);

  useEffect(() => {
    disabledRef.current = disabled;
    const pad = padRef.current;
    if (pad === null || listeningRef.current === !disabled) return;
    if (disabled) pad.off();
    else pad.on();
    listeningRef.current = !disabled;
  }, [disabled]);

  const clear = () => {
    padRef.current?.clear();
    setEmpty(true);
    onChangeRef.current(null);
  };

  const errorId = `${baseId}-errore`;
  return (
    <div className="flex flex-col gap-2">
      <p id={`${baseId}-etichetta`} className="text-sm font-medium">
        {label}
      </p>
      <div className="max-w-full overflow-x-auto">
        <div className="relative" style={{ width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT }}>
          <canvas
            ref={canvasRef}
            role="img"
            tabIndex={0}
            aria-labelledby={`${baseId}-etichetta`}
            aria-describedby={error === undefined ? undefined : errorId}
            data-invalid={error === undefined ? undefined : true}
            data-empty={empty ? "true" : "false"}
            data-disabled={disabled ? "true" : undefined}
            className="block touch-none rounded-md border border-input bg-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-invalid:border-destructive"
            style={{ width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT }}
          />
          {/* Linea di base e «Firma qui»: guida visiva, non entra nel PNG. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-6 bottom-12 border-b border-neutral-400" />
          {empty ? (
            <span aria-hidden="true" className="pointer-events-none absolute bottom-14 left-6 text-sm text-neutral-500">
              Firma qui
            </span>
          ) : null}
        </div>
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="button" variant="outline" className="h-11 px-4" onClick={clear} disabled={empty || disabled}>
          Cancella firma
        </Button>
      </div>
    </div>
  );
}
