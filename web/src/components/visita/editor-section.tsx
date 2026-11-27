"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "@/lib/utils";

// Una sezione richiudibile dell'editor della visita: l'intestazione è un pulsante con `aria-expanded`
// che apre e chiude il contenuto, e l'`id` della sezione è l'ancora dei link di "Per chiudere" (`sezione-b`, ...).
// Il contenuto chiuso resta nella pagina con `hidden`, così anche le ancore dei campi dentro la sezione
// (`campo-presenti`, `apertura-ciclo`, ...) si trovano: `revealAnchor` apre la sezione che le contiene e ci porta
// il focus.

const SECTION_ATTRIBUTE = "data-editor-section";
const REVEAL_EVENT = "visita:apri-sezione";
const NATIVE_FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
const RADIO_TAB_STOP = '[role="radio"][tabindex="0"]';

/**
 * Porta all'ancora `anchor` dell'editor: apre la sezione che la contiene, ci scorre e le dà il focus (con
 * `tabindex="-1"` se non lo prende da sola). Su un gruppo di radio (la scala del dolore) il focus va alla voce che
 * tiene il punto d'ingresso, così frecce e cifre funzionano subito. False se l'ancora non c'è nella pagina.
 */
export function revealAnchor(anchor: string): boolean {
  const target = document.getElementById(anchor);
  if (target === null) return false;
  // La sezione si apre in modo sincrono (`flushSync` nel suo ascoltatore): dopo, il campo è visibile e prende il focus.
  target.closest(`[${SECTION_ATTRIBUTE}]`)?.dispatchEvent(new Event(REVEAL_EVENT));
  const tabStop = target.getAttribute("role") === "radiogroup" ? target.querySelector<HTMLElement>(RADIO_TAB_STOP) : null;
  const focusTarget = tabStop ?? target;
  if (!focusTarget.matches(NATIVE_FOCUSABLE)) focusTarget.setAttribute("tabindex", "-1");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  focusTarget.focus({ preventScroll: true });
  return true;
}

export function EditorSection({
  id,
  title,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const sectionRef = useRef<HTMLElement>(null);
  const headingId = `${id}-titolo`;
  const contentId = `${id}-contenuto`;

  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const reveal = () => flushSync(() => setOpen(true));
    section.addEventListener(REVEAL_EVENT, reveal);
    return () => section.removeEventListener(REVEAL_EVENT, reveal);
  }, []);

  return (
    <section
      ref={sectionRef}
      id={id}
      aria-labelledby={headingId}
      tabIndex={-1}
      {...{ [SECTION_ATTRIBUTE]: "" }}
      className="scroll-mt-4 rounded-xl border bg-card text-card-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <h2 id={headingId} className="text-base font-medium">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {title}
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")}
          />
        </button>
      </h2>
      <div id={contentId} hidden={!open} className="px-4 pb-4">
        {children}
      </div>
    </section>
  );
}
