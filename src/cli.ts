#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ClassIndex } from './classes.js';
import { compileSource } from './compiler.js';
import type { FloatMode } from './floatlit.js';

function usage(): never {
  console.error('Usage: slrr-compile [--root GAME] [--out CACHE | --check | --compare] [--float A|B|C|D] [--build N] [SOURCE.java ...]');
  process.exit(2);
}

async function* sources(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.java')) yield path;
  }
}

function outputPath(source: string, root: string | undefined, out: string | undefined): string {
  const parent = dirname(source), owner = basename(parent).toLowerCase() === 'src' ? dirname(parent) : parent;
  const target = `${basename(source).replace(/\.java$/i, '')}.class`;
  if (!out) return join(owner, target);
  const rel = root ? relative(root, owner) : '';
  return join(out, rel.startsWith('..') || isAbsolute(rel) ? '' : rel, target);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2), files: string[] = [];
  let root: string | undefined, out: string | undefined, check = false, compare = false, floatMode: FloatMode = 'B', build = 0x24f9d;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') root = resolve(args[++i] ?? usage());
    else if (arg === '--out') out = resolve(args[++i] ?? usage());
    else if (arg === '--check') check = true;
    else if (arg === '--compare') compare = true;
    else if (arg === '--float') { const mode = args[++i]; if (!['A', 'B', 'C', 'D'].includes(mode)) usage(); floatMode = mode as FloatMode; }
    else if (arg === '--build') { build = Number(args[++i] ?? usage()); if (!Number.isInteger(build) || build < 0 || build > 0xffffffff) usage(); }
    else if (arg.startsWith('-')) usage();
    else files.push(resolve(arg));
  }
  if (Number(check) + Number(compare) + Number(!!out) !== 1) usage();
  if (!files.length) { if (!root) usage(); for await (const file of sources(root)) files.push(file); }
  if (root && out && (relative(root, out) === '' || !relative(root, out).startsWith('..'))) {
    console.error('Output directory must be outside the game root'); process.exit(2);
  }
  const index = new ClassIndex();
  if (root) { const result = await index.addDirectory(root); console.error(`Indexed ${result.classes} classes from ${result.files} files (${result.failed} skipped)`); }
  let succeeded = 0, failed = 0, different = 0;
  for (const file of files) {
    try {
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
      const result = compileSource(await readFile(file), { ...index.compileOptions(), build, floatMode });
      if (!result.ok) throw new Error(result.diagnostics.join('; '));
      const target = outputPath(file, root, out);
      if (compare) {
        const existing = await readFile(target);
        if (!existing.equals(Buffer.from(result.bytes))) { different++; console.error(`DIFFERENT ${file}`); }
        else console.log(`IDENTICAL ${file}`);
      } else if (out) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, result.bytes); console.log(`Wrote ${target}`); }
      succeeded++;
    } catch (error) { failed++; console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  console.error(`compiled ${succeeded} of ${files.length} sources; ${failed} failed${compare ? `, ${different} different` : ''}`);
  if (failed || different) process.exitCode = 1;
}

await main();
