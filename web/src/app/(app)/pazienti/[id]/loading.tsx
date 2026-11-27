import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro della scheda mentre si carica: testata, sezioni e un riquadro di contenuto,
// senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function PatientLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56 motion-reduce:animate-none" />
          <Skeleton className="h-5 w-64 motion-reduce:animate-none" />
        </div>
        <Skeleton className="h-9 w-48 motion-reduce:animate-none" />
      </div>
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4].map((tab) => (
          <Skeleton key={tab} className="h-9 w-28 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((block) => (
          <Skeleton key={block} className="h-32 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
