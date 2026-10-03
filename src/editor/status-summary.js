import { createHash } from 'node:crypto';

export const STATUS_PREVIEW_MAX_BYTES = 8192;
const MAX_FIELD_EXAMPLES = 64;
const TEXT_FIELDS = new Set(['stdout', 'stderr', 'output', 'outputTail', 'aggregated_output',
  'message', 'summary', 'reason', 'stack', 'error']);
// These objects can be reused as command inputs. Never turn a preview of a plan,
// acceptance contract or executable command into apparently complete JSON.
const CONTRACT_FIELDS = new Set(['plan', 'acceptance', 'acceptanceContract', 'acceptance_contract',
  'instruction', 'input', 'command', 'commands', 'args', 'profile', 'evaluatorProfile', 'regressionProfile']);
const pointerSegment = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

function previewText(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= STATUS_PREVIEW_MAX_BYTES) return null;
  let end = STATUS_PREVIEW_MAX_BYTES;
  // A UTF-8 continuation byte cannot begin the omitted suffix. Back up to the
  // beginning of that character rather than displaying a replacement glyph.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), originalBytes: bytes.length,
    previewBytes: end, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * A display-only, clone-on-write view. All collections, identities, state and
 * contracts survive intact; only selected diagnostic/human text is previewed.
 * Full records stay available from the default status and event/artifact APIs.
 * Small projections retain object identity for native read-only resources.
 */
export function summarizeStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new TypeError('Expected a status object.');
  if (status._fwaSummary?.schemaVersion === 1 && status._fwaSummary.displayOnly === true) return status;
  const fields = [];
  let truncatedFieldCount = 0;
  let removedTextBytes = 0;
  const visit = (value, key = '', pointer = '') => {
    if (CONTRACT_FIELDS.has(key)) return value;
    if (typeof value === 'string') {
      if (!TEXT_FIELDS.has(key)) return value;
      const preview = previewText(value);
      if (!preview) return value;
      truncatedFieldCount += 1;
      removedTextBytes += preview.originalBytes - preview.previewBytes;
      if (fields.length < MAX_FIELD_EXAMPLES) fields.push({ pointer, originalBytes: preview.originalBytes,
        previewBytes: preview.previewBytes, sha256: preview.sha256 });
      return preview.text;
    }
    if (!value || typeof value !== 'object') return value;
    let copy = value;
    for (const [childKey, child] of Object.entries(value)) {
      const next = visit(child, childKey, `${pointer}/${pointerSegment(childKey)}`);
      if (next !== child) {
        if (copy === value) copy = Array.isArray(value) ? [...value] : { ...value };
        copy[childKey] = next;
      }
    }
    return copy;
  };
  const result = visit(status);
  if (truncatedFieldCount === 0) return status;
  return { ...result, _fwaSummary: { schemaVersion: 1, displayOnly: true,
    notice: 'Display summary: long diagnostic text is truncated. Do not submit this view as executable configuration. Full records remain in the default status, events and artifact APIs.',
    maxTextPreviewBytes: STATUS_PREVIEW_MAX_BYTES, truncatedFieldCount, removedTextBytes,
    fields, omittedFieldCount: truncatedFieldCount - fields.length,
    fullStatusUrl: '/api/fwa/status', eventsUrl: '/api/fwa/events' } };
}
