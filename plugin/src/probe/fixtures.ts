export const MIB = 1024 * 1024;
export const ALLOWED_SIZES = [1, 8, 32, 64, 128] as const;
export function fixture(sizeMiB: number): ArrayBuffer {
  if (!(ALLOWED_SIZES as readonly number[]).includes(sizeMiB)) throw new Error("Unsupported fixture size");
  const buffer = new ArrayBuffer(sizeMiB * MIB);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >>> 8)) & 255;
  return buffer;
}
export function verifyFixture(buffer: ArrayBuffer, sizeMiB: number): void {
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== sizeMiB * MIB) throw new Error("Fixture length mismatch");
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== ((i * 31 + (i >>> 8)) & 255)) throw new Error(`Fixture mismatch at byte ${i}`);
  }
}
