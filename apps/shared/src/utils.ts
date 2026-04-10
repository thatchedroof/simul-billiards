import RAPIER from "@dimforge/rapier2d-compat";
import type { PixelVec, PhysicsVec, PhysicsWorld } from "./index.js";
import type { PuckId } from "./program.js";
import chroma from "chroma-js";
import Vector from "victor";

export function vectorFrom(x: number, y: number): Vector;
export function vectorFrom(obj: { x: number; y: number }): Vector;
export function vectorFrom(arr: [number, number]): Vector;
export function vectorFrom(...args: any[]): Vector {
  if (args.length === 1) {
    const arg = args[0];
    if (Array.isArray(arg)) {
      return new Vector(arg[0], arg[1]);
    } else if (typeof arg === "object" && "x" in arg && "y" in arg) {
      return new Vector(arg.x, arg.y);
    }
  } else if (args.length === 2) {
    return new Vector(args[0], args[1]);
  }
  throw new Error("Invalid arguments for vectorFrom");
}

export const PPM = 50;

export function pixToPhysics(v: PixelVec): PhysicsVec {
  return new RAPIER.Vector2(v.x / PPM, v.y / PPM) as PhysicsVec;
}

export function physicsToPix(v: PhysicsVec): PixelVec {
  return new Vector(v.x * PPM, v.y * PPM) as PixelVec;
}

export type PhysicsPuckState = {
  position: PhysicsVec;
  velocity: PhysicsVec;
  angle: number;
  angularVelocity: number;
};

export function stateFromRigidBody(rb: RAPIER.RigidBody): PhysicsPuckState {
  return {
    position: rb.translation() as PhysicsVec,
    velocity: rb.linvel() as PhysicsVec,
    angle: rb.rotation(),
    angularVelocity: rb.angvel(),
  };
}

export type PredictionResult = {
  points: PhysicsPuckState[];
  events: (
    | {
        type: "collision";
        with: "puck" | "wall";
        state: PhysicsPuckState;
      }
    | {
        type: "stop";
        state: PhysicsPuckState;
      }
    | {
        type: "oob";
        state: PhysicsPuckState;
      }
  )[];
};

export function cloneWorld(world: PhysicsWorld): PhysicsWorld {
  const snapshot = world.rapierWorld.takeSnapshot();
  const rapierWorld = RAPIER.World.restoreSnapshot(snapshot);
  let pucks: Record<PuckId, RAPIER.RigidBody> = {};

  for (const [puckId, rigidBody] of Object.entries(world.pucks)) {
    const newRigidBody = rapierWorld.getRigidBody(rigidBody.handle);
    if (newRigidBody) {
      pucks[puckId as PuckId] = newRigidBody;
    }
  }

  return { rapierWorld, pucks };
}

export function pointInPolygon(
  point: { x: number; y: number },
  polygon: { x: number; y: number }[],
): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

export function applyIceDrag(
  rb: RAPIER.RigidBody,
  dt: number,
  opts = {
    fastDecel: 0.8,
    slowDecel: 3.5,
    slowSpeed: 1.2,
    stopSpeed: 0.05,
    angDecel: 2.0,
    angStopSpeed: 0.1,
  },
): boolean {
  if (rb.isSleeping()) return true;

  const v = rb.linvel();
  const speed = Math.hypot(v.x, v.y);

  const angvel = rb.angvel();
  const absAngvel = Math.abs(angvel);

  // --- Linear drag ---
  if (speed < opts.stopSpeed) {
    rb.setLinvel({ x: 0, y: 0 }, true);
  } else {
    const decel = speed < opts.slowSpeed ? opts.slowDecel : opts.fastDecel;
    let dv = decel * dt;
    if (dv > speed) dv = speed; // don't reverse

    const invSpeed = 1.0 / speed;
    const dirx = v.x * invSpeed;
    const diry = v.y * invSpeed;

    const mass = rb.mass();
    const j = mass * dv;
    const impulse = new RAPIER.Vector2(-dirx * j, -diry * j);

    rb.applyImpulse(impulse, true);
  }

  // --- Angular drag ---
  if (absAngvel < opts.angStopSpeed) {
    rb.setAngvel(0, true);
  } else {
    let dw = opts.angDecel * dt;
    if (dw > absAngvel) dw = absAngvel; // don't reverse

    const newAngvel = Math.sign(angvel) * (absAngvel - dw);
    rb.setAngvel(newAngvel, true);
  }

  // Sleep only when both are effectively stopped
  const finalV = rb.linvel();
  const finalSpeed = Math.hypot(finalV.x, finalV.y);
  const finalAbsAngvel = Math.abs(rb.angvel());

  if (finalSpeed < opts.stopSpeed && finalAbsAngvel < opts.angStopSpeed) {
    rb.setLinvel({ x: 0, y: 0 }, true);
    rb.setAngvel(0, true);
    rb.sleep();
    return true;
  }

  return false;
}

const GOLDEN_ANGLE = 137.50776405003785;

export function generateColor(n: number): {
  color: number;
  secondaryColor: number;
} {
  return {
    color: chroma.lch(70, 50, (n * GOLDEN_ANGLE) % 360).num(),
    secondaryColor: chroma.lch(90, 50, (n * GOLDEN_ANGLE) % 360).num(),
  };
}

export type PhysicsWorldSnapshot = {
  rapierWorld: Uint8Array<ArrayBufferLike>;
  pucks: Record<PuckId, number>;
};

export function snapshotFromWorld(world: PhysicsWorld): PhysicsWorldSnapshot {
  const rapierWorld = world.rapierWorld.takeSnapshot();
  const pucks: Record<PuckId, number> = {};
  for (const [puckId, rigidBody] of Object.entries(world.pucks)) {
    pucks[puckId as PuckId] = rigidBody.handle;
  }
  return { rapierWorld, pucks };
}

export function worldFromSnapshot(
  snapshot: PhysicsWorldSnapshot,
): PhysicsWorld {
  const rapierWorld = RAPIER.World.restoreSnapshot(snapshot.rapierWorld);
  const pucks: Record<PuckId, RAPIER.RigidBody> = {};
  for (const [puckId, handle] of Object.entries(snapshot.pucks)) {
    const rigidBody = rapierWorld.getRigidBody(handle);
    if (rigidBody) {
      pucks[puckId as PuckId] = rigidBody;
    }
  }
  return { rapierWorld, pucks };
}

// export function worldFromSnapshot(
//   snapshot: Uint8Array<ArrayBufferLike>,
// ): PhysicsWorld {
//   const rapierWorld = RAPIER.World.restoreSnapshot(snapshot);
//   const pucks: Record<PuckId, RAPIER.RigidBody> = {};
//   rapierWorld.forEachRigidBody((body: RAPIER.RigidBody) => {
//     const data = body.userData as { puckId?: PuckId } | undefined;
//     console.log(data);
//     if (data?.puckId) {
//       pucks[data.puckId] = body;
//     }
//   });
//   return { rapierWorld, pucks };
// }
