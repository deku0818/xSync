import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryFixture } from './recovery-support';
export const MANAGED_ADMIN_PASSWORD = 'managed-integration-test-only';
export class ManagedFixture extends RecoveryFixture {
 cookie = '';
 constructor(private trustedProxies = '') { super(); }
 async open(): Promise<void> {
  await super.open(); await this.killServer();
  await this.sql(`TRUNCATE ${this.schema}.vaults CASCADE`);
  await writeFile(join(this.root, 'managed-server.json'), JSON.stringify({ dsn: this.config.dsn, listen: new URL(this.endpoint).host, objectDir: join(this.root, 'objects') }), { mode: 0o600 });
  this.server = spawn('.local/desktop/obsidiansync', ['--config', join(this.root, 'managed-server.json'), '--test-schema', this.schema, '--resume-test-schema'], { env: { ...process.env, XSYNC_ADMIN_PASSWORD: MANAGED_ADMIN_PASSWORD, XSYNC_TRUSTED_PROXIES: this.trustedProxies }, stdio: ['ignore', 'ignore', 'pipe'] });
  this.resumed = true;
  let error = ''; this.server.stderr?.on('data', chunk => { error += String(chunk); });
  const deadline = Date.now() + 10000;
  for (;;) {
   if (this.server.exitCode !== null) throw new Error(error);
   try { const response = await fetch(this.endpoint + '/admin/'); if (response.ok) break; } catch { /* Startup not ready. */ }
   if (Date.now() > deadline) throw new Error('MANAGED_START_TIMEOUT ' + error);
   await new Promise(resolve => setTimeout(resolve, 25));
  }
  const login = await fetch(this.endpoint + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: MANAGED_ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error('ADMIN_LOGIN_FAILED'); this.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
 }
 async admin<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(this.endpoint + '/admin/api/' + path, { method, headers: { Cookie: this.cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json() as { code: string }).code); return response.json() as Promise<T>;
 }
}
