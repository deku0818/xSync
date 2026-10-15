/** Preserve the wire/path contract while rejecting ASCII controls without a control-character regex. */
export function hasControlCharacter(value: string, includeDelete = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || includeDelete && code === 127) return true;
  }
  return false;
}
