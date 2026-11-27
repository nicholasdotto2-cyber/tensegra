// La copia del messaggio negli appunti. Sicuro per il client: nessun import dal server.

/**
 * writeText parte subito, nella stessa chiamata del gestore del clic: nessun await prima, così il browser
 * la lega al gesto dell'utente. Un rifiuto (permesso negato, contesto non sicuro) arriva al chiamante.
 */
export async function copyMessageText(text: string, clipboard: Pick<Clipboard, "writeText">): Promise<void> {
  await clipboard.writeText(text);
}

/** La copia, poi il registro soltanto se la copia è riuscita: un rifiuto non scrive nessuna riga. */
export async function copyThenRecord<T>(
  text: string,
  clipboard: Pick<Clipboard, "writeText">,
  record: () => Promise<T>,
): Promise<{ copied: false } | { copied: true; result: T }> {
  try {
    await copyMessageText(text, clipboard);
  } catch {
    return { copied: false };
  }
  return { copied: true, result: await record() };
}
