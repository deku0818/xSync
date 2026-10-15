import { expect, it } from "vitest";
import fc from "fast-check";
import { SyncPolicy, defaultRules, folderPath, validateRules } from "../../plugin/src/sync/policy";
import { sharedConfig, mergeConfig } from "../../plugin/src/sync/config-projection";
import { VaultCrypto } from "../../plugin/src/sync/crypto";
import { compareLines } from "../../plugin/src/ui/diff-lines";
const enc = new TextEncoder(), dec = new TextDecoder();
it("matches full directory boundaries, regex descendants and the exact 100 MB ceiling", () => {
  const policy = new SyncPolicy({ ...defaultRules(), folders: ["docs"], suffixes: [".zip"], regexes: [{ source: "^cache$", flags: "i" }] });
  expect(policy.reason("docs/a/b.md")).toContain("文件夹"); expect(policy.reason("docs-other/a.md")).toBeUndefined(); expect(policy.reason("CACHE/sub/file.md")).toContain("正则");
  expect(policy.reason("file.ZIP")).toContain("后缀"); expect(policy.reason("large.pdf", 100_000_000)).toBeUndefined(); expect(policy.reason("large.pdf", 100_000_001)).toBeDefined();
  expect(policy.reason(".obsidian/appearance.json")).toBeUndefined(); expect(policy.reason(".obsidian/workspace-mobile.json")).toBeDefined(); expect(policy.reason(".obsidian/obsidian-sync-local/device.json")).toBeDefined();
  expect(() => validateRules({ ...defaultRules(), maxMB: 101 })).toThrow(); expect(() => folderPath("../outside")).toThrow(); expect(() => new SyncPolicy({ ...defaultRules(), regexes: [{ source: "(?=x)", flags: "" }] })).toThrow();
  // Nested quantifiers use a non-backtracking engine instead of freezing the main thread.
  expect(new SyncPolicy({ ...defaultRules(), regexes: [{ source: "(a+)+$", flags: "" }] }).reason("a".repeat(1024) + "!")).toBeUndefined();
});
it("keeps credentials and device identity local while updating shared settings and preserving hotkeys", () => {
  const path = ".obsidian/plugins/example/data.json";
  const local = enc.encode(JSON.stringify({ theme: "old", apiKey: "LOCAL-SECRET", nested: { deviceId: "LOCAL-ID", fontSize: 14 }, accounts: [{ name: "me", token: "account-secret" }] }));
  const projected = sharedConfig(path, local); expect(dec.decode(projected)).not.toContain("LOCAL"); expect(dec.decode(projected)).not.toContain("account-secret");
  const merged = JSON.parse(dec.decode(mergeConfig(path, local, enc.encode('{"nested":{"fontSize":18},"theme":"new"}'))));
  expect(merged).toMatchObject({ theme: "new", apiKey: "LOCAL-SECRET", nested: { deviceId: "LOCAL-ID", fontSize: 18 }, accounts: [{ token: "account-secret" }] });
  expect(() => mergeConfig(path, local, enc.encode('{"apiKey":"REMOTE-SECRET"}'))).toThrow("REMOTE_CONFIG_CONTAINS_DEVICE_FIELDS");
  expect(JSON.parse(dec.decode(sharedConfig(".obsidian/hotkeys.json", enc.encode('{"command":[{"key":"A","modifiers":["Mod"]}]}')))).command[0].key).toBe("A");
  const plugins = enc.encode('["calendar","obsidian-sync-dev"]'); expect(dec.decode(sharedConfig(".obsidian/community-plugins.json", plugins))).not.toContain("obsidian-sync-dev"); expect(JSON.parse(dec.decode(mergeConfig(".obsidian/community-plugins.json", plugins, enc.encode('["calendar"]'))))).toContain("obsidian-sync-dev");
});
it("authenticates profile owner and revision so one client's configuration cannot be copied over another", async () => {
  const keys = await VaultCrypto.create("profile-vault", "public-test-key");
  const ciphertext = keys.crypto.profileSeal("device-A", 1, { folders: ["private-folder"], maxMB: 100 });
  expect(ciphertext).not.toContain("private-folder"); expect(keys.crypto.profileOpen("device-A", 1, ciphertext)).toEqual({ folders: ["private-folder"], maxMB: 100 });
  expect(() => keys.crypto.profileOpen("device-B", 1, ciphertext)).toThrow(); expect(() => keys.crypto.profileOpen("device-A", 2, ciphertext)).toThrow(); keys.crypto.close();
});
it("diff rendering always reconstructs the exact reviewed snapshots", () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 30 }), fc.array(fc.string({ maxLength: 20 }), { maxLength: 30 }), (a, b) => {
    const left = a.join("\n"), right = b.join("\n"), rows = compareLines(left, right);
    expect(rows.filter(r => r.aLine !== undefined).map(r => r.a).join("\n")).toBe(left); expect(rows.filter(r => r.bLine !== undefined).map(r => r.b).join("\n")).toBe(right);
  }), { numRuns: 100 });
  const a = "line\n".repeat(1500), b = "changed\n" + a; const rows = compareLines(a, b); expect(rows.filter(r => r.aLine !== undefined).map(r => r.a).join("\n")).toBe(a); expect(rows.filter(r => r.bLine !== undefined).map(r => r.b).join("\n")).toBe(b);
});
