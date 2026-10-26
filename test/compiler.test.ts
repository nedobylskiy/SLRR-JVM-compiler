import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { compileSource } from '../src/compiler.js';
import { readDeclarations } from '../src/classes.js';
import { floatLiteralBits } from '../src/floatlit.js';
import { parseSource } from '../src/source.js';

const fixture = (name: string): URL => new URL(`../../test/fixtures/${name}`, import.meta.url);

test('Node compiler reproduces the independent slrrc fixture byte for byte', async () => {
  const source = await readFile(fixture('Sample.java'));
  const reference = await readFile(fixture('Sample.class'));
  const result = compileSource(source);
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.deepEqual(Buffer.from(result.bytes), reference);
  const [info] = readDeclarations(result.bytes);
  assert.equal(info.name, 'example.Sample');
  assert.deepEqual(info.methods.map(x => x.name), ['run', 'choose']);
});

test('Build 940 decimal conversion follows SSE float32 steps', () => {
  assert.equal(floatLiteralBits('0.69'), 0x3f30a3d8);
  assert.equal(floatLiteralBits('0.9'), 0x3f666667);
  assert.equal(floatLiteralBits('1.9'), 0x3ff33334);
  assert.equal(floatLiteralBits('.5'), 0);
  assert.equal(floatLiteralBits('4294967297.5'), 0x3fc00000);
});

test('parser accepts SLRR resource ids, member calls and switch', () => {
  const program = parseSource(`package example; public class Flow {
    public int run(int x) {
      switch (x) { case 1: return 2; default: return 3; }
    }
    public void sound() { new ResourceRef(parts.engines.M20B25:0x05r).cache(); }
  }`);
  assert.equal(program.classes[0].members.length, 2);
  const result = compileSource(`package example; public class Flow {
    public int run(int x) { switch (x) { case 1: return 2; default: return 3; } }
  }`);
  assert.equal(result.ok, true, result.diagnostics.join('; '));
  assert.equal(readDeclarations(result.bytes)[0].name, 'example.Flow');
});
