import { describe, expect, it } from "vitest";

import { createSaveQueue, type SaveSnapshot } from "@/lib/visits/save-queue";
import type { ActionFailure, ActionResult } from "@/server/actions/result";

// La coda del salvataggio automatico dell'editor della visita: una chiamata
// alla volta, in ordine; un guasto ferma la coda finché «Riprova» non rimanda proprio la chiamata fallita; un
// rifiuto esce dalla coda e la coda va avanti; una rilettura silenziosa che fallisce si lascia cadere. Le chiamate
// sono promesse che il test risolve a mano, così ogni passo si guarda prima che arrivi la risposta.

type View = { version: number };

interface Pending {
  name: string;
  resolve: (result: ActionResult<View>) => void;
  reject: (error: unknown) => void;
}

/** Un banco di prova: le chiamate partite (in ordine), le viste ricevute, gli stati pubblicati. */
function bench() {
  const sent: Pending[] = [];
  const views: number[] = [];
  const snapshots: SaveSnapshot[] = [];
  const call =
    (name: string) =>
    () =>
      new Promise<ActionResult<View>>((resolve, reject) => {
        sent.push({ name, resolve, reject });
      });
  const queue = createSaveQueue<View>({
    onView: (view) => views.push(view.version),
    onChange: (snapshot) => snapshots.push(snapshot),
    reread: call("rilettura"),
  });
  return { queue, call, sent, views, snapshots, names: () => sent.map((p) => p.name) };
}

/** Lascia girare le promesse già risolte (la coda passa alla chiamata dopo). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ok = (version: number): ActionResult<View> => ({ ok: true, data: { version } });
const refusal = (message: string): ActionFailure => ({ ok: false, message, refused: true });
const failure: ActionFailure = { ok: false, message: "Qualcosa non ha funzionato." };

/** La chiamata partita in posizione `index`, che il test deve trovare. */
function at(sent: Pending[], index: number): Pending {
  const pending = sent[index];
  if (pending === undefined) throw new Error(`nessuna chiamata in posizione ${index}`);
  return pending;
}

describe("createSaveQueue", () => {
  it("retry_stesso_id: risposta persa dopo il salvataggio, due scritture hanno id diversi", async () => {
    const ids: string[] = [];
    const saved = new Set<string>();
    const queue = createSaveQueue<View>({ onView: () => {}, onChange: () => {}, reread: async () => ok(0) });
    let lost = true;
    const write = async (id: string) => {
      ids.push(id);
      saved.add(id);
      if (lost) {
        lost = false;
        throw new Error("Risposta persa dopo il commit");
      }
      return ok(saved.size);
    };
    queue.run(write);
    queue.run(write);
    await settle();
    expect(queue.snapshot().state).toBe("error");
    queue.retry();
    await settle();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(saved.size).toBe(2);
    expect(queue.snapshot().state).toBe("saved");
  });

  it("una chiamata alla volta, in ordine: la seconda parte solo dopo la risposta della prima", async () => {
    const b = bench();
    b.queue.run(b.call("a"));
    b.queue.run(b.call("b"));
    b.queue.run(b.call("c"));
    await settle();
    expect(b.names()).toEqual(["a"]);
    expect(b.queue.snapshot()).toEqual({ state: "saving", refusal: null, pending: true });

    at(b.sent, 0).resolve(ok(1));
    await settle();
    expect(b.names()).toEqual(["a", "b"]);
    at(b.sent, 1).resolve(ok(2));
    await settle();
    at(b.sent, 2).resolve(ok(3));
    await settle();

    expect(b.names()).toEqual(["a", "b", "c"]);
    expect(b.views).toEqual([1, 2, 3]);
    expect(b.queue.snapshot()).toEqual({ state: "saved", refusal: null, pending: false });
  });

  it("un guasto ferma la coda: le chiamate dopo aspettano, «Riprova» rimanda proprio la fallita e poi le altre", async () => {
    const b = bench();
    const first = b.call("a");
    let firstSent = 0;
    b.queue.run(() => {
      firstSent += 1;
      return first();
    });
    b.queue.run(b.call("b"));
    await settle();
    at(b.sent, 0).reject(new Error("An unexpected response was received from the server."));
    await settle();

    expect(b.queue.snapshot()).toEqual({ state: "error", refusal: null, pending: true });
    b.queue.run(b.call("c"));
    await settle();
    // Niente parte finché non si riprova: né la seconda né quella arrivata dopo il guasto.
    expect(b.names()).toEqual(["a"]);

    b.queue.retry();
    await settle();
    expect(firstSent).toBe(2);
    expect(b.names()).toEqual(["a", "a"]);
    at(b.sent, 1).resolve(ok(1));
    await settle();
    at(b.sent, 2).resolve(ok(2));
    await settle();
    at(b.sent, 3).resolve(ok(3));
    await settle();

    expect(b.names()).toEqual(["a", "a", "b", "c"]);
    expect(b.views).toEqual([1, 2, 3]);
    expect(b.queue.snapshot()).toEqual({ state: "saved", refusal: null, pending: false });
  });

  it("un `ok: false` senza rifiuto è un guasto come una richiesta che non arriva", async () => {
    const b = bench();
    b.queue.run(b.call("a"));
    await settle();
    at(b.sent, 0).resolve(failure);
    await settle();
    expect(b.queue.snapshot()).toEqual({ state: "error", refusal: null, pending: true });
  });

  it("«Riprova» due volte di fila, o senza guasto, non manda niente due volte", async () => {
    const b = bench();
    b.queue.retry();
    await settle();
    expect(b.names()).toEqual([]);

    b.queue.run(b.call("a"));
    await settle();
    at(b.sent, 0).resolve(failure);
    await settle();
    b.queue.retry();
    b.queue.retry();
    await settle();
    expect(b.names()).toEqual(["a", "a"]);
    at(b.sent, 1).resolve(ok(1));
    await settle();
    b.queue.retry();
    await settle();
    expect(b.names()).toEqual(["a", "a"]);
  });

  it("un rifiuto esce dalla coda: `onRefused` lo riceve, la coda va avanti e lo stato non è `error`", async () => {
    const b = bench();
    const refused: string[] = [];
    b.queue.run(b.call("a"), { onRefused: (f) => refused.push(f.message) });
    b.queue.run(b.call("b"));
    await settle();
    at(b.sent, 0).resolve(refusal("Scegli l'approccio."));
    await settle();

    expect(refused).toEqual(["Scegli l'approccio."]);
    // Dietro aspetta una scrittura, che riporta la vista: nessuna rilettura in più.
    expect(b.names()).toEqual(["a", "b"]);
    expect(b.queue.snapshot()).toEqual({ state: "saving", refusal: "Scegli l'approccio.", pending: true });

    at(b.sent, 1).resolve(ok(2));
    await settle();
    expect(b.views).toEqual([2]);
    // Il salvataggio andato a buon fine toglie il messaggio del rifiuto.
    expect(b.queue.snapshot()).toEqual({ state: "saved", refusal: null, pending: false });
  });

  it("un rifiuto con `quietRefusal` arriva solo a `onRefused`: lo stato non lo ripete (la rettifica lo dice da sé)", async () => {
    const b = bench();
    const refused: string[] = [];
    b.queue.run(b.call("rettifica"), { onRefused: (f) => refused.push(f.message), quietRefusal: true });
    await settle();
    at(b.sent, 0).resolve(refusal("In una rettifica ogni voce si cambia una volta sola."));
    await settle();
    expect(refused).toEqual(["In una rettifica ogni voce si cambia una volta sola."]);
    expect(b.queue.snapshot()).toEqual({ state: "idle", refusal: null, pending: false });
    // La vista torna quella del server, come per ogni rifiuto.
    expect(b.names()).toEqual(["rettifica", "rilettura"]);
  });

  it("un rifiuto senza scritture dietro rilegge la vista una volta, in silenzio", async () => {
    const b = bench();
    b.queue.run(b.call("a"));
    await settle();
    at(b.sent, 0).resolve(refusal("Operazione non permessa"));
    await settle();

    expect(b.names()).toEqual(["a", "rilettura"]);
    expect(b.queue.snapshot()).toEqual({ state: "idle", refusal: "Operazione non permessa", pending: false });
    at(b.sent, 1).resolve(ok(7));
    await settle();

    expect(b.views).toEqual([7]);
    expect(b.queue.snapshot()).toEqual({ state: "idle", refusal: "Operazione non permessa", pending: false });
    expect(b.names()).toEqual(["a", "rilettura"]);
  });

  it("una rilettura che fallisce si lascia cadere: niente stop, niente altra rilettura", async () => {
    const b = bench();
    b.queue.run(b.call("a"));
    await settle();
    at(b.sent, 0).resolve(refusal("Valore non valido"));
    await settle();
    at(b.sent, 1).reject(new Error("rete"));
    await settle();

    expect(b.names()).toEqual(["a", "rilettura"]);
    expect(b.queue.snapshot()).toEqual({ state: "idle", refusal: "Valore non valido", pending: false });

    // La coda non è ferma: la scrittura dopo parte subito.
    b.queue.run(b.call("b"));
    await settle();
    expect(b.names()).toEqual(["a", "rilettura", "b"]);
  });

  it("`refresh` rilegge in silenzio solo a coda vuota e non ferma", async () => {
    const b = bench();
    b.queue.refresh();
    await settle();
    expect(b.names()).toEqual(["rilettura"]);
    // Durante la rilettura nessuno stato cambia e non c'è niente da perdere.
    expect(b.snapshots).toEqual([]);
    b.queue.refresh();
    await settle();
    expect(b.names()).toEqual(["rilettura"]);
    at(b.sent, 0).resolve(ok(1));
    await settle();
    expect(b.views).toEqual([1]);

    b.queue.run(b.call("a"));
    b.queue.refresh();
    await settle();
    expect(b.names()).toEqual(["rilettura", "a"]);
    at(b.sent, 1).resolve(failure);
    await settle();
    b.queue.refresh();
    await settle();
    expect(b.names()).toEqual(["rilettura", "a"]);
    expect(b.queue.snapshot().state).toBe("error");
  });

  it("una rilettura che fallisce dopo `refresh` non ferma la coda", async () => {
    const b = bench();
    b.queue.refresh();
    await settle();
    at(b.sent, 0).resolve(failure);
    await settle();
    expect(b.queue.snapshot()).toEqual({ state: "idle", refusal: null, pending: false });
    b.queue.run(b.call("a"));
    await settle();
    expect(b.names()).toEqual(["rilettura", "a"]);
  });

  it("una scrittura arrivata mentre la rilettura è in corso parte dopo, e la sua vista resta l'ultima", async () => {
    const b = bench();
    b.queue.refresh();
    await settle();
    b.queue.run(b.call("a"));
    await settle();
    expect(b.names()).toEqual(["rilettura"]);
    at(b.sent, 0).resolve(ok(1));
    await settle();
    at(b.sent, 1).resolve(ok(2));
    await settle();
    expect(b.views).toEqual([1, 2]);
  });
});
