import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro del Listino mentre la pagina si carica: titolo, riquadro del regime e tabella con la
// stessa disposizione, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function ListinoLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-32 motion-reduce:animate-none" />
      <Skeleton className="h-10 w-full motion-reduce:animate-none" />
      <Skeleton className="h-64 motion-reduce:animate-none" />
    </div>
  );
}
