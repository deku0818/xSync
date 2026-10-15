import { expect, it } from "vitest";
import { connectionSettings } from "../../plugin/src/sync/connection-settings";
import { normalizeEndpoint } from "../../plugin/src/sync/transport";

it("retains saved server and pause state, accepting only local protected-record names", () => {
  const saved = { format: 2, endpoint: "https://sync.example.com/", record: `connection-${"a".repeat(64)}.json`, autoSync: false };
  expect(connectionSettings(saved, "http://127.0.0.1:8873")).toMatchObject({ endpoint: "https://sync.example.com", record: saved.record, autoSync: false, restoreAllowed: true });
  for (const record of ["../secret", "/outside.json", "desktop-unlock.json"]) expect(() => connectionSettings({ ...saved, record }, saved.endpoint)).toThrow();
  expect(() => connectionSettings({ ...saved, key: "must-not-be-in-data-json" }, saved.endpoint)).toThrow();
});
it("retains legacy pause and explicit lock until the user saves the new connection", () => {
  expect(connectionSettings(null, "http://localhost:8873")).toMatchObject({ autoSync: true, restoreAllowed: true });
  expect(connectionSettings({ format: 1, autoSync: false, manualLocked: true }, "http://localhost:8873")).toMatchObject({ autoSync: false, restoreAllowed: false, record: "desktop-unlock.json" });
  expect(connectionSettings({ format: 1, rememberDevice: false }, "http://localhost:8873").restoreAllowed).toBe(false);
});
it("requires HTTPS outside loopback and refuses credentials, paths and queries in the server address", () => {
  for (const endpoint of ["http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret", "https://example.com/#key"]) expect(() => normalizeEndpoint(endpoint)).toThrow();
  expect(normalizeEndpoint("https://SYNC.example.com:443/")).toBe("https://sync.example.com");
});
