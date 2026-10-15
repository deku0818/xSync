/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { RecoveryFiles, RecoveryFixture, RECOVERY_PASSPHRASE } from "./recovery-support";

// This CDP connection controls only a newly spawned, private headless test process/profile.
class Protocol {
  private serial = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private paused?: () => void;
  constructor(private socket: WebSocket) {
    socket.onmessage = event => {
      const msg = JSON.parse(String(event.data));
      if (msg.id) {
        const waiter = this.pending.get(msg.id); if (!waiter) return; this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error))); else waiter.resolve(msg.result);
      } else if (msg.method === "Debugger.paused") this.paused?.();
    };
    socket.onclose = () => { for (const w of this.pending.values()) w.reject(new Error("TEST_BROWSER_CLOSED")); this.pending.clear(); };
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.serial;
    const promise = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.socket.send(JSON.stringify({ id, method, params })); return promise;
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as { exceptionDetails?: unknown; result: { value: T } };
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  }
  async killAt(point: string, kill: () => Promise<void>): Promise<void> {
    await this.call("Debugger.enable"); await this.evaluate(`recovery.arm(${JSON.stringify(point)})`);
    let timer: ReturnType<typeof setTimeout>;
    const paused = new Promise<void>((resolve, reject) => { this.paused = resolve; timer = setTimeout(() => reject(new Error(`FAULT_NOT_REACHED:${point}`)), 10000); });
    // Do not wait for sync to unwind. Kill while JavaScript is paused at the exact boundary.
    const running = this.evaluate("recovery.sync()").then(() => "completed", () => "closed");
    try { await paused; await kill(); await running; } finally { clearTimeout(timer!); this.paused = undefined; }
  }
}
export class NativeRecoveryBrowser {
  private server?: Server;
  private process?: ChildProcess;
  private protocol?: Protocol;
  private origin = "";
  readonly files: RecoveryFiles;
  constructor(private fixture: RecoveryFixture, private executable: string) { this.files = new RecoveryFiles(join(fixture.root, "browser-files")); }
  async open(): Promise<void> {
    await mkdir(this.files.root, { recursive: true });
    const result = await build({ entryPoints: ["tests/desktop/recovery-browser-entry.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
    const bundle = result.outputFiles[0]!.contents;
    this.server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, this.origin || "http://127.0.0.1");
        if (url.pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><script src="/bundle.js"></script>'); return; }
        if (url.pathname === "/bundle.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return; }
        if (url.pathname === "/config") { response.end(JSON.stringify({ vaultId: this.fixture.config.vaultId, deviceId: this.fixture.config.devices[1]!.id, passphrase: RECOVERY_PASSPHRASE })); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
        if (url.pathname.startsWith("/remote/")) {
          // Fixed fixture origin/token, never an arbitrary HTTP proxy.
          const remote = await fetch(`${this.fixture.endpoint}${url.pathname.slice(7)}${url.search}`, { method: request.method, body: ["GET", "HEAD"].includes(request.method!) ? undefined : body, headers: { "Content-Type": String(request.headers["content-type"] ?? "application/json"), Authorization: `Bearer ${this.fixture.config.devices[1]!.token}`, ...(request.headers["x-ciphertext-sha256"] ? { "X-Ciphertext-SHA256": String(request.headers["x-ciphertext-sha256"]) } : {}) } });
          response.statusCode = remote.status; const hash = remote.headers.get("x-ciphertext-sha256"); if (hash) response.setHeader("X-Ciphertext-SHA256", hash); response.end(Buffer.from(await remote.arrayBuffer())); return;
        }
        if (url.pathname !== "/file" || request.method !== "POST") { response.statusCode = 404; response.end(); return; }
        const { operation, args } = JSON.parse(body.toString()) as { operation: string; args: unknown[] };
        const string = (i: number) => { if (typeof args[i] !== "string") throw new Error("INVALID_TEST_ARGUMENT"); return args[i] as string; };
        const bytes = (i: number) => new Uint8Array(args[i] as number[]);
        let value: unknown = null;
        switch (operation) {
          case "list": value = await this.files.list(); break;
          case "read": { const b = await this.files.read(string(0)); value = b === null ? null : [...b]; break; }
          case "write": await this.files.write(string(0), bytes(1), args[2] === null ? null : bytes(2)); break;
          case "rename": await this.files.rename(string(0), string(1), bytes(2)); break;
          case "remove": await this.files.remove(string(0), bytes(1)); break;
          case "stageWrite": await this.files.stageWrite(string(0), bytes(1)); break;
          case "stageRead": { const id = string(0); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID"); value = [...await this.files.stageRead(id)]; break; }
          default: throw new Error("INVALID_TEST_OPERATION");
        }
        response.end(JSON.stringify(value));
      } catch (error) { response.statusCode = 500; response.end(String(error)); }
    });
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    await this.start(0);
  }
  async start(offset: number): Promise<void> {
    const profile = join(this.fixture.root, "chrome-profile"); await rm(join(profile, "DevToolsActivePort"), { force: true });
    this.process = spawn(this.executable, ["--headless", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "about:blank"], { stdio: "ignore" });
    const deadline = Date.now() + 15000; let debugOrigin = "";
    for (;;) {
      if (this.process.exitCode !== null) throw new Error("TEST_CHROME_EXITED");
      try { const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; debugOrigin = `http://127.0.0.1:${port}`; await fetch(`${debugOrigin}/json/version`); break; }
      catch { if (Date.now() > deadline) throw new Error("TEST_CHROME_START_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    const pages = await (await fetch(`${debugOrigin}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const socket = new WebSocket(pages.find(p => p.type === "page")!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("TEST_CDP_FAILED")); });
    this.protocol = new Protocol(socket); await this.protocol.call("Page.enable"); await this.protocol.call("Page.navigate", { url: this.origin });
    for (;;) {
      if (await this.protocol.evaluate("typeof recovery !== 'undefined'")) break;
      if (Date.now() > deadline) throw new Error("TEST_PAGE_LOAD_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 25));
    }
    await this.protocol.evaluate(`recovery.setup(${offset})`);
  }
  async evaluate<T>(expression: string): Promise<T> { return this.protocol!.evaluate<T>(expression); }
  async kill(): Promise<void> {
    const child = this.process; if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  }
  async crash(point: string): Promise<void> { await this.protocol!.killAt(point, () => this.kill()); }
  async close(): Promise<void> { await this.kill(); if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); } }
}
