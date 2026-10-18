import { requestUrl } from 'obsidian';
import { boundedRequest, type HTTPRequest, type HTTPResponse } from './transport';

/** Native hosts may return mixed-case headers; the sync transport uses lowercase keys. */
export async function obsidianHTTP(request: HTTPRequest): Promise<HTTPResponse> {
 const response = await boundedRequest(requestUrl({ url: request.url, method: request.method, headers: request.headers, body: request.body?.slice().buffer, throw: false }));
 return {
  status: response.status,
  headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])),
  bytes: new Uint8Array(response.arrayBuffer),
 };
}
