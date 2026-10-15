import { z } from "zod";
import { commitSchema, changeSchema, handshakeSchema, receiptSchema, snapshotSchema } from "../../../protocol/src/wire";
import type { Commit } from "../../../protocol/src/types";
import { devicesSchema, deviceProfileSchema } from "../../../protocol/src/client-profile";
import { fingerprint } from "./crypto";

export interface HTTPRequest { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }
export interface HTTPResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
export type HTTP = (request: HTTPRequest) => Promise<HTTPResponse>;
export async function boundedRequest<T>(request: PromiseLike<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(request), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("NETWORK_TIMEOUT")), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
export class RemoteError extends Error { constructor(readonly code: string, readonly status?: number) { super(code); } }
export function normalizeEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("INVALID_ENDPOINT"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("INVALID_ENDPOINT");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("HTTPS_REQUIRED");
  return url.origin;
}
export class Transport {
  constructor(private endpoint: string, private token: string, private http: HTTP) {
    this.endpoint = normalizeEndpoint(endpoint);
  }
  private async request(path: string, method = "GET", body?: Uint8Array, extra: Record<string, string> = {}): Promise<HTTPResponse> {
    const r = await this.http({ url: `${this.endpoint}${path}`, method, body, headers: { Authorization: `Bearer ${this.token}`, ...extra } });
    if (r.status < 200 || r.status >= 300) { let code = `HTTP_${r.status}`; try { code = z.strictObject({ code: z.string().max(128) }).parse(JSON.parse(new TextDecoder().decode(r.bytes))).code; } catch { /* preserve HTTP status */ } throw new RemoteError(code, r.status); }
    return r;
  }
  private async json(path: string, method = "GET", input?: unknown): Promise<unknown> {
    const response = await this.request(path, method, input === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input)), { "Content-Type": "application/json" });
    if (response.bytes.length > 32 * 1024 * 1024) throw new Error("RESPONSE_TOO_LARGE");
    return JSON.parse(new TextDecoder().decode(response.bytes));
  }
  async devices() { return devicesSchema.parse(await this.json("/devices")).devices; }
  async putProfile(input: { name: string; expectedRevision: number; ciphertext: string }) { return deviceProfileSchema.parse(await this.json("/device/profile", "PUT", input)); }
  async handshake() { return handshakeSchema.parse(await this.json("/handshake")); }
  eventURL(): string { const url = new URL(`${this.endpoint}/events`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url.toString(); }
  async eventTicket(): Promise<string> {
    return z.strictObject({ ticket: z.string().regex(/^[a-f0-9]{48}$/) }).parse(await this.json("/events/tickets", "POST", {})).ticket;
  }
  async snapshot() {
    const { id } = z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(await this.json("/snapshots", "POST", {}));
    return snapshotSchema.parse(await this.json(`/snapshots/${id}`));
  }
  async changes(epoch: string, after: number) { return z.array(changeSchema).max(100).parse(await this.json(`/changes?epoch=${encodeURIComponent(epoch)}&after=${after}`)); }
  async commit(request: Commit) { return receiptSchema.parse(await this.json("/commits", "POST", commitSchema.parse(request))); }
  async upload(id: string, bytes: Uint8Array): Promise<void> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(id);
    const r = await this.request(`/objects/${id}`, "PUT", bytes, { "Content-Type": "application/octet-stream", "X-Ciphertext-SHA256": await fingerprint(bytes) });
    if (!z.strictObject({ finalized: z.literal(true) }).parse(JSON.parse(new TextDecoder().decode(r.bytes))).finalized) throw new Error("OBJECT_NOT_FINALIZED");
  }
  async object(id: string): Promise<Uint8Array> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(id); const r = await this.request(`/objects/${id}`);
    if (r.bytes.length > 16 * 1024 * 1024 || await fingerprint(r.bytes) !== r.headers["x-ciphertext-sha256"]) throw new Error("OBJECT_DIGEST_MISMATCH");
    return r.bytes;
  }
}
