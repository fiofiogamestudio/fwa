export const OBJECT_COLLECTIONS = Object.freeze(['nodes', 'refs', 'runs', 'changeSets', 'evidence', 'goals', 'groups', 'evaluations', 'integrations', 'reversions']);
const missing = () => Object.assign(new Error('Unknown projection resource.'), { status: 404, code: 'editor-resource-not-found' });
const segment = value => {
  if (typeof value !== 'string' || !value || value !== value.trim()) throw missing();
  return encodeURIComponent(value);
};

export function objectResourceName(type, id, { goalId } = {}) {
  if (!OBJECT_COLLECTIONS.includes(type)) throw missing();
  return `objects/${type}/${type === 'groups' ? `${segment(goalId)}/` : ''}${segment(id)}.json`;
}

export function parseObjectResourceName(name) {
  if (typeof name !== 'string') throw missing();
  const match = /^objects\/([^/]+)\/(.+)\.json$/.exec(name);
  if (!match || !OBJECT_COLLECTIONS.includes(match[1])) throw missing();
  try {
    const parts = match[2].split('/');
    if (parts.length !== (match[1] === 'groups' ? 2 : 1)) throw missing();
    const selection = { type: match[1], id: decodeURIComponent(parts.at(-1)),
      ...(match[1] === 'groups' ? { goalId: decodeURIComponent(parts[0]) } : {}) };
    // One canonical spelling rejects traversal, malformed or double-decoded names.
    if (objectResourceName(selection.type, selection.id, selection) !== name) throw missing();
    return selection;
  } catch { throw missing(); }
}

function groupRows(status) {
  const rows = [];
  function visit(item, goalId) {
    if (item.type === 'group') rows.push({ ...item, goalId });
    for (const child of item.children || []) visit(child, goalId);
  }
  for (const goal of status.workflow?.goals || []) for (const child of goal.children || []) visit(child, goal.id);
  return rows;
}

export function listObjectResources(status) {
  return [{ name: 'projection.json', label: 'Project projection', exists: true }, ...OBJECT_COLLECTIONS.flatMap(type =>
    (type === 'groups' ? groupRows(status) : status[type] || []).map(item => ({
      name: objectResourceName(type, item.id, item), label: `${type} · ${item.title || item.uri || item.id}`, exists: true
    })))];
}

export function readObjectResource(status, name) {
  if (name === 'projection.json') return { type: 'json', data: status };
  const selected = parseObjectResourceName(name);
  const rows = selected.type === 'groups' ? groupRows(status) : status[selected.type] || [];
  const object = rows.find(item => item.id === selected.id && (selected.type !== 'groups' || item.goalId === selected.goalId));
  if (!object) throw missing();
  const selection = { ...selected, ...(selected.type === 'goals' ? { goalId: object.id } : object.goalId ? { goalId: object.goalId } : {}) };
  return { type: 'json', data: { ...status, _fwaSelection: selection } };
}
