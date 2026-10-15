import { afterEach, expect, it, vi } from "vitest";
import { AutomaticSync, RemoteEvents, SerialWork, type EventSocket } from "../../plugin/src/sync/realtime";
import { boundedRequest } from "../../plugin/src/sync/transport";

afterEach(() => { vi.useRealTimers(); });
it("coalesces file bursts and drains changes arriving during a run without overlap", async () => {
  vi.useFakeTimers(); let finish!: () => void; let active = 0; let maximum = 0;
  const run = vi.fn(async () => { active++; maximum = Math.max(active, maximum); if (run.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; }); active--; });
  const automatic = new AutomaticSync(run, error => { throw error; }); automatic.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) automatic.trigger("file");
  finish(); await vi.advanceTimersByTimeAsync(349); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
  automatic.stop(); await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(2);
});
it("reconciles missed hints periodically and carries requests across pause/restart", async () => {
  vi.useFakeTimers(); let finish!: () => void;
  const run = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const automatic = new AutomaticSync(run, () => {}, 10, 1000); automatic.start(); await vi.advanceTimersByTimeAsync(0);
  automatic.stop(); automatic.start(); finish(); await vi.advanceTimersByTimeAsync(10); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledTimes(3); automatic.stop();
});
it("serializes rename, sync and explicit resolution, and recovers from a rejected job", async () => {
  const queue = new SerialWork(); const order: string[] = [];
  const first = queue.run(async () => { order.push("rename"); throw new Error("guard failed"); });
  const second = queue.run(async () => { order.push("sync"); }); const third = queue.run(async () => { order.push("resolution"); });
  await expect(first).rejects.toThrow("guard failed"); await Promise.all([second, third]); expect(order).toEqual(["rename", "sync", "resolution"]);
});
function socket(): EventSocket & { sent: string[] } {
  return { onopen: null, onmessage: null, onclose: null, onerror: null, sent: [],
    send(data) { this.sent.push(data); }, close() { this.onclose?.(); } };
}
it("uses first-frame tickets instead of URL credentials, reconnects and rejects malformed hints", async () => {
  vi.useFakeTimers(); const sockets: ReturnType<typeof socket>[] = []; const urls: string[] = []; const notify = vi.fn();
  const events = new RemoteEvents({ eventTicket: async () => "public-ticket", eventURL: () => "ws://127.0.0.1:8873/events" }, notify, () => {}, url => {
    urls.push(url); const s = socket(); sockets.push(s); return s;
  });
  events.start(); await vi.advanceTimersByTimeAsync(0); sockets[0]!.onopen?.();
  expect(urls[0]).not.toContain("ticket"); expect(sockets[0]!.sent).toEqual(['{"ticket":"public-ticket"}']);
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "ready", epoch: "E", seq: 5 }) }); expect(notify).toHaveBeenCalledWith({ type: "ready", epoch: "E", seq: 5 });
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "apply-directly", epoch: "E", seq: 999 }) });
  await vi.advanceTimersByTimeAsync(1000); expect(sockets).toHaveLength(2); expect(notify).toHaveBeenCalledTimes(1);
  events.stop(); await vi.advanceTimersByTimeAsync(60000); expect(sockets).toHaveLength(2);
});
it("does not create a socket when a ticket response returns after unload", async () => {
  let finish!: (ticket: string) => void; const factory = vi.fn(() => socket());
  const events = new RemoteEvents({ eventTicket: () => new Promise(resolve => { finish = resolve; }), eventURL: () => "ws://127.0.0.1/events" }, () => {}, () => {}, factory);
  events.start(); events.stop(); finish("late-ticket"); await Promise.resolve(); await Promise.resolve(); expect(factory).not.toHaveBeenCalled();
});
it("bounds an unresponsive native request without accepting its late result", async () => {
  vi.useFakeTimers(); let finish!: (value: string) => void;
  const pending = boundedRequest(new Promise<string>(resolve => { finish = resolve; }), 1000);
  const rejected = expect(pending).rejects.toThrow("NETWORK_TIMEOUT"); await vi.advanceTimersByTimeAsync(1000); await rejected;
  finish("late commit receipt"); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0);
});
