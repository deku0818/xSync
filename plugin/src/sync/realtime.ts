import { timerHost, type TimerHandle } from "../runtime/timers";
import { z } from "zod";
import type { Transport } from "./transport";

export class SerialWork {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task); this.tail = next.catch(() => {}); return next;
  }
  idle(): Promise<unknown> { return this.tail; }
}

/** Events accelerate sync; reconciliation remains necessary for dropped filesystem/network hints. */
export class AutomaticSync {
  private enabled = false;
  private pending?: { full: boolean; since: number };
  private running = false;
  private debounce?: TimerHandle;
  private periodic?: TimerHandle;
  constructor(private run: (full: boolean) => Promise<void>, private error: (error: unknown) => void,
    private delay = 350, private interval = 30000) {}
  start(): void {
    if (this.enabled) return; this.enabled = true;
    this.periodic = timerHost().setInterval(() => this.trigger("reconcile"), this.interval); this.trigger("startup", true);
  }
  stop(): void {
    this.enabled = false; this.pending = undefined;
    timerHost().clearTimeout(this.debounce); timerHost().clearInterval(this.periodic); this.debounce = undefined; this.periodic = undefined;
  }
  trigger(reason: string, immediate = false): void {
    if (!this.enabled) return;
    const full = ["startup", "foreground", "focus", "online", "configuration", "rules"].includes(reason);
    this.pending ??= { full: false, since: Date.now() };
    if (full) this.pending.full = true;
    if (this.running) return;
    timerHost().clearTimeout(this.debounce);
    const remaining = Math.max(0, 2000 - (Date.now() - this.pending.since));
    this.debounce = timerHost().setTimeout(() => { void this.flush(); }, immediate ? 0 : Math.min(this.delay, remaining));
  }
  private async flush(): Promise<void> {
    if (!this.enabled || this.running || !this.pending) return;
    const { full } = this.pending;
    this.running = true; this.pending = undefined;
    try { await this.run(full); } catch (error) { this.error(error); }
    finally {
      this.running = false;
      if (this.enabled && this.pending) this.trigger("queued");
    }
  }
}

export interface EventSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
const hintSchema = z.strictObject({ type: z.enum(["ready", "changed"]), epoch: z.string().min(1).max(128), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export class RemoteEvents {
  private generation = 0;
  private enabled = false;
  private socket?: EventSocket;
  private retry?: TimerHandle;
  private handshakeTimeout?: TimerHandle;
  private delay = 1000;
  constructor(private remote: Pick<Transport, "eventTicket" | "eventURL">,
    private notify: (hint: z.infer<typeof hintSchema>) => void,
    private state: (state: string) => void,
    private factory: (url: string) => EventSocket = url => new WebSocket(url) as unknown as EventSocket) {}
  start(): void { if (this.enabled) return; this.enabled = true; this.generation++; void this.connect(this.generation); }
  stop(): void {
    this.enabled = false; this.generation++; timerHost().clearTimeout(this.retry); timerHost().clearTimeout(this.handshakeTimeout);
    this.socket?.close(); this.socket = undefined; this.state("stopped");
  }
  reconnect(): void { if (!this.enabled) return; this.stop(); this.start(); }
  private async connect(generation: number): Promise<void> {
    if (!this.enabled || generation !== this.generation) return;
    this.state("connecting");
    try {
      const ticket = await this.remote.eventTicket();
      if (!this.enabled || generation !== this.generation) return;
      const socket = this.factory(this.remote.eventURL()); this.socket = socket;
      let retried = false;
      const lost = () => {
        if (retried || !this.enabled || generation !== this.generation) return; retried = true;
        timerHost().clearTimeout(this.handshakeTimeout); socket.close(); this.socket = undefined;
        this.schedule(generation);
      };
      socket.onopen = () => { if (generation === this.generation && this.enabled) socket.send(JSON.stringify({ ticket })); else socket.close(); };
      socket.onmessage = event => {
        if (generation !== this.generation || !this.enabled) return;
        if (typeof event.data !== "string" || event.data.length > 1024) { lost(); return; }
        try { const hint = hintSchema.parse(JSON.parse(event.data));
          timerHost().clearTimeout(this.handshakeTimeout); this.delay = 1000; this.state("connected"); this.notify(hint);
        } catch { lost(); }
      };
      socket.onclose = lost; socket.onerror = lost;
      this.handshakeTimeout = timerHost().setTimeout(lost, 10000);
    } catch { if (this.enabled && generation === this.generation) this.schedule(generation); }
  }
  private schedule(generation: number): void {
    this.state("retrying"); const delay = this.delay; this.delay = Math.min(this.delay * 2, 30000);
    timerHost().clearTimeout(this.retry); this.retry = timerHost().setTimeout(() => { void this.connect(generation); }, delay);
  }
}
