#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['bin', 'src', 'test', 'tools', 'examples', 'docs'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function sourceSnapshot(projectRoot = root) {
  const names = ['package.json', 'README.md', '.editorconfig', '.gitignore', '.npmignore'];
  async function visit(relative) {
    for (const entry of await readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`Snapshot refuses non-regular source entry: ${name}`);
    }
  }
  for (const directory of directories) await visit(directory);
  const files = [];
  for (const name of names.sort()) {
    const bytes = await readFile(path.join(projectRoot, name));
    files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { schemaVersion: 1, algorithm: 'sha256', digest: sha256(JSON.stringify(files)), files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command = 'show', file] = process.argv.slice(2);
  if (!['show', 'write', 'verify'].includes(command) || (command !== 'show' && !file)
    || process.argv.length > (command === 'show' ? 3 : 4)) {
    throw new Error('Usage: node tools/source-snapshot.mjs [show | write <new.json> | verify <snapshot.json>]');
  }
  const snapshot = await sourceSnapshot();
  if (command === 'verify') {
    const expected = JSON.parse(await readFile(file, 'utf8'));
    if (JSON.stringify(expected) !== JSON.stringify(snapshot)) {
      throw new Error('Source snapshot does not match: rerun validation against the current source.');
    }
    console.log(`SOURCE_SNAPSHOT_OK ${snapshot.files.length} files ${snapshot.digest}`);
  } else if (command === 'write') {
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    console.log(`SOURCE_SNAPSHOT_WRITTEN ${snapshot.files.length} files ${snapshot.digest}`);
  } else console.log(JSON.stringify(snapshot, null, 2));
}
