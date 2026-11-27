import { NotFoundState } from "@/components/shell/not-found-state";

// Una pagina o un paziente che non esistono (`notFound()` dentro la shell): sidebar e banner restano.
export default function AppNotFound() {
  return <NotFoundState />;
}
