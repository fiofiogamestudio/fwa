import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUnityEvaluatorProfile } from '../../src/index.js';

const [project, editor, output, option, ...extra] = process.argv.slice(2);
if (!project || !editor || !output || extra.length
  || (option !== undefined && option !== '--editmode-no-batch')) {
  throw new Error('Usage: node examples/unity/generate-profile.mjs <project> <Unity executable> <output.json> [--editmode-no-batch]');
}
const profile = await createUnityEvaluatorProfile({
  projectRoot: path.resolve(project), editorPath: path.resolve(editor),
  profileId: 'unity-project-checks', editModeBatchMode: option !== '--editmode-no-batch'
});
const destination = path.resolve(output);
await writeFile(destination, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${destination}\n`);
