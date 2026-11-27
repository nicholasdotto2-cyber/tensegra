import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro della lettera mentre si carica: il titolo, il modulo a sinistra e il foglio A4 a
// destra, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function ReferralLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64 motion-reduce:animate-none" />
        <Skeleton className="h-5 w-48 motion-reduce:animate-none" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-14 motion-reduce:animate-none" />
          <Skeleton className="h-14 motion-reduce:animate-none" />
          <Skeleton className="h-56 motion-reduce:animate-none" />
          <Skeleton className="h-28 motion-reduce:animate-none" />
        </div>
        <Skeleton className="aspect-[210/297] w-full max-w-xl motion-reduce:animate-none" />
      </div>
    </div>
  );
}
