import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro del dettaglio della fattura mentre si carica: il titolo, la copia di cortesia a
// sinistra e il pannello a destra, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function InvoiceLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <Skeleton className="h-8 w-56 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-40 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="aspect-[210/297] w-full motion-reduce:animate-none" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 motion-reduce:animate-none" />
          <Skeleton className="h-56 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
