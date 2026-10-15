import { timerHost, type TimerHandle } from "../runtime/timers";
import workerSource from "probe-worker-source";

export function runWorkerProbe(command: "ping" | "crypto", signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Probe cancelled")); return; }
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    let worker: Worker;
    let timeout: TimerHandle;
    const cleanup = () => {
      timerHost().clearTimeout(timeout); worker?.terminate(); URL.revokeObjectURL(url);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => { cleanup(); reject(new Error("Probe cancelled")); };
    try {
      worker = new Worker(url);
      signal?.addEventListener("abort", cancel, { once: true });
      timeout = timerHost().setTimeout(() => { cleanup(); reject(new Error("Worker timeout after 60 seconds")); }, 60_000);
      worker.onerror = () => { cleanup(); reject(new Error("Worker failed to load/execute")); };
      worker.onmessage = event => {
        cleanup();
        const data: unknown = event.data;
        if (data && typeof data === "object" && "ok" in data && data.ok === true && "result" in data && data.result && typeof data.result === "object" && !Array.isArray(data.result)) resolve(data.result as Record<string, unknown>);
        else {
          const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Worker returned no valid result";
          reject(new Error(message));
        }
      };
      worker.postMessage(command);
    } catch (error) { cleanup(); reject(error instanceof Error ? error : new Error("Worker probe failed")); }
  });
}
