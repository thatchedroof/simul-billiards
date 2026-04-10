/* ============================================================================
Deterministic continuous physics for 2D billiards-like game (no spin).
- Balls: positions, velocities, radius, mass.
- Segments: walls (collide) and edges (fall off/out-of-play).
- Uses Time-Of-Impact (TOI) event loop inside each fixed dt.
============================================================================ */

export type Vec2 = { x: number; y: number };

export interface Ball {
  id: number;
  p: Vec2;
  v: Vec2;
  r: number;
  m: number; // mass
  active: boolean;
}

export interface Segment {
  id: number;
  a: Vec2;
  b: Vec2;
  // Unit normal. For walls: points toward the playable side.
  // For edges: points from playable area toward "outside" (out-of-play).
  n: Vec2;
  kind: "wall" | "edge";
  restitution?: number; // default 1
}

export interface StepConfig {
  // global defaults
  restitution: number; // default 1
  maxSubSteps: number; // default 64
  eps: number; // default 1e-9
  epsTime: number; // default 1e-8
  // If true, apply tiny positional correction after collision to kill numeric overlap.
  positionalCorrection: boolean; // default true
  // If true, clamp tiny velocities to 0 after resolves
  clampTinyVelocity: boolean; // default true
  tinyVel: number; // default 1e-10
}

const DEFAULT_CFG: StepConfig = {
  restitution: 1.0,
  maxSubSteps: 64,
  eps: 1e-9,
  epsTime: 1e-8,
  positionalCorrection: true,
  clampTinyVelocity: true,
  tinyVel: 1e-10,
};

/* ============================= Vector utils ============================= */

function vAdd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}
function vSub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
function vMul(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}
function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}
function len2(a: Vec2): number {
  return dot(a, a);
}
function len(a: Vec2): number {
  return Math.sqrt(len2(a));
}

function normalize(a: Vec2, eps: number): Vec2 {
  const l = len(a);
  if (l <= eps) return { x: 1, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/* ============================= Event model ============================== */

type EventType = "BALL_BALL" | "BALL_WALL" | "BALL_EDGE";

interface EventBase {
  t: number; // time within remaining interval
  type: EventType; // for sorting / tie-breaking
}

// Ball-ball collision
interface BallBallEvent extends EventBase {
  type: "BALL_BALL";
  aId: number;
  bId: number;
  n: Vec2; // unit normal from A to B at impact
}

// Ball-wall collision (reflect)
interface BallWallEvent extends EventBase {
  type: "BALL_WALL";
  ballId: number;
  segId: number;
  n: Vec2; // unit normal (wall normal, pointing toward playable)
}

// Ball-edge crossing (out of play)
interface BallEdgeEvent extends EventBase {
  type: "BALL_EDGE";
  ballId: number;
  segId: number;
}

type Event = BallBallEvent | BallWallEvent | BallEdgeEvent;

function eventPriority(type: EventType): number {
  // Resolve "edge out-of-play" first at same time? or after collisions?
  // Deterministic choice. In billiards, if you cross boundary, you're out.
  // We'll prioritize EDGE, then collisions.
  switch (type) {
    case "BALL_EDGE":
      return 0;
    case "BALL_WALL":
      return 1;
    case "BALL_BALL":
      return 2;
  }
}

function compareEvents(e1: Event, e2: Event, epsTime: number): number {
  // Primary: time
  const dt = e1.t - e2.t;
  if (Math.abs(dt) > epsTime) return dt < 0 ? -1 : 1;

  // Secondary: event type priority
  const p1 = eventPriority(e1.type);
  const p2 = eventPriority(e2.type);
  if (p1 !== p2) return p1 - p2;

  // Tertiary: ids to be fully deterministic
  // Sort by involved ids in a stable manner.
  const key1 = eventKey(e1);
  const key2 = eventKey(e2);
  return key1 < key2 ? -1 : key1 > key2 ? 1 : 0;
}

function eventKey(e: Event): string {
  // Stable lexicographic key
  switch (e.type) {
    case "BALL_EDGE":
      return `E:${e.ballId}:${e.segId}`;
    case "BALL_WALL":
      return `W:${e.ballId}:${e.segId}`;
    case "BALL_BALL": {
      const a = Math.min(e.aId, e.bId);
      const b = Math.max(e.aId, e.bId);
      return `B:${a}:${b}`;
    }
  }
}

/* ============================ Main stepping ============================= */

export function stepContinuous(
  balls: Ball[],
  segments: Segment[],
  dt: number,
  cfgIn?: Partial<StepConfig>,
): void {
  const cfg: StepConfig = { ...DEFAULT_CFG, ...(cfgIn ?? {}) };

  // Build id maps for fast lookup (deterministic: do not iterate Map in a nondeterministic way)
  const ballById = new Map<number, Ball>();
  for (const b of balls) ballById.set(b.id, b);

  const segById = new Map<number, Segment>();
  for (const s of segments) segById.set(s.id, s);

  let remaining = dt;

  for (let sub = 0; sub < cfg.maxSubSteps && remaining > cfg.epsTime; sub++) {
    const ev = findEarliestEvent(balls, segments, remaining, cfg);

    if (!ev) {
      advanceAll(balls, remaining);
      break;
    }

    // Advance all balls to event time
    if (ev.t > 0) advanceAll(balls, ev.t);

    // Resolve
    resolveEvent(ev, ballById, segById, cfg);

    remaining -= ev.t;

    if (cfg.clampTinyVelocity) clampTinyVelocities(balls, cfg.tinyVel);
  }

  // Consume any leftover tiny time
  if (remaining > cfg.epsTime) {
    advanceAll(balls, remaining);
  }
}

function advanceAll(balls: Ball[], t: number): void {
  for (const b of balls) {
    if (!b.active) continue;
    b.p = vAdd(b.p, vMul(b.v, t));
  }
}

function clampTinyVelocities(balls: Ball[], tiny: number): void {
  const tiny2 = tiny * tiny;
  for (const b of balls) {
    if (!b.active) continue;
    if (len2(b.v) < tiny2) b.v = { x: 0, y: 0 };
  }
}

/* ======================== Event finding (CCD) =========================== */

function findEarliestEvent(
  balls: Ball[],
  segments: Segment[],
  maxT: number,
  cfg: StepConfig,
): Event | null {
  let best: Event | null = null;

  // --- ball-ball
  // If you have many balls, replace with broadphase. For billiards-scale (<= 32), O(n^2) is fine.
  for (let i = 0; i < balls.length; i++) {
    const A = balls[i];
    if (!A.active) continue;

    for (let j = i + 1; j < balls.length; j++) {
      const B = balls[j];
      if (!B.active) continue;

      const ev = toiBallBall(A, B, maxT, cfg);
      if (!ev) continue;

      best = pickBetter(best, ev, cfg.epsTime);
    }
  }

  // --- ball-segment (walls and edges)
  for (const b of balls) {
    if (!b.active) continue;

    for (const s of segments) {
      if (s.kind === "wall") {
        const ev = toiBallWall(b, s, maxT, cfg);
        if (!ev) continue;
        best = pickBetter(best, ev, cfg.epsTime);
      } else {
        const ev = toiBallEdge(b, s, maxT, cfg);
        if (!ev) continue;
        best = pickBetter(best, ev, cfg.epsTime);
      }
    }
  }

  return best;
}

function pickBetter(
  cur: Event | null,
  candidate: Event,
  epsTime: number,
): Event {
  if (!cur) return candidate;
  return compareEvents(candidate, cur, epsTime) < 0 ? candidate : cur;
}

/* ========================= TOI: ball-ball =============================== */

function toiBallBall(
  A: Ball,
  B: Ball,
  maxT: number,
  cfg: StepConfig,
): BallBallEvent | null {
  const dp = vSub(B.p, A.p);
  const dv = vSub(B.v, A.v);
  const R = A.r + B.r;

  const a = dot(dv, dv);
  const b = 2 * dot(dp, dv);
  const c = dot(dp, dp) - R * R;

  // Already overlapping?
  if (c <= 0) {
    // If overlapping and moving toward each other, treat as immediate collision at t=0 with a reasonable normal.
    // Deterministic normal: use dp if possible, else use relative velocity direction.
    const n = normalize(len2(dp) > cfg.eps ? dp : vMul(dv, -1), cfg.eps);
    return { type: "BALL_BALL", t: 0, aId: A.id, bId: B.id, n };
  }

  if (a <= cfg.eps) return null; // no relative motion

  // Must be approaching: b < 0 indicates decreasing distance initially.
  if (b >= 0) return null;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const sqrtD = Math.sqrt(disc);
  const t = (-b - sqrtD) / (2 * a);
  if (t < 0 || t > maxT) return null;

  const pA = vAdd(A.p, vMul(A.v, t));
  const pB = vAdd(B.p, vMul(B.v, t));
  const n = normalize(vSub(pB, pA), cfg.eps);

  return { type: "BALL_BALL", t, aId: A.id, bId: B.id, n };
}

/* ====================== TOI: ball vs wall segment ======================= */

function toiBallWall(
  ball: Ball,
  seg: Segment,
  maxT: number,
  cfg: StepConfig,
): BallWallEvent | null {
  const n = normalize(seg.n, cfg.eps);
  const a = seg.a;
  const b = seg.b;

  // Candidate 1: hit the segment interior via supporting line
  let bestT = Infinity;
  let bestN: Vec2 | null = null;

  const vn = dot(ball.v, n);
  // For a wall, we collide if moving toward the wall plane: vn < 0 (given n points into playable area)
  if (vn < -cfg.eps) {
    const dist0 = dot(vSub(ball.p, a), n); // signed distance to line along n
    // Touch when dist(t) = ball.r
    const tLine = (ball.r - dist0) / vn; // vn negative, so this is positive if dist0 > r
    if (tLine >= -cfg.epsTime && tLine <= maxT + cfg.epsTime) {
      const t = clampTimeToRange(tLine, maxT, cfg.epsTime);
      if (t !== null) {
        const pc = vAdd(ball.p, vMul(ball.v, t));
        if (pointProjectsInsideSegment(pc, a, b, cfg.eps)) {
          bestT = t;
          bestN = n;
        }
      }
    }
  }

  // Candidate 2 & 3: endpoint caps as circle-point TOI
  const tA = toiBallPoint(ball, a, maxT, cfg);
  if (tA !== null && tA < bestT - cfg.epsTime) {
    bestT = tA;
    const pc = vAdd(ball.p, vMul(ball.v, bestT));
    bestN = normalize(vSub(pc, a), cfg.eps);
  } else if (tA !== null && Math.abs(tA - bestT) <= cfg.epsTime && bestN) {
    // tie: keep deterministic normal: prefer wall normal over endpoint? We'll keep earlier bestN.
  }

  const tB = toiBallPoint(ball, b, maxT, cfg);
  if (tB !== null && tB < bestT - cfg.epsTime) {
    bestT = tB;
    const pc = vAdd(ball.p, vMul(ball.v, bestT));
    bestN = normalize(vSub(pc, b), cfg.eps);
  }

  if (bestT === Infinity || !bestN) return null;

  // If collision normal would not oppose motion (numeric issues), reject.
  if (dot(ball.v, bestN) >= 0) return null;

  return {
    type: "BALL_WALL",
    t: bestT,
    ballId: ball.id,
    segId: seg.id,
    n: bestN,
  };
}

// TOI for moving circle center vs fixed point, radius = ball.r
function toiBallPoint(
  ball: Ball,
  point: Vec2,
  maxT: number,
  cfg: StepConfig,
): number | null {
  const dp = vSub(point, ball.p);
  const dv = vMul(ball.v, -1); // relative velocity of point in ball frame
  const R = ball.r;

  const a = dot(dv, dv);
  const b = 2 * dot(dp, dv);
  const c = dot(dp, dp) - R * R;

  if (c <= 0) return 0; // already touching/inside endpoint cap
  if (a <= cfg.eps) return null;
  if (b >= 0) return null;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;

  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > maxT) return null;
  return t;
}

function pointProjectsInsideSegment(
  p: Vec2,
  a: Vec2,
  b: Vec2,
  eps: number,
): boolean {
  const d = vSub(b, a);
  const dd = dot(d, d);
  if (dd <= eps) return false;
  const u = dot(vSub(p, a), d) / dd;
  return u >= -eps && u <= 1 + eps;
}

function clampTimeToRange(
  t: number,
  maxT: number,
  epsTime: number,
): number | null {
  if (t < -epsTime) return null;
  if (t < 0) return 0;
  if (t > maxT + epsTime) return null;
  if (t > maxT) return maxT;
  return t;
}

/* ======================== TOI: ball crosses edge ======================== */

function toiBallEdge(
  ball: Ball,
  seg: Segment,
  maxT: number,
  cfg: StepConfig,
): BallEdgeEvent | null {
  // Interpret edge as a "boundary you can cross outward":
  // Crossing condition: dot((p + v t) - a, n) = 0 (or = -r if you want whole ball out)
  // with dot(v, n) < 0 meaning moving outward (since n points toward outside).
  const n = normalize(seg.n, cfg.eps);
  const a = seg.a;
  const b = seg.b;

  const vn = dot(ball.v, n);
  if (vn >= -cfg.eps) return null; // not moving outward enough

  const dist0 = dot(vSub(ball.p, a), n);

  // Choose threshold:
  // - If you want ball to be "out" when its CENTER crosses, use 0.
  // - If you want it out only when completely past edge, use -ball.r.
  const threshold = 0; // or -ball.r

  const tLine = (threshold - dist0) / vn;
  if (tLine < -cfg.epsTime || tLine > maxT + cfg.epsTime) return null;

  const t = clampTimeToRange(tLine, maxT, cfg.epsTime);
  if (t === null) return null;

  const pc = vAdd(ball.p, vMul(ball.v, t));
  if (!pointProjectsInsideSegment(pc, a, b, cfg.eps)) return null;

  return { type: "BALL_EDGE", t, ballId: ball.id, segId: seg.id };
}

/* ============================= Resolution =============================== */

function resolveEvent(
  ev: Event,
  ballById: Map<number, Ball>,
  segById: Map<number, Segment>,
  cfg: StepConfig,
): void {
  switch (ev.type) {
    case "BALL_EDGE": {
      const b = ballById.get(ev.ballId);
      if (!b || !b.active) return;
      // Mark out-of-play
      b.active = false;
      // Optional: zero velocity to keep things clean
      b.v = { x: 0, y: 0 };
      return;
    }

    case "BALL_WALL": {
      const b = ballById.get(ev.ballId);
      const s = segById.get(ev.segId);
      if (!b || !b.active || !s) return;

      const e = s.restitution ?? cfg.restitution;
      const n = normalize(ev.n, cfg.eps);

      const vn = dot(b.v, n);
      if (vn >= 0) return; // separating

      // Reflect normal component with restitution
      // v' = v - (1+e) * vn * n
      b.v = vSub(b.v, vMul(n, (1 + e) * vn));

      if (cfg.positionalCorrection) {
        // Tiny correction to keep from sinking due to numeric error:
        // Push ball along n so it is at least r away from wall line if this normal came from wall line.
        // For endpoint normals, correction still harmless.
        // Use a very small amount (eps-scaled).
        b.p = vAdd(b.p, vMul(n, cfg.eps * 10));
      }
      return;
    }

    case "BALL_BALL": {
      const A = ballById.get(ev.aId);
      const B = ballById.get(ev.bId);
      if (!A || !B || !A.active || !B.active) return;

      // Ensure deterministic ordering by id: treat "A" as smaller id in calculations if you want.
      // Here we keep as event stored but compute impulse correctly regardless.
      const n = normalize(ev.n, cfg.eps);

      const rv = vSub(B.v, A.v);
      const vn = dot(rv, n);
      if (vn >= 0) return; // separating

      const e = cfg.restitution;

      const invMA = A.m > cfg.eps ? 1 / A.m : 0;
      const invMB = B.m > cfg.eps ? 1 / B.m : 0;
      const denom = invMA + invMB;
      if (denom <= cfg.eps) return;

      const j = (-(1 + e) * vn) / denom;

      A.v = vSub(A.v, vMul(n, j * invMA));
      B.v = vAdd(B.v, vMul(n, j * invMB));

      if (cfg.positionalCorrection) {
        // Tiny symmetric separation along normal
        const corr = cfg.eps * 10;
        A.p = vSub(A.p, vMul(n, corr));
        B.p = vAdd(B.p, vMul(n, corr));
      }
      return;
    }
  }
}

/* ============================== Helpers =================================
Optional: build a segment normal from endpoints (if you don't want to supply n).
Given segment AB, one possible normal is perp(B-A) normalized. But you must
choose its direction (toward playable/outside) consistently in your level data.
============================================================================ */

export function computeSegmentNormal(a: Vec2, b: Vec2, eps = 1e-9): Vec2 {
  const d = vSub(b, a);
  return normalize(perp(d), eps);
}

const balls: Ball[] = [
  {
    id: 1,
    p: { x: 0, y: 0 },
    v: { x: 10, y: 0 },
    r: 0.0285,
    m: 0.17,
    active: true,
  },
  {
    id: 2,
    p: { x: 1, y: 0 },
    v: { x: 0, y: 0 },
    r: 0.0285,
    m: 0.17,
    active: true,
  },
];

const segments: Segment[] = [
  // Wall segment with normal pointing inward (playable side)
  {
    id: 100,
    a: { x: -2, y: -1 },
    b: { x: 2, y: -1 },
    n: { x: 0, y: 1 },
    kind: "wall",
  },
  // Edge segment with normal pointing outward (toward outside)
  {
    id: 200,
    a: { x: -2, y: 1 },
    b: { x: 2, y: 1 },
    n: { x: 0, y: 1 },
    kind: "edge",
  },
];

const dt = 1 / 120;
stepContinuous(balls, segments, dt, { restitution: 1, maxSubSteps: 64 });
