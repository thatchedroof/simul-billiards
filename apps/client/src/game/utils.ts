import type { PixelVec } from "@siturbi/shared";
import Vector from "victor";

export function pixelVector(
  v: Phaser.Math.Vector2 | { x: number; y: number },
): PixelVec {
  return new Vector(v.x, v.y) as PixelVec;
}

const makeRoundedButton = (
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  onClick: () => void,
) => {
  const radius = 10;

  g.fillStyle(0x222222, 0.8);
  g.fillRoundedRect(x, y, width, height, radius);

  // Create interactive hit area manually
  const hitArea = new Phaser.Geom.Rectangle(x, y, width, height);

  g.setInteractive(hitArea, Phaser.Geom.Rectangle.Contains);

  const text = this.add
    .text(x + 10, y + 10, label, {
      fontSize: "16px",
      color: "#ffffff",
    })
    .setScrollFactor(0)
    .setDepth(1001);

  g.on("pointerdown", onClick);

  // Hover effect
  g.on("pointerover", () => {
    g.clear();
    g.fillStyle(0x444444, 0.9);
    g.fillRoundedRect(x, y, width, height, radius);
  });

  g.on("pointerout", () => {
    g.clear();
    g.fillStyle(0x222222, 0.8);
    g.fillRoundedRect(x, y, width, height, radius);
  });

  return { g, text };
};
