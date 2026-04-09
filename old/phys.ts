/* ============================================================================
Deterministic 2D billiards-like physics with continuous collision detection (CCD)
- Balls are disks (no spin)
- Walls are line segments
- Solid ground is a simple polygon (CCW or CW). Balls are removed when their
  CENTER leaves the polygon (you can pre-shrink your polygon by radius if you
  want "disk fully inside" semantics).
- Linear drag: dv/dt = -k v (exact integration)
- Fixed-step, event-driven time-of-impact (TOI) solver
============================================================================ */

export type Vec = { x: number; y: number };

export type Ball = {
  id: number;
  p: Vec; // position (center)
  v: Vec; // velocity
  r: number; // radius
  m: number; // mass (your "weight")
  alive: boolean;
};

export type Segment = {
  id: number;
  a: Vec;
  b: Vec;
};

export type Polygon = Vec[]; // closed implicitly (last connects to first)

export type Params = {
  // Drag coefficient k (1/seconds). k=0 disables drag.
  dragK: number;

  // Restitution (bounciness)
  restitutionBall: number; // for ball-ball
  restitutionWall: number; // for ball-wall

  // If |v| falls below this, snap to 0 to avoid endless tiny motion.
  vStop: number;

  // Epsilons
  epsU: number; // simultaneity grouping in u-space
  epsDist: number; // overlap tolerance
  maxEventsPerStep: number;

  minAdvanceTime: number;
  minAdvanceU: number;
};

const DEFAULT_PARAMS: Params = {
  dragK: 0.5,
  restitutionBall: 0.98,
  restitutionWall: 0.9,
  vStop: 1e-3,
  epsU: 1e-10,
  epsDist: 1e-9,
  maxEventsPerStep: 64,
  minAdvanceTime: 1e-6,
  minAdvanceU: 1e-12,
};

/* =========================
   Vector helpers
========================= */
function v(x: number, y: number): Vec {
  return { x, y };
}
function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}
function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}
function mul(a: Vec, s: number): Vec {
  return { x: a.x * s, y: a.y * s };
}
function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}
function len2(a: Vec): number {
  return dot(a, a);
}
function len(a: Vec): number {
  return Math.sqrt(len2(a));
}
function perpLeft(a: Vec): Vec {
  return { x: -a.y, y: a.x };
}
function perpRight(a: Vec): Vec {
  return { x: a.y, y: -a.x };
}
function normalize(a: Vec): Vec {
  const L = len(a);
  if (L === 0) return { x: 0, y: 0 };
  return { x: a.x / L, y: a.y / L };
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/* =========================
   Drag mapping helpers
   u(t) = (1 - exp(-k t))/k
   t(u) = -ln(1 - k u)/k
========================= */
function uFromTime(t: number, k: number): number {
  if (k === 0) return t;
  return (1 - Math.exp(-k * t)) / k;
}
function timeFromU(u: number, k: number): number {
  if (k === 0) return u;
  // u must satisfy 0 <= u < 1/k
  return -Math.log(1 - k * u) / k;
}
function decayFactor(t: number, k: number): number {
  if (k === 0) return 1;
  return Math.exp(-k * t);
}

/* =========================
   Polygon helpers (solid ground)
========================= */
function polygonSignedArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}

/** Ray casting point-in-polygon (boundary counts as inside). */
function pointInPolygon(p: Vec, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];

    // Check if on segment (boundary): treat as inside
    if (pointOnSegment(p, pj, pi, 1e-12)) return true;

    const intersect =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointOnSegment(p: Vec, a: Vec, b: Vec, eps: number): boolean {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const t = dot(ap, ab) / (dot(ab, ab) || 1);
  if (t < -eps || t > 1 + eps) return false;
  const closest = add(a, mul(ab, clamp(t, 0, 1)));
  return len2(sub(p, closest)) <= eps * eps;
}

/* =========================
   Closest point on segment
========================= */
function closestPointOnSegment(p: Vec, a: Vec, b: Vec): { q: Vec; t: number } {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom === 0) return { q: a, t: 0 };
  const t = clamp(dot(sub(p, a), ab) / denom, 0, 1);
  return { q: add(a, mul(ab, t)), t };
}

/* =========================
   Events
========================= */
type EventOut = { kind: "out"; u: number; ballId: number };
type EventWall = {
  kind: "wall";
  u: number;
  ballId: number;
  wallId: number;
  normal: Vec;
};
type EventBall = { kind: "ball"; u: number; aId: number; bId: number };
type Event = EventOut | EventWall | EventBall;

function eventPriority(e: Event): number {
  // Deterministic ordering for simultaneous events
  // 0: out-of-play, 1: wall, 2: ball-ball
  if (e.kind === "out") return 0;
  if (e.kind === "wall") return 1;
  return 2;
}

function eventKey(e: Event): number[] {
  // Lexicographic key for deterministic tie-break
  // Use stable IDs
  if (e.kind === "out") return [eventPriority(e), e.ballId, 0, 0];
  if (e.kind === "wall") return [eventPriority(e), e.ballId, e.wallId, 0];
  const a = Math.min(e.aId, e.bId);
  const b = Math.max(e.aId, e.bId);
  return [eventPriority(e), a, b, 0];
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/* =========================
   CCD: Ball-ball TOI in u-space
========================= */
function ballBallTOIu(
  a: Ball,
  b: Ball,
  uMax: number,
  epsU: number,
): number | null {
  const p = sub(b.p, a.p);
  const vrel = sub(b.v, a.v);
  const R = a.r + b.r;

  const A = dot(vrel, vrel);
  const B = 2 * dot(p, vrel);
  const C = dot(p, p) - R * R;

  if (A === 0) return null;

  // If already overlapping, treat as immediate collision at u=0
  if (C <= 0) return 0;

  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;

  const sqrtD = Math.sqrt(disc);
  const u1 = (-B - sqrtD) / (2 * A);
  // const u2 = (-B + sqrtD) / (2 * A); // later root

  if (u1 < -epsU || u1 > uMax + epsU) return null;

  // Closing condition at u=0
  if (dot(p, vrel) >= 0) return null;

  return clamp(u1, 0, uMax);
}

/* =========================
   CCD: Ball vs segment wall TOI in u-space
   We compute earliest contact with:
   - infinite line (side hit) and check projection within segment
   - endpoints (cap hits)
   Returns {u, normalAtImpact} or null
========================= */
function ballWallTOIu(
  ball: Ball,
  seg: Segment,
  uMax: number,
  epsU: number,
): { u: number; normal: Vec } | null {
  const A = seg.a;
  const B = seg.b;
  const d = sub(B, A);
  const dLen2 = dot(d, d);
  if (dLen2 === 0) {
    // Treat as point
    return ballPointTOIu(ball, A, uMax, epsU);
  }

  // Endpoints (cap hits): swept point vs circle
  const hitA = ballPointTOIu(ball, A, uMax, epsU);
  const hitB = ballPointTOIu(ball, B, uMax, epsU);

  // Side hit with infinite line:
  // Build a consistent normal for the line.
  // We'll compute normal at impact based on closest point anyway.
  // For candidate times, solve distance to line equals radius.
  const nLine = normalize(perpLeft(d)); // arbitrary but consistent

  const s0 = dot(sub(ball.p, A), nLine);
  const sn = dot(ball.v, nLine);

  let best: { u: number; normal: Vec } | null = null;

  // If moving parallel to line, no side crossing unless already overlapping
  if (sn !== 0) {
    // We want |s0 + sn*u| = r, but only if approaching the line.
    // Solve two candidates: s0 + sn*u = +r and = -r
    const candUs = [(ball.r - s0) / sn, (-ball.r - s0) / sn];

    for (const uc of candUs) {
      if (uc < -epsU || uc > uMax + epsU) continue;
      const u = clamp(uc, 0, uMax);

      // Position at u
      const pAt = add(ball.p, mul(ball.v, u));

      // Closest point on infinite line:
      const sAt = dot(sub(pAt, A), nLine);
      const q = sub(pAt, mul(nLine, sAt)); // projected onto line

      // Check if q is within segment
      const lambda = dot(sub(q, A), d) / dLen2;
      if (lambda < -1e-12 || lambda > 1 + 1e-12) continue;

      // Must be moving toward the line at impact (sn should reduce |dist|).
      // Compute dist sign at u=0 and u=epsilon to infer approach:
      // Simpler: require (s0 * sn) < 0 OR we are on the "wrong side" and moving inward.
      // Use actual distance reduction near impact:
      // We'll accept if sn * (sAt) < 0 (crossing toward 0) OR if u==0 with overlap.
      if (u > 0 && sn * sAt > 0) continue;

      // Normal points from wall (line) toward ball at impact:
      const { q: qs } = closestPointOnSegment(pAt, A, B);
      const normal = normalize(sub(pAt, qs));

      // If normal is zero (rare), fallback to line normal direction
      const n =
        normal.x === 0 && normal.y === 0
          ? sAt >= 0
            ? nLine
            : mul(nLine, -1)
          : normal;

      if (
        !best ||
        u < best.u - epsU ||
        (Math.abs(u - best.u) <= epsU && lexLess([seg.id], [seg.id]))
      ) {
        best = { u, normal: n };
      }
    }
  } else {
    // Parallel: if already within radius from line and projected within segment, treat as u=0 hit
    const distAbs = Math.abs(s0);
    if (distAbs <= ball.r) {
      const { q: q0 } = closestPointOnSegment(ball.p, A, B);
      const normal = normalize(sub(ball.p, q0));
      if (!(normal.x === 0 && normal.y === 0)) {
        best = { u: 0, normal };
      }
    }
  }

  // Choose earliest among side and endpoint hits
  const candidates: { u: number; normal: Vec }[] = [];
  if (best) candidates.push(best);
  if (hitA) candidates.push(hitA);
  if (hitB) candidates.push(hitB);

  if (candidates.length === 0) return null;

  candidates.sort((x, y) => x.u - y.u);
  return candidates[0];
}

function ballPointTOIu(
  ball: Ball,
  point: Vec,
  uMax: number,
  epsU: number,
): { u: number; normal: Vec } | null {
  const p = sub(ball.p, point);
  const v0 = ball.v;
  const R = ball.r;

  const A = dot(v0, v0);
  const B = 2 * dot(p, v0);
  const C = dot(p, p) - R * R;

  if (A === 0) {
    if (C <= 0) {
      const n = normalize(p);
      return { u: 0, normal: n.x === 0 && n.y === 0 ? v(1, 0) : n };
    }
    return null;
  }

  if (C <= 0) {
    const n = normalize(p);
    return { u: 0, normal: n.x === 0 && n.y === 0 ? v(1, 0) : n };
  }

  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const u1 = (-B - sqrtD) / (2 * A);
  if (u1 < -epsU || u1 > uMax + epsU) return null;
  const u = clamp(u1, 0, uMax);

  const pAt = add(ball.p, mul(ball.v, u));
  const n = normalize(sub(pAt, point));
  return { u, normal: n.x === 0 && n.y === 0 ? v(1, 0) : n };
}

/* =========================
   CCD: Leaving solid ground (point leaves polygon)
   We treat "inside" as point-in-polygon with boundary inside.
   Event occurs when segment p(u) crosses an edge outward.

   Determinism note:
   - We determine polygon winding once.
   - Outward normal depends on winding:
     * CCW polygon: outward normal is right perpendicular of edge
     * CW polygon: outward normal is left perpendicular of edge
========================= */
function leavingPolygonTOIu(
  ball: Ball,
  poly: Polygon,
  uMax: number,
  epsU: number,
): number | null {
  // If currently outside -> remove immediately
  if (!pointInPolygon(ball.p, poly)) return 0;

  const area = polygonSignedArea(poly);
  const isCCW = area > 0;

  const p0 = ball.p;
  const p1 = add(ball.p, mul(ball.v, uMax));

  let bestU: number | null = null;

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e = sub(b, a);

    // Outward normal:
    const nOut = normalize(isCCW ? perpRight(e) : perpLeft(e));

    // We consider crossing the supporting line from inside to outside:
    // signed distance to line through a with normal nOut:
    const s0 = dot(sub(p0, a), nOut);
    const s1 = dot(sub(p1, a), nOut);

    // Inside half-space is s <= 0 (for outward normal). Leaving means s goes from <=0 to >0.
    if (s0 <= 0 && s1 > 0) {
      // Solve s0 + (s1 - s0) * t = 0 for t in (0,1]
      const denom = s1 - s0;
      if (denom === 0) continue;
      const t = -s0 / denom; // in (0,1)
      if (t < -1e-12 || t > 1 + 1e-12) continue;

      // Intersection point with boundary line at that t
      const u = clamp(t * uMax, 0, uMax);

      const pAt = add(ball.p, mul(ball.v, u));

      // Check if intersection is within segment (a,b) using projection
      const { q, t: segT } = closestPointOnSegment(pAt, a, b);
      // pAt is on the line; if it's close to segment, accept
      if (segT >= -1e-6 && segT <= 1 + 1e-6 && len2(sub(pAt, q)) <= 1e-8) {
        if (bestU === null || u < bestU - epsU) bestU = u;
      }
    }
  }

  // Optional: if bestU is null but end is outside, fallback to binary search (rare numeric edge cases)
  if (bestU === null && !pointInPolygon(p1, poly)) {
    let lo = 0;
    let hi = uMax;
    for (let it = 0; it < 60; it++) {
      const mid = 0.5 * (lo + hi);
      const pm = add(ball.p, mul(ball.v, mid));
      if (pointInPolygon(pm, poly)) lo = mid;
      else hi = mid;
    }
    bestU = hi;
  }

  return bestU;
}

/* =========================
   Advance with exact drag
========================= */
function advanceAll(balls: Ball[], dt: number, k: number): void {
  if (dt <= 0) return;

  if (k === 0) {
    for (const b of balls) {
      if (!b.alive) continue;
      b.p = add(b.p, mul(b.v, dt));
    }
    return;
  }

  const e = decayFactor(dt, k);
  const u = (1 - e) / k;

  for (const b of balls) {
    if (!b.alive) continue;
    b.p = add(b.p, mul(b.v, u));
    b.v = mul(b.v, e);
  }
}

/* =========================
   Resolve collisions
========================= */
function resolveBallBall(
  a: Ball,
  b: Ball,
  restitution: number,
  epsDist: number,
): void {
  const dp = sub(b.p, a.p);
  const dist = len(dp);
  let n: Vec;
  if (dist === 0) {
    // Arbitrary deterministic normal if coincident
    n = v(1, 0);
  } else {
    n = mul(dp, 1 / dist);
  }

  const vrel = dot(sub(b.v, a.v), n);
  if (vrel >= 0) return; // separating

  const invMa = a.m > 0 ? 1 / a.m : 0;
  const invMb = b.m > 0 ? 1 / b.m : 0;
  const j = (-(1 + restitution) * vrel) / (invMa + invMb || 1);

  a.v = add(a.v, mul(n, -j * invMa));
  b.v = add(b.v, mul(n, j * invMb));

  // Small positional correction to prevent immediate re-collide due to eps
  const target = a.r + b.r;
  const penetration = target - dist;
  if (penetration > 0) {
    const slop = epsDist;
    const corr = Math.max(0, penetration - slop);
    const totalInv = invMa + invMb || 1;
    const moveA = corr * (invMa / totalInv);
    const moveB = corr * (invMb / totalInv);
    a.p = add(a.p, mul(n, -moveA));
    b.p = add(b.p, mul(n, moveB));
  }
}

function resolveBallWall(
  ball: Ball,
  normal: Vec,
  restitution: number,
  epsDist: number,
): void {
  const n = normalize(normal);
  const vn = dot(ball.v, n);
  if (vn >= 0) return; // moving away

  // Reflect with restitution: v' = v - (1+e)*vn*n
  ball.v = sub(ball.v, mul(n, (1 + restitution) * vn));

  // No robust positional correction here because we used exact TOI,
  // but we can nudge slightly to avoid numerical stickiness.
  ball.p = add(ball.p, mul(n, epsDist));
}

/* =========================
   Find earliest events
========================= */
function findEventsAtMinU(
  balls: Ball[],
  walls: Segment[],
  ground: Polygon,
  uMax: number,
  params: Params,
): { minU: number; events: Event[] } | null {
  let minU = Infinity;
  const all: Event[] = [];

  // Out-of-play (ground leaving)
  for (const b of balls) {
    if (!b.alive) continue;
    const uOut = leavingPolygonTOIu(b, ground, uMax, params.epsU);
    if (uOut === null) continue;
    if (uOut < minU - params.epsU) {
      minU = uOut;
      all.length = 0;
      all.push({ kind: "out", u: uOut, ballId: b.id });
    } else if (Math.abs(uOut - minU) <= params.epsU) {
      all.push({ kind: "out", u: uOut, ballId: b.id });
    }
  }

  // Ball-wall
  for (const b of balls) {
    if (!b.alive) continue;
    for (const w of walls) {
      const hit = ballWallTOIu(b, w, uMax, params.epsU);
      if (!hit) continue;
      const u = hit.u;
      if (u < minU - params.epsU) {
        minU = u;
        all.length = 0;
        all.push({
          kind: "wall",
          u,
          ballId: b.id,
          wallId: w.id,
          normal: hit.normal,
        });
      } else if (Math.abs(u - minU) <= params.epsU) {
        all.push({
          kind: "wall",
          u,
          ballId: b.id,
          wallId: w.id,
          normal: hit.normal,
        });
      }
    }
  }

  // Ball-ball
  // Deterministic: iterate by increasing IDs
  const aliveBalls = balls
    .filter((b) => b.alive)
    .slice()
    .sort((a, b) => a.id - b.id);
  for (let i = 0; i < aliveBalls.length; i++) {
    for (let j = i + 1; j < aliveBalls.length; j++) {
      const A = aliveBalls[i];
      const B = aliveBalls[j];
      const u = ballBallTOIu(A, B, uMax, params.epsU);
      if (u === null) continue;

      if (u < minU - params.epsU) {
        minU = u;
        all.length = 0;
        all.push({ kind: "ball", u, aId: A.id, bId: B.id });
      } else if (Math.abs(u - minU) <= params.epsU) {
        all.push({ kind: "ball", u, aId: A.id, bId: B.id });
      }
    }
  }

  if (!isFinite(minU)) return null;

  // Filter to events within epsU of minU (in case earlier section added and later found smaller)
  const events = all.filter((e) => Math.abs(e.u - minU) <= params.epsU);

  // Deterministic ordering among simultaneous events
  events.sort((e1, e2) => {
    const k1 = eventKey(e1);
    const k2 = eventKey(e2);
    return lexLess(k1, k2) ? -1 : lexLess(k2, k1) ? 1 : 0;
  });

  return { minU, events };
}

function ballById(balls: Ball[], id: number): Ball | undefined {
  // If you want speed, store in Map outside. This is simplest.
  return balls.find((b) => b.id === id);
}

/* =========================
   Public: step simulation by fixed dt
========================= */
export function stepPhysicsCCD(
  balls: Ball[],
  walls: Segment[],
  solidGround: Polygon,
  dt: number,
  paramsPartial: Partial<Params> = {},
): void {
  const params: Params = { ...DEFAULT_PARAMS, ...paramsPartial };
  const k = params.dragK;

  let remaining = dt;

  for (let iter = 0; iter < params.maxEventsPerStep && remaining > 0; iter++) {
    // Snap tiny velocities to 0 (deterministic: do at top of each sub-iteration)
    for (const b of balls) {
      if (!b.alive) continue;
      if (len2(b.v) < params.vStop * params.vStop) b.v = v(0, 0);
    }

    // If everything stopped, just exit quickly
    let anyMoving = false;
    for (const b of balls) {
      if (b.alive && (b.v.x !== 0 || b.v.y !== 0)) {
        anyMoving = true;
        break;
      }
    }
    if (!anyMoving) break;

    const uMax = uFromTime(remaining, k);

    const found = findEventsAtMinU(balls, walls, solidGround, uMax, params);
    if (!found) {
      // No events in remaining time: advance all and finish
      advanceAll(balls, remaining, k);
      remaining = 0;
      break;
    }

    const uHitRaw = found.minU;
    let uHit = clamp(uHitRaw, 0, uMax);
    let tHit = timeFromU(uHit, k);

    // If earliest event is essentially "now", don't get stuck.
    // Resolve, then force a tiny deterministic advance if we still don't progress.
    const isZeroTime =
      tHit <= params.minAdvanceTime || uHit <= params.minAdvanceU;

    // Advance only if non-zero time
    if (!isZeroTime) {
      advanceAll(balls, tHit, k);
      remaining -= tHit;
    } else {
      // no time advance yet; we'll resolve events at current state
      tHit = 0;
      uHit = 0;
    }

    // Resolve all events at this exact time (deterministic order)
    for (const e of found.events) {
      if (e.kind === "out") {
        const b = ballById(balls, e.ballId);
        if (!b || !b.alive) continue;
        // Remove if outside (or on boundary but moving outward).
        if (!pointInPolygon(b.p, solidGround)) {
          b.alive = false;
          b.v = v(0, 0);
        } else {
          // Edge case: numeric jitter. If still inside, do nothing.
        }
      } else if (e.kind === "wall") {
        const b = ballById(balls, e.ballId);
        if (!b || !b.alive) continue;
        // Recompute normal robustly at impact by finding closest point
        const w = walls.find((s) => s.id === e.wallId);
        if (!w) continue;

        const { q } = closestPointOnSegment(b.p, w.a, w.b);
        const n = normalize(sub(b.p, q));
        const normal = n.x === 0 && n.y === 0 ? e.normal : n;

        resolveBallWall(b, normal, params.restitutionWall, params.epsDist);
      } else {
        const a = ballById(balls, e.aId);
        const b = ballById(balls, e.bId);
        if (!a || !b || !a.alive || !b.alive) continue;
        resolveBallBall(a, b, params.restitutionBall, params.epsDist);
      }
    }
    if (isZeroTime && remaining > 0) {
      const micro = Math.min(params.minAdvanceTime, remaining);
      advanceAll(balls, micro, k);
      remaining -= micro;
    }

    // After resolving, if remaining is very tiny, stop
    if (remaining < 1e-12) break;
  }

  // Final snap of tiny velocities
  for (const b of balls) {
    if (!b.alive) continue;
    if (len2(b.v) < params.vStop * params.vStop) b.v = v(0, 0);
  }
}

// Random balls
export const balls: Ball[] = Array.from({ length: 10 }, (_, i) => ({
  id: i,
  p: v(Math.random() * 2 - 1.5, Math.random() * 2 - 1.5),
  v: v(Math.random() * 400 - 2, Math.random() * 400 - 2),
  r: 0.05,
  m: 1,
  alive: true,
}));

export const walls: Segment[] = [
  { id: 10, a: { x: -2, y: -1 }, b: { x: 2, y: -1 } },
  { id: 11, a: { x: 2, y: -1 }, b: { x: 2, y: 1 } },
  { id: 12, a: { x: 2, y: 1 }, b: { x: -2, y: 1 } },
  { id: 13, a: { x: -2, y: 1 }, b: { x: -2, y: -1 } },
];

export const ground: Polygon = [
  { x: -2, y: -1 },
  { x: 2, y: -1 },
  { x: 2, y: 1 },
  { x: -2, y: 1 },
];
