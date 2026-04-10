import RAPIER from "@dimforge/rapier2d-compat";
import {
  PhysicsWorld,
  PuckId,
  MoveSchema,
  pointInGround,
  Program,
  GameState,
} from "./program.js";
import {
  PredictionResult,
  stateFromRigidBody,
  applyIceDrag,
  physicsToPix,
} from "./utils.js";

export function predictTrajectory(
  world: PhysicsWorld,
  moves: Record<PuckId, MoveSchema[]>,
  program: Program,
  state: GameState,
  config: {
    predictStride: number;
  },
): Record<PuckId, PredictionResult> {
  const results: Record<PuckId, PredictionResult> = {};
  const idByRBHandle: Record<number, PuckId> = {};

  program.runTurn(state, world, moves);

  // Add colliders to event queue
  for (const [puckId, puck] of Object.entries(world.pucks)) {
    idByRBHandle[puck.handle] = puckId as PuckId;
    for (let i = 0; i < puck.numColliders(); i++) {
      const col = world.rapierWorld.getCollider(puck.collider(i).handle);
      col.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }

    // Add initial positions to results
    results[puckId as PuckId] = {
      points: [stateFromRigidBody(puck)],
      events: [],
    };
  }

  const eventQueue = new RAPIER.EventQueue(true);
  const maxSteps = 60000;

  const inactivePucks: Set<PuckId> = new Set();

  for (let step = 0; step < maxSteps; step++) {
    // Drain collision-start events; record puck centers at that step
    eventQueue.drainCollisionEvents((c1: any, c2: any, started: any) => {
      if (!started) return;

      const col1 = world.rapierWorld.getCollider(c1);
      const col2 = world.rapierWorld.getCollider(c2);

      const rb1Handle = col1.parent()?.handle;
      const rb2Handle = col2.parent()?.handle;

      // Handle static collisions
      if (rb1Handle === undefined || rb2Handle === undefined) {
        const puckHandle = rb1Handle ?? rb2Handle;
        const puckId = idByRBHandle[puckHandle!];
        if (puckId) {
          const puck = world.rapierWorld.getRigidBody(puckHandle!);

          results[puckId].events.push({
            type: "collision",
            with: "wall",
            state: stateFromRigidBody(puck),
          });
        }
      }

      const id1 = idByRBHandle[rb1Handle!];
      const id2 = idByRBHandle[rb2Handle!];

      const rb1 = world.rapierWorld.getRigidBody(rb1Handle!);
      const rb2 = world.rapierWorld.getRigidBody(rb2Handle!);

      const p1 = stateFromRigidBody(rb1);
      const p2 = stateFromRigidBody(rb2);

      // Push "collision centers" (not contact points)
      if (id1) {
        results[id1].events.push({
          type: "collision",
          with: "puck",
          state: p1,
        });
      }
      if (id2) {
        results[id2].events.push({
          type: "collision",
          with: "puck",
          state: p2,
        });
      }
    });

    let pucksSleeping = 0;

    for (const [puckId, puck] of Object.entries(world.pucks)) {
      if (inactivePucks.has(puckId as PuckId)) {
        pucksSleeping++;
        continue;
      }

      const sleeping = applyIceDrag(puck, world.rapierWorld.timestep);

      if (sleeping) {
        pucksSleeping++;
      }
    }

    // Step with events
    world.rapierWorld.step(eventQueue);

    // Record trajectory samples
    for (const [puckId, puck] of Object.entries(world.pucks)) {
      if (inactivePucks.has(puckId as PuckId)) {
        continue;
      }

      const p = stateFromRigidBody(puck);

      // If puck is out of bounds, remove it from the simulation and stop tracking its trajectory
      const pos = program.posToCoord(physicsToPix(p.position));
      if (!pointInGround(pos, state.mapData.groundAreas)) {
        world.rapierWorld.removeRigidBody(puck);

        inactivePucks.add(puckId as PuckId);
        results[puckId as PuckId].events.push({
          type: "oob",
          state: p,
        });
        continue;
      }

      if (step % config.predictStride === 0) {
        results[puckId as PuckId].points.push(p);
      }
    }

    if (pucksSleeping === Object.keys(world.pucks).length) {
      // Add the final stop point of every puck to events
      for (const [puckId, puck] of Object.entries(world.pucks)) {
        if (inactivePucks.has(puckId as PuckId)) {
          continue;
        }

        results[puckId as PuckId].events.push({
          type: "stop",
          state: stateFromRigidBody(puck),
        });
      }

      break;
    }
  }
  return results;
}
