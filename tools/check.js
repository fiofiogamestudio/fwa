import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['bin', 'src', 'test', 'tools', 'examples'];

export async function collectJavaScriptFiles(projectRoot, directories = roots) {
  const files = [];
  async function collect(relativeDirectory) {
    const directory = path.join(projectRoot, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await collect(relativePath);
      } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/u.test(entry.name)) {
        files.push(relativePath);
      }
    }
  }
  for (const directory of directories) await collect(directory);
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const files = await collectJavaScriptFiles(root);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      process.exit(result.status || 1);
    }
  }
  process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
}
