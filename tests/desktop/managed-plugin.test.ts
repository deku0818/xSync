import 'fake-indexeddb/auto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import { ManagedFixture } from './managed-support';
import { RecoveryFiles, recoveryHTTP } from './recovery-support';
import { fingerprint, randomId } from '../../plugin/src/sync/crypto';
import { AccessClient } from '../../plugin/src/sync/access-client';
import { SyncEngine } from '../../plugin/src/sync/engine';
import { Transport } from '../../plugin/src/sync/transport';
import { SyncDB } from '../../plugin/src/sync/store';
const host = vi.hoisted(() => ({ saved: null as unknown, failSave: false, failProtect: false, loseCreation: false, loseEnrollment: false, titleCaseHeaders: false, commands: [] as { name: string }[], root: '', files: new Map<string, string>() }));
vi.mock('obsidian', () => ({ getLanguage: () => "zh",
 Plugin: class {
  constructor(public app: unknown, public manifest: unknown) {}
  addStatusBarItem() { return { setText() {}, addClass() {}, setAttribute() {}, dataset: {} }; }
  addRibbonIcon() { return { addClass() {}, setAttribute() {}, dataset: {} }; }
  addCommand(command: { name: string }) { command.name = "xSync: " + command.name; host.commands.push(command); return command; } addSettingTab() {} registerEvent() {} registerDomEvent() {}
  async loadData() { return host.saved; }
  async saveData(value: unknown) { if (host.failSave) throw new Error('SETTINGS_WRITE_FAILED'); host.saved = structuredClone(value); }
 }, Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, Platform: { isDesktop: true },
 requestUrl: async (request: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer }) => {
  const response = await recoveryHTTP({ ...request, body: request.body ? new Uint8Array(request.body) : undefined });
  if (host.loseCreation && request.method === 'POST' && request.url.endsWith('/api/vaults')) { host.loseCreation = false; throw new Error('CREATION_RECEIPT_LOST'); }
  if (host.loseEnrollment && request.method === 'POST' && /\/api\/vaults\/[^/]+\/devices$/.test(request.url)) { host.loseEnrollment = false; throw new Error('ENROLLMENT_RECEIPT_LOST'); }
  const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [host.titleCaseHeaders ? key.replace(/(^|-)[a-z]/g, part => part.toUpperCase()) : key, value]));
  return { status: response.status, headers, arrayBuffer: response.bytes.slice().buffer };
 },
}));
// The system protectors have separate encryption tests. This fixture targets durable host pointers.
vi.mock('../../plugin/src/desktop/protector', () => ({ desktopProtector: () => ({ name: 'test-only', protect: async (text: string) => { if (host.failProtect) throw new Error('TEST_SECURE_STORE_UNAVAILABLE'); return new TextEncoder().encode(text); }, unprotect: async (bytes: Uint8Array) => new TextDecoder().decode(bytes) }) }));
vi.mock('../../plugin/src/sync/vault-port', () => ({ ObsidianVaultPort: class extends RecoveryFiles {
 constructor() { super(host.root); }
 logical(path: string) { return path; } inScope() { return true; } isOwnWrite() { return false; } isOwnRename() { return false; }
 async configurationStats() { return new Map(); }
} }));
import ObsidianSyncPlugin from '../../plugin/src/sync-main';

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== '1')('managed plugin connection persistence', () => {
 let fixture: ManagedFixture, plugin: ObsidianSyncPlugin | undefined, dbId: string, userId: string, accessKey: string;
 async function load(): Promise<ObsidianSyncPlugin> {
  const adapter = { list: async (root: string) => ({ files: [...host.files.keys()].filter(path => path.startsWith(root + '/') && !path.slice(root.length + 1).includes('/')), folders: [] }), remove: async (path: string) => { host.files.delete(path); }, exists: async (path: string) => host.files.has(path), mkdir: async () => {}, read: async (path: string) => host.files.get(path)!, write: async (path: string, text: string) => { host.files.set(path, text); } };
  const app = { vault: { configDir: '.obsidian', adapter, getName: () => '工作笔记', on: () => {} }, workspace: { getLeavesOfType: () => [], onLayoutReady() {} } } as unknown as App;
  plugin = new ObsidianSyncPlugin(app, { version: '0.1.2' } as PluginManifest); await plugin.onload(); return plugin;
 }
 beforeEach(async () => {
  fixture = new ManagedFixture(); await fixture.open(); dbId = randomId();
  host.root = join(fixture.root, 'plugin-files'); await mkdir(host.root, { recursive: true });
  host.saved = null; host.failSave = false; host.failProtect = false; host.loseCreation = false; host.loseEnrollment = false; host.titleCaseHeaders = false; host.commands = []; host.files.clear();
  host.files.set('.obsidian/obsidian-sync-local/device.json', JSON.stringify({ deviceId: randomId(), databaseId: dbId }));
  vi.stubGlobal('window', {}); vi.stubGlobal('document', {});
  const issued = await fixture.admin<{ user: { id: string }; key: string }>('users', 'POST', { name: '测试用户' }); userId = issued.user.id; accessKey = issued.key; await load();
 });
 afterEach(async () => { plugin?.onunload(); plugin = undefined; await new SyncDB('obsidian-sync-dev-' + dbId).delete(); await fixture.close(); vi.unstubAllGlobals(); });
 async function create(): Promise<void> { await plugin!.authorizeServer(fixture.endpoint, accessKey, 'MacBook'); await plugin!.connectManagedVault('', 'my-vault-password', '工作笔记'); }
 it('persists language before setup and across authorization, pause and restart without syncing it', async () => {
  await plugin!.setLanguage('en'); expect(host.saved).toEqual({ language: 'en' });
  expect(plugin!.syncStatus.label).toBe('Connection required');
  expect(host.commands.map(command => command.name)).toContain('xSync: View sync status');
  plugin!.onunload(); await load(); expect(plugin!.i18n.language).toBe('en');
  await create(); await plugin!.setAutoSync(false);
  const before = structuredClone(host.saved);
  await plugin!.setLanguage('zh'); expect(host.saved).toEqual({ ...before as object, language: 'zh' });
  expect(plugin!.engine?.unlocked).toBe(true); expect(plugin!.autoSync).toBe(false);
  const snapshot = (await plugin!.refreshClients())[0]!.configuration;
  expect(snapshot).toBeDefined(); expect(snapshot).not.toHaveProperty('language');
  plugin!.onunload(); await load(); expect(plugin!.i18n.language).toBe('zh');
  expect(plugin!.autoSync).toBe(false); expect(plugin!.vaultName).toBe('工作笔记');
 }, 30000);
 it('leaves the active language and all connection pointers intact when saving language fails', async () => {
  await create(); const before = structuredClone(host.saved), bound = plugin!.boundVaultId;
  host.failSave = true; await expect(plugin!.setLanguage('en')).rejects.toThrow('SETTINGS_WRITE_FAILED');
  expect(plugin!.i18n.language).toBe('zh'); expect(host.saved).toEqual(before);
  expect(plugin!.engine?.unlocked).toBe(true); expect(plugin!.boundVaultId).toBe(bound);
 }, 30000);
 it.each(['fresh', 'rotated', 'restored'])('syncs uploads and downloads with mixed-case native headers after a %s connection', async phase => {
  host.titleCaseHeaders = true; await create();
  if (phase === 'rotated') {
   const issued = await fixture.admin<{ key: string }>(`users/${userId}/key`, 'POST'); accessKey = issued.key;
   await plugin!.authorizeServer(fixture.endpoint, accessKey, 'MacBook');
  }
  if (phase === 'restored') {
   plugin!.onunload(); await load();
   await (plugin as unknown as { startup(): Promise<void> }).startup();
  }
  const files = new RecoveryFiles(host.root);
  await files.edit('upload.md', 'native mixed-case upload');
  expect((await plugin!.engine!.sync()).errors).toEqual([]);
  const id = plugin!.boundVaultId, deviceId = randomId(), token = randomId();
  await new AccessClient(fixture.endpoint, accessKey, recoveryHTTP).enroll(id, { deviceId, name: 'Peer', tokenHash: await fingerprint(new TextEncoder().encode(token)) });
  const peerFiles = new RecoveryFiles(join(fixture.root, 'peer-files')); await mkdir(peerFiles.root);
  const db = new SyncDB('managed-headers-' + randomId()); await db.open();
  const peer = new SyncEngine(db, new Transport(fixture.endpoint, token, recoveryHTTP, undefined, id), peerFiles, deviceId, id);
  try {
   await peer.restoreRemembered(plugin!.engine!.rememberedMaterial());
   await peerFiles.edit('download.md', 'native mixed-case download');
   expect((await peer.sync()).errors).toEqual([]);
   expect(await peerFiles.text('upload.md')).toBe('native mixed-case upload');
   expect((await plugin!.engine!.sync()).errors).toEqual([]);
   expect(await files.text('download.md')).toBe('native mixed-case download');
  } finally { peer.lock(); await db.delete(); }
 }, 30000);
 it('saves access before binding, creates encrypted content and rotates authorization without changing vault/password/pause', async () => {
  await create(); const id = plugin!.boundVaultId;
  const oldRecord = host.saved as { record: string };
  const oldEnvelope = JSON.parse(host.files.get('.obsidian/obsidian-sync-local/' + oldRecord.record)!);
  const oldToken = JSON.parse(new TextDecoder().decode(Uint8Array.from(oldEnvelope.ciphertext))).material.token as string;
  expect(plugin!.vaultName).toBe('工作笔记'); expect(plugin!.engine?.unlocked).toBe(true);
  expect(JSON.stringify(host.saved)).not.toContain(accessKey); expect(JSON.stringify(host.saved)).not.toContain('my-vault-password');
  await plugin!.setAutoSync(false);
  const refreshed = await fixture.admin<{ key: string }>(`users/${userId}/key`, 'POST');
  await plugin!.authorizeServer(fixture.endpoint, refreshed.key, 'MacBook');
  expect(plugin!.boundVaultId).toBe(id); expect(plugin!.engine?.unlocked).toBe(true); expect(plugin!.autoSync).toBe(false);
  const { Transport } = await import('../../plugin/src/sync/transport');
  await expect(new Transport(fixture.endpoint, oldToken, recoveryHTTP, undefined, id).handshake()).rejects.toThrow('UNAUTHORIZED');
  plugin!.onunload(); await load(); await plugin!.authorizeServer(fixture.endpoint, '', 'MacBook');
  expect(plugin!.boundVaultId).toBe(id); expect(plugin!.autoSync).toBe(false); expect(plugin!.engine?.unlocked).toBe(true);
 }, 30000);
 it.each(['creation', 'enrollment', 'pointer'])('recovers a lost %s result without creating another vault', async boundary => {
  await plugin!.authorizeServer(fixture.endpoint, accessKey, 'MacBook');
  host.loseCreation = boundary === 'creation'; host.loseEnrollment = boundary === 'enrollment'; host.failSave = boundary === 'pointer';
  await expect(plugin!.connectManagedVault('', 'my-vault-password', '工作笔记')).rejects.toThrow();
  host.failSave = false; plugin!.onunload(); await load();
  await plugin!.connectManagedVault('', 'my-vault-password', '工作笔记');
  expect(plugin!.engine?.unlocked).toBe(true);
  const result = await fixture.admin<{ vaults: { id: string }[] }>('vaults'); expect(result.vaults).toHaveLength(1); expect(result.vaults[0]!.id).toBe(plugin!.boundVaultId);
 }, 30000);
 it.each(['enrollment', 'pointer'])('recovers a rotated key after a failed %s and restart without losing the original vault', async boundary => {
  await create(); const id = plugin!.boundVaultId, anchor = plugin!.engine!.rememberedMaterial().keyPackageFingerprint;
  const files = new RecoveryFiles(host.root); await files.edit('retained.md', 'local work before reauthorization');
  const rotated = await fixture.admin<{ key: string }>(`users/${userId}/key`, 'POST');
  host.loseEnrollment = boundary === 'enrollment'; host.failSave = boundary === 'pointer';
  await expect(plugin!.authorizeServer(fixture.endpoint, rotated.key, 'MacBook')).rejects.toThrow();
  host.failSave = false; plugin!.onunload(); await load();
  await plugin!.authorizeServer(fixture.endpoint, rotated.key, 'MacBook');
  expect(plugin!.boundVaultId).toBe(id);
  expect(plugin!.engine!.rememberedMaterial().keyPackageFingerprint).toBe(anchor);
  expect((await plugin!.engine!.sync()).errors).toEqual([]);
  expect(await files.text('retained.md')).toBe('local work before reauthorization');
 }, 30000);
 it('does not reuse a stored access key at another origin, and permits correcting the user before binding', async () => {
  await plugin!.authorizeServer(fixture.endpoint, accessKey, 'MacBook');
  await expect(plugin!.authorizeServer('https://other.example', '', 'MacBook')).rejects.toThrow('ACCESS_KEY_REQUIRED');
  expect(plugin!.endpoint).toBe(fixture.endpoint);
  const other = await fixture.admin<{ user: { id: string }; key: string }>('users', 'POST', { name: '另一用户' });
  await plugin!.authorizeServer(fixture.endpoint, other.key, 'MacBook');
  expect(plugin!.accessUser?.id).toBe(other.user.id); expect(plugin!.boundVaultId).toBe('');
 });
 it('never publishes a vault if protecting its decryption material fails', async () => {
  await plugin!.authorizeServer(fixture.endpoint, accessKey, 'MacBook'); host.failProtect = true;
  await expect(plugin!.connectManagedVault('', 'my-vault-password', '工作笔记')).rejects.toThrow('TEST_SECURE_STORE_UNAVAILABLE');
  expect((await fixture.admin<{ vaults: unknown[] }>('vaults')).vaults).toEqual([]);
 });
});
