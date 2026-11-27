import { describe, expect, it, vi } from "vitest";
import { copyMessageText, copyThenRecord } from "@/lib/messages/copy";

/** Una Promise che il test risolve o rifiuta quando vuole, per guardare cosa succede prima. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("copia del messaggio", () => {
  it("clipboard_sincrona", async () => {
    // writeText parte nella stessa chiamata, prima che la sua Promise si risolva: resta dentro il gesto del clic.
    const pending = deferred();
    const writeText = vi.fn(() => pending.promise);
    const copied = copyMessageText("Ciao Chiara", { writeText });
    expect(writeText).toHaveBeenCalledWith("Ciao Chiara");
    expect(writeText).toHaveBeenCalledTimes(1);
    pending.resolve();
    await expect(copied).resolves.toBeUndefined();

    // Il rifiuto arriva al chiamante, senza diventare una copia riuscita.
    const denied = new Error("Permesso negato");
    await expect(copyMessageText("Ciao Chiara", { writeText: () => Promise.reject(denied) })).rejects.toBe(denied);

    // Con la copia e il registro insieme: il registro parte solo dopo la copia riuscita, mai dopo un rifiuto.
    const record = vi.fn(async () => ({ id: "a" }));
    const failing = deferred();
    const outcome = copyThenRecord("Ciao Chiara", { writeText: () => failing.promise }, record);
    failing.reject(denied);
    await expect(outcome).resolves.toEqual({ copied: false });
    expect(record).not.toHaveBeenCalled();

    const later = deferred();
    const writeLater = vi.fn(() => later.promise);
    const succeeding = copyThenRecord("Ciao Chiara", { writeText: writeLater }, record);
    expect(writeLater).toHaveBeenCalledWith("Ciao Chiara");
    await Promise.resolve();
    expect(record).not.toHaveBeenCalled();
    later.resolve();
    await expect(succeeding).resolves.toEqual({ copied: true, result: { id: "a" } });
    expect(record).toHaveBeenCalledTimes(1);
  });
});
