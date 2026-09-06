const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:\/|$)/;
const WINDOWS_RESERVED_CHARACTER_PATTERN = /[<>:"|]/u;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function evidence(code, path, message, details = undefined) {
  const item = { code, path, message };
  if (details !== undefined) {
    item.details = details;
  }
  return Object.freeze(item);
}

function freezeResult(result) {
  return Object.freeze({
    ...result,
    declaredWrites: Object.freeze([...result.declaredWrites]),
    actualWrites: Object.freeze([...result.actualWrites]),
    violations: Object.freeze([...result.violations])
  });
}

export class EffectPatternError extends Error {
  constructor(errors) {
    super(`Effect pattern validation failed with ${errors.length} error(s).`);
    this.name = 'EffectPatternError';
    this.code = 'FWA_INVALID_EFFECT_PATTERN';
    this.errors = Object.freeze([...errors]);
  }
}

export class WriteSetViolationError extends Error {
  constructor(result) {
    super(`Actual writes exceeded the declared write set in ${result.violations.length} place(s).`);
    this.name = 'WriteSetViolationError';
    this.code = 'FWA_WRITE_SET_VIOLATION';
    this.evidence = result;
  }
}

function normalizeRelative(value, { allowGlobs, path: fieldPath }) {
  const errors = [];
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    errors.push(evidence(
      'INVALID_PATH',
      fieldPath,
      'Expected a non-empty, trimmed path string.'
    ));
    throw new EffectPatternError(errors);
  }
  if (value.includes('\0')) {
    errors.push(evidence('NUL_IN_PATH', fieldPath, 'NUL bytes are not allowed in paths.'));
  }
  if (/[\u0001-\u001f\u007f]/u.test(value)) {
    errors.push(evidence(
      'CONTROL_CHARACTER_IN_PATH',
      fieldPath,
      'Control characters are not allowed in workspace paths.'
    ));
  }
  if (value.includes('\\')) {
    errors.push(evidence(
      'BACKSLASH_IN_PATH',
      fieldPath,
      'Use portable forward slashes in workspace paths.'
    ));
  }
  if (/^ref:\/\//i.test(value)) {
    errors.push(evidence(
      'UNSUPPORTED_REF_PATH',
      fieldPath,
      'ref:// paths require an adapter mapping and are not supported by this slice.'
    ));
  }
  if (value.startsWith('/') || value.startsWith('//') || WINDOWS_DRIVE_PATH.test(value)) {
    errors.push(evidence(
      'ABSOLUTE_PATH',
      fieldPath,
      'Workspace paths must be relative.'
    ));
  }
  if (!allowGlobs && /[*?]/.test(value)) {
    errors.push(evidence(
      'GLOB_IN_ACTUAL_PATH',
      fieldPath,
      'An actual write must identify one concrete workspace path.'
    ));
  }

  const parts = value.split('/');
  if (parts.includes('..')) {
    errors.push(evidence(
      'PARENT_TRAVERSAL',
      fieldPath,
      'Parent traversal segments are not allowed.'
    ));
  }
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue;
    if (WINDOWS_RESERVED_CHARACTER_PATTERN.test(part)) {
      errors.push(evidence(
        'WINDOWS_RESERVED_CHARACTER',
        fieldPath,
        `Path segment ${index} contains a Windows-reserved character.`
      ));
    }
    if (/[ .]$/u.test(part)) {
      errors.push(evidence(
        'WINDOWS_AMBIGUOUS_SEGMENT',
        fieldPath,
        `Path segment ${index} ends with a dot or space and is not portable.`
      ));
    }
    if (WINDOWS_DEVICE_NAME_PATTERN.test(part)) {
      errors.push(evidence(
        'WINDOWS_DEVICE_NAME',
        fieldPath,
        `Path segment ${index} is a reserved Windows device name.`
      ));
    }
    if (part.toLocaleLowerCase('en-US') === '.git') {
      errors.push(evidence(
        'RESERVED_GIT_PATH',
        fieldPath,
        'Git administrative paths are outside every executor write set.'
      ));
    }
    if (index === 0 && part.toLocaleLowerCase('en-US') === '.fwa') {
      errors.push(evidence(
        'RESERVED_FWA_PATH',
        fieldPath,
        'The root .fwa namespace is reserved for orchestration state.'
      ));
    }
  }
  if (errors.length > 0) {
    throw new EffectPatternError(errors);
  }

  const normalized = parts.filter((part) => part !== '' && part !== '.').join('/');
  if (normalized.length === 0) {
    throw new EffectPatternError([
      evidence('WORKSPACE_ROOT_PATH', fieldPath, 'The workspace root is not a writable file path.')
    ]);
  }
  return normalized;
}

export function normalizeEffectPattern(pattern, options = {}) {
  return normalizeRelative(pattern, {
    allowGlobs: true,
    path: options.path ?? 'pattern'
  });
}

export function normalizeWorkspacePath(workspacePath, options = {}) {
  return normalizeRelative(workspacePath, {
    allowGlobs: false,
    path: options.path ?? 'path'
  });
}

export function normalizeWritePatterns(patterns, options = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new EffectPatternError([
      evidence(
        'INVALID_WRITE_SET',
        options.path ?? 'writes',
        'Expected a non-empty array of declared write patterns.'
      )
    ]);
  }

  const normalized = [];
  const errors = [];
  const seen = new Set();
  for (let index = 0; index < patterns.length; index += 1) {
    try {
      const pattern = normalizeEffectPattern(patterns[index], {
        path: `${options.path ?? 'writes'}[${index}]`
      });
      const key = options.ignoreCase ? pattern.toLocaleLowerCase('en-US') : pattern;
      if (seen.has(key)) {
        errors.push(evidence(
          'DUPLICATE_WRITE_PATTERN',
          `${options.path ?? 'writes'}[${index}]`,
          `Duplicate normalized write pattern "${pattern}".`,
          { pattern }
        ));
      } else {
        seen.add(key);
        normalized.push(pattern);
      }
    } catch (error) {
      if (error instanceof EffectPatternError) {
        errors.push(...error.errors);
      } else {
        throw error;
      }
    }
  }
  if (errors.length > 0) {
    throw new EffectPatternError(errors);
  }
  return Object.freeze(normalized);
}

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      while (pattern[index + 1] === '*') {
        index += 1;
      }
      if (pattern[index + 1] === '/') {
        source += '(?:.*/)?';
        index += 1;
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

export function matchesEffectPattern(pattern, workspacePath, options = {}) {
  const normalizedPattern = normalizeEffectPattern(pattern);
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const expression = new RegExp(
    `^${globSource(normalizedPattern)}$`,
    options.ignoreCase ? 'iu' : 'u'
  );
  return expression.test(normalizedPath);
}

export function validateActualWrites(declaredWrites, actualWrites, options = {}) {
  const normalizedPatterns = normalizeWritePatterns(declaredWrites, {
    path: options.declaredPath ?? 'declaredWrites',
    ignoreCase: options.ignoreCase === true
  });
  if (!Array.isArray(actualWrites)) {
    throw new TypeError('actualWrites must be an array of workspace paths.');
  }

  const normalizedActual = [];
  const violations = [];
  for (let index = 0; index < actualWrites.length; index += 1) {
    let actualWrite;
    try {
      actualWrite = normalizeWorkspacePath(actualWrites[index], {
        path: `${options.actualPath ?? 'actualWrites'}[${index}]`
      });
      normalizedActual.push(actualWrite);
    } catch (error) {
      if (!(error instanceof EffectPatternError)) {
        throw error;
      }
      violations.push(evidence(
        'INVALID_ACTUAL_WRITE',
        `${options.actualPath ?? 'actualWrites'}[${index}]`,
        'The executor reported an invalid concrete workspace path.',
        { actualWrite: actualWrites[index], errors: error.errors }
      ));
      continue;
    }

    const matched = normalizedPatterns.some((pattern) => (
      matchesEffectPattern(pattern, actualWrite, { ignoreCase: options.ignoreCase === true })
    ));
    if (!matched) {
      violations.push(evidence(
        'WRITE_OUT_OF_SCOPE',
        `${options.actualPath ?? 'actualWrites'}[${index}]`,
        `Write "${actualWrite}" is outside the declared write set.`,
        {
          actualWrite,
          declaredWrites: normalizedPatterns
        }
      ));
    }
  }

  const result = freezeResult({
    ok: violations.length === 0,
    declaredWrites: normalizedPatterns,
    actualWrites: normalizedActual,
    violations
  });
  if (!result.ok && options.throwOnViolation === true) {
    throw new WriteSetViolationError(result);
  }
  return result;
}

export function assertActualWrites(declaredWrites, actualWrites, options = {}) {
  return validateActualWrites(declaredWrites, actualWrites, {
    ...options,
    throwOnViolation: true
  });
}
