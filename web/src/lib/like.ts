// Il testo cercato dentro un `like`: `%`, `_` e `\` sono jolly o escape di
// LIKE, quindi una barra davanti li fa valere come testo. Postgres usa `\` come escape predefinito:
// la query non scrive nessuna clausola `escape` (in un template literal `escape '\'` diventerebbe
// `escape ''` e spegnerebbe la protezione).

/** "50%_a\b" -> "50\%\_a\\b". */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}
