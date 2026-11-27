import { NotFoundState } from "@/components/shell/not-found-state";

// Un indirizzo che nessuna rotta riconosce: fuori dalla shell, quindi con il suo `main`.
export default function RootNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-8 py-16">
      <NotFoundState />
    </main>
  );
}
