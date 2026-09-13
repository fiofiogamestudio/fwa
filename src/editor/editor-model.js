import { INTERACTION_FIELDS } from '../core/interaction-contract.js';
import { GoalStatus, NodeStatus, RunStatus, EvaluationStatus, IntegrationStatus, ReversionStatus, Validity } from '../core/state-machines.js';

const multiline = new Set(['request', 'goalRequest', 'reason', 'revisionReason', 'feedback', 'plan', 'reviewNote']);

/** A derived FWE model, not a second authoritative schema or generic write API. */
export function createEditorModel() {
  const fields = {};
  for (const [name, contract] of Object.entries(INTERACTION_FIELDS)) {
    const { trimmed, ...constraints } = contract;
    fields[`commands.${name}`] = {
      path: name, ...constraints,
      type: contract.options ? 'select' : multiline.has(name) ? 'textarea' : 'text',
      ...(name === 'plan' ? { valueType: 'string', contentType: 'application/json' } : {}),
      ...(trimmed ? { description: 'Trimmed text; the server validates the exact command value.' } : {})
    };
  }
  const scalar = (schemaPath, valueType = 'string', extra = {}) => {
    fields[schemaPath] = { path: schemaPath.split('.').at(-1), type: extra.options ? 'select' : 'readonly', valueType, readOnly: true, disabled: true, ...extra };
  };
  scalar('projectId'); scalar('projectRoot'); scalar('lastSequence', 'number');
  for (const collection of ['goals', 'nodes', 'refs', 'runs', 'changeSets', 'evidence', 'evaluations', 'integrations', 'reversions']) {
    scalar(`${collection}[].id`);
    if (collection !== 'goals' && collection !== 'refs') scalar(`${collection}[].goalId`);
  }
  for (const [collection, statuses] of Object.entries({ goals: GoalStatus, nodes: NodeStatus, runs: RunStatus,
    evaluations: EvaluationStatus, integrations: IntegrationStatus, reversions: ReversionStatus })) {
    scalar(`${collection}[].status`, 'string', { options: Object.values(statuses) });
  }
  scalar('nodes[].validity', 'string', { options: Object.values(Validity) });
  scalar('nodes[].integrationStatus', 'string', { options: [...Object.values(IntegrationStatus), null] });
  for (const schemaPath of ['goals[].title', 'goals[].request', 'nodes[].title', 'refs[].uri', 'refs[].kind', 'refs[].hash']) scalar(schemaPath);
  return { type: 'object', root: '$', authority: 'fwa-interaction-contract-v1', fields };
}

export function applyEditorModel(domain) {
  domain.model = createEditorModel();
  domain.inspector = { ...domain.inspector, forms: {
    commands: { groups: [{ title: 'FWA commands', fields: Object.entries(domain.model.fields)
      .filter(([key]) => key.startsWith('commands.')).map(([, field]) => field) }] },
    projection: { groups: [{ title: 'FWA projection · read only', fields: Object.entries(domain.model.fields)
      .filter(([key]) => !key.startsWith('commands.')).map(([key, field]) => ({ ...field, path: key })) }] }
  } };
  return domain;
}
