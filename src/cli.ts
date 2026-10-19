#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { projectOf } from './refs';
import { fold } from './snapshot';

const USAGE = 'usage: llmd snapshot [spec]';

export function main(args: string[]): number {
  const [command, file] = args;
  if (command !== 'snapshot') return fail(USAGE);
  const specs = file ? [file] : fs.existsSync('.llmd') ? fs.readdirSync('.llmd').filter((f) => f.endsWith('.llmd')).map((f) => path.join('.llmd', f)) : [];
  if (!specs.length) return fail(`No spec in .llmd/. ${USAGE}`);
  if (!specs.filter(snapshot).length) console.log('Nothing to fold: no done steps besides Current state.');
  return 0;
}

// Folds one spec and archives its folded steps. Returns whether it folded anything.
function snapshot(spec: string): boolean {
  const { text, folded } = fold(fs.readFileSync(spec, 'utf8'));
  if (!folded.length) return false;
  const absolute = path.resolve(spec);
  const archive = path.join(projectOf(absolute) ?? path.dirname(absolute), '.llmd', 'archive', path.basename(spec));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const before = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trimEnd() + '\n\n' : '';
  // Archive first: if the spec write fails, the steps are in both places rather than in neither.
  fs.writeFileSync(archive, before + folded.join('\n\n') + '\n');
  fs.writeFileSync(spec, text);
  const title = (step: string) => step.split(/\r?\n/)[0].replace(/^##\s+\[[xX]\]\s*/, '');
  console.log(`Folded into Current state of ${path.basename(spec)}: ${folded.map(title).join(', ')}`);
  console.log(`Archived in ${path.relative(process.cwd(), archive)}`);
  // ponytail: also matches a "* " line inside a fenced block; fine for a warning
  const free = folded.filter((s) => /^\s*\*\s/m.test(s));
  if (free.length) console.warn(`Warning: ${free.map(title).join(', ')} still had "*" lines, so Current state holds prose there. Replace them with what was built.`);
  return true;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
