import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro dell'editor della visita mentre si carica: la barra in alto, le cinque sezioni nella
// colonna principale e la colonna destra, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function VisitLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 motion-reduce:animate-none" />
        <Skeleton className="h-5 w-96 max-w-full motion-reduce:animate-none" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4">
          {[0, 1, 2, 3, 4].map((section) => (
            <Skeleton key={section} className="h-14 motion-reduce:animate-none" />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 motion-reduce:animate-none" />
          <Skeleton className="h-32 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
