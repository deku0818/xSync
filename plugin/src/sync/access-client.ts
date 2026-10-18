import { accessConnectionSchema, managedVaultSchema, type ManagedVault } from '../../../protocol/src/access';
import { z } from 'zod';
import { normalizeEndpoint, RemoteError, type HTTP } from './transport';
export class AccessClient {
 private endpoint: string;
 constructor(endpoint: string, private key: string, private http: HTTP) { this.endpoint = normalizeEndpoint(endpoint); }
 private async json(path: string, method = 'GET', value?: unknown): Promise<unknown> {
  const response = await this.http({ url: this.endpoint + '/api/' + path, method, headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : new TextEncoder().encode(JSON.stringify(value)) });
  if (response.bytes.length > 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
  const body = JSON.parse(new TextDecoder().decode(response.bytes));
  if (response.status < 200 || response.status >= 300) throw new RemoteError(typeof body.code === 'string' ? body.code : 'ACCESS_FAILED', response.status);
  return body;
 }
 async connection() { return accessConnectionSchema.parse(await this.json('connection')); }
 async create(input: { id: string; name: string; epoch: string; keyPackage: unknown }): Promise<ManagedVault> { return managedVaultSchema.parse(await this.json('vaults', 'POST', input)); }
 async enroll(vaultId: string, input: { deviceId: string; name: string; tokenHash: string }): Promise<void> { z.strictObject({ enrolled: z.literal(true) }).parse(await this.json(`vaults/${vaultId}/devices`, 'POST', input)); }
}
