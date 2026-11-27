// Errori attesi del dominio: una regola che vuole una frase precisa si controlla prima
// della scrittura e risponde con un `DomainError`. La Server Action lo trasforma in un valore
// (`toActionFailure`), mai in un'eccezione che arriva al client.
//
// Si riconoscono per `name`, non con `instanceof`: Turbopack compila i moduli una volta per bundle
// (come in `system-state-for.ts`), e un errore nato in un bundle non è un'istanza della classe
// importata da un altro.

/** Una regola non rispettata. `field` è il campo del modulo a cui attaccare il messaggio. */
export class DomainError extends Error {
  readonly field?: string;
  /** Gli errori di un intero modulo, per percorso (`days.0.bands.0.closes`); `message` e `field` sono il primo. */
  readonly fieldErrors?: Readonly<Record<string, string>>;

  constructor(message: string, options: { field?: string; fieldErrors?: Record<string, string> } = {}) {
    super(message);
    this.name = "DomainError";
    if (options.field !== undefined) this.field = options.field;
    if (options.fieldErrors !== undefined) this.fieldErrors = options.fieldErrors;
  }
}

/** Il token ottimistico di un appuntamento non combacia più: qualcun altro lo ha modificato. */
export class ConflictError extends Error {
  constructor() {
    super("L'appuntamento è stato modificato in un'altra finestra. Ricarico i dati.");
    this.name = "ConflictError";
  }
}

function hasName(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

export function isDomainError(err: unknown): err is DomainError {
  return hasName(err, "DomainError");
}

export function isConflictError(err: unknown): err is ConflictError {
  return hasName(err, "ConflictError");
}

/** Una transizione o una scrittura che la regola non ammette (stesso testo del `42501` del database). */
export const NOT_ALLOWED = "Operazione non permessa";

/** Una delete ferma da un dato collegato (stesso testo del `23001` del database). */
export const BLOCKED_DELETE = "È collegato ad altri dati: non si può eliminare.";
