/**
 * Dopo un rifiuto riporta il focus sul campo in errore (accessibilità: focus al primo campo in errore), ma solo
 * se il focus è ancora dentro `scope` o da nessuna parte (`body`): un rifiuto arriva quasi sempre dopo la perdita
 * del focus, e chi ha già preso un altro campo non lo perde. `target` è l'elemento che prende il focus (di
 * predefinito `scope`).
 */
export function refocusIfIdle(scope: HTMLElement | null, target: HTMLElement | null = scope): void {
  if (scope === null || target === null) return;
  const active = document.activeElement;
  if (active === null || active === document.body || scope.contains(active)) target.focus();
}
