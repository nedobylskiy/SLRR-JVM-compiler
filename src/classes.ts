import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompileOptions } from './compiler.js';
import type { Program, SourceClass } from './source.js';

export interface ClassField { name: string; descriptor: string; flags: number }
export interface ClassMethod { name: string; descriptor: string; flags: number }
export interface ClassInfo { name: string; parent?: string; interfaces: string[]; fields: ClassField[]; methods: ClassMethod[] }

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  get left(): number { return this.bytes.length - this.offset; }
  take(n: number): Uint8Array { if (n < 0 || n > this.left) throw new Error('Truncated TUFA'); const b = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return b; }
  u32(): number { const b = this.take(4); return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true); }
  tag(): string { return Buffer.from(this.take(4)).toString('ascii'); }
}

function parsePool(bytes: Uint8Array): ({ kind: number; text?: string; a?: number; b?: number })[] {
  const r = new Reader(bytes), count = r.u32(), entries = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u32();
    if (kind === 0) { const n = r.u32(), text = Buffer.from(r.take(n)).toString('latin1'); r.take(1); entries.push({ kind, text }); }
    else if (kind === 4) entries.push({ kind, a: r.u32() });
    else if ([3, 5, 7].includes(kind)) entries.push({ kind, a: r.u32(), b: r.u32() });
    else throw new Error(`Unexpected TUFA pool tag ${kind}`);
  }
  return entries;
}

function parseRows(bytes: Uint8Array | undefined, methods: boolean, utf8: (index: number) => string): (ClassField | ClassMethod)[] {
  if (!bytes) return [];
  const r = new Reader(bytes), result: (ClassField | ClassMethod)[] = [];
  for (let group = 0; group < 2; group++) {
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const flags = r.u32(), name = utf8(r.u32()), descriptor = utf8(r.u32());
      r.u32(); if (methods) r.u32();
      result.push({ flags, name, descriptor });
    }
  }
  return result;
}

export function readDeclarations(bytes: Uint8Array): ClassInfo[] {
  const r = new Reader(bytes), result: ClassInfo[] = [];
  while (r.left) {
    if (r.tag() !== 'TUFA') throw new Error('Expected TUFA header');
    r.take(r.u32());
    const chunks = new Map<string, Uint8Array>();
    while (!chunks.has('TREE')) { const tag = r.tag(); chunks.set(tag, r.take(r.u32())); }
    const constants = parsePool(chunks.get('CONS') ?? new Uint8Array());
    const utf8 = (index: number): string => { const c = constants[index]; if (c?.kind !== 0) throw new Error('Expected UTF8'); return c.text!; };
    const className = (index: number): string => { const c = constants[index]; if (c?.kind !== 4) throw new Error('Expected class'); return utf8(c.a!); };
    const cls = new Reader(chunks.get('CLSS') ?? new Uint8Array());
    cls.u32(); cls.u32(); const name = className(cls.u32()), parentIndex = cls.u32(), count = cls.u32();
    const interfaces = Array.from({ length: count }, () => className(cls.u32()));
    const fields = parseRows(chunks.get('FILD'), false, utf8);
    const methods = parseRows(chunks.get('MTHD'), true, utf8);
    result.push({ name, parent: parentIndex === 0xffffffff ? undefined : className(parentIndex), interfaces, fields, methods });
  }
  return result;
}

export class ClassIndex {
  readonly classes = new Map<string, ClassInfo>();
  add(info: ClassInfo): void { if (info.name) this.classes.set(info.name.toLowerCase(), info); }
  get(name: string): ClassInfo | undefined { return this.classes.get(name.toLowerCase()); }
  addClassFile(bytes: Uint8Array): void { for (const info of readDeclarations(bytes)) this.add(info); }
  async addDirectory(directory: string): Promise<{ files: number; classes: number; failed: number }> {
    let files = 0, classes = 0, failed = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.class')) {
          files++;
          try { const found = readDeclarations(await readFile(path)); for (const info of found) this.add(info); classes += found.length; }
          catch { failed++; }
        }
      }
    };
    await walk(directory);
    return { files, classes, failed };
  }
  resolveType(name: string, context: SourceClass, program: Program): string | undefined {
    if (name.includes('.')) return this.get(name)?.name ?? name;
    const own = `${program.packageName}.${name}`;
    if (this.get(own)) return this.get(own)!.name;
    for (const imported of program.imports) {
      const candidate = imported.endsWith('.*') ? imported.slice(0, -1) + name : imported;
      if ((imported.endsWith('.*') || imported.endsWith(`.${name}`)) && this.get(candidate)) return this.get(candidate)!.name;
    }
    const lang = `java.lang.${name}`;
    return this.get(lang)?.name;
  }
  resolveField(owner: string, name: string): { owner: string; descriptor: string; isStatic: boolean } | undefined {
    let current = this.get(owner); const seen = new Set<string>();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      const field = current.fields.find(x => x.name === name);
      if (field) return { owner: (field.flags & 8) ? current.name : owner, descriptor: field.descriptor, isStatic: !!(field.flags & 8) };
      current = current.parent ? this.get(current.parent) : undefined;
    }
    return undefined;
  }
  resolveMethod(owner: string, name: string, argumentCount: number): { owner: string; descriptor: string } | undefined {
    let current = this.get(owner); const seen = new Set<string>();
    while (current && !seen.has(current.name)) {
      seen.add(current.name);
      const method = current.methods.find(x => x.name === name && parameterCount(x.descriptor) === argumentCount);
      if (method) return { owner, descriptor: method.descriptor };
      current = current.parent ? this.get(current.parent) : undefined;
    }
    return undefined;
  }
  compileOptions(): CompileOptions {
    return {
      resolveType: (name, context, program) => this.resolveType(name, context, program),
      resolveField: (owner, name) => this.resolveField(owner, name),
      resolveMethod: (owner, name, args) => this.resolveMethod(owner, name, args),
    };
  }
}

function parameterCount(descriptor: string): number {
  if (!descriptor.startsWith('(')) return -1;
  let at = 1, count = 0;
  while (descriptor[at] && descriptor[at] !== ')') {
    while (descriptor[at] === '[') at++;
    if (descriptor[at] === 'L') { const end = descriptor.indexOf(';', at); if (end < 0) return -1; at = end + 1; }
    else at++;
    count++;
  }
  return count;
}
