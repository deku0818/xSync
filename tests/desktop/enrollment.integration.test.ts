import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { RememberedUnlock, type StoredMaterial } from "../../plugin/src/desktop/remembered-unlock";
import { enrollConnection } from "../../plugin/src/sync/enrollment";
import { Transport } from "../../plugin/src/sync/transport";
import { randomId } from "../../plugin/src/sync/crypto";
import { SyncDB } from "../../plugin/src/sync/store";
import { SyncEngine } from "../../plugin/src/sync/engine";
import { RecoveryFixture, RecoveryFiles, recoveryHTTP, RECOVERY_PASSPHRASE } from "./recovery-support";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("ordinary device enrollment with real Go HTTP and Docker PG",() => {
  let fixture: RecoveryFixture;
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(true); },20000);
  afterEach(async () => { await fixture?.close(); });
  async function admin(...flags: string[]) {
    const child = spawn(".local/desktop/obsidiansync",["--config",join(fixture.root,"server.json"),"--test-schema",fixture.schema,"--resume-test-schema",...flags],{stdio:"ignore"});
    await new Promise<void>((resolve,reject) => { child.once("error",reject); child.once("exit",code => code===0 ? resolve() : reject(new Error("ADMIN_COMMAND_FAILED"))); });
  }
  function enrollmentClient(name: string) {
    const id = randomId(); const disk = new Map<string,string>();
    // Test-only protector. Actual OS behavior is covered separately and still requires device validation.
    const store = new RememberedUnlock({exists:async p=>disk.has(p),read:async p=>disk.get(p)!,write:async(p,v)=>{disk.set(p,v);}},"pending",{vaultId:fixture.config.vaultId,deviceId:id,databaseId:randomId(),endpoint:fixture.endpoint},{name:"integration-fixture-only",protect:async text=>new TextEncoder().encode(text),unprotect:async bytes=>new TextDecoder().decode(bytes)});
    let loseReceipt = false;
    const remote = new Transport(fixture.endpoint,"",async request => { const response = await recoveryHTTP(request); if (loseReceipt && request.url.endsWith("/enroll") && response.status===200) { loseReceipt=false; throw new Error("RECEIPT_LOST"); } return response; });
    const options = {remote,deviceId:id,vaultId:"",name,key:RECOVERY_PASSPHRASE,pendingStore:async()=>store,stage:()=>{},validate:async()=>{},assertActive:()=>{}};
    return {id,remote,options,store,loseReceipt:()=>{loseReceipt=true;}};
  }
  async function engine(index: number,device: ReturnType<typeof enrollmentClient>,material: StoredMaterial) {
    const files = new RecoveryFiles(join(fixture.root,`ordinary-${index}`)); await mkdir(files.root,{recursive:true});
    const db = new SyncDB(`enrollment-${randomId()}`); await db.open();
    const engine = new SyncEngine(db,device.remote,files,device.id,fixture.config.vaultId); await engine.restoreRemembered(material); await engine.validateConnection();
    const client = {engine,db,files,material,databaseName:db.name}; fixture.clients.push(client); return client;
  }
  it("recovers enrollment receipt loss, gates the second device, then synchronizes in both directions and keeps revocation across restart",async () => {
    const a = enrollmentClient("电脑 A"); a.loseReceipt();
    await expect(enrollConnection(a.options)).rejects.toThrow("RECEIPT_LOST");
    const pending = await a.store.load(); const enrolledA = await enrollConnection(a.options); expect(enrolledA.material.token).toBe(pending!.token);
    const b = enrollmentClient("手机 B"); await expect(enrollConnection(b.options)).rejects.toThrow("ENROLLMENT_CLOSED");
    await admin("--enroll-for","10m"); const enrolledB = await enrollConnection(b.options); await admin("--enroll-for","0");
    const computer = await engine(0,a,enrolledA.material); const phone = await engine(1,b,enrolledB.material);
    await computer.files.edit("computer.md","from computer"); expect((await computer.engine.sync()).errors).toEqual([]); expect((await phone.engine.sync()).errors).toEqual([]); expect(await phone.files.text("computer.md")).toBe("from computer");
    await phone.files.edit("phone.md","from phone"); expect((await phone.engine.sync()).errors).toEqual([]); expect((await computer.engine.sync()).errors).toEqual([]); expect(await computer.files.text("phone.md")).toBe("from phone");
    await admin("--revoke-device",b.id); await expect(b.remote.handshake()).rejects.toThrow("UNAUTHORIZED");
    await fixture.killServer(); await fixture.startServer(true);
    await expect(b.remote.handshake()).rejects.toThrow("UNAUTHORIZED"); expect((await a.remote.handshake()).devices).toHaveLength(2);
    await admin("--enroll-for","10m"); await expect(enrollConnection({...b.options,previous:enrolledB.material})).rejects.toThrow("DEVICE_REVOKED");
  },20000);
  it("requires an open window to rotate a lost credential while preserving the exact device identity",async () => {
    const device = enrollmentClient("电脑"); const first = await enrollConnection(device.options);
    // An expired successful receipt is deliberately removed to simulate the owner's loss of this local protector record.
    await device.store.clear();
    await expect(enrollConnection(device.options)).rejects.toThrow("ENROLLMENT_CLOSED");
    await admin("--enroll-for","1m"); const next = await enrollConnection(device.options);
    expect(next.material.token).not.toBe(first.material.token);
    await expect(new Transport(fixture.endpoint,first.material.token!,recoveryHTTP).handshake()).rejects.toThrow("UNAUTHORIZED");
    expect((await device.remote.handshake()).devices).toEqual([{id:device.id,name:"电脑"}]);
  },20000);
});
