#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { projectOf } from './refs';
import { fold, foldInto, takeNamed } from './snapshot';

const USAGE = 'usage: llmd snapshot [spec]';

export function main(args: string[]): number {
  const [command, file] = args;
  if (command !== 'snapshot') return fail(USAGE);
  const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.llmd')).map((f) => path.join(dir, f)) : []);
  const specs = file ? [file] : [...list('.llmd'), ...list(path.join('.llmd', 'drafts'))];
  if (!specs.length) return fail(`No spec in .llmd/. ${USAGE}`);
  if (!specs.filter(snapshot).length) console.log('Nothing to fold: no done steps besides Current state.');
  return 0;
}

// Folds one spec's done steps: those that name a snapshot into .llmd/snapshots/<name>.llmd, the others into the spec's own
// Current state, archiving them. Returns whether it folded anything.
function snapshot(spec: string): boolean {
  const absolute = path.resolve(spec);
  const original = fs.readFileSync(spec, 'utf8');
  const named = takeNamed(original);
  for (const step of named.steps) {
    const target = path.join(projectOf(absolute) ?? path.dirname(absolute), '.llmd', 'snapshots', step.name + '.llmd');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
    fs.writeFileSync(target, foldInto(before, step.lines, step.name, original.match(/^lang:.*$/m)?.[0]));
    console.log(`Folded ${step.lines[0].replace(/^##\s+\[[xX]\]\s*/, '')} into ${path.relative(process.cwd(), target)}`);
  }
  // A draft with no steps left is done with.
  if (named.steps.length && /[\\/]\.llmd[\\/]drafts[\\/]/.test(absolute) && !/^##\s/m.test(named.text)) fs.rmSync(spec);
  else if (named.steps.length) fs.writeFileSync(spec, named.text);
  if (!fs.existsSync(spec)) return true;
  const { text, folded } = fold(named.text);
  if (!folded.length) return named.steps.length > 0;
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
