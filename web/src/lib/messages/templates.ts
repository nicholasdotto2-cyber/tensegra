export type TemplateKey = "conferma" | "promemoria" | "spostamento" | "richiamo" | "consigli";
export type Variant = "tu" | "lei";

/** I testi predefiniti dei modelli dei messaggi. */
export const DEFAULT_TEMPLATES: Record<TemplateKey, Record<Variant, string>> = {
  conferma: {
    tu: "Ciao {nome}, ti confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se hai un imprevisto, scrivimi pure qui. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, le confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Per qualsiasi imprevisto può scrivermi a questo numero. {osteopata}, {studio}",
  },
  promemoria: {
    tu: "Ciao {nome}, ti ricordo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se non riesci a venire, avvisami qui: così posso dare l'orario a qualcun altro. A presto. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, le ricordo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se non potesse venire, mi avvisi qui: potrò offrire l'orario a un'altra persona. Cordiali saluti. {osteopata}, {studio}",
  },
  spostamento: {
    tu: "Ciao {nome}, ho spostato l'appuntamento{per_paziente}: ti aspetto {quando} alle {ora}, in {indirizzo}. Se il nuovo orario non va bene, scrivimi. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, l'appuntamento{per_paziente} è stato spostato a {quando} alle {ora}, in {indirizzo}. Se il nuovo orario non le fosse comodo, mi scriva pure. {osteopata}, {studio}",
  },
  richiamo: {
    tu: "Ciao {nome}, sono {osteopata}. Sono passate {settimane} settimane dall'ultima seduta{di_paziente}: se ti va, fissiamo un controllo. Scrivimi quando ti è comodo e ti propongo un orario. {studio}",
    lei: "Buongiorno {nome}, sono {osteopata}. Sono trascorse {settimane} settimane dall'ultima seduta{di_paziente}: se lo desidera, possiamo fissare un controllo. Mi scriva quando le è comodo e le propongo un orario. {studio}",
  },
  consigli: {
    tu: "Ciao {nome}, come promesso ecco i consigli di oggi: {consigli} Se nei prossimi giorni noti qualcosa di insolito, scrivimi. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, come d'accordo le riporto i consigli di oggi: {consigli} Se nei prossimi giorni nota qualcosa di insolito, mi scriva. {osteopata}, {studio}",
  },
};

const COMMON = ["nome", "studio", "indirizzo", "telefono_studio", "osteopata", "per_paziente", "di_paziente"];
const APPOINTMENT = ["quando", "ora", "durata"];
const PLACEHOLDERS: Record<TemplateKey, ReadonlySet<string>> = {
  conferma: new Set([...COMMON, ...APPOINTMENT]),
  promemoria: new Set([...COMMON, ...APPOINTMENT]),
  spostamento: new Set([...COMMON, ...APPOINTMENT]),
  richiamo: new Set([...COMMON, "settimane"]),
  consigli: new Set([...COMMON, "consigli"]),
};

/** Whitelist per modello, sintassi a graffe singole e limite come char_length di Postgres. */
export function templateProblem(key: TemplateKey, body: string): string | null {
  if (!body.trim()) return "Scrivi il testo del modello.";
  if (Array.from(body).length > 700) return "Il modello supera i 700 caratteri.";
  let problem: string | null = null;
  const remaining = body.replace(/\{([^{}]+)\}/g, (placeholder, name: string) => {
    if (!PLACEHOLDERS[key].has(name) && problem === null) problem = `Segnaposto non riconosciuto: ${placeholder}.`;
    return "";
  });
  if (/[{}]/.test(remaining)) return "Segnaposto non valido: usa graffe singole e bilanciate.";
  return problem;
}
