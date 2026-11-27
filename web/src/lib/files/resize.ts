import { HEIC_TEXT, MAX_FILE_BYTES, NOT_IMAGE_TEXT, TOO_BIG_TEXT } from "./messages";

// Il ridimensionamento della foto nel browser: lato lungo al massimo
// 2000 px, JPEG 0,85. Ridisegnare la foto su un canvas la ricodifica senza metadati (posizione, modello del
// telefono) e con l'orientamento già applicato; il server poi riconosce comunque il tipo dai primi byte. Solo
// browser: usa `createImageBitmap` e `document`.

const LONG_SIDE = 2000;
const QUALITY = 0.85;

/** HEIC e HEIF si riconoscono dall'estensione o dal tipo: il browser non sempre sa decodificarli. */
function isHeic(file: File): boolean {
  return /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]$/i.test(file.type);
}

/**
 * La foto ridotta e ricodificata in JPEG, con le sue misure in pixel. Lancia `Error` col testo per l'utente:
 * HEIC, un file che non è un'immagine che il browser legge, oltre 10 MB anche dopo la riduzione.
 */
export async function resizePhoto(
  file: File,
  longSide: number = LONG_SIDE,
  quality: number = QUALITY,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (isHeic(file)) throw new Error(HEIC_TEXT);

  let bitmap: ImageBitmap;
  try {
    // L'orientamento della foto si applica qui: dopo la ricodifica non c'è più il campo che lo dice.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(NOT_IMAGE_TEXT);
  }

  try {
    // Mai ingrandire: una foto già piccola resta com'è.
    const scale = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error(NOT_IMAGE_TEXT);
    // Un PNG con sfondo trasparente diventerebbe nero in JPEG.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob === null) throw new Error(NOT_IMAGE_TEXT);
    if (blob.size > MAX_FILE_BYTES) throw new Error(TOO_BIG_TEXT);
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}
