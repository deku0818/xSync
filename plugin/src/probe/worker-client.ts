import workerSource from "probe-worker-source";

export function runWorkerProbe(command: "ping" | "crypto", signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Probe cancelled")); return; }
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    let worker: Worker;
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout); worker?.terminate(); URL.revokeObjectURL(url);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => { cleanup(); reject(new Error("Probe cancelled")); };
    try {
      worker = new Worker(url);
      signal?.addEventListener("abort", cancel, { once: true });
      timeout = setTimeout(() => { cleanup(); reject(new Error("Worker timeout after 60 seconds")); }, 60_000);
      worker.onerror = () => { cleanup(); reject(new Error("Worker failed to load/execute")); };
      worker.onmessage = event => {
        cleanup();
        if (event.data?.ok) resolve(event.data.result as Record<string, unknown>);
        else reject(new Error(String(event.data?.error ?? "Worker returned no result")));
      };
      worker.postMessage(command);
    } catch (error) { cleanup(); reject(error); }
  });
}
