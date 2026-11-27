import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro dell'agenda mentre la pagina si carica: titolo, barra e griglia con la stessa
// disposizione, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function AgendaLoading() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col gap-6">
      <Skeleton className="h-8 w-32 motion-reduce:animate-none" />
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-60 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-44 motion-reduce:animate-none" />
      </div>
      <Skeleton className="min-h-[20rem] flex-1 motion-reduce:animate-none" />
    </div>
  );
}
