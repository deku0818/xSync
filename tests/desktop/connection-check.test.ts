import { expect, it } from "vitest";
import { connectionFailure } from "../../plugin/src/sync/connection-check";
import { RemoteError } from "../../plugin/src/sync/transport";

it("distinguishes server, authorization, key and persistence failures without displaying raw errors", () => {
  expect(connectionFailure(new Error("NETWORK_TIMEOUT"), "server")).toMatchObject({ step: "server", message: expect.stringContaining("超时") });
  expect(connectionFailure(new RemoteError("arbitrary server text", 403), "server")).toMatchObject({ step: "authorization", message: expect.stringContaining("授权被拒绝") });
  expect(connectionFailure(new Error("HANDSHAKE_MISMATCH"), "server").step).toBe("authorization");
  expect(connectionFailure(new Error("cipher error with a secret"), "key")).toMatchObject({ step: "key", message: expect.not.stringContaining("secret") });
  expect(connectionFailure(new TypeError("native network error"), "server").message).toContain("无法连接");
  expect(connectionFailure(new Error("disk error with a secret"), "storage")).toMatchObject({ step: "storage", message: expect.not.stringContaining("secret") });
});
