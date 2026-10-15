import manifest from "../../../manifest.json";
const selfIds = new Set([manifest.id, "obsidian-sync-dev"]);
export const isSelfPlugin = (id: unknown): boolean => typeof id === "string" && selfIds.has(id.toLowerCase());
