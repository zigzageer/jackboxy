import {
  canStand,
  MINT_WALK_AREA,
  type Point,
  type WalkArea,
} from "./model.ts";
const STEP = 20;
const key = (p: Point) => `${p.x},${p.y}`;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
function clearLine(a: Point, b: Point, area: WalkArea) {
  if (!canStand(a, area) || !canStand(b, area)) return false;
  // Intersect the full segment with each padded footprint. Sampling can miss a
  // narrow slice of a corner and leave an auto-walking character stuck there.
  return !area.obstacles.some((r) => {
    let enter = 0,
      leave = 1;
    const axes = [
      [a.x, b.x - a.x, r.x - 15, r.x + r.w + 15],
      [a.y, b.y - a.y, r.y - 8, r.y + r.h + 8],
    ];
    for (const [origin, delta, min, max] of axes) {
      if (Math.abs(delta) < 1e-10) {
        if (origin <= min || origin >= max) return false;
      } else {
        const t1 = (min - origin) / delta,
          t2 = (max - origin) / delta;
        enter = Math.max(enter, Math.min(t1, t2));
        leave = Math.min(leave, Math.max(t1, t2));
        if (leave - enter <= 1e-10) return false;
      }
    }
    return leave - enter > 1e-10;
  });
}
const walkGrids = new WeakMap<WalkArea, Point[]>();
function walkGrid(area: WalkArea) {
  const cached = walkGrids.get(area);
  if (cached) return cached;
  const { left, right, top, bottom } = area.bounds;
  const nodes: Point[] = [];
  for (let y = Math.ceil(top / STEP) * STEP; y <= bottom; y += STEP)
    for (let x = Math.ceil(left / STEP) * STEP; x <= right; x += STEP)
      if (canStand({ x, y }, area)) nodes.push({ x, y });
  walkGrids.set(area, nodes);
  return nodes;
}

/** Keep long trips responsive on phones without sorting the entire frontier. */
class Frontier {
  items: { p: Point; cost: number; score: number }[] = [];
  push(item: (typeof this.items)[number]) {
    let i = this.items.push(item) - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.items[parent].score <= item.score) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0],
      last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < this.items.length &&
          this.items[child + 1].score < this.items[child].score
        )
          child++;
        if (last.score <= this.items[child].score) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}
export function findPath(
  start: Point,
  requested: Point,
  area = MINT_WALK_AREA,
): Point[] {
  if (
    !canStand(start, area) ||
    !Number.isFinite(requested.x) ||
    !Number.isFinite(requested.y)
  )
    return [];
  const { left, right, top, bottom } = area.bounds;
  const bounded = {
    x: Math.max(left, Math.min(right, requested.x)),
    y: Math.max(top, Math.min(bottom, requested.y)),
  };
  const validTarget = canStand(bounded, area);
  if (validTarget && clearLine(start, bounded, area)) return [bounded];
  const nodes = walkGrid(area);
  const nearest = (p: Point, requireLine: boolean) => {
    let nearestPoint: Point | undefined;
    let distance = Infinity;
    for (const node of nodes) {
      const candidate = (node.x - p.x) ** 2 + (node.y - p.y) ** 2;
      if (candidate < distance && (!requireLine || clearLine(p, node, area))) {
        nearestPoint = node;
        distance = candidate;
      }
    }
    return nearestPoint;
  };
  const from = nearest(start, true),
    to = nearest(bounded, validTarget);
  if (!from || !to) return [];
  const open = new Frontier(),
    costs = new Map([[key(from), 0]]),
    parents = new Map<string, Point>();
  open.push({
    p: from,
    cost: 0,
    score: Math.hypot(from.x - to.x, from.y - to.y),
  });
  let found = false;
  while (open.items.length) {
    const { p: current, cost } = open.pop();
    if (cost !== costs.get(key(current))) continue;
    if (same(current, to)) {
      found = true;
      break;
    }
    for (const dx of [-STEP, 0, STEP])
      for (const dy of [-STEP, 0, STEP]) {
        if (!dx && !dy) continue;
        const next = { x: current.x + dx, y: current.y + dy },
          nk = key(next);
        if (!canStand(next, area) || !clearLine(current, next, area)) continue;
        const nextCost = cost + Math.hypot(dx, dy);
        if (nextCost >= (costs.get(nk) ?? Infinity)) continue;
        costs.set(nk, nextCost);
        parents.set(nk, current);
        open.push({
          p: next,
          cost: nextCost,
          score: nextCost + Math.hypot(next.x - to.x, next.y - to.y),
        });
      }
  }
  if (!found) return [];
  const path = [to];
  let p = to;
  while (!same(p, from)) {
    p = parents.get(key(p))!;
    path.unshift(p);
  }
  if (validTarget && !same(to, bounded)) path.push(bounded);
  // Keep only turns with a clear segment between them. Following every grid
  // point adds stop/start frames and makes distant destinations needlessly slow.
  const full = [start, ...path],
    turns: Point[] = [];
  for (let i = 0; i < full.length - 1; ) {
    let next = full.length - 1;
    while (next > i + 1 && !clearLine(full[i], full[next], area)) next--;
    turns.push(full[next]);
    i = next;
  }
  return turns;
}
