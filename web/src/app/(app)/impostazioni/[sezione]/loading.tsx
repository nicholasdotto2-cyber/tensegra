import { Skeleton } from "@/components/ui/skeleton";

// Lo scheletro di una sezione di Impostazioni mentre la pagina si carica: titolo, sottomenu e modulo con
// la stessa disposizione, senza testo. `prefers-reduced-motion` ferma il pulsare.
export default function SettingsSectionLoading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48 motion-reduce:animate-none" />
      <div className="flex flex-col gap-6 lg:flex-row">
        <Skeleton className="h-8 w-full motion-reduce:animate-none lg:h-48 lg:w-52" />
        <Skeleton className="h-96 w-full max-w-2xl motion-reduce:animate-none" />
      </div>
    </div>
  );
}
