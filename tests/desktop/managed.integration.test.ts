import 'fake-indexeddb/auto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessClient } from '../../plugin/src/sync/access-client';
import { VaultCrypto, randomId } from '../../plugin/src/sync/crypto';
import { SyncEngine } from '../../plugin/src/sync/engine';
import { SyncDB } from '../../plugin/src/sync/store';
import { Transport } from '../../plugin/src/sync/transport';
import { RecoveryFiles, recoveryHTTP } from './recovery-support';
import { ManagedFixture, MANAGED_ADMIN_PASSWORD } from './managed-support';

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== '1')('managed server encrypted multi-vault sync', () => {
 let fixture: ManagedFixture;
 const databases: SyncDB[] = [], engines: SyncEngine[] = [];
 beforeEach(async () => { fixture = new ManagedFixture('127.0.0.1/32'); await fixture.open(); });
 afterEach(async () => { for (const engine of engines.splice(0)) engine.lock(); for (const db of databases.splice(0)) await db.delete(); await fixture.close(); });
 it('applies the trusted-proxy environment setting to the running login endpoint', async () => {
  const login = (source: string, password: string) => fetch(fixture.endpoint + '/admin/api/login', {
   method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': source }, body: JSON.stringify({ password }),
  });
  for (let i = 0; i < 10; i++) expect((await login('198.51.100.1', 'wrong-password')).status).toBe(401);
  expect((await login('198.51.100.1', MANAGED_ADMIN_PASSWORD)).status).toBe(429);
  const admin = await login('198.51.100.2', MANAGED_ADMIN_PASSWORD);
  expect(admin.status).toBe(200);
  expect(admin.headers.get('set-cookie')).toContain('HttpOnly');
 });
 it('isolates users and vaults, keeps decryption independent of key rotation and revokes device sessions', async () => {
  const issued = await fixture.admin<{ user: { id: string }; key: string }>('users', 'POST', { name: 'Alice' });
  const access = new AccessClient(fixture.endpoint, issued.key, recoveryHTTP);
  const id = randomId(), keys = await VaultCrypto.create(id, 'vault-only-password');
  const v = await access.create({ id, name: '工作笔记', epoch: randomId(), keyPackage: keys.keyPackage });
  expect((await access.connection()).vaults.map(v => v.id)).toEqual([id]);
  expect((await access.create({ id, name: v.name, epoch: v.epoch, keyPackage: keys.keyPackage })).id).toBe(id);
  const connect = async (name: string, accessClient: AccessClient) => {
   const deviceId = randomId(), token = randomId();
   const { fingerprint } = await import('../../plugin/src/sync/crypto');
   await accessClient.enroll(id, { deviceId, name, tokenHash: await fingerprint(new TextEncoder().encode(token)) });
   const remote = new Transport(fixture.endpoint, token, recoveryHTTP, undefined, id);
   const files = new RecoveryFiles(join(fixture.root, name)); await mkdir(files.root, { recursive: true });
   const db = new SyncDB('managed-' + randomId()); await db.open(); databases.push(db);
   const engine = new SyncEngine(db, remote, files, deviceId, id); engines.push(engine);
   await engine.unlock('vault-only-password'); return { engine, files, remote, deviceId, token };
  };
  const a = await connect('MacBook', access), b = await connect('iPhone', access);
  await a.files.edit('note.md', 'end-to-end encrypted content'); expect((await a.engine.sync()).errors).toEqual([]);
  expect((await b.engine.sync()).errors).toEqual([]); expect(await b.files.text('note.md')).toBe('end-to-end encrypted content');
  const userB = await fixture.admin<{ key: string }>('users', 'POST', { name: 'Bob' });
  const other = new AccessClient(fixture.endpoint, userB.key, recoveryHTTP);
  expect((await other.connection()).vaults).toEqual([]);
  await expect(other.enroll(id, { deviceId: randomId(), name: 'spy', tokenHash: randomId() })).rejects.toThrow('UNAUTHORIZED');
  const newKey = await fixture.admin<{ key: string }>(`users/${issued.user.id}/key`, 'POST');
  await expect(access.connection()).rejects.toThrow('UNAUTHORIZED');
  expect((await a.engine.sync()).errors).toContain('UNAUTHORIZED'); expect((await b.engine.sync()).errors).toContain('UNAUTHORIZED');
  const renewed = new AccessClient(fixture.endpoint, newKey.key, recoveryHTTP);
  expect((await renewed.connection()).vaults[0]!.keyPackage).toEqual(keys.keyPackage);
  const c = await connect('New Device', renewed); expect((await c.engine.sync()).errors).toEqual([]); expect(await c.files.text('note.md')).toBe('end-to-end encrypted content');
  await fixture.admin(`users/${issued.user.id}`, 'PUT', { active: false }); await expect(c.remote.handshake()).rejects.toThrow('UNAUTHORIZED');
  await fixture.admin(`users/${issued.user.id}`, 'PUT', { active: true }); await expect(c.remote.handshake()).resolves.toBeDefined();
  await fixture.admin(`users/${issued.user.id}`, 'DELETE', { name: 'Alice' }); await expect(c.remote.handshake()).rejects.toThrow('VAULT_NOT_FOUND');
  expect(await c.files.text('note.md')).toBe('end-to-end encrypted content'); keys.crypto.close();
 }, 30000);
});
