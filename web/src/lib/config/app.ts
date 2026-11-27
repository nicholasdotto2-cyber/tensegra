// Nome del prodotto: si cambia da NEXT_PUBLIC_APP_NAME, senza toccare il codice.
export const APP_NAME: string =
  process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Tensegra";
