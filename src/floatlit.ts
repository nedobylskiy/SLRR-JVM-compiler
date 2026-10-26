/** SLRR's decimal-to-float routine. Mode B is the Build 940 SSE path. */
export type FloatMode = 'A' | 'B' | 'C' | 'D';
const f32 = Math.fround;
const bitPattern = (value: number): number => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b.readUInt32LE(); };
const tenth = f32(0.1);

export function floatLiteralBits(text: string, mode: FloatMode = 'B'): number {
  const clean = text.replace(/[fFdD]$/, '');
  const match = /^(\d*)\.(\d*)$/.exec(clean);
  if (!match) return bitPattern(f32(Number(clean)));
  const [, integer, fractionRaw] = match;
  if (!integer) return 0;
  let whole = 0;
  for (const char of integer) whole = (Math.imul(whole, 10) + (char.charCodeAt(0) - 48)) >>> 0;
  const fraction = fractionRaw.slice(0, 1024);
  let value = mode === 'D' ? whole : f32(whole), scale = mode === 'B' || mode === 'D' ? tenth : 1;
  for (const char of fraction) {
    const digit = char.charCodeAt(0) - 48;
    if (mode === 'B') { const part = f32(digit * scale); scale = f32(scale * tenth); value = f32(value + part); }
    else if (mode === 'C') { scale = f32(scale / 10); value = f32(value + digit * scale); }
    else if (mode === 'D') { value += digit * scale; scale /= 10; }
    else { scale = f32(scale / 10); value = f32(value + f32(digit * scale)); }
  }
  return bitPattern(value);
}
