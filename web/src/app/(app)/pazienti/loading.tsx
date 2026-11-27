import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro dei Pazienti mentre la pagina si carica: intestazione, barra di ricerca e filtri, e una
// tabella con la stessa disposizione, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function PazientiLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-8 w-32 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-36 motion-reduce:animate-none" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-full max-w-sm motion-reduce:animate-none" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3, 4, 5].map((chip) => (
            <Skeleton key={chip} className="h-8 w-32 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
          <Skeleton key={row} className="h-12 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
