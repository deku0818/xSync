/**
 * Stable protocol namespace, not a physical vault directory.
 * Changing this value changes encrypted path identities. ObsidianVaultPort maps
 * it to/from Vault.configDir before every configuration filesystem operation.
 */
export const SHARED_CONFIG_ROOT = ".obsidian";
export const SHARED_CONFIG_PREFIX = `${SHARED_CONFIG_ROOT}/`;
export const COMMUNITY_PLUGINS_PATH = `${SHARED_CONFIG_PREFIX}community-plugins.json`;

export function isSharedConfigPath(path: string): boolean {
  return path.startsWith(SHARED_CONFIG_PREFIX);
}
