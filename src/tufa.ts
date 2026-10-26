/** TUFA constant pool and binary writer. Integers in SLRR class files are little-endian. */
export const NONE = 0xffffffff;
export const OP_FLAGS = [
  0x0000, 0x1001, 0x1002, 0x1003, 0x0004, 0x0005, 0x1006, 0x1007,
  0x1008, 0x4009, 0x200a, 0x100b, 0x000c, 0x100d, 0x100e, 0x100f,
  0x0010, 0x1011, 0x4012, 0x0013, 0x1014, 0x1015, 0x1016, 0x1017,
  0x0018, 0x1019, 0x101a, 0x101b, 0x401c, 0x001d, 0x101e, 0x101f,
  0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x4025, 0x4026, 0x1027,
  0x0028, 0x0029, 0x002a, 0x002b, 0x002c, 0x002d, 0x402e, 0x0000,
] as const;

export type PoolEntry =
  | { kind: 0; text: string }
  | { kind: 3 | 7 | 5; a: number; b: number }
  | { kind: 4; a: number };

export class Pool {
  readonly entries: PoolEntry[] = [];
  private readonly index = new Map<string, number>();
  utf8(text: string): number {
    const key = `0:${text}`;
    const old = this.index.get(key); if (old !== undefined) return old;
    const i = this.entries.length;
    this.entries.push({ kind: 0, text }); this.index.set(key, i); return i;
  }
  private entry(kind: 3 | 4 | 5 | 7, a: number, b = 0): number {
    const key = `${kind}:${a}:${b}`;
    const old = this.index.get(key); if (old !== undefined) return old;
    const i = this.entries.length;
    this.entries.push(kind === 4 ? { kind, a } : { kind, a, b }); this.index.set(key, i); return i;
  }
  cls(name: string): number { return this.entry(4, this.utf8(name)); }
  nat(name: string, descriptor: string): number { return this.entry(7, this.utf8(name), this.utf8(descriptor)); }
  ref(owner: string, name: string, descriptor: string): number { return this.entry(5, this.cls(owner), this.nat(name, descriptor)); }
  rid(pack: string, id: number): number { return this.entry(3, this.utf8(pack), id >>> 0); }
}

export interface RawMember { flags: number; name: string; descriptor: string; tree: number; locals?: number }
export interface RawNode { op: number; line: number; value?: number }
export interface RawClass {
  name: string;
  superName?: string;
  interfaces: string[];
  isInterface: boolean;
  staticFields: RawMember[];
  instanceFields: RawMember[];
  staticMethods: RawMember[];
  instanceMethods: RawMember[];
  trees: RawNode[][];
  pool: Pool;
}

const u8 = (n: number): Buffer => Buffer.from([n & 255]);
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 65535); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const join = (...items: Buffer[]): Buffer => Buffer.concat(items);
function chunk(tag: string, data: Buffer): Buffer { return join(Buffer.from(tag, 'ascii'), u32(data.length), data); }

function members(pool: Pool, values: RawMember[], methods: boolean): Buffer {
  return join(u32(values.length), ...values.map(row => join(
    u32(row.flags), u32(pool.utf8(row.name)), u32(pool.utf8(row.descriptor)),
    u32(row.tree), ...(methods ? [u32(row.locals ?? 0)] : []),
  )));
}

export function writeClass(raw: RawClass, build = 0x24f9d): Uint8Array {
  const pool = raw.pool;
  const name = pool.cls(raw.name), parent = raw.superName ? pool.cls(raw.superName) : NONE;
  const interfaces = raw.interfaces.map(x => pool.cls(x));
  // Member names and descriptors must be present before CONS is serialized.
  for (const row of [...raw.staticFields, ...raw.instanceFields, ...raw.staticMethods, ...raw.instanceMethods]) {
    pool.utf8(row.name); pool.utf8(row.descriptor);
  }
  const cons = join(u32(pool.entries.length), ...pool.entries.map(entry => {
    if (entry.kind === 0) {
      const bytes = Buffer.from(entry.text, 'latin1');
      return join(u32(0), u32(bytes.length), bytes, u8(0));
    }
    if (entry.kind === 4) return join(u32(4), u32(entry.a));
    return join(u32(entry.kind), u32(entry.a), u32(entry.b));
  }));
  const fild = join(members(pool, raw.staticFields, false), members(pool, raw.instanceFields, false));
  const mthd = join(members(pool, raw.staticMethods, true), members(pool, raw.instanceMethods, true));
  const clss = join(u32(NONE), u32(raw.isInterface ? 1 : 0), u32(name), u32(parent), u32(interfaces.length), ...interfaces.map(u32));
  const trees = join(u32(raw.trees.length), ...raw.trees.map(nodes => join(u32(nodes.length), ...nodes.map(node => {
    if (!Number.isInteger(node.line) || node.line < 0 || node.line > 65535) throw new RangeError('TREE line exceeds u16');
    if (node.op <= 0 || node.op >= OP_FLAGS.length - 1) throw new RangeError(`Unknown TREE opcode ${node.op}`);
    return join(u8(node.op), u16(node.line), ...((OP_FLAGS[node.op] >>> 12) ? [u32(node.value ?? 0)] : []));
  }))));
  return join(
    chunk('TUFA', u32(build)), chunk('CONS', cons),
    ...((raw.staticFields.length || raw.instanceFields.length) ? [chunk('FILD', fild)] : []),
    ...((raw.staticMethods.length || raw.instanceMethods.length) ? [chunk('MTHD', mthd)] : []),
    chunk('CLSS', clss), chunk('TREE', trees),
  );
}

export function floatBits(value: number): number { const b = Buffer.alloc(4); b.writeFloatLE(Math.fround(value)); return b.readUInt32LE(); }
