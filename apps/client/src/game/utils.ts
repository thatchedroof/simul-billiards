import type { PixelVec } from "@siturbi/shared";
import Vector from "victor";

export function pixelVector(
  v: Phaser.Math.Vector2 | { x: number; y: number },
): PixelVec {
  return new Vector(v.x, v.y) as PixelVec;
}
