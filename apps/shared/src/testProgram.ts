import RAPIER from "@dimforge/rapier2d-compat";
import type {
  Program,
  PuckId,
  Coordinate,
  PlayerId,
  GameState,
  PlayerView,
  PixelVec,
  PuckData,
} from "./program.js";
import { pixToPhysics, PPM } from "./utils.js";
import Vector from "victor";

export const testProgram: Program = {
  initialState: (_, playerData) => {
    const puckData: Record<PuckId, PuckData> = {};
    // Create a puck for each player in a circle.
    // If only one player has joined, put it in the center.
    const playerIds = Object.keys(playerData);
    const numPlayers = playerIds.length;
    const radius = 5;
    playerIds.forEach((playerId, index) => {
      const angle = (index / numPlayers) * 2 * Math.PI;
      const position = new Vector(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
      ) as Coordinate;
      puckData[`puck-${playerId}` as PuckId] = {
        position: testProgram.coordToPos(position),
        radius: 20,
        player: playerId as PlayerId,
      };
    });

    const mapData = {
      walls: [
        {
          a: new Vector(-7, -7) as Coordinate,
          b: new Vector(7, -7) as Coordinate,
          thickness: 1,
        },
        {
          a: new Vector(7, -7) as Coordinate,
          b: new Vector(7, 7) as Coordinate,
          thickness: 1,
        },
        {
          a: new Vector(7, 7) as Coordinate,
          b: new Vector(-7, 7) as Coordinate,
          thickness: 1,
        },
        {
          a: new Vector(-7, 7) as Coordinate,
          b: new Vector(-7, -7) as Coordinate,
          thickness: 1,
        },
      ],
      groundAreas: [
        [
          new Vector(-8, -8) as Coordinate,
          new Vector(8, -8) as Coordinate,
          new Vector(8, 8) as Coordinate,
          new Vector(-8, 8) as Coordinate,
        ],
      ],
    };

    return {
      winner: null,
      playerData,
      puckData,
      mapData,
    };
  },
  initialPhysics: (_, state: GameState) => {
    const world = new RAPIER.World(new RAPIER.Vector2(0.0, 0.0));
    let pucks: Record<PuckId, RAPIER.RigidBody> = {};

    for (const [id, puck] of Object.entries(state.puckData)) {
      const pos = pixToPhysics(puck.position);
      const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setCcdEnabled(true)
        .setTranslation(pos.x, pos.y)
        .setAngularDamping(0.9)
        .setLinearDamping(0.9);
      const rigidBody = world.createRigidBody(rigidBodyDesc);
      rigidBody.userData = { puckId: id as PuckId };

      const colliderDesc = RAPIER.ColliderDesc.ball(
        puck.radius / PPM,
      ).setRestitution(0.7);
      world.createCollider(colliderDesc, rigidBody);
      pucks[id as PuckId] = rigidBody;
    }

    return { rapierWorld: world, pucks };
  },
  stateToPlayerViews: (state: GameState) => {
    const playerViews: Record<PlayerId, PlayerView> = {};
    for (const playerId in state.playerData) {
      playerViews[playerId as PlayerId] = {
        moveSchemas: Object.entries(state.puckData)
          .filter(([_, puck]) => puck.player === playerId)
          .map(([puckId, _]) => ({
            type: "velocity",
            puckId: puckId as PuckId,
          })),
      };
    }
    return playerViews;
  },
  validateMoves: () => true,
  runTurn: (_, world, moves) => {
    // Apply moves to physics world
    for (const [_, moveList] of Object.entries(moves)) {
      for (const move of moveList) {
        if (move.type === "velocity") {
          const rigidBody = world.pucks[move.puckId as PuckId];
          rigidBody.setLinvel(
            new RAPIER.Vector2(move.velocity.x, move.velocity.y),
            true,
          );
        }
      }
    }
  },
  coordToPos: (v, origin = new Vector(0, 0) as PixelVec) => {
    return new Vector(v.x * 50 + origin.x, v.y * 50 + origin.y) as PixelVec;
  },
  posToCoord: (v, origin = new Vector(0, 0) as PixelVec) => {
    return new Vector(
      (v.x - origin.x) / 50,
      (v.y - origin.y) / 50,
    ) as Coordinate;
  },
};
