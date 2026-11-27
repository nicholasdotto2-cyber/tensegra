import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { systemClock } from "@/server/clock";
import { addDays } from "@/lib/fiscal/calendar";
import { loadConfig } from "@/server/config";
import { resetDataDir } from "@/server/db/maintenance";
import { loadNextEnvFiles, webRootOf } from "./script-env";

// Smoke sulla build: ricrea i dati in .data/smoke, avvia `next start` sulla
// build vera e prova le risposte: le pagine Oggi e Agenda con lo studio demo, una query sul database
// attraverso RLS con le estensioni e con la ricerca dei pazienti sull'indice trigram, un PDF, la lettera
// al medico del seed in PDF, il 404 della route dei file e quello del PDF di una fattura.
// Uscita 0 se tutti i controlli passano, 1 se no.
//
// Il server si ferma sempre con un kill forzato (taskkill /F su Windows): non esegue il gestore
// di uscita, quindi lascia app.lock. L'esecuzione dopo lo prende da sola (resetDataDir passa da
// acquireLock, che toglie il lock di un processo morto).

const HOST = "127.0.0.1";
const PORT = 3200;
const BASE_URL = `http://${HOST}:${PORT}`;
const DATA_DIR = ".data/smoke";
const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const STOP_WAIT_MS = 5_000;
const LOG_TAIL_CHARS = 4_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const webRoot = webRootOf(import.meta.url);
// Gli stessi file .env* di `next start` (per esempio APP_FIXED_NOW in .env.local): il seed dello
// smoke e il server vedono la stessa configurazione. La cartella dati resta sempre .data/smoke.
loadNextEnvFiles(webRoot);

/** Il server avviato: il processo, cosa ha scritto e se è già uscito. */
interface Server {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited(): boolean;
  /** Le ultime righe che ha scritto, per spiegare un avvio fallito. */
  output(): string;
}

function startServer(): Server {
  const nextBin = join(webRoot, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-H", HOST, "-p", String(PORT)], {
    cwd: webRoot,
    env: { ...process.env, APP_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let written = "";
  const keep = (chunk: Buffer) => {
    written = (written + chunk.toString("utf8")).slice(-LOG_TAIL_CHARS);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = false;
  const done = new Promise<void>((resolveDone) => {
    child.once("exit", () => {
      exited = true;
      resolveDone();
    });
    child.once("error", (error) => {
      written += `\n${error.message}`;
      exited = true;
      resolveDone();
    });
  });
  return { child, exited: done, hasExited: () => exited, output: () => written.trim() };
}

// Su Windows `kill` non ferma i processi figli e non è forzato: taskkill /T /F ferma l'albero.
async function stopServer(server: Server): Promise<void> {
  const { pid } = server.child;
  if (!server.hasExited() && pid !== undefined) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        server.child.kill();
      }
    } catch {
      // Già uscito fra il controllo e il kill: va bene lo stesso.
    }
  }
  await Promise.race([server.exited, sleep(STOP_WAIT_MS)]);
  server.child.stdout?.destroy();
  server.child.stderr?.destroy();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function get(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** Un'altra istanza sulla porta farebbe passare i controlli al posto di quella appena avviata. */
async function assertPortFree(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1_500) });
  } catch {
    return; // connessione rifiutata: la porta è libera
  }
  throw new Error(`La porta ${PORT} è già occupata da un altro processo.`);
}

async function waitForReady(server: Server): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "nessuna risposta";
  while (Date.now() < deadline) {
    if (server.hasExited()) {
      throw new Error(`Il server si è fermato prima di rispondere.\n${server.output()}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(1, deadline - Date.now()))),
      });
      if (res.status === 200) return;
      last = `risposta ${res.status}`;
    } catch (error) {
      last = reasonOf(error);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Il server non era pronto dopo ${READY_TIMEOUT_MS / 1000} s (${last}).\n${server.output()}`);
}

interface Check {
  name: string;
  /** Lancia un Error con il motivo se il controllo non passa. */
  run(): Promise<void>;
}

const CHECKS: readonly Check[] = [
  {
    name: "GET /fatture",
    async run() {
      const res = await get("/fatture");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      if (!body.includes("Questa versione crea PDF e XML ma non li invia allo SdI.")) throw new Error("Manca il riquadro dello SdI.");
      if (body.includes("Non riesco a caricare questo elenco.") || body.includes("Qualcosa non ha funzionato.")) throw new Error("La pagina Fatture non è stata caricata.");
    },
  },
  {
    name: "GET /api/fatture/<uuid>/pdf (fattura del mese precedente)",
    async run() {
      const month = addDays(`${systemClock.today().slice(0, 7)}-01`, -1).slice(0, 7);
      const list = await get(`/fatture?tab=emesse&anno=${month.slice(0, 4)}&mese=${month}`);
      if (list.status !== 200) throw new Error(`lista: risposta ${list.status}, attesa 200`);
      // Il link della lista è il download, con `?download=1`.
      const href = new RegExp(`href="(/api/fatture/${UUID}/pdf\\?download=1)"`).exec(await list.text())?.[1];
      if (!href) throw new Error("Nella lista manca un link al PDF di una fattura.");
      const res = await get(href);
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("application/pdf")) throw new Error(`content-type "${type}", atteso application/pdf`);
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") throw new Error(`i primi 5 byte sono ${JSON.stringify(head)}, attesi "%PDF-"`);
    },
  },
  {
    name: "GET /oggi",
    async run() {
      const res = await get("/oggi");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // I cinque blocchi di Oggi con il loro titolo; "Promemoria per" perché il resto
      // del titolo è la data di domani.
      const expected = [
        "Oggi",
        "Studio Osteopatico Borgo Tiglio",
        "Appuntamenti di oggi",
        "Consensi mancanti",
        "Fatture da emettere",
        "Promemoria per",
        "Da richiamare",
      ];
      for (const text of expected) {
        if (!body.includes(text)) throw new Error(`nel corpo manca "${text}"`);
      }
      // Un blocco fallito mostra questa frase e gli altri restano: nel seed di prova nessuno fallisce.
      // L'HTML grezzo scrive gli apostrofi come `&#x27;`: nessun testo atteso ne contiene.
      if (body.includes("Non riesco a caricare questo elenco.")) {
        throw new Error(`nel corpo c'è "Non riesco a caricare questo elenco."`);
      }
    },
  },
  {
    name: "GET /agenda",
    async run() {
      const res = await get("/agenda");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // L'interruttore Giorno/Settimana della barra.
      if (!body.includes("Settimana")) throw new Error(`nel corpo manca "Settimana"`);
      // "Non riesco a caricare l'agenda." senza l'apostrofo, che l'HTML grezzo scrive `&#x27;`.
      if (body.includes("Non riesco a caricare l")) throw new Error(`nel corpo c'è "Non riesco a caricare l'agenda."`);
    },
  },
  {
    name: "GET /listino",
    async run() {
      const res = await get("/listino");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // Il titolo e la voce di partenza del seed.
      for (const text of ["Listino", "Seduta osteopatica"]) {
        if (!body.includes(text)) throw new Error(`nel corpo manca "${text}"`);
      }
      // "Non riesco a caricare il listino." senza altro: nessun apostrofo da scrivere in HTML.
      if (body.includes("Non riesco a caricare il listino.")) {
        throw new Error(`nel corpo c'è "Non riesco a caricare il listino."`);
      }
    },
  },
  {
    name: "GET /pazienti",
    async run() {
      const res = await get("/pazienti");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // Il titolo e la prima riga della lista del seed.
      for (const text of ["Pazienti", "Bellandi Marco"]) {
        if (!body.includes(text)) throw new Error(`nel corpo manca "${text}"`);
      }
      // "Non riesco a caricare questo elenco." senza apostrofi da scrivere in HTML.
      if (body.includes("Non riesco a caricare questo elenco.")) {
        throw new Error(`nel corpo c'è "Non riesco a caricare questo elenco."`);
      }
    },
  },
  {
    // La scheda del primo paziente della lista: il link vero, preso dal corpo di /pazienti.
    name: "GET /pazienti/<id> (scheda)",
    async run() {
      const list = await (await get("/pazienti")).text();
      const href = /href="(\/pazienti\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(list)?.[1];
      if (href === undefined) throw new Error(`nel corpo di /pazienti non c'è un link a una scheda`);
      const res = await get(href);
      if (res.status !== 200) throw new Error(`${href}: risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // L'etichetta della prima sezione.
      if (!body.includes("Riepilogo")) throw new Error(`${href}: nel corpo manca "Riepilogo"`);
      if (body.includes("Non riesco a caricare questo elenco.")) {
        throw new Error(`${href}: nel corpo c'è "Non riesco a caricare questo elenco."`);
      }
    },
  },
  {
    // La lettera al medico di Roberto Esposito: dalla lista alla
    // sua Cartella, il link del rinvio consegnato, poi il PDF che la route genera e congela alla prima richiesta.
    name: "GET /api/rinvii/<id>/pdf (lettera di Roberto Esposito)",
    async run() {
      const list = await (await get("/pazienti")).text();
      // Il nome può stare dentro altri elementi del link: si saltano i tag fra `<a>` e il testo.
      const patient = new RegExp(`<a[^>]*href="(/pazienti/${UUID})"[^>]*>(?:<[^>]+>)*Esposito Roberto`).exec(list)?.[1];
      if (patient === undefined) throw new Error(`nel corpo di /pazienti non c'è il link di Esposito Roberto`);
      const cartella = await get(`${patient}?tab=cartella`);
      if (cartella.status !== 200) throw new Error(`${patient}?tab=cartella: risposta ${cartella.status}, attesa 200`);
      const body = await cartella.text();
      const referral = new RegExp(`href="${patient}/rinvii/(${UUID})"`).exec(body)?.[1];
      if (referral === undefined) throw new Error(`nella Cartella di Esposito Roberto non c'è il link del rinvio`);
      const res = await get(`/api/rinvii/${referral}/pdf`);
      if (res.status !== 200) throw new Error(`/api/rinvii/${referral}/pdf: risposta ${res.status}, attesa 200`);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("application/pdf")) throw new Error(`content-type "${type}", atteso application/pdf`);
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") throw new Error(`i primi 5 byte sono ${JSON.stringify(head)}, attesi "%PDF-"`);
    },
  },
  {
    name: "GET /impostazioni/fisco",
    async run() {
      const res = await get("/impostazioni/fisco");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      if (!body.includes("Forfettario")) throw new Error('nel corpo manca "Forfettario"');
      if (body.includes("Non riesco a caricare questa sezione.") || body.includes("Qualcosa non ha funzionato.")) {
        throw new Error("La sezione Fisco non è stata caricata.");
      }
    },
  },
  {
    name: "GET /impostazioni/studio",
    async run() {
      const res = await get("/impostazioni/studio");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = await res.text();
      // Il campo del modulo con il nome dello studio del seed: il nome da solo c'è
      // sempre nell'intestazione della sidebar, anche se il modulo non si disegna.
      for (const text of ["Nome dello studio", 'value="Studio Osteopatico Borgo Tiglio"']) {
        if (!body.includes(text)) throw new Error(`nel corpo manca ${JSON.stringify(text)}`);
      }
      // La frase di `(app)/error.tsx`: la pagina è caduta nel confine d'errore.
      if (body.includes("Qualcosa non ha funzionato.")) throw new Error(`nel corpo c'è "Qualcosa non ha funzionato."`);
      // "Non riesco a caricare questa sezione." senza altro: nessun apostrofo da scrivere in HTML.
      if (body.includes("Non riesco a caricare questa sezione.")) {
        throw new Error(`nel corpo c'è "Non riesco a caricare questa sezione."`);
      }
    },
  },
  {
    name: "GET /api/health (RLS, unaccent, trgm, ricerca pazienti)",
    async run() {
      const res = await get("/api/health");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const body = (await res.json()) as { ok?: unknown; unaccent?: unknown; trgm?: unknown; patientSearch?: unknown };
      if (body.ok !== true) throw new Error(`ok vale ${JSON.stringify(body.ok)}, atteso true`);
      if (body.unaccent !== "Bellandi") {
        throw new Error(`unaccent vale ${JSON.stringify(body.unaccent)}, atteso "Bellandi"`);
      }
      if (typeof body.trgm !== "number" || !(body.trgm > 0)) {
        throw new Error(`trgm vale ${JSON.stringify(body.trgm)}, atteso un numero maggiore di 0`);
      }
      // Quanti pazienti trova la ricerca: con il seed di oggi nessuno, ma la query deve girare e rispondere un numero.
      if (typeof body.patientSearch !== "number") {
        throw new Error(`patientSearch vale ${JSON.stringify(body.patientSearch)}, atteso un numero`);
      }
    },
  },
  {
    name: "GET /api/health/pdf",
    async run() {
      const res = await get("/api/health/pdf");
      if (res.status !== 200) throw new Error(`risposta ${res.status}, attesa 200`);
      const type = res.headers.get("content-type") ?? "";
      if (!type.startsWith("application/pdf")) throw new Error(`content-type "${type}", atteso application/pdf`);
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") throw new Error(`i primi 5 byte sono ${JSON.stringify(head)}, attesi "%PDF-"`);
    },
  },
  {
    // Un uuid senza riga: la route cerca come l'utente e risponde 404 con la frase.
    name: "GET /api/files/<uuid> (404)",
    async run() {
      const res = await get("/api/files/00000000-0000-4000-8000-000000000000");
      if (res.status !== 404) throw new Error(`risposta ${res.status}, attesa 404`);
      const body = await res.text();
      if (!body.includes("Il file non è più disponibile")) throw new Error(`nel corpo manca "Il file non è più disponibile"`);
      const cache = res.headers.get("cache-control") ?? "";
      if (cache !== "private, no-store") throw new Error(`cache-control "${cache}", atteso "private, no-store"`);
    },
  },
  {
    // Il PDF di una fattura: un uuid senza riga è 404.
    name: "GET /api/fatture/<uuid>/pdf (404)",
    async run() {
      const res = await get("/api/fatture/00000000-0000-4000-8000-000000000000/pdf");
      if (res.status !== 404) throw new Error(`risposta ${res.status}, attesa 404`);
      const cache = res.headers.get("cache-control") ?? "";
      if (cache !== "private, no-store") throw new Error(`cache-control "${cache}", atteso "private, no-store"`);
    },
  },
  {
    // Un id che non è un uuid: 404 prima di toccare il database.
    name: "GET /api/fatture/abc/pdf (404)",
    async run() {
      const res = await get("/api/fatture/abc/pdf");
      if (res.status !== 404) throw new Error(`risposta ${res.status}, attesa 404`);
    },
  },
  {
    // Un id che non è un uuid: 404 prima di toccare il database.
    name: "GET /api/files/non-un-uuid (404)",
    async run() {
      const res = await get("/api/files/non-un-uuid");
      if (res.status !== 404) throw new Error(`risposta ${res.status}, attesa 404`);
    },
  },
];

async function runChecks(): Promise<boolean> {
  let allPassed = true;
  for (const check of CHECKS) {
    try {
      await check.run();
      console.log(`OK      ${check.name}`);
    } catch (error) {
      allPassed = false;
      console.error(`ERRORE  ${check.name}: ${reasonOf(error)}`);
    }
  }
  return allPassed;
}

async function main(): Promise<boolean> {
  if (!existsSync(join(webRoot, ".next", "BUILD_ID"))) {
    console.error("Esegui prima pnpm build.");
    return false;
  }
  await assertPortFree();
  const cfg = loadConfig({ ...process.env, APP_DATA_DIR: DATA_DIR }, webRoot);
  await resetDataDir(cfg, { seed: true, clock: systemClock });

  const server = startServer();
  try {
    await waitForReady(server);
    return await runChecks();
  } finally {
    await stopServer(server);
  }
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (error) {
  console.error(`ERRORE  ${reasonOf(error)}`);
  process.exitCode = 1;
}
