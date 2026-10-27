/** Parser for the Java-like source language used by SLRR scripts. */
export interface Token { text: string; line: number; column: number; kind: 'id' | 'number' | 'string' | 'resource' | 'symbol' | 'eof' }
export interface Expr { kind: string; token: Token; text?: string; value?: string; left?: Expr; right?: Expr; third?: Expr; args?: Expr[] }
export interface Field { kind: 'field'; name: string; type: string; flags: string[]; initial?: Expr; token: Token }
export interface Method { kind: 'method'; name: string; result: string; params: { type: string; name: string }[]; flags: string[]; body?: Stmt; token: Token; constructor: boolean }
export interface Stmt { kind: string; token: Token; endLine?: number; expr?: Expr; body?: Stmt; elseBody?: Stmt; items?: Stmt[]; init?: Stmt; update?: Expr[]; declarations?: Field[]; cases?: { value?: Expr; items: Stmt[] }[] }
export interface SourceClass { name: string; fullName: string; parent?: string; interfaces: string[]; flags: string[]; members: (Field | Method)[]; token: Token }
export interface Program { packageName: string; imports: string[]; classes: SourceClass[] }

const keywords = new Set('package import class interface extends implements public private protected static final abstract native synchronized void int float double boolean byte char short long new return if else for while do switch case default break continue this super null true false instanceof'.split(' '));
const symbols = ['>>>=', '<<=', '>>=', '>>>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'];
const punct = new Set('{}()[];,.?:=+-*/%&|^~!<>'.split(''));
const resourcePattern = /^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*:0[xX][0-9a-fA-F]+r\b/;
const numberPattern = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[fFdD]?/;

export function scan(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0, line = 1, col = 1;
  const advance = (value: string): void => {
    for (const ch of value) if (ch === '\n') { line++; col = 1; } else col++;
    i += value.length;
  };
  while (i < source.length) {
    const rest = source.slice(i), char = rest[0];
    if (/\s/.test(char)) { advance(char); continue; }
    if (rest.startsWith('//')) { advance(rest.slice(0, rest.indexOf('\n') < 0 ? rest.length : rest.indexOf('\n'))); continue; }
    if (rest.startsWith('/*')) { const end = rest.indexOf('*/', 2); if (end < 0) throw new SyntaxError(`Unclosed comment at ${line}:${col}`); advance(rest.slice(0, end + 2)); continue; }
    const token: Token = { text: '', line, column: col, kind: 'symbol' };
    const resource = resourcePattern.exec(rest);
    if (resource) { token.text = resource[0]; token.kind = 'resource'; }
    else if (char === '"' || char === "'") {
      let end = 1;
      while (end < rest.length) { if (rest[end] === '\\') end += 2; else if (rest[end++] === char) break; }
      if (rest[end - 1] !== char) throw new SyntaxError(`Unclosed string at ${line}:${col}`);
      token.text = rest.slice(0, end); token.kind = 'string';
    } else {
      const number = numberPattern.exec(rest);
      if (number) { token.text = number[0]; token.kind = 'number'; }
      else {
        const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
        if (identifier) { token.text = identifier[0]; token.kind = 'id'; }
        else { token.text = symbols.find(x => rest.startsWith(x)) ?? (punct.has(char) ? char : ''); }
      }
    }
    if (!token.text) throw new SyntaxError(`Unexpected character ${JSON.stringify(char)} at ${line}:${col}`);
    tokens.push(token); advance(token.text);
  }
  tokens.push({ text: '<eof>', line, column: col, kind: 'eof' });
  return tokens;
}

const precedence: Record<string, number> = {
  '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '&=': 1, '|=': 1, '^=': 1, '<<=': 1, '>>=': 1, '>>>=': 1,
  '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8, '<': 9, '>': 9, '<=': 9, '>=': 9, 'instanceof': 9,
  '<<': 10, '>>': 10, '>>>': 10, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12,
};
const modifiers = new Set('public private protected static final abstract native synchronized'.split(' '));

class Parser {
  i = 0;
  constructor(readonly tokens: Token[]) {}
  peek(n = 0): Token { return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]; }
  at(text: string): boolean { return this.peek().text === text; }
  eat(text: string): boolean { if (this.at(text)) { this.i++; return true; } return false; }
  need(text: string): Token { const token = this.peek(); if (!this.eat(text)) this.error(`Expected ${text}, got ${token.text}`); return token; }
  error(message: string): never { const t = this.peek(); throw new SyntaxError(`${message} at ${t.line}:${t.column}`); }
  name(): string { const t = this.peek(); if (t.kind !== 'id' || keywords.has(t.text)) this.error(`Expected identifier, got ${t.text}`); this.i++; return t.text; }
  qualified(): string {
    let result = this.name();
    if (this.eat(':')) result += ':' + (this.eat('*') ? '*' : this.name());
    while (this.eat('.')) result += '.' + (this.eat('*') ? '*' : this.name());
    return result;
  }
  baseType(): string {
    let result: string;
    if (['void', 'int', 'float', 'double', 'boolean', 'byte', 'char', 'short', 'long'].includes(this.peek().text)) result = this.tokens[this.i++].text;
    else result = this.qualified();
    return result;
  }
  type(): string { let result = this.baseType(); while (this.at('[') && this.peek(1).text === ']') { this.i += 2; result += '[]'; } return result; }
  flags(): string[] { const result: string[] = []; while (modifiers.has(this.peek().text)) result.push(this.tokens[this.i++].text); return result; }
  program(): Program {
    const packageName = this.eat('package') ? this.qualified() : '';
    if (packageName) this.need(';');
    const imports: string[] = [];
    while (this.eat('import')) { imports.push(this.qualified()); this.need(';'); }
    const classes: SourceClass[] = [];
    while (this.peek().kind !== 'eof') classes.push(this.classDeclaration(packageName));
    if (!classes.length) this.error('No classes declared');
    return { packageName, imports, classes };
  }
  classDeclaration(packageName: string): SourceClass {
    const flags = this.flags(), token = this.peek();
    if (!this.eat('class') && !this.eat('interface')) this.error('Expected class or interface');
    const name = this.name(), fullName = packageName ? `${packageName}.${name}` : name;
    const parent = this.eat('extends') ? this.qualified() : undefined;
    const interfaces: string[] = [];
    if (this.eat('implements')) do { interfaces.push(this.qualified()); } while (this.eat(','));
    this.need('{');
    const members: (Field | Method)[] = [];
    while (!this.eat('}')) {
      if (this.peek().kind === 'eof') this.error('Unclosed class');
      if (this.eat(';')) continue;
      const memberFlags = this.flags(), start = this.peek(), first = this.type();
      if (this.at('(')) {
        members.push(this.method(first, first, memberFlags, start, true));
        continue;
      }
      const name = this.name();
      if (this.at('(')) members.push(this.method(name, first, memberFlags, start, false));
      else {
        let current = name;
        do {
          let type = first;
          while (this.eat('[')) { this.need(']'); type += '[]'; }
          members.push({ kind: 'field', name: current, type, flags: memberFlags, initial: this.eat('=') ? this.expression(2) : undefined, token: start });
          if (!this.eat(',')) break;
          current = this.name();
        } while (true);
        this.need(';');
      }
    }
    return { name, fullName, parent, interfaces, flags, members, token };
  }
  method(name: string, result: string, flags: string[], token: Token, constructor: boolean): Method {
    this.need('(');
    const params: { type: string; name: string }[] = [];
    if (!this.eat(')')) {
      do { const type = this.type(), name = this.name(); params.push({ type, name }); } while (this.eat(','));
      this.need(')');
    }
    while (this.eat('[')) { this.need(']'); result += '[]'; }
    const body = this.eat(';') ? undefined : this.statement();
    return { kind: 'method', name, result: constructor ? 'void' : result, params, flags, body, token, constructor };
  }
  private localStart(): boolean {
    let p = this.i;
    if (this.tokens[p]?.text === 'final') p++;
    if (this.tokens[p]?.kind !== 'id' || (keywords.has(this.tokens[p].text) && !['int', 'float', 'double', 'boolean', 'byte', 'char', 'short', 'long'].includes(this.tokens[p].text))) return false;
    p++;
    while (this.tokens[p]?.text === '.') { p++; if (this.tokens[p++]?.kind !== 'id') return false; }
    while (this.tokens[p]?.text === '[' && this.tokens[p + 1]?.text === ']') p += 2;
    return this.tokens[p]?.kind === 'id' && !keywords.has(this.tokens[p].text);
  }
  private local(expectSemi: boolean): Stmt {
    const token = this.peek(), flags = this.flags(), type = this.type(), declarations: Field[] = [];
    do {
      const name = this.name(); let fullType = type;
      while (this.eat('[')) { this.need(']'); fullType += '[]'; }
      declarations.push({ kind: 'field', name, type: fullType, flags, initial: this.eat('=') ? this.expression(2) : undefined, token });
    } while (this.eat(','));
    if (expectSemi) this.need(';');
    return { kind: 'local', token, declarations };
  }
  statement(): Stmt {
    const token = this.peek();
    if (this.eat('{')) {
      const items: Stmt[] = [];
      while (!this.at('}')) { if (this.peek().kind === 'eof') this.error('Unclosed block'); items.push(this.statement()); }
      const endLine = this.need('}').line;
      return { kind: 'block', token, endLine, items };
    }
    if (this.eat(';')) return { kind: 'empty', token };
    if (this.eat('if')) { this.need('('); const expr = this.expression(); this.need(')'); const body = this.statement(); const endLine = this.peek().line; return { kind: 'if', token, endLine, expr, body, elseBody: this.eat('else') ? this.statement() : undefined }; }
    if (this.eat('while')) { this.need('('); const expr = this.expression(); this.need(')'); return { kind: 'while', token, expr, body: this.statement() }; }
    if (this.eat('do')) { const body = this.statement(); this.need('while'); this.need('('); const expr = this.expression(); this.need(')'); this.need(';'); return { kind: 'do', token, expr, body }; }
    if (this.eat('for')) {
      this.need('('); let init: Stmt | undefined;
      if (!this.at(';')) init = this.localStart() ? this.local(false) : { kind: 'exprs', token: this.peek(), items: this.expressionList().map(expr => ({ kind: 'expr', token: expr.token, expr })) };
      this.need(';'); const expr = this.at(';') ? undefined : this.expression(); this.need(';');
      const update = this.at(')') ? [] : this.expressionList(); this.need(')');
      return { kind: 'for', token, init, expr, update, body: this.statement() };
    }
    if (this.eat('return')) { const expr = this.at(';') ? undefined : this.expression(); this.need(';'); return { kind: 'return', token, expr }; }
    if (this.eat('break')) { this.need(';'); return { kind: 'break', token }; }
    if (this.eat('continue')) { this.need(';'); return { kind: 'continue', token }; }
    if (this.eat('switch')) {
      this.need('('); const expr = this.expression(); this.need(')'); this.need('{');
      const cases: { value?: Expr; items: Stmt[] }[] = [];
      while (!this.eat('}')) {
        let value: Expr | undefined;
        if (this.eat('case')) { value = this.expression(); this.need(':'); }
        else { this.need('default'); this.need(':'); }
        const items: Stmt[] = [];
        while (!this.at('case') && !this.at('default') && !this.at('}')) items.push(this.statement());
        cases.push({ value, items });
      }
      return { kind: 'switch', token, expr, cases };
    }
    if (this.localStart()) return this.local(true);
    const expr = this.expression(); this.need(';'); return { kind: 'expr', token, expr };
  }
  expressionList(): Expr[] { const values = [this.expression()]; while (this.eat(',')) values.push(this.expression()); return values; }
  expression(min = 1): Expr {
    let left = this.prefix();
    for (;;) {
      const token = this.peek();
      if (this.eat('.')) { left = { kind: 'member', token, left, text: this.name() }; continue; }
      if (this.eat('(')) { const args = this.at(')') ? [] : this.expressionList(); this.need(')'); left = { kind: 'call', token, left, args }; continue; }
      if (this.eat('[')) { const right = this.expression(); this.need(']'); left = { kind: 'index', token, left, right }; continue; }
      if (this.at('++') || this.at('--')) { this.i++; left = { kind: 'postfix', token, left, text: token.text }; continue; }
      if (this.at('?') && min <= 2) { this.i++; const right = this.expression(); this.need(':'); left = { kind: 'ternary', token, left, right, third: this.expression(2) }; continue; }
      const priority = precedence[token.text];
      if (priority === undefined || priority < min) break;
      this.i++;
      if (token.text === 'instanceof') { const right: Expr = { kind: 'type', token: this.peek(), text: this.type() }; left = { kind: 'instanceof', token, left, right }; }
      else left = { kind: priority === 1 ? 'assign' : 'binary', token, text: token.text, left, right: this.expression(priority === 1 ? priority : priority + 1) };
    }
    return left;
  }
  prefix(): Expr {
    const token = this.peek(); this.i++;
    if (['number', 'string', 'resource'].includes(token.kind) || ['true', 'false', 'null'].includes(token.text)) return { kind: 'literal', token, value: token.text };
    if (['!', '~', '-', '+', '++', '--'].includes(token.text)) return { kind: 'unary', token, text: token.text, left: this.expression(13) };
    if (token.text === '(') {
      // A type followed by ')' and an operand is a cast; otherwise it is a grouped expression.
      const saved = this.i;
      try { const type = this.type(); if (this.eat(')') && !this.at(';')) return { kind: 'cast', token, text: type, left: this.expression(13) }; } catch { /* grouped expression */ }
      this.i = saved; const expr = this.expression(); this.need(')'); return { kind: 'paren', token, left: expr };
    }
    if (token.text === 'new') {
      const type = this.baseType();
      if (this.eat('(')) { const args = this.at(')') ? [] : this.expressionList(); this.need(')'); return { kind: 'new', token, text: type, args }; }
      if (this.eat('[')) { const right = this.expression(); this.need(']'); return { kind: 'newarray', token, text: type, right }; }
      this.error('Expected new type constructor or array size');
    }
    if (token.kind === 'id') return { kind: token.text === 'this' || token.text === 'super' ? token.text : 'name', token, text: token.text };
    this.error(`Unexpected expression token ${token.text}`);
  }
}

export function parseSource(source: string): Program { return new Parser(scan(source)).program(); }
