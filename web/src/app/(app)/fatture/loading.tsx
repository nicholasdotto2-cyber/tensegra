import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return <div className="space-y-6" aria-busy="true" aria-label="Caricamento fatture">
    <PageHeader title="Fatture" />
    <Skeleton className="h-14 w-full" />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}
    </div>
    <Skeleton className="h-72 w-full" />
  </div>;
}
