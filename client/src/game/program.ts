import { pointInPolygon, Vector } from "./utils.ts";
import type { PlayerId, PuckId } from "./config.ts";
import RAPIER from "@dimforge/rapier2d-compat";

export type Coordinate = Vector & { __brand: "Coordinate" };
export type PixelVec = Vector & { __brand: "PixelVec" };
export type PhysicsVec = RAPIER.Vector2;

export type PuckData = {
  position: Coordinate;
  radius: number;
  player: PlayerId | null;

  [key: string]: any;
};

export type PlayerData = {
  color?: number;
  secondaryColor?: number;

  [key: string]: any;
};

export type WallSegment = {
  a: Coordinate;
  b: Coordinate;
  thickness: number;
};

export type GroundPolygon = Coordinate[];

export type MapData = {
  walls: WallSegment[];
  groundAreas: GroundPolygon[];
};

export type GameState = {
  winner: PlayerId | null;
  playerData: Record<PlayerId, PlayerData>;
  puckData: Record<PuckId, PuckData>;
  mapData: MapData;

  [key: string]: any;
};

export class PhysicsWorld {
  rapierWorld!: RAPIER.World;
  pucks: Record<PuckId, RAPIER.RigidBody> = {};
}

export type MoveSchema =
  | {
      type: "velocity";
      puckId: PuckId;

      [key: string]: any;
    }
  | {
      type: "ability";
      abilityName: string;
      puckId: PuckId;

      [key: string]: any;
    };

export type PlayerView = {
  moveSchemas: MoveSchema[];
};

export type Move =
  | {
      type: "velocity";
      velocity: Vector;
      puckId: PuckId;

      [key: string]: any;
    }
  | {
      type: "ability";
      abilityName: string;
      puckId: PuckId;

      [key: string]: any;
    };

export type Program = {
  initialState: (config: any) => GameState;
  initialPhysics: (config: any, state: GameState) => PhysicsWorld;
  stateToPlayerViews: (state: GameState) => Record<PlayerId, PlayerView>;
  validateMoves: (
    state: GameState,
    playerId: PlayerId,
    moves: Move[],
  ) => boolean;
  runTurn: (
    state: GameState,
    world: PhysicsWorld,
    moves: Record<PlayerId, Move[]>,
  ) => void;
  coordToPos: (v: Coordinate, origin?: PixelVec) => PixelVec;
  posToCoord: (v: PixelVec, origin?: PixelVec) => Coordinate;
};

export function pointInGround(
  point: Coordinate,
  groundAreas: GroundPolygon[],
): boolean {
  for (const groundArea of groundAreas) {
    if (pointInPolygon(point, groundArea)) {
      return true;
    }
  }
  return false;
}
