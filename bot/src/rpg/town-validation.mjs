import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('./contracts/town-v1.schema.json', import.meta.url), 'utf8'));

function validate(value, rule, location) {
  if (rule.$ref) return validate(value, schema.$defs[rule.$ref.split('/').at(-1)], location);
  const fail = (detail) => { throw new Error(`Invalid town ${location}. ${detail}`); };
  if ('const' in rule && value !== rule.const) fail('Unexpected version.');
  if (rule.enum && !rule.enum.includes(value)) fail('Unsupported value.');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object.');
    for (const key of rule.required || []) if (!(key in value)) fail(`Missing ${key}.`);
    for (const [key, child] of Object.entries(value)) {
      if (!rule.properties?.[key]) fail(`Unexpected field ${key}.`);
      validate(child, rule.properties[key], `${location}.${key}`);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) fail('Expected an array.');
    if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity)) fail('Unexpected item count.');
    value.forEach((child, index) => validate(child, rule.items, `${location}[${index}]`));
  } else if (rule.type === 'integer') {
    if (!Number.isInteger(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)) fail('Expected an integer within the supported bounds.');
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)) fail('Expected a label within the supported length.');
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail('Unsupported text or asset path.');
  }
}

export function assertTown(town, guildId) {
  validate(town, schema, 'document');
  if (town.guildId !== guildId) throw new Error('The town belongs to a different server.');
  const ids = new Set();
  for (const item of [...town.buildings, ...town.landmarks]) {
    if (ids.has(item.id)) throw new Error('Town building and landmark IDs must be unique.');
    ids.add(item.id);
  }
  for (const rect of [...town.roads, ...town.buildings]) {
    if (rect.x + rect.w > town.width || rect.y + rect.h > town.height) throw new Error('Town rectangles must fit inside the world.');
  }
  for (const building of town.buildings) {
    if (building.art && !building.art.startsWith(`/games/${guildId}/town/`)) throw new Error('Town artwork must belong to this server.');
    const { door } = building;
    if (door.x < building.x || door.x > building.x + building.w || door.y < building.y + building.h + 12 || door.y > building.y + building.h + 120) {
      throw new Error('Place each town door in front of its building.');
    }
  }
  for (let index = 0; index < town.buildings.length; index++) {
    const left = town.buildings[index];
    for (const right of town.buildings.slice(index + 1)) {
      if (left.x < right.x + right.w && right.x < left.x + left.w && left.y < right.y + right.h && right.y < left.y + left.h) {
        throw new Error('Town buildings must have separate footprints.');
      }
    }
  }
  const open = ({ x, y }) => x >= 28 && y >= 28 && x <= town.width - 28 && y <= town.height - 28
    && town.buildings.every((b) => x <= b.x - 18 || x >= b.x + b.w + 18 || y <= b.y - 18 || y >= b.y + b.h + 18);
  const points = [town.spawn, ...town.buildings.map((b) => b.door), ...town.landmarks, ...town.characterSpawns];
  if (points.some((point) => !open(point))) throw new Error('Town spawns, landmarks, and doors need clear walking space.');
  const visible = (from, to) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 8));
    for (let step = 0; step <= steps; step++) {
      const fraction = step / steps;
      if (!open({ x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction })) return false;
    }
    return true;
  };
  const step = 20;
  const columns = Math.floor((town.width - 56) / step) + 1;
  const rows = Math.floor((town.height - 56) / step) + 1;
  const position = (index) => ({ x: 28 + (index % columns) * step, y: 28 + Math.floor(index / columns) * step });
  const nearby = (point) => {
    const x = Math.round((point.x - 28) / step);
    const y = Math.round((point.y - 28) / step);
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const column = x + dx;
      const row = y + dy;
      if (column >= 0 && row >= 0 && column < columns && row < rows) {
        const index = row * columns + column;
        if (visible(point, position(index))) candidates.push(index);
      }
    }
    return candidates;
  };
  const pending = nearby(town.spawn);
  const reachable = new Set(pending);
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const index = pending[cursor];
    const from = position(index);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const neighbors = [];
    if (column > 0) neighbors.push(index - 1);
    if (column + 1 < columns) neighbors.push(index + 1);
    if (row > 0) neighbors.push(index - columns);
    if (row + 1 < rows) neighbors.push(index + columns);
    for (const next of neighbors) if (!reachable.has(next) && visible(from, position(next))) {
      reachable.add(next);
      pending.push(next);
    }
  }
  if (points.some((point) => !nearby(point).some((index) => reachable.has(index)))) {
    throw new Error('All town doors, landmarks, and character spawns must be reachable.');
  }
  return town;
}
