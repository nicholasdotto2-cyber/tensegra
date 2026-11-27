"use client";

// Confine d'errore delle pagine: il layout resta, con sidebar e banner, e la pagina mostra
// solo questo. Il `main` è quello della shell: qui un div.
export default function AppError() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col py-10">
      <p>Qualcosa non ha funzionato. I dati già salvati sono al sicuro. Ricarica la pagina.</p>
    </div>
  );
}
