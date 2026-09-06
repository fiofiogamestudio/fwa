import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
  MAX_COMMAND_TIMEOUT_MS,
  normalizeCommandEvaluationManifest
} from './command-evaluator.js';

export const UNITY_EVALUATION_MODE = 'editmode';
export const DEFAULT_UNITY_PROFILE_ID = 'unity-v0.1';
export const DEFAULT_UNITY_COMPILE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_UNITY_EDITMODE_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_UNITY_COMPILE_LOG_PATH = 'Library/fwa-compile-editor.log';
export const DEFAULT_UNITY_EDITMODE_LOG_PATH = 'Library/fwa-editmode-editor.log';
export const DEFAULT_UNITY_TEST_RESULTS_PATH = 'Library/fwa-editmode-results.xml';

const MAX_PROJECT_VERSION_FILE_BYTES = 64 * 1024;
const NUNIT_VALIDATION_TIMEOUT_MS = 30_000;
const PROFILE_FIELDS = Object.freeze([
  'projectRoot',
  'editorPath',
  'profileId',
  'mode',
  'compileTimeoutMs',
  'editModeTimeoutMs',
  'editModeBatchMode',
  'editModeNoGraphics',
  'testResultsPath'
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[/\\]|$)/u;
const WINDOWS_RESERVED_CHARACTER_PATTERN = /[<>:"|?*]/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

const NUNIT_XML_VALIDATOR_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const filePath = process.argv[1];
const fail = (message) => {
  process.stderr.write('Invalid NUnit XML: ' + message + '\n');
  process.exit(1);
};
if (typeof filePath !== 'string' || filePath.length === 0) fail('missing result path');
let source;
try {
  source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath));
} catch (error) {
  fail(error && error.message ? error.message : 'cannot read UTF-8 result');
}
source = source.replace(/^\uFEFF/u, '');
let cursor = 0;
let root = null;
let rootAttributes = null;
let rootClosed = false;
const stack = [];
const outsideText = (text) => {
  if (stack.length === 0 && text.trim().length > 0) fail('text outside the root element');
};
const tagEnd = (start) => {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
};
const attributes = (input) => {
  const result = Object.create(null);
  let rest = input.trim();
  while (rest.length > 0) {
    const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*/u.exec(rest);
    if (!match) fail('malformed attribute list');
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) fail('duplicate attribute ' + match[1]);
    result[key] = match[2] === undefined ? match[3] : match[2];
    rest = rest.slice(match[0].length);
  }
  return result;
};
while (cursor < source.length) {
  const opening = source.indexOf('<', cursor);
  if (opening === -1) {
    outsideText(source.slice(cursor));
    cursor = source.length;
    break;
  }
  outsideText(source.slice(cursor, opening));
  if (source.startsWith('<!--', opening)) {
    const end = source.indexOf('-->', opening + 4);
    if (end === -1) fail('unterminated comment');
    cursor = end + 3;
    continue;
  }
  if (source.startsWith('<![CDATA[', opening)) {
    if (stack.length === 0) fail('CDATA outside the root element');
    const end = source.indexOf(']]>', opening + 9);
    if (end === -1) fail('unterminated CDATA');
    cursor = end + 3;
    continue;
  }
  if (source.startsWith('<?', opening)) {
    const end = source.indexOf('?>', opening + 2);
    if (end === -1) fail('unterminated processing instruction');
    cursor = end + 2;
    continue;
  }
  if (source.startsWith('<!', opening)) fail('unsupported declaration');
  const end = tagEnd(opening + 1);
  if (end === -1) fail('unterminated tag');
  let body = source.slice(opening + 1, end).trim();
  const closing = body.startsWith('/');
  if (closing) body = body.slice(1).trim();
  const selfClosing = !closing && body.endsWith('/');
  if (selfClosing) body = body.slice(0, -1).trim();
  const nameMatch = /^([A-Za-z_:][A-Za-z0-9_.:-]*)/u.exec(body);
  if (!nameMatch) fail('invalid element name');
  const name = nameMatch[1];
  const remainder = body.slice(name.length);
  if (closing) {
    if (remainder.trim().length > 0) fail('closing tag contains extra data');
    if (stack.length === 0 || stack.pop() !== name) fail('mismatched closing tag ' + name);
    if (stack.length === 0) rootClosed = true;
  } else {
    const parsedAttributes = attributes(remainder);
    if (stack.length === 0) {
      if (root !== null || rootClosed) fail('multiple root elements');
      root = name;
      rootAttributes = parsedAttributes;
    }
    if (!selfClosing) stack.push(name);
    else if (stack.length === 0) rootClosed = true;
  }
  cursor = end + 1;
}
if (root === null || stack.length !== 0 || !rootClosed) fail('incomplete document');
const rootName = root.toLowerCase();
const count = (name, { positive = false, required = true } = {}) => {
  const value = rootAttributes[name];
  if (value === undefined && !required) return null;
  if (!/^\d+$/u.test(value || '')) fail('invalid ' + name + ' count');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) {
    fail((positive ? 'non-positive ' : 'invalid ') + name + ' count');
  }
  return parsed;
};
if (rootName === 'test-run') {
  if ((rootAttributes.result || '').toLowerCase() !== 'passed') {
    fail('NUnit test-run result is not Passed');
  }
  const total = count('total', { positive: true });
  const passed = count('passed', { positive: true });
  const failed = count('failed');
  if (failed !== 0) {
    fail('NUnit test-run reports failed tests');
  }
  if (passed > total) fail('NUnit test-run passed count exceeds total');
} else if (rootName === 'test-results') {
  const total = count('total', { positive: true });
  for (const name of ['errors', 'failures']) {
    if (count(name) !== 0) {
      fail('NUnit test-results reports ' + name);
    }
  }
  const notRun = count('not-run', { required: false });
  if (notRun !== null && notRun >= total) fail('NUnit test-results has no executed tests');
} else {
  fail('expected NUnit test-run or test-results root');
}
`.trim();

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function frozenDetails(details) {
  return details === undefined ? undefined : Object.freeze({ ...details });
}

export class UnityEvaluatorProfileError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'UnityEvaluatorProfileError';
    this.code = code;
    if (details !== undefined) this.details = frozenDetails(details);
  }
}

function fail(code, message, details = undefined) {
  throw new UnityEvaluatorProfileError(code, message, details);
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\0')
    || !path.isAbsolute(value)) {
    fail(
      'FWA_INVALID_UNITY_PATH',
      `${name} must be a non-empty, trimmed absolute path without NUL bytes.`,
      { field: name }
    );
  }
  return path.resolve(value);
}

function requireProfileId(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || !IDENTIFIER_PATTERN.test(value)) {
    fail(
      'FWA_INVALID_UNITY_PROFILE_ID',
      'profileId must be a portable CommandEvaluator identifier.',
      { field: 'profileId' }
    );
  }
  return value;
}

function requireMode(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.toLocaleLowerCase('en-US') !== UNITY_EVALUATION_MODE) {
    fail(
      'FWA_UNSUPPORTED_UNITY_MODE',
      'Only Unity EditMode evaluation is supported by the V0.1 profile.',
      { mode: value }
    );
  }
  return UNITY_EVALUATION_MODE;
}

function requireTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMMAND_TIMEOUT_MS) {
    fail(
      'FWA_INVALID_UNITY_TIMEOUT',
      `${name} must be an integer from 1 through ${MAX_COMMAND_TIMEOUT_MS}.`,
      { field: name, value }
    );
  }
  return value;
}

function requireBooleanOption(value, name, fallback = false) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'boolean') {
    fail(
      'FWA_INVALID_UNITY_PROFILE_OPTIONS',
      `${name} must be a boolean when supplied.`,
      { field: name, value }
    );
  }
  return selected;
}

function requireTestResultsPath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || WINDOWS_DRIVE_PATH.test(value)
    || !value.toLocaleLowerCase('en-US').endsWith('.xml')) {
    fail(
      'FWA_INVALID_UNITY_RESULTS_PATH',
      'testResultsPath must be a trimmed, portable workspace-relative .xml path.',
      { field: 'testResultsPath' }
    );
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0
      || part === '.'
      || part === '..'
      || /[\u0001-\u001f\u007f]/u.test(part)
      || WINDOWS_RESERVED_CHARACTER_PATTERN.test(part)
      || /[ .]$/u.test(part)
      || WINDOWS_DEVICE_NAME_PATTERN.test(part))
    || ['.git', '.fwa'].includes(parts[0].toLocaleLowerCase('en-US'))) {
    fail(
      'FWA_INVALID_UNITY_RESULTS_PATH',
      'testResultsPath contains an unsafe or non-portable path segment.',
      { field: 'testResultsPath' }
    );
  }
  return value;
}

async function requireDirectory(targetPath, field) {
  let canonical;
  let information;
  try {
    canonical = await realpath(targetPath);
    information = await stat(canonical);
  } catch (error) {
    fail(
      'FWA_INVALID_UNITY_PATH',
      `${field} does not resolve to an existing directory.`,
      { field, path: targetPath, causeCode: error?.code ?? null }
    );
  }
  if (!information.isDirectory()) {
    fail(
      'FWA_INVALID_UNITY_PATH',
      `${field} must resolve to a directory.`,
      { field, path: targetPath }
    );
  }
  return canonical;
}

async function requireEditor(targetPath) {
  let canonical;
  let information;
  try {
    canonical = await realpath(targetPath);
    information = await stat(canonical);
  } catch (error) {
    fail(
      'FWA_INVALID_UNITY_EDITOR',
      'editorPath does not resolve to an existing file.',
      { path: targetPath, causeCode: error?.code ?? null }
    );
  }
  if (!information.isFile()) {
    fail(
      'FWA_INVALID_UNITY_EDITOR',
      'editorPath must resolve to a regular file.',
      { path: targetPath }
    );
  }
  return canonical;
}

export async function inspectUnityProject(projectRoot) {
  const requestedRoot = requireAbsolutePath(projectRoot, 'projectRoot');
  const canonicalRoot = await requireDirectory(requestedRoot, 'projectRoot');
  const versionFile = path.join(canonicalRoot, 'ProjectSettings', 'ProjectVersion.txt');
  let information;
  let contents;
  try {
    information = await stat(versionFile);
    if (!information.isFile() || information.size > MAX_PROJECT_VERSION_FILE_BYTES) {
      fail(
        'FWA_NOT_UNITY_PROJECT',
        'ProjectSettings/ProjectVersion.txt must be a small regular file.',
        { projectRoot: canonicalRoot }
      );
    }
    contents = await readFile(versionFile, 'utf8');
  } catch (error) {
    if (error instanceof UnityEvaluatorProfileError) throw error;
    fail(
      'FWA_NOT_UNITY_PROJECT',
      'projectRoot is not a Unity project with ProjectSettings/ProjectVersion.txt.',
      { projectRoot: canonicalRoot, causeCode: error?.code ?? null }
    );
  }
  const match = /^m_EditorVersion:\s*([^\s]+)\s*$/mu.exec(contents.replace(/^\uFEFF/u, ''));
  if (!match || match[1].length > 128 || /[\u0000-\u001f\u007f]/u.test(match[1])) {
    fail(
      'FWA_INVALID_UNITY_PROJECT_VERSION',
      'ProjectVersion.txt does not contain a valid m_EditorVersion entry.',
      { projectRoot: canonicalRoot }
    );
  }
  return Object.freeze({
    projectRoot: canonicalRoot,
    projectVersionPath: versionFile,
    editorVersion: match[1]
  });
}

export async function createUnityEvaluatorProfile(options = {}) {
  if (!isPlainObject(options)) {
    fail('FWA_INVALID_UNITY_PROFILE_OPTIONS', 'Unity profile options must be a plain object.');
  }
  for (const field of Object.keys(options)) {
    if (!PROFILE_FIELDS.includes(field)) {
      fail(
        'FWA_INVALID_UNITY_PROFILE_OPTIONS',
        `Unknown Unity profile option "${field}".`,
        { field }
      );
    }
  }

  const requestedRoot = requireAbsolutePath(options.projectRoot, 'projectRoot');
  const requestedEditor = requireAbsolutePath(options.editorPath, 'editorPath');
  const profileId = requireProfileId(options.profileId ?? DEFAULT_UNITY_PROFILE_ID);
  requireMode(options.mode ?? UNITY_EVALUATION_MODE);
  const compileTimeoutMs = requireTimeout(
    options.compileTimeoutMs ?? DEFAULT_UNITY_COMPILE_TIMEOUT_MS,
    'compileTimeoutMs'
  );
  const editModeTimeoutMs = requireTimeout(
    options.editModeTimeoutMs ?? DEFAULT_UNITY_EDITMODE_TIMEOUT_MS,
    'editModeTimeoutMs'
  );
  const editModeBatchMode = requireBooleanOption(
    options.editModeBatchMode,
    'editModeBatchMode',
    true
  );
  const editModeNoGraphics = requireBooleanOption(
    options.editModeNoGraphics,
    'editModeNoGraphics'
  );
  if (!editModeBatchMode && editModeNoGraphics) {
    fail(
      'FWA_INVALID_UNITY_PROFILE_OPTIONS',
      'editModeNoGraphics requires editModeBatchMode=true.',
      { fields: ['editModeBatchMode', 'editModeNoGraphics'] }
    );
  }
  const testResultsPath = requireTestResultsPath(
    options.testResultsPath ?? DEFAULT_UNITY_TEST_RESULTS_PATH
  );

  await inspectUnityProject(requestedRoot);
  const editorPath = await requireEditor(requestedEditor);
  return normalizeCommandEvaluationManifest({
    schemaVersion: COMMAND_EVALUATION_MANIFEST_SCHEMA_VERSION,
    id: profileId,
    checks: [
      {
        id: 'unity-compile',
        kind: 'compile',
        command: editorPath,
        args: [
          '-batchmode',
          '-nographics',
          '-projectPath',
          '.',
          '-forgetProjectPath',
          '-logFile',
          DEFAULT_UNITY_COMPILE_LOG_PATH,
          '-quit'
        ],
        timeoutMs: compileTimeoutMs,
        expectedExitCodes: [0],
        cwd: '.',
        captureOutput: false,
        expectedArtifacts: [{ path: DEFAULT_UNITY_COMPILE_LOG_PATH }]
      },
      {
        id: 'unity-editmode-tests',
        kind: 'test',
        command: editorPath,
        args: [
          ...(editModeBatchMode ? ['-batchmode'] : []),
          ...(editModeNoGraphics ? ['-nographics'] : []),
          '-projectPath',
          '.',
          '-forgetProjectPath',
          '-runTests',
          '-testPlatform',
          'EditMode',
          '-testResults',
          testResultsPath,
          '-logFile',
          DEFAULT_UNITY_EDITMODE_LOG_PATH
        ],
        timeoutMs: editModeTimeoutMs,
        expectedExitCodes: [0],
        cwd: '.',
        captureOutput: false,
        expectedArtifacts: [
          { path: testResultsPath },
          { path: DEFAULT_UNITY_EDITMODE_LOG_PATH }
        ]
      },
      {
        id: 'unity-editmode-results',
        kind: 'test-report',
        command: process.execPath,
        args: ['-e', NUNIT_XML_VALIDATOR_SOURCE, '--', testResultsPath],
        timeoutMs: NUNIT_VALIDATION_TIMEOUT_MS,
        expectedExitCodes: [0],
        cwd: '.',
        expectedArtifacts: []
      }
    ]
  });
}
