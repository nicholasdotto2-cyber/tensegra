// Limite e testi del caricamento dei file. Sicuro per il
// client: lo usano il controllo del server (`src/server/files/sniff.ts`) e il ridimensionamento nel
// browser, così le due parti dicono la stessa frase.

/** 10 MB, come il check di `files.size_bytes`. */
export const MAX_FILE_BYTES = 10485760;

export const HEIC_TEXT = "Esporta la foto in JPEG dal telefono";
export const NOT_IMAGE_TEXT = "Il file non è un'immagine JPEG, PNG o WebP.";
export const TOO_BIG_TEXT = "File troppo grande (massimo 10 MB)";
