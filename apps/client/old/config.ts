import jexl from "jexl";
import type Expression from "jexl/Expression";
import YAML from "yaml";

export type Hex = {
  q: number;
  r: number;
};

const SQRT3 = Math.sqrt(3);

export function hexToPixel(
  hex: Vector,
  size: number,
  origin: Vector = new Vector(0, 0),
): Vector {
  const x = size * SQRT3 * (hex.x + hex.y / 2);
  const y = ((size * 3) / 2) * hex.y;
  return new Vector(x + origin.x, y + origin.y);
}

export function pixelToHex(
  v: Vector,
  size: number,
  origin: Vector = new Vector(0, 0),
): Vector {
  let x = v.x;
  let y = v.y;
  x -= origin.x;
  y -= origin.y;

  const q = ((SQRT3 / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;

  return new Vector(q, r);
}

export function hexRound(hex: Hex): Hex {
  let x = hex.q;
  let z = hex.r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;

  return { q: rx, r: rz };
}

export function hexCorners(c: Vector, size: number): Vector[] {
  const corners: Vector[] = [];
  const startAngle = -Math.PI / 6; // pointy-top
  for (let i = 0; i < 6; i++) {
    const a = startAngle + i * (Math.PI / 3);
    corners.push(
      new Vector(c.x + size * Math.cos(a), c.y + size * Math.sin(a)),
    );
  }
  return corners;
}

export type Tile = {
  data?: any;
};

export type PuckId = string & { __brand: "PuckId" };
export type PlayerId = string & { __brand: "PlayerId" };

export type Player = {
  color: string;
};

export type Puck = {
  playerId: PlayerId | null;
  radius: number;
  data?: any;
};

export type GridConfig = {
  size: number;
  origin: Vector;
  type: "hex" | "square";
};

// export type TriggerDef =
//   | {
//       type: "init";
//     }
//   | {
//       type: "turnStart";
//       turn: number;
//     }
//   | {
//       type: "puckEnterTile";
//       puckIndex: number;
//       tileCoord: [number, number];
//     }
//   | {
//       type: "puckEliminated";
//       puckIndex: number;
//     };
export type TriggerDef =
  | "init"
  | "turnStart"
  | "puckEnterTile"
  | "puckEliminated";

export type EffectDef =
  | {
      type: "win";
      playerId: PlayerId;
    }
  | {
      type: "setVar";
      varName: string;
      value: string;
    };

export type Effect =
  | {
      type: "win";
      playerId: Expression;
    }
  | {
      type: "setVar";
      varName: string;
      value: Expression;
    };

export type RuleDef = {
  on: TriggerDef;
  if?: string;
  do: EffectDef[];
};

export type Rule = {
  on: TriggerDef;
  if?: Expression;
  do: Effect[];
};

export type GameConfigDoc = {
  dim: [number, number];
  grid: GridConfig;
  players: Record<string, Player>;
  tiles: ({ tile?: Tile; coord: [number, number] } | [number, number])[];
  initialPucks: { puck: Puck; coord: [number, number] }[];
  rules: RuleDef[];
};

export type GameConfig = {
  dim: [number, number];
  grid: GridConfig;
  players: Record<string, Player>;
  tiles: { tile: Tile; coord: Vector }[];
  initialPucks: { puck: Puck; coord: Vector }[];
  rules: Rule[];
};

function parseRuleDef(ruleDef: RuleDef): Rule {
  const rule: Rule = {
    on: ruleDef.on,
    if: ruleDef.if ? jexl.compile(ruleDef.if) : undefined,
    do: ruleDef.do.map((effectDef) => {
      if (effectDef.type === "win") {
        return {
          type: "win",
          playerId: jexl.compile(effectDef.playerId),
        };
      } else if (effectDef.type === "setVar") {
        return {
          type: "setVar",
          varName: effectDef.varName,
          value: jexl.compile(effectDef.value),
        };
      } else {
        throw new Error(`Unknown effect type: ${(effectDef as any).type}`);
      }
    }),
  };

  return rule;
}

export function parseGameConfig(doc: GameConfigDoc): GameConfig {
  const rules: Rule[] = doc.rules.map(parseRuleDef);

  return {
    dim: doc.dim,
    grid: doc.grid,
    players: doc.players,
    tiles: doc.tiles.map((t) => {
      const coord = "coord" in t ? t.coord : t;
      return {
        tile: "tile" in t ? t.tile || {} : {},
        coord: new Vector(coord[0], coord[1]),
      };
    }),
    initialPucks: doc.initialPucks.map((p) => ({
      puck: p.puck,
      coord: new Vector(p.coord[0], p.coord[1]),
    })),
    rules,
  };
}

export function parseGameConfigYaml(yamlStr: string): GameConfig {
  const doc = YAML.parse(yamlStr) as GameConfigDoc;
  return parseGameConfig(doc);
}
