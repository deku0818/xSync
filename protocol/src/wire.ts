import { z } from "zod";
import { OBJECT_CAPABILITY, objectIDSchema } from "./objects";
import { CONTINUITY_CAPABILITY } from "./continuity";

// Experimental v0 HTTP boundary, intentionally capped for desktop test vaults.
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const payloadSchema = z.strictObject({
  kind: z.enum(["file", "directory", "deleted"]), keyEpoch: z.literal(1),
  encryptedManifest: z.string().min(1).max(2 * 1024 * 1024), objects: z.array(objectIDSchema).max(128),
});
export const locationSchema = z.strictObject({ revision: id, pathKey: opaque, encryptedPath: z.string().min(1).max(16384) });
export const revisionSchema = z.strictObject({ id, fileId: id, parents: z.array(id).max(1000), deviceId: id, payload: payloadSchema, selectedFrom: id.optional() });
export const fileSchema = z.strictObject({ id, entryKind: z.enum(["file", "directory"]), location: locationSchema, heads: z.array(id).min(1).max(1000) });
const createSchema = z.strictObject({ type: z.literal("create"), fileId: id, revisionId: id, payload: payloadSchema, location: locationSchema });
const branchSchema = z.strictObject({ type: z.literal("branch"), fileId: id, revisionId: id, payload: payloadSchema });
const editSchema = z.strictObject({ type: z.literal("edit"), fileId: id, revisionId: id, displayedRevision: id, payload: payloadSchema });
const moveSchema = z.strictObject({ type: z.literal("move"), fileId: id, expectedLocation: id, location: locationSchema });
const resolveSchema = z.strictObject({ type: z.literal("resolve"), fileId: id, expectedLocation: id.optional(), observedHeads: z.array(id).min(2).max(1000), revisionId: id, payload: payloadSchema,
  decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("manual") }),
    z.strictObject({ kind: z.literal("select"), selectedRevision: id }),
    z.strictObject({ kind: z.literal("keep-both"), selectedRevision: id, companionSource: id, companion: createSchema }),
  ]),
});
export const actionSchema = z.discriminatedUnion("type", [createSchema, editSchema, moveSchema, resolveSchema, branchSchema]);
export const commitSchema = z.strictObject({ protocol: z.literal(0), vaultId: id, epoch: id, requiredFeatures: z.array(z.string().max(128)).max(32), deviceId: id, opId: id, actions: z.array(actionSchema).min(1).max(1000) });
export const changeSchema = z.strictObject({ seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), deviceId: id, opId: id, actions: z.array(actionSchema).min(1).max(1000) });
export const baseProofSchema = z.strictObject({ vaultId: id, epoch: id, fileId: id, revisionId: id, digest: opaque, boundary: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), token: opaque });
export const snapshotSchema = z.strictObject({ epoch: id, boundary: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), files: z.array(fileSchema).max(10000), revisions: z.array(revisionSchema).max(100000), checkpoint: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), bases: z.array(baseProofSchema).max(100000).optional() });
export const handshakeSchema = z.strictObject({ protocol: z.literal(0), vaultId: id, epoch: id, seq: z.number().int().nonnegative(), features: z.array(z.string()),
  keyPackage: z.unknown(), devices: z.array(z.strictObject({ id, name: z.string().min(1).max(128) })), maxObjectBytes: z.number().int().positive(),
  metadataCheckpoint: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  continuity: z.literal(true),
});
export const receiptSchema = z.strictObject({ epoch: id, seq: z.number().int().positive(), opId: id });

export const CONTENT_CAPABILITY = "content-leases-v1";
export const METADATA_CAPABILITY = "metadata-anchors-v1";
export const COMPACT_CAPABILITY = "compact-heads-v1";
export const SYNC_FEATURES = ["causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1", CONTENT_CAPABILITY, METADATA_CAPABILITY, COMPACT_CAPABILITY, OBJECT_CAPABILITY, CONTINUITY_CAPABILITY] as const;
