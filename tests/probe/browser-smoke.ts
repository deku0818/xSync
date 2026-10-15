import { ProbeStore } from "../../plugin/src/probe/store";
import { runWorkerProbe } from "../../plugin/src/probe/worker-client";

const button = document.querySelector<HTMLButtonElement>("button")!;
const output = document.querySelector<HTMLPreElement>("pre")!;
button.onclick = async () => {
  button.disabled = true; output.textContent = "running";
  const rows: unknown[] = [];
  const db = new ProbeStore(`browser-smoke-${crypto.randomUUID()}`);
  try {
    await db.open(); rows.push({ indexedDB: await db.verifyTransactions() });
    db.close(); await db.open();
    if ((await db.cursors.get("receive"))?.received !== 1) throw new Error("reopen lost cursor");
    rows.push({ connectionReopen: true });
    output.textContent = JSON.stringify(rows, null, 2);
    rows.push({ workerWasm: await runWorkerProbe("ping") });
    output.textContent = JSON.stringify(rows, null, 2);
    rows.push({ workerCrypto: await runWorkerProbe("crypto") });
    rows.push({ status: "pass", scope: "desktop browser smoke only; no Obsidian or iPhone verification" });
  } catch (error) { rows.push({ status: "fail", error: String(error) }); }
  finally { await db.delete(); output.textContent = JSON.stringify(rows, null, 2); button.disabled = false; }
};
