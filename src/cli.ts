#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { projectOf } from './refs';
import { fold } from './snapshot';

const USAGE = 'usage: llmd snapshot [spec]';

export function main(args: string[]): number {
  const [command, file] = args;
  if (command !== 'snapshot') return fail(USAGE);
  let spec = file;
  if (!spec) {
    const specs = fs.existsSync('.llmd') ? fs.readdirSync('.llmd').filter((f) => f.endsWith('.llmd')) : [];
    if (specs.length !== 1) return fail(specs.length ? `Several specs, name one: ${specs.join(', ')}` : `No spec in .llmd/. ${USAGE}`);
    spec = path.join('.llmd', specs[0]);
  }

  const { text, folded } = fold(fs.readFileSync(spec, 'utf8'));
  if (!folded.length) {
    console.log('Nothing to fold: no done steps besides Current state.');
    return 0;
  }
  const absolute = path.resolve(spec);
  const archive = path.join(projectOf(absolute) ?? path.dirname(absolute), '.llmd', 'archive', path.basename(spec));
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const before = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trimEnd() + '\n\n' : '';
  // Archive first: if the spec write fails, the steps are in both places rather than in neither.
  fs.writeFileSync(archive, before + folded.join('\n\n') + '\n');
  fs.writeFileSync(spec, text);
  console.log(`Folded into Current state: ${folded.map((s) => s.split(/\r?\n/)[0].replace(/^##\s+\[[xX]\]\s*/, '')).join(', ')}`);
  console.log(`Archived in ${path.relative(process.cwd(), archive)}`);
  return 0;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
