import { AUTO, Game } from "phaser";
import { Game as MainGame } from "./scenes/Game.ts";
import RAPIER from "@dimforge/rapier2d-compat";
import { pixToPhysics, PPM, Vector } from "./utils.ts";
import type { PuckId, PlayerId } from "./config.ts";
import type {
  Program,
  GameState,
  PlayerView,
  PixelVec,
  Coordinate,
} from "./program.ts";

const testProgram: Program = {
  initialState: () => {
    // An alternating 5x5 grid of pucks each 5 squares apart
    const puckData: Record<
      PuckId,
      { position: Coordinate; radius: number; player: PlayerId | null }
    > = {};
    const gridSize = 2;
    const spacing = 5;
    let puckIndex = 0;
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const puckId = `puck${puckIndex}` as PuckId;
        const x = j * spacing - ((gridSize - 1) * spacing) / 2;
        const y = i * spacing - ((gridSize - 1) * spacing) / 2;
        puckData[puckId] = {
          position: new Vector(x, y) as Coordinate,
          radius: 20,
          player:
            (i + j) % 2 === 0
              ? ("player1" as PlayerId)
              : ("player2" as PlayerId),
        };
        puckIndex++;
      }
    }

    const playerData = {
      player1: { color: 0xff0000, secondaryColor: 0xffaaaa },
      player2: { color: 0x0000ff, secondaryColor: 0xaaaaff },
    };

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
      const pos = pixToPhysics(testProgram.coordToPos(puck.position));
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
  runTurn: (state, world, moves) => {
    // Apply moves to physics world
    for (const [playerId, moveList] of Object.entries(moves)) {
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

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  width: 1920,
  height: 1080,
  parent: "game-container",
  backgroundColor: "#0b5a2a",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [
    new MainGame({
      key: "MainGame",
    }),
  ],
};

const StartGame = (parent: string) => {
  const game = new Game({ ...config, parent });

  game.scene.start("MainGame", testProgram);

  return game;
};

export default StartGame;
