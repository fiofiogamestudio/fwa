const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null)
);

const aliases = Object.freeze({
  dependsOn: ['dependsOn', 'depends_on'],
  capabilities: ['capabilities', 'requires'],
  acceptance: ['acceptance', 'acceptanceContract', 'acceptance_contract'],
  maxRetries: ['maxRetries', 'max_retries'],
  maxFiles: ['maxFiles', 'max_files'],
  maxDiffLines: ['maxDiffLines', 'max_diff_lines'],
  wallTimeMinutes: ['wallTimeMinutes', 'wall_time_minutes'],
  tokenBudget: ['tokenBudget', 'token_budget']
});

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_SEMANTIC_LIMITS = Object.freeze({ textBytes: 2000, derivedChildren: 8 });
export const PLAN_BUDGET_LIMITS = Object.freeze({
  maxRetries: 100,
  maxFiles: 100_000,
  maxDiffLines: 10_000_000,
  wallTimeMinutes: 10_080,
  tokenBudget: 100_000_000
});

function addError(errors, code, path, message, details = undefined) {
  const error = { code, path, message };
  if (details !== undefined) {
    error.details = details;
  }
  errors.push(Object.freeze(error));
}

function validateKnownFields(value, allowed, path, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      addError(
        errors,
        'UNKNOWN_FIELD',
        path === '$' ? field : `${path}.${field}`,
        `Unknown field "${field}".`
      );
    }
  }
}

function aliasedValue(object, names, path, errors) {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length > 1) {
    addError(
      errors,
      'AMBIGUOUS_FIELD',
      path,
      `Use only one of: ${names.join(', ')}.`,
      { fields: present }
    );
  }
  return present.length === 0 ? undefined : object[present[0]];
}

function validateIdentifier(value, path, errors, required = true) {
  if (value === undefined && !required) {
    return false;
  }
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    addError(errors, 'INVALID_ID', path, 'Expected a non-empty, trimmed string.');
    return false;
  }
  return true;
}

function validateStringList(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    addError(errors, 'INVALID_LIST', path, 'Expected an array of strings.');
    return [];
  }
  if (nonEmpty && value.length === 0) {
    addError(errors, 'EMPTY_LIST', path, 'Expected at least one item.');
  }

  const validValues = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string' || item.length === 0 || item !== item.trim()) {
      addError(
        errors,
        'INVALID_LIST_ITEM',
        itemPath,
        'Expected a non-empty, trimmed string.'
      );
      continue;
    }
    if (seen.has(item)) {
      addError(errors, 'DUPLICATE_LIST_ITEM', itemPath, `Duplicate item "${item}".`);
      continue;
    }
    seen.add(item);
    validValues.push(item);
  }
  return validValues;
}

function validateSemanticText(value, path, errors) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || new TextEncoder().encode(value).byteLength > PLAN_SEMANTIC_LIMITS.textBytes) {
    addError(errors, 'INVALID_SEMANTIC_TEXT', path,
      `Expected non-empty, trimmed text of at most ${PLAN_SEMANTIC_LIMITS.textBytes} UTF-8 bytes.`);
  }
}

function validateNodeMeaning(node, dependencies, path, errors) {
  const hasOutcome = Object.hasOwn(node, 'outcome');
  const hasReasons = Object.hasOwn(node, 'dependencyReasons');
  // Historical authored plans have neither field. Never invent an explanation for them.
  if (hasOutcome !== hasReasons) addError(errors, 'INCOMPLETE_NODE_MEANING', path,
    'outcome and dependencyReasons must be declared together.');
  if (hasOutcome) validateSemanticText(node.outcome, `${path}.outcome`, errors);
  if (hasReasons) {
    if (!Array.isArray(node.dependencyReasons)) addError(errors, 'INVALID_DEPENDENCY_REASONS', `${path}.dependencyReasons`, 'Expected an array of edge explanations.');
    else {
      const seen = new Set();
      for (const [index, item] of node.dependencyReasons.entries()) {
        const itemPath = `${path}.dependencyReasons[${index}]`;
        if (!isPlainObject(item)) { addError(errors, 'INVALID_DEPENDENCY_REASON', itemPath, 'Expected nodeId and reason.'); continue; }
        validateKnownFields(item, ['nodeId', 'reason'], itemPath, errors);
        validateIdentifier(item.nodeId, `${itemPath}.nodeId`, errors);
        validateSemanticText(item.reason, `${itemPath}.reason`, errors);
        if (seen.has(item.nodeId) || !dependencies.includes(item.nodeId)) addError(errors, 'DEPENDENCY_REASON_MISMATCH', itemPath,
          'Each dependency must have exactly one explanation and no unrelated explanation.');
        seen.add(item.nodeId);
      }
      if (dependencies.some(id => !seen.has(id))) addError(errors, 'MISSING_DEPENDENCY_REASON', `${path}.dependencyReasons`, 'Explain every dependency.');
    }
  }
  if (Object.hasOwn(node, 'derivedFrom')) {
    validateIdentifier(node.derivedFrom, `${path}.derivedFrom`, errors);
    if (node.derivedFrom === node.id) addError(errors, 'SELF_DERIVATION', `${path}.derivedFrom`, 'A leaf cannot derive from itself.');
    if (!hasOutcome || !hasReasons) addError(errors, 'INCOMPLETE_NODE_MEANING', path, 'Derived leaves require an outcome and dependency explanations.');
  }
}

function validateAcceptance(value, path, errors) {
  if (typeof value === 'string') {
    if (value.length === 0 || value !== value.trim()) {
      addError(
        errors,
        'INVALID_ACCEPTANCE',
        path,
        'Acceptance contract id must be a non-empty, trimmed string.'
      );
    }
    return;
  }

  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    addError(
      errors,
      'INVALID_ACCEPTANCE',
      path,
      'Expected a contract id or a non-empty inline acceptance object.'
    );
    return;
  }

  const supportedFields = ['commands', 'checks', 'evaluators'];
  const presentFields = supportedFields.filter((field) => Object.hasOwn(value, field));
  if (presentFields.length === 0) {
    addError(
      errors,
      'EMPTY_ACCEPTANCE',
      path,
      `Inline acceptance must define at least one of: ${supportedFields.join(', ')}.`
    );
  }
  for (const field of Object.keys(value)) {
    if (!supportedFields.includes(field)) {
      addError(
        errors,
        'UNKNOWN_ACCEPTANCE_FIELD',
        `${path}.${field}`,
        `Unknown inline acceptance field "${field}".`
      );
    }
  }

  for (const listName of supportedFields) {
    if (Object.hasOwn(value, listName)) {
      validateStringList(value[listName], `${path}.${listName}`, errors, {
        nonEmpty: true
      });
    }
  }
}

function validateBudget(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, 'INVALID_BUDGET', path, 'Expected a budget object.');
    return;
  }
  validateKnownFields(value, [
    ...aliases.maxRetries,
    ...aliases.maxFiles,
    ...aliases.maxDiffLines,
    ...aliases.wallTimeMinutes,
    ...aliases.tokenBudget
  ], path, errors);

  const requiredLimits = [
    ['maxRetries', 0],
    ['maxFiles', 1],
    ['maxDiffLines', 1]
  ];
  const optionalLimits = [
    ['wallTimeMinutes', 1],
    ['tokenBudget', 1]
  ];

  for (const [name, minimum] of requiredLimits) {
    const limit = aliasedValue(value, aliases[name], `${path}.${name}`, errors);
    if (!Number.isSafeInteger(limit) || limit < minimum) {
      addError(
        errors,
        'INVALID_BUDGET_LIMIT',
        `${path}.${name}`,
        `Expected a safe integer greater than or equal to ${minimum}.`
      );
    } else if (limit > PLAN_BUDGET_LIMITS[name]) {
      addError(
        errors,
        'BUDGET_LIMIT_EXCEEDED',
        `${path}.${name}`,
        `Budget exceeds the schema-v1 maximum of ${PLAN_BUDGET_LIMITS[name]}.`
      );
    }
  }

  for (const [name, minimum] of optionalLimits) {
    const limit = aliasedValue(value, aliases[name], `${path}.${name}`, errors);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < minimum)) {
      addError(
        errors,
        'INVALID_BUDGET_LIMIT',
        `${path}.${name}`,
        `Expected a safe integer greater than or equal to ${minimum}.`
      );
    } else if (limit !== undefined && limit > PLAN_BUDGET_LIMITS[name]) {
      addError(
        errors,
        'BUDGET_LIMIT_EXCEEDED',
        `${path}.${name}`,
        `Budget exceeds the schema-v1 maximum of ${PLAN_BUDGET_LIMITS[name]}.`
      );
    }
  }
}

function findCycle(nodeIds, dependenciesById) {
  const states = new Map();
  const stack = [];

  function visit(nodeId) {
    states.set(nodeId, 1);
    stack.push(nodeId);

    for (const dependencyId of dependenciesById.get(nodeId) ?? []) {
      if (dependencyId === nodeId || !dependenciesById.has(dependencyId)) {
        continue;
      }
      const state = states.get(dependencyId) ?? 0;
      if (state === 0) {
        const cycle = visit(dependencyId);
        if (cycle) {
          return cycle;
        }
      } else if (state === 1) {
        const cycleStart = stack.lastIndexOf(dependencyId);
        return [...stack.slice(cycleStart), dependencyId];
      }
    }

    stack.pop();
    states.set(nodeId, 2);
    return null;
  }

  for (const nodeId of nodeIds) {
    if ((states.get(nodeId) ?? 0) === 0) {
      const cycle = visit(nodeId);
      if (cycle) {
        return cycle;
      }
    }
  }
  return null;
}

function nodeDependencies(node) {
  return Object.hasOwn(node, 'dependsOn') ? node.dependsOn : node.depends_on;
}

export class PlanValidationError extends Error {
  constructor(errors) {
    super(`Plan validation failed with ${errors.length} error(s).`);
    this.name = 'PlanValidationError';
    this.code = 'FWA_INVALID_PLAN';
    this.errors = errors;
  }
}

export function validatePlan(plan, options = {}) {
  const errors = [];
  if (!isPlainObject(plan)) {
    addError(errors, 'INVALID_PLAN', '$', 'Expected a plan object.');
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  validateKnownFields(
    plan,
    ['schemaVersion', 'id', 'goalId', 'goal_id', 'groups', 'nodes'],
    '$',
    errors
  );
  if (Object.hasOwn(plan, 'schemaVersion')
    && plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    addError(
      errors,
      'UNSUPPORTED_SCHEMA',
      'schemaVersion',
      `Unsupported plan schema version ${String(plan.schemaVersion)}.`
    );
  }

  if (Object.hasOwn(plan, 'id')) {
    validateIdentifier(plan.id, 'id', errors, false);
  }
  const goalId = aliasedValue(plan, ['goalId', 'goal_id'], 'goalId', errors);
  validateIdentifier(goalId, 'goalId', errors, false);

  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    addError(errors, 'INVALID_NODES', 'nodes', 'Expected a non-empty node array.');
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  let availableCapabilities;
  if (options.availableCapabilities !== undefined) {
    if (typeof options.availableCapabilities === 'string'
      || options.availableCapabilities?.[Symbol.iterator] === undefined) {
      throw new TypeError('availableCapabilities must be an iterable of strings.');
    }
    availableCapabilities = new Set(options.availableCapabilities);
    for (const capability of availableCapabilities) {
      if (typeof capability !== 'string'
        || capability.length === 0
        || capability !== capability.trim()) {
        throw new TypeError(
          'availableCapabilities must contain non-empty, trimmed strings.'
        );
      }
    }
  }

  const nodesById = new Map();
  const dependenciesById = new Map();

  for (let index = 0; index < plan.nodes.length; index += 1) {
    const node = plan.nodes[index];
    const path = `nodes[${index}]`;
    if (!isPlainObject(node)) {
      addError(errors, 'INVALID_NODE', path, 'Expected a node object.');
      continue;
    }

    validateKnownFields(node, [
      'id', 'title', 'parentId', 'resources', 'instruction', 'referenceInputs',
      'outcome', 'dependencyReasons', 'derivedFrom',
      ...aliases.dependsOn,
      'reads', 'writes',
      ...aliases.capabilities,
      ...aliases.acceptance,
      'budget'
    ], path, errors);

    const validId = validateIdentifier(node.id, `${path}.id`, errors);
    if (validId) {
      if (nodesById.has(node.id)) {
        addError(
          errors,
          'DUPLICATE_NODE_ID',
          `${path}.id`,
          `Node id "${node.id}" is already used.`
        );
      } else {
        nodesById.set(node.id, node);
      }
    }

    if (Object.hasOwn(node, 'title')
      && (typeof node.title !== 'string'
        || node.title.length === 0
        || node.title !== node.title.trim())) {
      addError(
        errors,
        'INVALID_TITLE',
        `${path}.title`,
        'Expected a non-empty, trimmed string.'
      );
    }

    const dependencies = aliasedValue(
      node,
      aliases.dependsOn,
      `${path}.dependsOn`,
      errors
    );
    const validDependencies = validateStringList(
      dependencies,
      `${path}.dependsOn`,
      errors
    );
    validateNodeMeaning(node, validDependencies, path, errors);
    if (validId && !dependenciesById.has(node.id)) {
      dependenciesById.set(node.id, validDependencies);
    }

    validateStringList(node.reads, `${path}.reads`, errors);
    validateStringList(node.writes, `${path}.writes`, errors);
    if (node.resources !== undefined) validateStringList(node.resources, `${path}.resources`, errors);
    if (node.instruction !== undefined) validateIdentifier(node.instruction, `${path}.instruction`, errors);
    if (node.referenceInputs !== undefined) {
      if (!Array.isArray(node.referenceInputs)) addError(errors, 'INVALID_REFERENCE_INPUTS', `${path}.referenceInputs`, 'Expected snapshot descriptors.');
      else {
        const snapshots = new Set();
        for (const [inputIndex, input] of node.referenceInputs.entries()) {
          const inputPath = `${path}.referenceInputs[${inputIndex}]`;
          if (!isPlainObject(input)) { addError(errors, 'INVALID_REFERENCE_INPUT', inputPath, 'Expected a snapshot descriptor.'); continue; }
          validateKnownFields(input, ['libraryId', 'versionId', 'manifestHash'], inputPath, errors);
          validateIdentifier(input.libraryId, `${inputPath}.libraryId`, errors);
          validateIdentifier(input.versionId, `${inputPath}.versionId`, errors);
          if (typeof input.manifestHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.manifestHash)) {
            addError(errors, 'INVALID_REFERENCE_HASH', `${inputPath}.manifestHash`, 'Expected a SHA-256 manifest hash.');
          }
          const key = JSON.stringify([input.libraryId, input.versionId]);
          if (snapshots.has(key)) addError(errors, 'DUPLICATE_REFERENCE_INPUT', inputPath, 'Duplicate library snapshot.');
          snapshots.add(key);
        }
      }
    }

    const capabilities = aliasedValue(
      node,
      aliases.capabilities,
      `${path}.capabilities`,
      errors
    );
    const validCapabilities = validateStringList(
      capabilities,
      `${path}.capabilities`,
      errors,
      { nonEmpty: true }
    );
    if (availableCapabilities) {
      for (const capability of validCapabilities) {
        if (!availableCapabilities.has(capability)) {
          addError(
            errors,
            'UNAVAILABLE_CAPABILITY',
            `${path}.capabilities`,
            `No registered executor provides "${capability}".`,
            { capability }
          );
        }
      }
    }

    const acceptance = aliasedValue(
      node,
      aliases.acceptance,
      `${path}.acceptance`,
      errors
    );
    validateAcceptance(acceptance, `${path}.acceptance`, errors);
    validateBudget(node.budget, `${path}.budget`, errors);
  }

  for (const [nodeId, dependencies] of dependenciesById) {
    for (const dependencyId of dependencies) {
      if (dependencyId === nodeId) {
        addError(
          errors,
          'SELF_DEPENDENCY',
          `node:${nodeId}.dependsOn`,
          `Node "${nodeId}" cannot depend on itself.`
        );
      } else if (!nodesById.has(dependencyId)) {
        addError(
          errors,
          'MISSING_DEPENDENCY',
          `node:${nodeId}.dependsOn`,
          `Dependency "${dependencyId}" does not exist.`,
          { dependencyId }
        );
      }
    }
  }

  const cycle = findCycle([...nodesById.keys()], dependenciesById);
  if (cycle) {
    addError(
      errors,
      'CYCLE_DETECTED',
      'nodes',
      `Dependency cycle detected: ${cycle.join(' -> ')}.`,
      { cycle }
    );
  }

  // Decomposition is a separate forest. Only plan.nodes are executable leaves;
  // a parent group can neither declare effects nor become a DAG prerequisite.
  const groupsById = new Map();
  if (plan.groups !== undefined && !Array.isArray(plan.groups)) {
    addError(errors, 'INVALID_GROUPS', 'groups', 'Expected a group array.');
  }
  for (const [index, group] of (Array.isArray(plan.groups) ? plan.groups : []).entries()) {
    const groupPath = `groups[${index}]`;
    if (!isPlainObject(group)) {
      addError(errors, 'INVALID_GROUP', groupPath, 'Expected a group object.');
      continue;
    }
    validateKnownFields(group, ['id', 'title', 'parentId'], groupPath, errors);
    if (validateIdentifier(group.id, `${groupPath}.id`, errors)) {
      if (groupsById.has(group.id) || nodesById.has(group.id)) {
        addError(errors, 'DUPLICATE_GROUP_ID', `${groupPath}.id`, 'Group and leaf ids must be distinct.');
      } else groupsById.set(group.id, group);
    }
    validateIdentifier(group.title, `${groupPath}.title`, errors);
  }
  const parentsById = new Map();
  for (const [id, item] of [...groupsById, ...nodesById]) {
    const parentId = item.parentId;
    if (parentId === undefined || parentId === null) {
      if (groupsById.has(id)) parentsById.set(id, []);
      continue;
    }
    if (!validateIdentifier(parentId, `${id}.parentId`, errors)) continue;
    if (!groupsById.has(parentId)) {
      addError(errors, 'MISSING_PARENT_GROUP', `${id}.parentId`, 'A parent must name a group, not an executable leaf.');
    } else if (parentId === id) {
      addError(errors, 'HIERARCHY_CYCLE', `${id}.parentId`, 'A group cannot contain itself.');
    }
    if (groupsById.has(id)) parentsById.set(id, [parentId]);
  }
  const hierarchyCycle = findCycle([...groupsById.keys()], parentsById);
  if (hierarchyCycle) addError(errors, 'HIERARCHY_CYCLE', 'groups', 'Decomposition must be acyclic.', { cycle: hierarchyCycle });
  for (const id of groupsById.keys()) {
    if (![...groupsById.values(), ...nodesById.values()].some(item => item.parentId === id)) {
      addError(errors, 'EMPTY_GROUP', `group:${id}`, 'A group must contain a group or executable leaf.');
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors)
  });
}

export function assertValidPlan(plan, options = {}) {
  const result = validatePlan(plan, options);
  if (!result.ok) {
    throw new PlanValidationError(result.errors);
  }
  return plan;
}

export function topologicalSort(plan) {
  assertValidPlan(plan);
  const ordered = [];
  const completed = new Set();

  while (ordered.length < plan.nodes.length) {
    let progressed = false;
    for (const node of plan.nodes) {
      if (completed.has(node.id)) {
        continue;
      }
      if (nodeDependencies(node).every((dependencyId) => completed.has(dependencyId))) {
        ordered.push(node.id);
        completed.add(node.id);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error('Validated plan unexpectedly contains an unresolved cycle.');
    }
  }
  return ordered;
}

function toKnownIdSet(value, name, knownIds) {
  const source = typeof value === 'string' ? [value] : value;
  if (source?.[Symbol.iterator] === undefined) {
    throw new TypeError(`${name} must be an iterable of node ids.`);
  }
  const ids = new Set(source);
  for (const id of ids) {
    if (!knownIds.has(id)) {
      throw new RangeError(`${name} contains unknown node id "${String(id)}".`);
    }
  }
  return ids;
}

export function getReadyNodeIds(
  plan,
  completedNodeIds = [],
  unavailableNodeIds = []
) {
  assertValidPlan(plan);
  const knownIds = new Set(plan.nodes.map((node) => node.id));
  const completed = toKnownIdSet(completedNodeIds, 'completedNodeIds', knownIds);
  const unavailable = toKnownIdSet(
    unavailableNodeIds,
    'unavailableNodeIds',
    knownIds
  );

  return plan.nodes
    .filter((node) => !completed.has(node.id) && !unavailable.has(node.id))
    .filter((node) => (
      nodeDependencies(node).every((dependencyId) => completed.has(dependencyId))
    ))
    .map((node) => node.id);
}
