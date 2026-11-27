import type { ReferralLetter } from "@/server/domain/referrals/queries";

// L'anteprima della lettera al medico: le stesse righe di `ReferralDocument`
// (src/server/pdf/referral.tsx) in HTML, in un riquadro di proporzioni A4. Mostra la lettera com'è salvata, cioè
// ciò che il PDF stamperà. È la carta: resta bianca anche nel tema scuro. Il riquadro non ha un'altezza fissa: un
// testo lungo lo allunga, come un secondo foglio. Resta fermo accanto al modulo solo se la finestra è abbastanza alta
// per il foglio intero (circa 815 px): su un portatile basso la firma sarebbe tagliata.

export function LetterPreview({ letter }: { letter: ReferralLetter }) {
  return (
    <section aria-label="Anteprima della lettera" className="min-w-0 [@media(min-width:1024px)_and_(min-height:880px)]:sticky [@media(min-width:1024px)_and_(min-height:880px)]:top-4">
      <div className="relative mx-auto aspect-[210/297] w-full max-w-xl rounded-sm border border-border bg-white p-[9%] text-[10px] leading-[1.45] text-neutral-900 shadow-sm sm:text-[11px]">
        {letter.demo ? (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-[48%] -rotate-[35deg] text-center text-[4em] font-bold text-neutral-200 select-none"
          >
            DATI DI PROVA
          </p>
        ) : null}
        {/* Il testo sta sopra la scritta in filigrana: un elemento posizionato dopo di lei la copre. */}
        <div className="relative">
          <header className="mb-[6%]">
            <p className="text-[1.2em] font-bold">{letter.studio.name}</p>
            {letter.studio.lines.map((line) => (
              <p key={line} className="text-neutral-600">
                {line}
              </p>
            ))}
          </header>
          <p className="mb-[4%] ml-[50%]">{letter.recipient.text}</p>
          <p className="mb-[4%] text-right">{letter.dayText}</p>
          <p className="mb-[3%] font-bold">{`Paziente: ${letter.patient.name}, ${letter.patient.birthDateText}`}</p>
          <p className="mb-[3%] whitespace-pre-line">{letter.summaryText}</p>
          <p className="mb-[3%] whitespace-pre-line">{letter.requestText}</p>
          <div className="mt-[5%] ml-[50%]">
            <p>{letter.signature}</p>
            <p className="mt-[12%] border-t border-neutral-500 pt-1 text-neutral-600">Firma</p>
          </div>
        </div>
      </div>
    </section>
  );
}
