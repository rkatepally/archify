const SIDES = ['left', 'right', 'top', 'bottom'];
const SIDE_VECTOR = {
  left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1],
};
const EPS = 1e-4;

function asArray(value) { return Array.isArray(value) ? value : []; }
function finitePoint(point) { return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite); }

function componentBox(component) {
  if (!component || !finitePoint(component.pos)) return null;
  const size = finitePoint(component.size) ? component.size : [120, 60];
  if (!(size[0] > 0) || !(size[1] > 0)) return null;
  return {
    id: component.id,
    x: component.pos[0], y: component.pos[1],
    width: size[0], height: size[1],
    cx: component.pos[0] + size[0] / 2,
    cy: component.pos[1] + size[1] / 2,
  };
}

function anchor(box, side) {
  if (side === 'left') return [box.x, box.cy];
  if (side === 'right') return [box.x + box.width, box.cy];
  if (side === 'top') return [box.cx, box.y];
  return [box.cx, box.y + box.height];
}

function normalizePoints(points) {
  const deduped = [];
  for (const source of points) {
    if (!finitePoint(source)) continue;
    const point = [Number(source[0]), Number(source[1])];
    const previous = deduped.at(-1);
    if (!previous || Math.abs(previous[0] - point[0]) > EPS || Math.abs(previous[1] - point[1]) > EPS) deduped.push(point);
  }
  const normalized = [];
  for (const point of deduped) {
    while (normalized.length >= 2) {
      const a = normalized.at(-2);
      const b = normalized.at(-1);
      const sameX = Math.abs(a[0] - b[0]) <= EPS && Math.abs(b[0] - point[0]) <= EPS;
      const sameY = Math.abs(a[1] - b[1]) <= EPS && Math.abs(b[1] - point[1]) <= EPS;
      if (!sameX && !sameY) break;
      const forward = (b[0] - a[0]) * (point[0] - b[0]) + (b[1] - a[1]) * (point[1] - b[1]) >= -EPS;
      if (!forward) break;
      normalized.pop();
    }
    normalized.push(point);
  }
  return normalized;
}

function segmentLength(a, b) { return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); }
function routeLength(points) { return points.slice(0, -1).reduce((sum, p, i) => sum + segmentLength(p, points[i + 1]), 0); }

function endpointDirectionsValid(points, fromSide, toSide) {
  if (points.length < 2) return false;
  const sourceDelta = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
  const sourceVector = SIDE_VECTOR[fromSide];
  if (!sourceVector) return false;
  if (sourceDelta[0] * sourceVector[0] + sourceDelta[1] * sourceVector[1] <= EPS) return false;
  if (sourceVector[0] === 0 && Math.abs(sourceDelta[0]) > EPS) return false;
  if (sourceVector[1] === 0 && Math.abs(sourceDelta[1]) > EPS) return false;

  const last = points.length - 1;
  const targetDelta = [points[last][0] - points[last - 1][0], points[last][1] - points[last - 1][1]];
  const targetVector = SIDE_VECTOR[toSide];
  if (!targetVector) return false;
  if (targetDelta[0] * -targetVector[0] + targetDelta[1] * -targetVector[1] <= EPS) return false;
  if (targetVector[0] === 0 && Math.abs(targetDelta[0]) > EPS) return false;
  if (targetVector[1] === 0 && Math.abs(targetDelta[1]) > EPS) return false;
  return true;
}

function routeRhythmValid(points) {
  for (let i = 0; i < points.length - 1; i += 1) {
    const length = segmentLength(points[i], points[i + 1]);
    if (length < 8 - EPS) return false;
    if (i > 0 && i < points.length - 2 && length < 16 - EPS) return false;
  }
  return true;
}

function segmentIntersectsRect(start, end, box, gap = 0) {
  const left = box.x - gap;
  const right = box.x + box.width + gap;
  const top = box.y - gap;
  const bottom = box.y + box.height + gap;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let enter = 0;
  let leave = 1;
  const bounds = [
    [-dx, start[0] - left],
    [dx, right - start[0]],
    [-dy, start[1] - top],
    [dy, bottom - start[1]],
  ];
  for (const [direction, distance] of bounds) {
    if (Math.abs(direction) <= EPS) {
      if (distance < -EPS) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave + EPS) return false;
  }
  return true;
}

function routeClearsComponents(points, connection, boxes) {
  for (const box of boxes.values()) {
    if (box.id === connection.from || box.id === connection.to) continue;
    for (let i = 0; i < points.length - 1; i += 1) {
      if (segmentIntersectsRect(points[i], points[i + 1], box, 2)) return false;
    }
  }
  return true;
}

function properSegmentIntersection(a, b, c, d) {
  const dx1 = b[0] - a[0];
  const dy1 = b[1] - a[1];
  const dx2 = d[0] - c[0];
  const dy2 = d[1] - c[1];
  const denominator = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denominator) <= EPS) return null;
  const t = ((c[0] - a[0]) * dy2 - (c[1] - a[1]) * dx2) / denominator;
  const u = ((c[0] - a[0]) * dy1 - (c[1] - a[1]) * dx1) / denominator;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return [a[0] + t * dx1, a[1] + t * dy1];
}

function collinearOverlapLength(a, b, c, d) {
  const horizontal = Math.abs(a[1] - b[1]) <= EPS && Math.abs(c[1] - d[1]) <= EPS && Math.abs(a[1] - c[1]) <= EPS;
  const vertical = Math.abs(a[0] - b[0]) <= EPS && Math.abs(c[0] - d[0]) <= EPS && Math.abs(a[0] - c[0]) <= EPS;
  if (!horizontal && !vertical) return 0;
  const axis = horizontal ? 0 : 1;
  const low = Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]));
  const high = Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]));
  return Math.max(0, high - low);
}

function shareSemanticEndpoint(left, right) {
  return [left.from, left.to].some((id) => id === right.from || id === right.to);
}

function routesConflict(leftConnection, leftPoints, rightConnection, rightPoints) {
  if (shareSemanticEndpoint(leftConnection, rightConnection)) return false;
  for (let li = 0; li < leftPoints.length - 1; li += 1) {
    for (let ri = 0; ri < rightPoints.length - 1; ri += 1) {
      if (properSegmentIntersection(leftPoints[li], leftPoints[li + 1], rightPoints[ri], rightPoints[ri + 1])) return true;
      if (collinearOverlapLength(leftPoints[li], leftPoints[li + 1], rightPoints[ri], rightPoints[ri + 1]) >= 8 - EPS) return true;
    }
  }
  return false;
}

function laneCoordinates(boxes) {
  const gap = 24;
  const xs = new Set();
  const ys = new Set();
  const list = [...boxes.values()];
  for (const box of list) {
    xs.add(box.x - gap);
    xs.add(box.x + box.width + gap);
    ys.add(box.y - gap);
    ys.add(box.y + box.height + gap);
  }
  const xEdges = [...new Set(list.flatMap((box) => [box.x, box.x + box.width]))].sort((a, b) => a - b);
  const yEdges = [...new Set(list.flatMap((box) => [box.y, box.y + box.height]))].sort((a, b) => a - b);
  for (let i = 0; i < xEdges.length - 1; i += 1) {
    if (xEdges[i + 1] - xEdges[i] >= 32) xs.add((xEdges[i] + xEdges[i + 1]) / 2);
  }
  for (let i = 0; i < yEdges.length - 1; i += 1) {
    if (yEdges[i + 1] - yEdges[i] >= 32) ys.add((yEdges[i] + yEdges[i + 1]) / 2);
  }
  if (list.length) {
    const minX = Math.min(...list.map((box) => box.x));
    const maxX = Math.max(...list.map((box) => box.x + box.width));
    const minY = Math.min(...list.map((box) => box.y));
    const maxY = Math.max(...list.map((box) => box.y + box.height));
    xs.add(minX - 40); xs.add(maxX + 40);
    ys.add(minY - 40); ys.add(maxY + 40);
  }
  return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

function routeCandidates(connection, boxes, lanes) {
  const source = boxes.get(connection.from);
  const target = boxes.get(connection.to);
  if (!source || !target) return [];
  const candidates = new Map();
  const stub = 24;

  for (const fromSide of SIDES) {
    for (const toSide of SIDES) {
      const start = anchor(source, fromSide);
      const end = anchor(target, toSide);
      const sourceVector = SIDE_VECTOR[fromSide];
      const targetVector = SIDE_VECTOR[toSide];
      const startStub = [start[0] + sourceVector[0] * stub, start[1] + sourceVector[1] * stub];
      const endStub = [end[0] + targetVector[0] * stub, end[1] + targetVector[1] * stub];
      const raw = [];

      if (Math.abs(start[0] - end[0]) <= EPS || Math.abs(start[1] - end[1]) <= EPS) raw.push([start, end]);
      raw.push([start, startStub, [endStub[0], startStub[1]], endStub, end]);
      raw.push([start, startStub, [startStub[0], endStub[1]], endStub, end]);
      for (const x of lanes.xs) raw.push([start, startStub, [x, startStub[1]], [x, endStub[1]], endStub, end]);
      for (const y of lanes.ys) raw.push([start, startStub, [startStub[0], y], [endStub[0], y], endStub, end]);

      for (const points of raw) {
        const normalized = normalizePoints(points);
        if (normalized.length < 2) continue;
        if (!endpointDirectionsValid(normalized, fromSide, toSide)) continue;
        if (!routeRhythmValid(normalized)) continue;
        if (!routeClearsComponents(normalized, connection, boxes)) continue;
        const key = normalized.map(([x, y]) => `${x},${y}`).join(';');
        const candidate = {
          fromSide, toSide, points: normalized, via: normalized.slice(1, -1),
          length: routeLength(normalized), bends: Math.max(0, normalized.length - 2),
        };
        const previous = candidates.get(key);
        if (!previous || candidate.length < previous.length || (candidate.length === previous.length && candidate.bends < previous.bends)) {
          candidates.set(key, candidate);
        }
      }
    }
  }

  return [...candidates.values()]
    .sort((a, b) => a.length - b.length || a.bends - b.bends || a.fromSide.localeCompare(b.fromSide) || a.toSide.localeCompare(b.toSide))
    .slice(0, 180);
}

function chooseRoutes(connections, candidateMap) {
  const orders = [
    [...connections],
    [...connections].sort((a, b) => candidateMap.get(a.id).length - candidateMap.get(b.id).length || a.id.localeCompare(b.id)),
    [...connections].sort((a, b) => (candidateMap.get(a.id)[0]?.length ?? Infinity) - (candidateMap.get(b.id)[0]?.length ?? Infinity) || a.id.localeCompare(b.id)),
  ];

  for (const order of orders) {
    const selected = new Map();
    let failed = false;
    for (const connection of order) {
      const candidate = candidateMap.get(connection.id).find((proposal) => (
        [...selected.entries()].every(([otherId, other]) => !routesConflict(connection, proposal.points, other.connection, other.candidate.points))
      ));
      if (!candidate) { failed = true; break; }
      selected.set(connection.id, { connection, candidate });
    }
    if (!failed && selected.size === connections.length) return selected;
  }
  return null;
}

function rectsOverlap(left, right, gap = 0) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function pointRectDistance(point, rect) {
  const dx = Math.max(rect.x - point[0], 0, point[0] - (rect.x + rect.width));
  const dy = Math.max(rect.y - point[1], 0, point[1] - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPS) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const projection = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + projection * dx), point[1] - (start[1] + projection * dy));
}

function segmentRectClearance(start, end, rect) {
  if (segmentIntersectsRect(start, end, rect, 0)) return 0;
  const corners = [
    [rect.x, rect.y], [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height],
  ];
  return Math.min(
    pointRectDistance(start, rect), pointRectDistance(end, rect),
    ...corners.map((corner) => pointSegmentDistance(corner, start, end)),
  );
}

function labelWidth(text) { return Math.max(30, Array.from(String(text ?? '')).length * 4.8 + 10); }
function labelRect(label, point) {
  const width = labelWidth(label);
  return { x: point[0] - width / 2, y: point[1] - 10, width, height: 14 };
}

function candidateLabelPoints(points) {
  const candidates = [];
  const seen = new Set();
  const add = (point) => {
    const key = `${Math.round(point[0] * 10) / 10},${Math.round(point[1] * 10) / 10}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(point);
  };
  const dxs = [0, -24, 24, -48, 48, -72, 72];
  const dys = [-10, -26, 20, 36, -50, 52, -74, 74];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]; const b = points[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const dy of dys) for (const dx of dxs) add([mid[0] + dx, mid[1] + dy]);
  }
  return candidates;
}

function placeLabels(connections, selected, boxes) {
  const placed = [];
  for (const connection of connections) {
    if (!connection.label) continue;
    const routed = selected.get(connection.id)?.candidate?.points;
    if (!routed) continue;
    let chosen = null;
    for (const point of candidateLabelPoints(routed)) {
      const rect = labelRect(connection.label, point);
      if ([...boxes.values()].some((box) => rectsOverlap(rect, box, -2))) continue;
      if (placed.some((entry) => rectsOverlap(rect, entry.rect, 2))) continue;
      let clear = true;
      for (const other of connections) {
        if (other.id === connection.id) continue;
        const otherPoints = selected.get(other.id)?.candidate?.points;
        if (!otherPoints) continue;
        for (let i = 0; i < otherPoints.length - 1; i += 1) {
          if (segmentRectClearance(otherPoints[i], otherPoints[i + 1], rect) < 4 - EPS) { clear = false; break; }
        }
        if (!clear) break;
      }
      if (!clear) continue;
      chosen = point; break;
    }
    if (!chosen) return false;
    connection.labelAt = chosen.map((value) => Math.round(value * 10) / 10);
    delete connection.labelDx; delete connection.labelDy; delete connection.labelSegment;
    placed.push({ rect: labelRect(connection.label, chosen), connection });
  }
  return true;
}

function stabilizeArchitectureLayoutMutable(spec) {
  if (!spec || spec.diagram_type !== 'architecture') return { changed: false, reason: 'not-architecture' };
  const components = asArray(spec.components);
  const connections = asArray(spec.connections);
  const boxes = new Map(components.map((component) => [component.id, componentBox(component)]).filter(([, box]) => box));
  if (boxes.size !== components.length || !connections.length) return { changed: false, reason: 'unsupported-layout' };
  if (connections.some((connection) => !boxes.has(connection.from) || !boxes.has(connection.to))) return { changed: false, reason: 'unknown-endpoint' };

  const lanes = laneCoordinates(boxes);
  const candidateMap = new Map();
  for (const connection of connections) {
    const candidates = routeCandidates(connection, boxes, lanes);
    if (!candidates.length) return { changed: false, reason: `no-route:${connection.id || `${connection.from}->${connection.to}`}` };
    candidateMap.set(connection.id, candidates);
  }
  const selected = chooseRoutes(connections, candidateMap);
  if (!selected) return { changed: false, reason: 'no-global-route-set' };

  for (const connection of connections) {
    const candidate = selected.get(connection.id).candidate;
    connection.fromSide = candidate.fromSide;
    connection.toSide = candidate.toSide;
    if (candidate.via.length) connection.via = candidate.via.map((point) => point.map((value) => Math.round(value * 10) / 10));
    else delete connection.via;
    connection.route = candidate.via.length ? undefined : 'straight';
    if (connection.route === undefined) delete connection.route;
    delete connection.labelDx; delete connection.labelDy; delete connection.labelSegment;
  }

  if (!placeLabels(connections, selected, boxes)) return { changed: false, reason: 'no-label-layout' };
  if (Array.isArray(spec.meta?.viewBox)) delete spec.meta.viewBox;
  return { changed: true, reason: 'stabilized', routed: connections.length };
}

export function stabilizeArchitectureLayout(spec) {
  if (!spec || typeof spec !== 'object') return { changed: false, reason: 'not-architecture' };
  const before = JSON.stringify(spec);
  const working = structuredClone(spec);
  const result = stabilizeArchitectureLayoutMutable(working);
  if (!result.changed) return result;
  if (JSON.stringify(working) === before) return { ...result, changed: false, reason: 'already-stable' };
  for (const key of Object.keys(spec)) delete spec[key];
  Object.assign(spec, working);
  return result;
}

export function inspectArchitectureGeometry(spec) {
  const components = asArray(spec?.components);
  const connections = asArray(spec?.connections);
  const boxes = new Map(components.map((component) => [component.id, componentBox(component)]).filter(([, box]) => box));
  const paths = new Map();
  const issues = [];
  for (const connection of connections) {
    const from = boxes.get(connection.from); const to = boxes.get(connection.to);
    if (!from || !to || !connection.fromSide || !connection.toSide) { issues.push({ code: 'missing-route', id: connection.id }); continue; }
    const points = normalizePoints([anchor(from, connection.fromSide), ...asArray(connection.via), anchor(to, connection.toSide)]);
    paths.set(connection.id, points);
    if (!endpointDirectionsValid(points, connection.fromSide, connection.toSide)) issues.push({ code: 'endpoint-side', id: connection.id });
    if (!routeRhythmValid(points)) issues.push({ code: 'route-rhythm', id: connection.id });
    if (!routeClearsComponents(points, connection, boxes)) issues.push({ code: 'edge-through-node', id: connection.id });
  }
  for (let i = 0; i < connections.length; i += 1) {
    const left = connections[i]; const lp = paths.get(left.id); if (!lp) continue;
    for (let j = i + 1; j < connections.length; j += 1) {
      const right = connections[j]; const rp = paths.get(right.id); if (!rp || shareSemanticEndpoint(left, right)) continue;
      if (routesConflict(left, lp, right, rp)) issues.push({ code: 'route-conflict', left: left.id, right: right.id });
    }
  }
  const labelRects = [];
  for (const connection of connections) {
    if (!connection.label || !finitePoint(connection.labelAt)) continue;
    const rect = labelRect(connection.label, connection.labelAt);
    if ([...boxes.values()].some((box) => rectsOverlap(rect, box, -2))) issues.push({ code: 'label-component', id: connection.id });
    for (const other of connections) {
      if (other.id === connection.id) continue;
      const op = paths.get(other.id); if (!op) continue;
      for (let i = 0; i < op.length - 1; i += 1) {
        if (segmentRectClearance(op[i], op[i + 1], rect) < 4 - EPS) { issues.push({ code: 'label-route', id: connection.id, other: other.id }); break; }
      }
    }
    labelRects.push({ connection, rect });
  }
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      if (rectsOverlap(labelRects[i].rect, labelRects[j].rect, 2)) {
        issues.push({ code: 'label-label', left: labelRects[i].connection.id, right: labelRects[j].connection.id });
      }
    }
  }
  return { ok: issues.length === 0, issues, paths: Object.fromEntries([...paths]) };
}
