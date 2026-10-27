import { parseSource, type Expr, type Field, type Method, type Program, type SourceClass, type Stmt } from './source.js';
import { NONE, Pool, writeClass, type PoolEntry, type RawClass, type RawMember, type RawNode } from './tufa.js';
import { floatLiteralBits, type FloatMode } from './floatlit.js';

const flagBits: Record<string, number> = { public: 1, protected: 2, private: 4, static: 8, abstract: 16, final: 32, native: 64, synchronized: 128 };
const tag: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '!=': 6, '==': 7, '>=': 8, '<=': 9, '>': 10, '<': 11,
  '>>': 13, '<<': 14, '-': 15, '+': 16, '%': 17, '/': 18, '*': 19,
  '~': 20, '!': 21, 'neg': 22, 'post++': 23, 'post--': 24, 'pre++': 25, 'pre--': 26,
  call: 27, literal: 28, new: 30, newarray: 31, instanceof: 32, cast: 33, ctor: 34,
  '=': 35, '*=': 36, '/=': 37, '%=': 38, '+=': 39, '-=': 40, '&=': 44, '^=': 45, '|=': 46,
};
const primitive: Record<string, string> = { void: 'V', int: 'I', float: 'F', double: 'D', boolean: 'Z', byte: 'B', char: 'C', short: 'S', long: 'J' };

export interface CompileOptions {
  build?: number;
  floatMode?: FloatMode;
  /** Package for package-less sources whose class identity comes from the game script path. */
  packageName?: string;
  /** Resolve an external simple or qualified type to its full SLRR class name. */
  resolveType?: (name: string, context: SourceClass, program: Program) => string | undefined;
  /** Return a known field descriptor. Undefined fields are emitted as late-bound names. */
  resolveField?: (owner: string, name: string) => { owner: string; descriptor: string; isStatic?: boolean } | undefined;
  /** Return a known method descriptor. Undefined methods are emitted as late-bound names. */
  resolveMethod?: (owner: string, name: string, argumentsCount: number) => { owner: string; descriptor: string } | undefined;
  /** Convert a symbolic resource ID to its TUFA pack file name and local ID. */
  resolveResource?: (pack: string, id: number) => { pack: string; id: number };
}
export interface CompileResult { ok: boolean; bytes: Uint8Array; classNames: string[]; diagnostics: string[] }

function flags(names: string[]): number { return names.reduce((bits, name) => bits | (flagBits[name] ?? 0), 0); }
function resolveType(name: string, cls: SourceClass, program: Program, options: CompileOptions): string {
  if (primitive[name]) return name;
  if (name.includes('.')) return name;
  if (name === cls.name) return cls.fullName;
  const explicit = program.imports.find(x => x.endsWith(`.${name}`));
  if (explicit) return explicit;
  return options.resolveType?.(name, cls, program) ?? `${program.packageName ? program.packageName + '.' : ''}${name}`;
}
function descriptor(type: string, cls: SourceClass, program: Program, options: CompileOptions): string {
  if (type.endsWith('[]')) return '[' + descriptor(type.slice(0, -2), cls, program, options);
  return primitive[type] ?? `L${resolveType(type, cls, program, options)};`;
}
function methodDescriptor(method: Method, cls: SourceClass, program: Program, options: CompileOptions): string {
  return `(${method.params.map(x => descriptor(x.type, cls, program, options)).join('')})${method.constructor ? '' : descriptor(method.result, cls, program, options)}`;
}
function classOf(desc: string): string | undefined {
  return desc.startsWith('L') && desc.endsWith(';') ? desc.slice(1, -1) : desc.startsWith('[') ? desc : undefined;
}

class Emitter {
  readonly nodes: RawNode[] = [];
  readonly locals = new Map<string, { slot: number; descriptor: string }>();
  private nextLocal = 0;
  private maxLocal = 0;
  private readonly scopes: string[][] = [];
  private readonly breakTargets: number[][] = [];
  private readonly continueTargets: number[][] = [];
  constructor(readonly cls: SourceClass, readonly program: Program, readonly pool: Pool, readonly options: CompileOptions, readonly member: Method | Field, readonly fields: Map<string, string>, readonly methods: Map<string, Method>) {
    if (member.kind === 'method') {
      if (!member.flags.includes('static')) this.declare('this', `L${cls.fullName};`);
      for (const param of [...member.params].reverse()) this.declare(param.name, descriptor(param.type, cls, program, options));
    }
    this.scopes.push([]);
  }
  get localCount(): number { return this.maxLocal; }
  private declare(name: string, desc: string): number { const slot = this.nextLocal++; this.maxLocal = Math.max(this.maxLocal, this.nextLocal); this.locals.set(name, { slot, descriptor: desc }); return slot; }
  private put(op: number, line: number, value?: number): number { this.nodes.push({ op, line, ...(value === undefined ? {} : { value: value >>> 0 }) }); return this.nodes.length - 1; }
  private jump(op: number, line: number): number { return this.put(op, line, 0); }
  private patch(at: number, to = this.nodes.length): void { this.nodes[at].value = (to - at) >>> 0; }
  private type(type: string): string { return descriptor(type, this.cls, this.program, this.options); }
  private field(name: string, line: number): boolean {
    const own = this.fields.get(name);
    const external = this.options.resolveField?.(this.cls.fullName, name);
    const value = own ? { owner: this.cls.fullName, descriptor: own } : external;
    if (value) { this.put(27, line, this.pool.ref(value.owner, name, value.descriptor)); return true; }
    return false;
  }
  private nameSegment(name: string, line: number): void {
    const local = this.locals.get(name);
    if (local) this.put(1, line, local.slot);
    else if (!this.field(name, line)) this.put(18, line, this.pool.utf8(name));
  }
  private name(name: string, line: number): void {
    if (this.locals.has(name) || this.fields.has(name) || this.options.resolveField?.(this.cls.fullName, name)) this.nameSegment(name, line);
    else { this.put(17, line, 1); this.nameSegment(name, line); }
  }
  private resource(text: string): { pack: string; id: number } {
    const at = text.lastIndexOf(':');
    const pack = text.slice(0, at), id = Number.parseInt(text.slice(at + 1, -1), 16);
    return this.options.resolveResource?.(pack, id) ?? { pack: pack.replaceAll('.', '\\') + '.rpk', id };
  }
  private segments(expr: Expr): Expr[] {
    if (expr.kind === 'member') return [...this.segments(expr.left!), expr];
    return [expr];
  }
  private simplePath(expr: Expr): boolean {
    if (expr.kind === 'member') return this.simplePath(expr.left!);
    return ['name', 'this', 'super'].includes(expr.kind);
  }
  private path(expr: Expr, callArgs?: Expr[]): void {
    const segments = this.segments(expr);
    this.put(17, expr.token.line, segments.length);
    let owner: string | undefined;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const lastCall = callArgs !== undefined && i === segments.length - 1;
      if (lastCall) {
        const typed = callArgs.every(arg => this.typedArgument(arg) !== undefined);
        const method = typed && owner ? this.options.resolveMethod?.(owner, segment.text!, callArgs.length) : undefined;
        if (method) this.put(26, segment.token.line, this.pool.ref(owner!, segment.text!, method.descriptor));
        else this.put(18, segment.token.line, this.pool.utf8(segment.text!));
      } else if (segment.kind === 'name') {
        const local = this.locals.get(segment.text!);
        const own = this.fields.get(segment.text!);
        const field = own ? { owner: this.cls.fullName, descriptor: own } : this.options.resolveField?.(this.cls.fullName, segment.text!);
        if (local) { this.put(1, segment.token.line, local.slot); owner = classOf(local.descriptor); }
        else if (field) { this.put(27, segment.token.line, this.pool.ref(field.owner, segment.text!, field.descriptor)); owner = classOf(field.descriptor); }
        else {
          const type = this.options.resolveType?.(segment.text!, this.cls, this.program);
          if (type) { this.put(25, segment.token.line, this.pool.cls(type)); owner = type; }
          else { this.put(18, segment.token.line, this.pool.utf8(segment.text!)); owner = undefined; }
        }
      } else if (segment.kind === 'this' || segment.kind === 'super') {
        this.put(1, segment.token.line, this.locals.get('this')?.slot ?? 0);
        owner = segment.kind === 'this' ? this.cls.fullName : (this.cls.parent ? resolveType(this.cls.parent, this.cls, this.program, this.options) : undefined);
      } else if (segment.kind === 'member') {
        const field = owner ? this.options.resolveField?.(owner, segment.text!) : undefined;
        if (field) { this.put(27, segment.token.line, this.pool.ref(field.owner, segment.text!, field.descriptor)); owner = classOf(field.descriptor); }
        else { this.put(18, segment.token.line, this.pool.utf8(segment.text!)); owner = undefined; }
      }
      else throw new Error(`Unsupported member path at ${segment.token.line}:${segment.token.column}`);
    }
  }
  private typedArgument(expr: Expr): string | undefined {
    if (expr.kind === 'this') return `L${this.cls.fullName};`;
    if (expr.kind === 'name') return this.locals.get(expr.text!)?.descriptor ?? this.fields.get(expr.text!) ?? this.options.resolveField?.(this.cls.fullName, expr.text!)?.descriptor;
    if (expr.kind !== 'literal') return undefined;
    const value = expr.value!;
    if (value === 'null') return 'null';
    if (value.startsWith('"') || value.startsWith("'")) return 'Ljava.lang.String;';
    if (/[.eEfFdD]/.test(value) && !/^0[xX]/.test(value)) return 'F';
    return 'I';
  }
  expr(expr: Expr, used = true): void {
    const line = expr.token.line, outer = used ? 7 : 8;
    switch (expr.kind) {
      case 'paren': this.expr(expr.left!, used); return;
      case 'literal': {
        this.put(outer, line, tag.literal);
        const value = expr.value!;
        if (value.startsWith('"') || value.startsWith("'")) this.put(9, line, this.pool.utf8(decodeString(value)));
        else if (value.includes(':0x') || value.includes(':0X')) { const rid = this.resource(value); this.put(14, line, this.pool.rid(rid.pack, rid.id)); }
        else if (value === 'null') this.put(12, line);
        else if (value === 'true' || value === 'false') this.put(13, line, value === 'true' ? 1 : 0);
        else if (/[.eEfFdD]/.test(value) && !/^0[xX]/.test(value)) this.put(10, line, floatLiteralBits(value, this.options.floatMode));
        else this.put(11, line, Number(value) >>> 0);
        return;
      }
      case 'name': this.name(expr.text!, line); return;
      case 'this': this.put(1, line, this.locals.get('this')?.slot ?? 0); return;
      case 'super': this.put(1, line, this.locals.get('this')?.slot ?? 0); return;
      case 'member':
        if (this.simplePath(expr)) this.path(expr);
        else { this.expr(expr.left!); this.put(28, line, this.pool.utf8(expr.text!)); }
        return;
      case 'index': this.expr(expr.right!); this.expr(expr.left!); this.put(32, line); return;
      case 'assign': {
        this.expr(expr.right!); this.expr(expr.left!); this.put(outer, line, tag[expr.text!] ?? fail(`Unsupported assignment ${expr.text}`, line)); return;
      }
      case 'binary': {
        this.expr(expr.left!);
        if (expr.text === '&&' || expr.text === '||') {
          this.put(expr.text === '&&' ? 4 : 5, line);
          const skip = this.jump(20, line);
          this.expr(expr.right!);
          this.put(outer, line, tag[expr.text]);
          this.patch(skip);
        } else {
          this.expr(expr.right!);
          this.put(outer, line, tag[expr.text!] ?? fail(`Unsupported operator ${expr.text}`, line));
        }
        return;
      }
      case 'unary': case 'postfix': {
        this.expr(expr.left!);
        if (expr.kind === 'unary' && expr.text === '+') return;
        const operation = expr.kind === 'postfix' ? `post${expr.text}` : (expr.text === '-' ? 'neg' : expr.text === '++' || expr.text === '--' ? `pre${expr.text}` : expr.text!);
        this.put(outer, line, tag[operation] ?? fail(`Unsupported unary ${operation}`, line)); return;
      }
      case 'call': {
        const callee = expr.left!;
        if ((callee.kind === 'super' || callee.kind === 'this') && this.member.kind === 'method' && this.member.constructor) {
          for (const arg of expr.args ?? []) this.expr(arg);
          this.put(39, line, expr.args?.length ?? 0);
          this.put(callee.kind === 'super' ? 35 : 34, line);
          this.put(outer, line, tag.ctor);
          return;
        }
        for (const arg of expr.args ?? []) this.expr(arg);
        this.put(39, line, expr.args?.length ?? 0);
        if (callee.kind === 'member' && callee.left?.kind === 'super') {
          this.put(38, line, this.pool.utf8(callee.text!));
          this.put(outer, line, tag.call);
          return;
        }
        if (callee.kind === 'member' && !this.simplePath(callee)) {
          this.expr(callee.left!);
          this.put(37, line, this.pool.utf8(callee.text!));
          this.put(outer, line, tag.call);
          return;
        }
        this.put(36, line);
        if (callee.kind === 'name') {
          const own = this.methods.get(callee.text!);
          const args = expr.args ?? [];
          const typed = args.every(arg => this.typedArgument(arg) !== undefined);
          const known = typed ? (own ? { owner: this.cls.fullName, descriptor: methodDescriptor(own, this.cls, this.program, this.options) } : this.options.resolveMethod?.(this.cls.fullName, callee.text!, args.length)) : undefined;
          if (known) this.put(26, line, this.pool.ref(known.owner, callee.text!, known.descriptor));
          else { this.put(17, line, 1); this.put(18, line, this.pool.utf8(callee.text!)); }
        } else this.path(callee, expr.args ?? []);
        this.put(outer, line, tag.call); return;
      }
      case 'new': {
        const type = this.type(expr.text!);
        this.put(outer, line, tag.new);
        this.put(6, line, this.pool.utf8(type));
        for (const arg of expr.args ?? []) this.expr(arg);
        this.put(39, line, expr.args?.length ?? 0);
        this.put(33, line); return;
      }
      case 'newarray': {
        const type = '[' + this.type(expr.text!);
        this.expr(expr.right!); this.put(outer, line, tag.newarray); this.put(6, line, this.pool.utf8(type)); return;
      }
      case 'cast': {
        this.expr(expr.left!); this.put(outer, line, tag.cast);
        const type = this.type(expr.text!);
        if (type.startsWith('L') && type.endsWith(';')) this.put(25, line, this.pool.cls(type.slice(1, -1)));
        else this.put(6, line, this.pool.utf8(type));
        return;
      }
      case 'instanceof': this.expr(expr.left!); this.put(outer, line, tag.instanceof); this.put(6, line, this.pool.utf8(this.type(expr.right!.text!))); return;
      case 'ternary': this.expr(expr.left!); this.expr(expr.right!); this.expr(expr.third!); this.put(outer, line, 0); return;
      default: throw new Error(`Unsupported expression ${expr.kind} at ${line}:${expr.token.column}`);
    }
  }
  private releaseAll(line: number): void { for (let slot = this.nextLocal - 1; slot >= 0; slot--) this.put(3, line, slot); }
  private enter(): void { this.scopes.push([]); }
  private leave(line: number): void {
    const names = this.scopes.pop()!;
    for (let i = names.length - 1; i >= 0; i--) { const current = this.locals.get(names[i]); if (current) { this.put(3, line, current.slot); this.locals.delete(names[i]); this.nextLocal = current.slot; } }
  }
  stmt(stmt: Stmt): void {
    const line = stmt.token.line;
    switch (stmt.kind) {
      case 'empty': return;
      case 'block': this.enter(); for (const child of stmt.items ?? []) this.stmt(child); this.leave(line); return;
      case 'expr': this.expr(stmt.expr!, false); return;
      case 'exprs': for (const child of stmt.items ?? []) this.stmt(child); return;
      case 'local': {
        for (const field of stmt.declarations ?? []) {
          const desc = this.type(field.type), slot = this.declare(field.name, desc);
          this.scopes.at(-1)!.push(field.name);
          this.put(2, field.token.line, slot); this.put(6, field.token.line, this.pool.utf8(desc));
          if (field.initial) { this.put(44, field.token.line); this.expr(field.initial); this.put(45, field.token.line); }
        }
        return;
      }
      case 'return':
        if (this.member.kind === 'method' && this.member.constructor) { this.put(42, line); this.releaseAll(line); }
        else { if (stmt.expr) { this.expr(stmt.expr); this.put(40, line); } else this.put(41, line); this.releaseAll(line); this.put(43, line); }
        return;
      case 'if': {
        this.expr(stmt.expr!);
        const otherwise = this.jump(21, stmt.endLine ?? line);
        this.stmt(stmt.body!);
        if (stmt.elseBody) { const end = this.jump(20, line); this.patch(otherwise); this.stmt(stmt.elseBody); this.patch(end); }
        else this.patch(otherwise);
        return;
      }
      case 'while': {
        const start = this.nodes.length;
        this.expr(stmt.expr!);
        const end = this.jump(21, line);
        const breaks: number[] = [], continues: number[] = [];
        this.breakTargets.push(breaks); this.continueTargets.push(continues);
        this.stmt(stmt.body!);
        for (const at of continues) this.patch(at, start);
        const back = this.jump(20, line); this.patch(back, start);
        this.patch(end); for (const at of breaks) this.patch(at);
        this.breakTargets.pop(); this.continueTargets.pop(); return;
      }
      case 'for': {
        this.enter(); if (stmt.init) this.stmt(stmt.init);
        const start = this.nodes.length;
        if (stmt.expr) this.expr(stmt.expr);
        const end = stmt.expr ? this.jump(21, line) : -1;
        const breaks: number[] = [], continues: number[] = [];
        this.breakTargets.push(breaks); this.continueTargets.push(continues);
        this.stmt(stmt.body!);
        for (const at of continues) this.patch(at);
        for (const expr of stmt.update ?? []) this.expr(expr, false);
        const back = this.jump(20, line); this.patch(back, start);
        if (end >= 0) this.patch(end);
        for (const at of breaks) this.patch(at);
        this.breakTargets.pop(); this.continueTargets.pop(); this.leave(line); return;
      }
      case 'do': {
        const start = this.nodes.length;
        const breaks: number[] = [], continues: number[] = [];
        this.breakTargets.push(breaks); this.continueTargets.push(continues);
        this.stmt(stmt.body!);
        for (const at of continues) this.patch(at);
        this.expr(stmt.expr!); const back = this.jump(22, line); this.patch(back, start);
        for (const at of breaks) this.patch(at);
        this.breakTargets.pop(); this.continueTargets.pop(); return;
      }
      case 'break': { const target = this.breakTargets.at(-1); if (!target) fail('break outside loop', line); target.push(this.jump(20, line)); return; }
      case 'continue': { const target = this.continueTargets.at(-1); if (!target) fail('continue outside loop', line); target.push(this.jump(20, line)); return; }
      case 'switch': {
        this.expr(stmt.expr!);
        const jumps: { caseIndex: number; jump: number }[] = [];
        for (let i = 0; i < (stmt.cases?.length ?? 0); i++) {
          const group = stmt.cases![i];
          if (group.value) { this.expr(group.value); jumps.push({ caseIndex: i, jump: this.jump(23, line) }); }
        }
        this.put(24, line);
        const defaultJump = this.jump(20, line);
        const breaks: number[] = []; this.breakTargets.push(breaks);
        let defaultStart: number | undefined;
        for (let i = 0; i < (stmt.cases?.length ?? 0); i++) {
          const group = stmt.cases![i], start = this.nodes.length;
          for (const hit of jumps) if (hit.caseIndex === i) this.patch(hit.jump, start);
          if (!group.value) defaultStart = start;
          this.enter(); for (const item of group.items) this.stmt(item); this.leave(line);
        }
        const end = this.nodes.length;
        this.patch(defaultJump, defaultStart ?? end);
        for (const hit of jumps) if (!this.nodes[hit.jump].value) this.patch(hit.jump, end);
        for (const at of breaks) this.patch(at, end);
        this.breakTargets.pop(); return;
      }
      default: throw new Error(`Unsupported statement ${stmt.kind} at ${line}:${stmt.token.column}`);
    }
  }
  finish(): RawNode[] {
    if (this.member.kind === 'field') { this.expr(this.member.initial!); this.put(16, this.member.token.line); }
    else if (this.member.body) {
      const body = this.member.body, close = body.endLine ?? body.token.line;
      if (!this.member.constructor && !(body.items?.length)) return this.nodes;
      const first = body.items?.[0];
      const explicitCtorCall = first?.kind === 'expr' && first.expr?.kind === 'call' && ['super', 'this'].includes(first.expr.left?.kind ?? '');
      if (this.member.constructor && !explicitCtorCall) {
        this.put(39, body.token.line, 0); this.put(35, body.token.line); this.put(8, body.token.line, tag.ctor);
      }
      for (const item of body.items ?? [body]) this.stmt(item);
      if (this.member.constructor) { this.put(42, close); this.releaseAll(close); }
      else if (this.member.result === 'void') { this.put(41, close); this.releaseAll(close); this.put(43, close); }
      this.leave(close);
      this.releaseAll(close);
    }
    return this.nodes;
  }
}

function fail(message: string, line: number): never { throw new Error(`${message} at line ${line}`); }
function decodeString(text: string): string {
  return text.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, escape: string) => escape.startsWith('u') ? String.fromCharCode(Number.parseInt(escape.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '0': '\0' } as Record<string, string>)[escape] ?? escape);
}

function orderedPool(raw: RawClass, seedLength: number): void {
  const old = raw.pool.entries, next = new Pool();
  const text = (index: number): string => { const e = old[index]; if (e?.kind !== 0) throw new Error('Expected UTF8 pool entry'); return e.text; };
  const className = (index: number): string => { const e = old[index]; if (e?.kind !== 4) throw new Error('Expected CLASS pool entry'); return text(e.a); };
  const intern = (index: number): number => {
    const e: PoolEntry | undefined = old[index]; if (!e) throw new Error(`Missing pool entry ${index}`);
    if (e.kind === 0) return next.utf8(e.text);
    if (e.kind === 4) return next.cls(text(e.a));
    if (e.kind === 3) return next.rid(text(e.a), e.b);
    if (e.kind === 7) return next.nat(text(e.a), text(e.b));
    const nat = old[e.b]; if (nat?.kind !== 7) throw new Error('Invalid method/field reference');
    return next.ref(className(e.a), text(nat.a), text(nat.b));
  };
  for (let i = 0; i < seedLength; i++) intern(i);
  const rows = [...raw.staticMethods, ...raw.instanceMethods, ...raw.staticFields, ...raw.instanceFields];
  for (const row of rows) {
    if (row.tree === NONE) continue;
    for (const node of raw.trees[row.tree]) {
      if ([25, 26, 27].includes(node.op)) intern(node.value!);
      else if (node.op === 1 && node.value === 0 && !(row.flags & 8)) next.utf8(`L${raw.name};`);
    }
  }
  for (const nodes of raw.trees) for (const node of nodes) {
    if ([9, 14, 18, 28, 37, 38].includes(node.op)) intern(node.value!);
  }
  for (const nodes of raw.trees) for (const node of nodes) {
    if ([6, 9, 14, 18, 25, 26, 27, 28, 37, 38, 46].includes(node.op)) node.value = intern(node.value!);
  }
  raw.pool = next;
}

function compileClass(cls: SourceClass, program: Program, options: CompileOptions): Uint8Array {
  const pool = new Pool();
  const parentName = cls.parent ? resolveType(cls.parent, cls, program, options) : undefined;
  const effectiveOptions: CompileOptions = {
    ...options,
    resolveField(owner, name) {
      const direct = options.resolveField?.(owner, name);
      if (direct) return direct;
      const inherited = owner === cls.fullName && parentName ? options.resolveField?.(parentName, name) : undefined;
      return inherited ? { owner: inherited.isStatic ? inherited.owner : cls.fullName, descriptor: inherited.descriptor, isStatic: inherited.isStatic } : undefined;
    },
    resolveMethod(owner, name, count) {
      const direct = options.resolveMethod?.(owner, name, count);
      if (direct) return direct;
      const inherited = owner === cls.fullName && parentName ? options.resolveMethod?.(parentName, name, count) : undefined;
      return inherited ? { owner: cls.fullName, descriptor: inherited.descriptor } : undefined;
    },
  };
  const raw: RawClass = {
    name: cls.fullName,
    superName: parentName ?? (cls.fullName === 'java.lang.Object' ? undefined : 'java.lang.Object'),
    interfaces: cls.interfaces.map(x => resolveType(x, cls, program, options)), isInterface: cls.flags.includes('interface'),
    staticFields: [], instanceFields: [], staticMethods: [], instanceMethods: [], trees: [], pool,
  };
  // TUFA's first three pool stages: class hierarchy, type descriptors, then member names.
  pool.cls(raw.name); if (raw.superName) pool.cls(raw.superName); for (const name of raw.interfaces) pool.cls(name);
  const fields = new Map<string, string>(), methods = new Map<string, Method>();
  for (const member of cls.members) {
    if (member.kind === 'field') { const desc = descriptor(member.type, cls, program, options); fields.set(member.name, desc); pool.utf8(desc); }
    else {
      for (const p of member.params) pool.utf8(descriptor(p.type, cls, program, options));
      if (!member.constructor) pool.utf8(descriptor(member.result, cls, program, options));
      methods.set(member.name, member);
    }
  }
  for (const member of cls.members) {
    if (member.kind === 'field') pool.utf8(member.name);
    else { pool.utf8(methodDescriptor(member, cls, program, options)); pool.utf8(member.constructor ? '<init>' : member.name); }
  }
  const seedLength = pool.entries.length;
  for (const member of cls.members) {
    const hasTree = member.kind === 'field' ? !!member.initial : !!member.body;
    const emitter = hasTree ? new Emitter(cls, program, pool, effectiveOptions, member, fields, methods) : undefined;
    const tree = hasTree ? raw.trees.push(emitter!.finish()) - 1 : NONE;
    const row: RawMember = { flags: flags(member.flags), name: member.kind === 'method' && member.constructor ? '<init>' : member.name,
      descriptor: member.kind === 'field' ? descriptor(member.type, cls, program, options) : methodDescriptor(member, cls, program, options), tree,
      ...(member.kind === 'method' ? { locals: emitter?.localCount ?? 0 } : {}) };
    const isStatic = member.flags.includes('static');
    if (member.kind === 'field') (isStatic ? raw.staticFields : raw.instanceFields).push(row);
    else (isStatic ? raw.staticMethods : raw.instanceMethods).push(row);
  }
  orderedPool(raw, seedLength);
  return writeClass(raw, options.build);
}

export function compileSource(source: string | Uint8Array, options: CompileOptions = {}): CompileResult {
  const diagnostics: string[] = [];
  try {
    const text = typeof source === 'string' ? source : Buffer.from(source).toString('latin1');
    const program = parseSource(text);
    if (options.packageName !== undefined) {
      if (program.packageName && program.packageName !== options.packageName) throw new Error(`Source declares package ${program.packageName}, expected ${options.packageName}`);
      program.packageName = options.packageName;
      for (const cls of program.classes) cls.fullName = options.packageName ? `${options.packageName}.${cls.name}` : cls.name;
    }
    const blobs = program.classes.map(cls => compileClass(cls, program, options));
    return { ok: true, bytes: Buffer.concat(blobs), classNames: program.classes.map(x => x.fullName), diagnostics };
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return { ok: false, bytes: new Uint8Array(), classNames: [], diagnostics };
  }
}
