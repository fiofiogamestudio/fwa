/** FWA interaction values, shared by command validation and editor derivation.
 * No editor or FWE dependency belongs in this contract. Application invariants
 * (plan topology, permissions, event transitions) remain with their owners.
 */
const text = (maxLength, { required = true, trimmed = true } = {}) => ({
  valueType: 'string', required, trimmed, maxLength, ...(required ? { minLength: 1 } : {})
});

const fields = {
  commandId: { ...text(128), pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
  title: text(512),
  request: text(16384, { required: false, trimmed: false }),
  goalRequest: text(16384),
  goalId: text(256),
  nodeId: text(256),
  reason: text(4096),
  revisionReason: text(16384),
  feedback: text(16384),
  reviewNote: text(4000),
  mode: { valueType: 'string', required: true, options: ['plan', 'work'] },
  permission: { valueType: 'string', required: false, options: ['read', 'write', 'deny', null] },
  plan: { valueType: 'object', required: true },
  libraryLabel: text(200, { trimmed: false })
};
for (const field of Object.values(fields)) {
  if (field.options) Object.freeze(field.options);
  Object.freeze(field);
}
export const INTERACTION_FIELDS = Object.freeze(fields);
export const LIBRARY_ACCESS_VALUES = Object.freeze(INTERACTION_FIELDS.permission.options.filter(value => value !== null));
export const INTERACTION_LIMITS = Object.freeze({ maxReferenceLibraries: 16, maxRevisionFeedback: 32 });

/** Validate one scalar transport field without normalizing or changing intent. */
export function validateInteractionField(name, value) {
  const field = INTERACTION_FIELDS[name];
  if (!field) throw new TypeError(`Unknown interaction field: ${name}`);
  if (field.options) {
    if (!field.options.includes(value)) throw new TypeError(`${name} must be one of ${field.options.map(value => value === null ? 'null' : value).join(', ')}.`);
  } else if (field.valueType === 'string') {
    if (typeof value !== 'string' || (field.required && !value.trim())
      || (field.trimmed && value !== value.trim()) || value.length > field.maxLength
      || (field.pattern && !new RegExp(field.pattern).test(value))) {
      throw new TypeError(`${name} must be ${field.trimmed ? 'a trimmed ' : 'a '}${field.required ? 'nonempty ' : ''}string (maximum ${field.maxLength} characters).`);
    }
  } else if (field.valueType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  return value;
}
