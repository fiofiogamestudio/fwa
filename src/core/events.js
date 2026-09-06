import {
  createHash,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';

export const EVENT_SCHEMA_VERSION = 1;

const EVENT_FIELDS = Object.freeze([
  'actor',
  'causationId',
  'correlationId',
  'eventId',
  'hash',
  'metadata',
  'occurredAt',
  'payload',
  'schemaVersion',
  'sequence',
  'streamId',
  'type'
]);

const isPlainObject = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null)
);

function serializeStable(value, ancestors, path) {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} contains a non-finite number.`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${path} contains a non-JSON value.`);
  }

  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference.`);
  }
  ancestors.add(value);

  let result;
  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, index) => (
      serializeStable(value[index], ancestors, `${path}[${index}]`)
    ));
    result = `[${items.join(',')}]`;
  } else {
    if (!isPlainObject(value)) {
      ancestors.delete(value);
      throw new TypeError(`${path} contains a non-plain object.`);
    }
    const symbolKeys = Object.getOwnPropertySymbols(value)
      .filter((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol));
    if (symbolKeys.length > 0) {
      ancestors.delete(value);
      throw new TypeError(`${path} contains an enumerable symbol key.`);
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => (
        `${JSON.stringify(key)}:${serializeStable(value[key], ancestors, `${path}.${key}`)}`
      ));
    result = `{${entries.join(',')}}`;
  }

  ancestors.delete(value);
  return result;
}

export function stableStringify(value) {
  return serializeStable(value, new Set(), '$');
}

function cloneJson(value) {
  return JSON.parse(stableStringify(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function requireIdentifier(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty, trimmed string.`);
  }
  return value;
}

export class EventEnvelopeError extends Error {
  constructor(message, reason = 'invalid-event-envelope') {
    super(message);
    this.name = 'EventEnvelopeError';
    this.code = 'FWA_INVALID_EVENT_ENVELOPE';
    this.reason = reason;
  }
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('occurredAt must be a valid date or timestamp.');
  }
  return date.toISOString();
}

export function eventHash(event) {
  if (!isPlainObject(event)) {
    throw new TypeError('event must be a plain object.');
  }
  const hashable = { ...event };
  delete hashable.hash;
  return `sha256:${createHash('sha256').update(stableStringify(hashable)).digest('hex')}`;
}

export const hashEvent = eventHash;

export function verifyEventHash(event) {
  if (!isPlainObject(event) || typeof event.hash !== 'string') {
    return false;
  }

  let expected;
  try {
    expected = eventHash(event);
  } catch {
    return false;
  }

  const actualBuffer = Buffer.from(event.hash);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function assertValidEventEnvelope(event) {
  if (!isPlainObject(event)) {
    throw new EventEnvelopeError('Event envelope must be a plain object.');
  }
  const fields = Object.keys(event).sort();
  if (fields.length !== EVENT_FIELDS.length
    || fields.some((field, index) => field !== EVENT_FIELDS[index])) {
    throw new EventEnvelopeError(
      'Event envelope fields do not match schema version 1.',
      'invalid-event-fields'
    );
  }
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new EventEnvelopeError(
      `Unsupported event schema version ${String(event.schemaVersion)}.`,
      'unsupported-event-schema'
    );
  }
  try {
    requireIdentifier(event.eventId, 'eventId');
    requireIdentifier(event.type, 'type');
    requireIdentifier(event.streamId, 'streamId');
    requireIdentifier(event.actor, 'actor');
    requireIdentifier(event.correlationId, 'correlationId');
    if (event.causationId !== null) {
      requireIdentifier(event.causationId, 'causationId');
    }
  } catch (error) {
    throw new EventEnvelopeError(error.message, 'invalid-event-identifier');
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new EventEnvelopeError(
      'Event sequence must be a positive safe integer.',
      'invalid-event-sequence'
    );
  }
  if (typeof event.occurredAt !== 'string') {
    throw new EventEnvelopeError(
      'Event occurredAt must be a canonical ISO timestamp.',
      'invalid-event-timestamp'
    );
  }
  let timestamp;
  try {
    timestamp = new Date(event.occurredAt).toISOString();
  } catch {
    throw new EventEnvelopeError(
      'Event occurredAt must be a canonical ISO timestamp.',
      'invalid-event-timestamp'
    );
  }
  if (timestamp !== event.occurredAt) {
    throw new EventEnvelopeError(
      'Event occurredAt must be a canonical ISO timestamp.',
      'invalid-event-timestamp'
    );
  }
  if (!isPlainObject(event.payload) || !isPlainObject(event.metadata)) {
    throw new EventEnvelopeError(
      'Event payload and metadata must be plain objects.',
      'invalid-event-content'
    );
  }
  if (!verifyEventHash(event)) {
    throw new EventEnvelopeError(
      `Event ${event.eventId} failed its hash check.`,
      'event-hash-invalid'
    );
  }
  return event;
}

export function createEvent(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('event input must be a plain object.');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('event options must be a plain object.');
  }

  const type = requireIdentifier(input.type, 'type');
  const streamId = requireIdentifier(input.streamId, 'streamId');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError('sequence must be a positive safe integer.');
  }

  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  if (typeof idFactory !== 'function') {
    throw new TypeError('idFactory must be a function.');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('clock must be a function.');
  }

  const eventId = requireIdentifier(idFactory(), 'eventId');
  const occurredAt = normalizeTimestamp(input.occurredAt ?? clock());
  const actor = requireIdentifier(input.actor ?? 'system', 'actor');
  const correlationId = requireIdentifier(
    input.correlationId ?? eventId,
    'correlationId'
  );
  const causationId = input.causationId ?? null;
  if (causationId !== null) {
    requireIdentifier(causationId, 'causationId');
  }

  const payload = input.payload ?? {};
  const metadata = input.metadata ?? {};
  if (!isPlainObject(payload)) {
    throw new TypeError('payload must be a plain object.');
  }
  if (!isPlainObject(metadata)) {
    throw new TypeError('metadata must be a plain object.');
  }

  const envelope = cloneJson({
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    type,
    streamId,
    sequence: input.sequence,
    occurredAt,
    actor,
    correlationId,
    causationId,
    payload,
    metadata
  });
  const event = {
    ...envelope,
    hash: eventHash(envelope)
  };
  return deepFreeze(event);
}
