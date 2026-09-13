#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReviewConfig } from '../src/application/review-config.js';

const usage = 'node tools/create-review-config.mjs --validation <acceptance.json> --regression <regression.json> --target <branch> --output <review.json>';
try {
  const args = process.argv.slice(2), values = new Map();
  if (args.includes('--help')) { process.stdout.write(`${usage}\nCombines existing evaluator profiles; does not execute them or modify a project.\n`); }
  else {
    for (let index = 0; index < args.length; index += 2) {
      const [key, value] = args.slice(index, index + 2);
      if (!['--validation', '--regression', '--target', '--output'].includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error(usage);
      values.set(key, value);
    }
    if (values.size !== 4) throw new Error(usage);
    const read = async key => JSON.parse(await readFile(path.resolve(values.get(key)), 'utf8'));
    const config = { schemaVersion: 1, targetRef: values.get('--target'), validationProfiles: [await read('--validation')], regressionProfile: await read('--regression') };
    const checked = normalizeReviewConfig(config), output = path.resolve(values.get('--output'));
    await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output, targetRef: checked.targetRef, criteria: checked.validationProfiles[0].checks.map(check => check.id),
      next: `start.bat --project <initialized-project> --allow-write --review-config "${output}" --check` }, null, 2) + '\n');
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
