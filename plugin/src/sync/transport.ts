import { z } from "zod";

import { devicesSchema, deviceProfileSchema } from "../../../protocol/src/client-profile.js";
import { CONTINUITY_CAPABILITY, continuitySchema, migrationStateSchema } from "../../../protocol/src/continuity.js";
import { onboardingSchema, challengeSchema, enrollmentSchema, type Enrollment } from "../../../protocol/src/enrollment.js";
import { baseAnchorSchema, requestStreamSchema, trackedResultSchema, type BaseProof, type RequestCoordinate, type RequestAck } from "../../../protocol/src/metadata.js";
import { OBJECT_CAPABILITY, objectIDSchema, isAddressedObject } from "../../../protocol/src/objects.js";
import type { Commit, Revision, Snapshot } from "../../../protocol/src/types.js";
import { commitSchema, changeSchema, handshakeSchema, receiptSchema, snapshotSchema, snapshotPageSchema, SNAPSHOT_CAPABILITY, CONTENT_CAPABILITY, METADATA_CAPABILITY, COMPACT_CAPABILITY } from "../../../protocol/src/wire.js";
import { timerHost, type TimerHandle } from "../runtime/timers.js";
import { fingerprint, randomId } from "./crypto.js";

export interface HTTPRequest { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }
export interface HTTPResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
export type HTTP = (request: HTTPRequest) => Promise<HTTPResponse>;
export type ContinuityGuard = (send: (headers: Record<string, string>) => Promise<HTTPResponse>) => Promise<HTTPResponse>;
export async function boundedRequest<T>(request: PromiseLike<T>, milliseconds = 15000): Promise<T> {
  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([Promise.resolve(request), new Promise<never>((_resolve, reject) => { timer = timerHost().setTimeout(() => reject(new Error("NETWORK_TIMEOUT")), milliseconds); })]);
  } finally { timerHost().clearTimeout(timer); }
}
export class RemoteError extends Error { constructor(readonly code: string, readonly status?: number) { super(code); } }
/** Explicit, exact-origin opt-in carried only by a generated development device fixture. */
export function normalizeEndpoint(endpoint: string, developmentEndpoint?: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("INVALID_ENDPOINT"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("INVALID_ENDPOINT");
  const parts = url.hostname.split(".").map(Number);
  const privateIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168);
  const developmentLAN = privateIPv4 && url.origin === developmentEndpoint;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || developmentLAN))) throw new Error("HTTPS_REQUIRED");
  return url.origin;
}
export class Transport {
  private continuityGuard?: ContinuityGuard;
  setContinuityGuard(guard: ContinuityGuard): void { this.continuityGuard = guard; }
  private activeSnapshot?: { id: string; leaseId: string };
  private snapshotRequest?: string;
  private leaseRenewed = new Map<string, number>();
  constructor(private endpoint: string, private token: string, private http: HTTP, developmentEndpoint?: string) {
    this.endpoint = normalizeEndpoint(endpoint, developmentEndpoint);
  }
  setToken(token: string): void { this.token = token; }
  private async request(path: string, method = "GET", body?: Uint8Array, extra: Record<string, string> = {}, publicRequest = false): Promise<HTTPResponse> {
    const guarded = path.startsWith("/changes?") || path === "/metadata/base" || path === "/metadata/commits" || path === "/commits" || (path === "/snapshots" && method === "POST");
    const send = (protection: Record<string, string>) => this.http({ url: `${this.endpoint}${path}`, method, body, headers: { "X-Sync-Content": CONTENT_CAPABILITY, "X-Sync-Metadata": METADATA_CAPABILITY, "X-Sync-Compaction": COMPACT_CAPABILITY, "X-Sync-Objects": OBJECT_CAPABILITY, "X-Sync-Continuity": CONTINUITY_CAPABILITY, "X-Sync-Snapshots": SNAPSHOT_CAPABILITY, ...(!publicRequest && this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra, ...protection } });
    const r = guarded && this.continuityGuard ? await this.continuityGuard(send) : await send(guarded ? { "X-Sync-Read-Only": "1" } : {});
    if (r.status < 200 || r.status >= 300) { let code = `HTTP_${r.status}`; try { code = z.strictObject({ code: z.string().max(128) }).parse(JSON.parse(new TextDecoder().decode(r.bytes))).code; } catch { /* preserve HTTP status */ } throw new RemoteError(code, r.status); }
    return r;
  }
  private async json(path: string, method = "GET", input?: unknown, publicRequest = false): Promise<unknown> {
    const response = await this.request(path, method, input === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input)), { "Content-Type": "application/json" }, publicRequest);
    if (response.bytes.length > 32 * 1024 * 1024) throw new Error("RESPONSE_TOO_LARGE");
    return JSON.parse(new TextDecoder().decode(response.bytes));
  }
  async devices() { return devicesSchema.parse(await this.json("/devices")).devices; }
  async onboarding() { return onboardingSchema.parse(await this.json("/onboarding", "GET", undefined, true)); }
  async challenge() { return challengeSchema.parse(await this.json("/enroll/challenges", "POST", {}, true)); }
  async enroll(input: Enrollment): Promise<void> { z.strictObject({ enrolled: z.literal(true) }).parse(await this.json("/enroll", "POST", enrollmentSchema.parse(input), true)); }
  async putProfile(input: { name: string; expectedRevision: number; ciphertext: string }) { return deviceProfileSchema.parse(await this.json("/device/profile", "PUT", input)); }
  async handshake() { return handshakeSchema.parse(await this.json("/handshake")); }
  async requestStream() { return requestStreamSchema.parse(await this.json("/metadata/stream", "POST", {})); }
  async continuityToken() { return continuitySchema.parse(await this.json("/metadata/continuity")).token; }
  async fenceContinuity(from: string, next: string) {
    const response = await this.request("/metadata/continuity/fence", "POST", undefined, { "X-Sync-Continuity-From": from, "X-Sync-Continuity-Next": next });
    return continuitySchema.parse(JSON.parse(new TextDecoder().decode(response.bytes))).token;
  }
  async migrationState() { return migrationStateSchema.parse(await this.json("/metadata/migrations")); }
  async registerLegacy(requests: Commit[]): Promise<void> { z.strictObject({ registered: z.literal(true) }).parse(await this.json("/metadata/migrate", "POST", { requests })); }
  async registerLegacyObjects(requests: Commit[]): Promise<void> { z.strictObject({ registered: z.literal(true) }).parse(await this.json("/content/migrate", "POST", { requests })); }
  async certifyBase(revision: Revision) { return baseAnchorSchema.parse(await this.json("/metadata/base", "POST", { revision })); }
  async commitTracked(request: Commit, coordinate: RequestCoordinate, bases: BaseProof[]) {
    return trackedResultSchema.parse(await this.json("/metadata/commits", "POST", { request: commitSchema.parse(request), tracking: { ...coordinate, bases } }));
  }
  async acknowledgeRequest(ack: RequestAck): Promise<void> {
    z.strictObject({ acknowledged: z.literal(true) }).parse(await this.json("/metadata/ack", "POST", ack));
  }
  eventURL(): string { const url = new URL(`${this.endpoint}/events`); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url.toString(); }
  async eventTicket(): Promise<string> {
    return z.strictObject({ ticket: z.string().regex(/^[a-f0-9]{48}$/) }).parse(await this.json("/events/tickets", "POST", {})).ticket;
  }
  async snapshot(): Promise<z.infer<typeof snapshotSchema>> {
    await this.releaseSnapshots();
    this.snapshotRequest ??= randomId();
    const ticket = z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/), leaseId: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await this.json("/snapshots", "POST", { requestId: this.snapshotRequest }));
    this.activeSnapshot = ticket;
    this.snapshotRequest = undefined;
    this.leaseRenewed.set(ticket.leaseId, Date.now());
    let snapshot: Snapshot | undefined;
    let offset = 0;
    let total = 0;
    for (;;) {
      await this.renewContent(ticket.leaseId);
      const page = snapshotPageSchema.parse(await this.json(`/snapshots/${ticket.id}/pages?offset=${offset}`));
      if (!snapshot) {
        snapshot = { epoch: page.epoch, boundary: page.boundary, files: [], revisions: [] };
        if (page.checkpoint !== undefined) {
          snapshot.checkpoint = page.checkpoint;
          snapshot.bases = [];
        }
        total = page.total;
      }
      if (page.epoch !== snapshot.epoch || page.boundary !== snapshot.boundary || page.checkpoint !== snapshot.checkpoint || page.total !== total) throw new Error("INVALID_SNAPSHOT");
      const count = page.files.length + page.revisions.length + (page.bases?.length ?? 0);
      offset += count;
      if (offset > total) throw new Error("INVALID_SNAPSHOT");
      if (page.next === null) {
        if (offset !== total) throw new Error("INVALID_SNAPSHOT");
      } else if (!count || page.next !== offset || offset >= total) {
        throw new Error("INVALID_SNAPSHOT");
      }
      snapshot.files.push(...page.files);
      snapshot.revisions.push(...page.revisions);
      if (page.bases) {
        snapshot.bases ??= [];
        snapshot.bases.push(...page.bases);
      }
      if (page.next === null) return snapshotSchema.parse(snapshot);
    }
  }
  async releaseSnapshots(): Promise<void> {
    const ticket = this.activeSnapshot; this.activeSnapshot = undefined;
    if (ticket) await this.releaseContent(ticket.leaseId);
  }
  private contentID(value: unknown): string { return z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(value).id; }
  async uploadLease(request: Commit): Promise<string> {
    const id = this.contentID(await this.json("/content/upload", "POST", commitSchema.parse(request)));
    this.leaseRenewed.set(id, Date.now()); return id;
  }
  async readLease(revisionId: string): Promise<string> {
    if (this.activeSnapshot) await this.renewContent(this.activeSnapshot.leaseId);
    const id = this.contentID(await this.json("/content/read", "POST", { revisionId, requestId: randomId(), ...(this.activeSnapshot ? { snapshotId: this.activeSnapshot.id } : {}) }));
    this.leaseRenewed.set(id, Date.now()); return id;
  }
  async renewContent(id: string): Promise<void> {
    if (Date.now() - (this.leaseRenewed.get(id) ?? 0) < 60000) return;
    z.strictObject({ renewed: z.literal(true) }).parse(await this.json(`/content/leases/${id}/renew`, "POST", {}));
    this.leaseRenewed.set(id, Date.now());
  }
  async releaseContent(id: string): Promise<void> {
    this.leaseRenewed.delete(id);
    try { await boundedRequest(this.json(`/content/leases/${id}`, "DELETE"), 3000); } catch { /* Expiry is the durable fallback after disconnect or revocation. */ }
  }
  async changes(epoch: string, after: number) { return z.array(changeSchema).max(100).parse(await this.json(`/changes?epoch=${encodeURIComponent(epoch)}&after=${after}`)); }
  async commit(request: Commit) { return receiptSchema.parse(await this.json("/commits", "POST", commitSchema.parse(request))); }
  async upload(id: string, bytes: Uint8Array, lease: string): Promise<void> {
    objectIDSchema.parse(id);
    await this.renewContent(lease);
    const r = await this.request(`/objects/${id}`, "PUT", bytes, { "X-Content-Lease": lease, "Content-Type": "application/octet-stream", "X-Ciphertext-SHA256": await fingerprint(bytes) });
    if (!z.strictObject({ finalized: z.literal(true) }).parse(JSON.parse(new TextDecoder().decode(r.bytes))).finalized) throw new Error("OBJECT_NOT_FINALIZED");
  }
  async object(id: string, lease: string): Promise<Uint8Array> {
    objectIDSchema.parse(id); await this.renewContent(lease);
    const r = await this.request(`/objects/${id}`, "GET", undefined, { "X-Content-Lease": lease });
    if (r.bytes.length > 16 * 1024 * 1024) throw new Error("OBJECT_DIGEST_MISMATCH");
    const digest = await fingerprint(r.bytes);
    if (digest !== r.headers["x-ciphertext-sha256"] || (isAddressedObject(id) && id.slice(2) !== digest)) throw new Error("OBJECT_DIGEST_MISMATCH");
    return r.bytes;
  }
}
