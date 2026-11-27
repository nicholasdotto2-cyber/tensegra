import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro di Oggi mentre la pagina si carica: intestazione e cinque blocchi con la stessa
// disposizione, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function OggiLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-28 motion-reduce:animate-none" />
        <Skeleton className="h-5 w-64 motion-reduce:animate-none" />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <Skeleton className="h-96 xl:col-span-2 motion-reduce:animate-none" />
        <div className="flex flex-col gap-6">
          {[0, 1, 2, 3].map((block) => (
            <Skeleton key={block} className="h-40 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    </div>
  );
}
