import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { searchFiles } from "./fs-tools";

if (!isMainThread) parentPort!.postMessage(searchFiles(workerData.root, workerData.args));

/** A pathological regex can be terminated without freezing the agent/UI. */
export function searchFilesBounded(root: string, args: Record<string, any>, signal?: AbortSignal, timeoutMs = 5000): Promise<string> {
  if (signal?.aborted) return Promise.resolve("Error: recherche annulée");
  return new Promise((resolve) => {
    const worker = new Worker(__filename, { workerData: { root, args } });
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => finish("Error: recherche annulée");
    const timer = setTimeout(
      () => finish("Error: la recherche a expiré. Utilisez un motif plus simple ou cherchez dans un plus petit dossier."),
      timeoutMs
    );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", finish);
    worker.once("error", (err) => finish(`Error: la recherche a échoué : ${err.message}`));
    worker.once("exit", (code) => {
      if (!settled) finish(`Error: le worker de recherche s'est arrêté (${code})`);
    });
  });
}
