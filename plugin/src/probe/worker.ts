import { cryptoProbe } from "./crypto";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (value: unknown) => void;
};
async function handleMessage(event: MessageEvent): Promise<void> {
  try {
    if (event.data === "ping") {
      // Minimal WASM function returning 42; validates actual instantiation/execution.
      const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,42,11]);
      const wasm = await WebAssembly.instantiate(bytes);
      const answer = (wasm.instance.exports.run as () => number)();
      if (answer !== 42) throw new Error("WASM returned wrong value");
      scope.postMessage({ ok: true, result: { worker: true, wasm: true } });
    } else if (event.data === "crypto") {
      scope.postMessage({ ok: true, result: await cryptoProbe() });
    } else throw new Error("Unknown worker probe");
  } catch (error) { scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
}
scope.onmessage = event => { void handleMessage(event); };
