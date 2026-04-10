// Minimal Phaser 3 Scene that renders the given balls, wall segments, and ground polygon.
// Assumes coordinates are in "world units" (like meters). We map world -> screen with a camera transform.

import Phaser from "phaser";
import {
  ground,
  walls,
  balls,
  type Polygon,
  type Vec,
  stepPhysicsCCD,
} from "./phys.ts";

let i = 0;

export class DebugDisplayScene extends Phaser.Scene {
  // world -> screen
  private readonly scaleWU = 250;
  private readonly originPx = new Phaser.Math.Vector2(500, 300);

  // static visuals
  private staticGfx!: Phaser.GameObjects.Graphics;

  // dynamic visuals (one-time creation, updated via transforms)
  private ballDots = new Map<number, Phaser.GameObjects.Arc>();
  private ballLabels = new Map<number, Phaser.GameObjects.Text>();
  private ballVelLines = new Map<number, Phaser.GameObjects.Line>();

  // static labels
  private wallLabels = new Map<number, Phaser.GameObjects.Text>();

  constructor() {
    super({ key: "EfficientDebugScene" });
  }

  create() {
    // 1) Draw static stuff once
    this.staticGfx = this.add.graphics().setDepth(1);
    this.drawStaticWorld();

    // 2) Create static wall labels once
    this.initWallLabels();

    // 3) Create dynamic objects once
    this.initBallObjects();

    // 4) Initial placement
    this.syncBallObjectsToData();
  }

  // update(time: number, deltaMs: number) {
  //   // Convert to seconds and clamp huge spikes (tab switch / debugger pause)
  //   let frameDt = deltaMs / 1000;
  //   frameDt = Math.min(frameDt, MAX_FRAME_DT);

  //   // Accumulate elapsed real time
  //   accumulator += frameDt;

  //   // Step physics in fixed increments
  //   let steps = 0;

  //   while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
  //     // save previous for interpolation (optional but nice)
  //     cachePrevPositions(this.balls);

  //     stepPhysicsCCD(
  //       this.balls,
  //       this.walls,
  //       this.groundPoly,
  //       FIXED_DT,
  //       this.params,
  //     );

  //     accumulator -= FIXED_DT;
  //     steps++;
  //   }

  //   // alpha is how far we are into the next physics tick
  //   const alpha = accumulator / FIXED_DT;

  //   // Update Phaser sprites from physics state
  //   // If you do interpolation: render = prev*(1-alpha) + curr*alpha
  //   for (const b of this.balls) {
  //     const sprite = this.ballSprites.get(b.id);
  //     if (!sprite) continue;

  //     if (!b.alive) {
  //       sprite.setVisible(false);
  //       sprite.body?.enable && (sprite.body.enable = false); // if using arcade bodies
  //       continue;
  //     }

  //     sprite.setVisible(true);

  //     const prev = prevPos.get(b.id);
  //     if (prev) {
  //       const x = prev.x + (b.p.x - prev.x) * alpha;
  //       const y = prev.y + (b.p.y - prev.y) * alpha;
  //       sprite.setPosition(x, y);
  //     } else {
  //       sprite.setPosition(b.p.x, b.p.y);
  //     }
  //   }
  // }

  update(_t: number, dtMs: number) {
    const dt = dtMs / 1000;

    // if (i++ % 30 === 0)
    stepPhysicsCCD(balls, walls, ground, 1 / 120, { dragK: 0.4 });

    // Update transforms only (no clear/redraw)
    this.syncBallObjectsToData();
  }

  // ----------------- Static world (draw once) -----------------

  private drawStaticWorld() {
    this.staticGfx.clear();

    // ground
    this.drawPolygonStatic(ground, 0x2b2f77, 0.2, 0xffffff, 2);

    // walls
    for (const s of walls) {
      this.drawSegmentStatic(s.a, s.b, 0xffcc00, 3);
    }

    // optional axes (uncomment if you like)
    // this.drawSegmentStatic({ x: -2.5, y: 0 }, { x: 2.5, y: 0 }, 0x666666, 2);
    // this.drawSegmentStatic({ x: 0, y: -1.5 }, { x: 0, y: 1.5 }, 0x666666, 2);
  }

  private initWallLabels() {
    for (const s of walls) {
      const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
      const P = this.w2s(mid);

      const txt = this.add
        .text(P.x + 6, P.y + 6, `wall ${s.id}`, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#ffcc00",
        })
        .setOrigin(0, 0.5)
        .setDepth(5)
        .setShadow(1, 1, "#000", 2);

      this.wallLabels.set(s.id, txt);
    }
  }

  // ----------------- Dynamic balls (create once) -----------------

  private initBallObjects() {
    for (const b of balls) {
      // Ball dot (Arc)
      const dot = this.add.circle(0, 0, 10, 0x00ff99, 1).setDepth(10);
      // Outline
      dot.setStrokeStyle(2, 0x001a10, 1);

      // Velocity line (Line game object)
      const vel = this.add
        .line(0, 0, 0, 0, 0, 0, 0x00ff99, 1)
        .setOrigin(0, 0) // important: make endpoints absolute in its local space
        .setDepth(9);
      vel.setLineWidth(2, 2);

      // Label
      const label = this.add
        .text(0, 0, `ball ${b.id}`, {
          fontFamily: "monospace",
          fontSize: "12px",
          color: "#00ff99",
        })
        .setOrigin(0, 0.5)
        .setDepth(11)
        .setShadow(1, 1, "#000", 2);

      this.ballDots.set(b.id, dot);
      this.ballVelLines.set(b.id, vel);
      this.ballLabels.set(b.id, label);
    }
  }

  private syncBallObjectsToData() {
    for (const b of balls) {
      const dot = this.ballDots.get(b.id);
      const vel = this.ballVelLines.get(b.id);
      const label = this.ballLabels.get(b.id);

      if (!dot || !vel || !label) continue;

      if (!b.alive) {
        dot.setVisible(false);
        vel.setVisible(false);
        label.setVisible(false);
        continue;
      }

      dot.setVisible(true);
      vel.setVisible(true);
      label.setVisible(true);

      const C = this.w2s(b.p);
      const rPx = b.r * this.scaleWU;

      // dot position + radius
      dot.setPosition(C.x, C.y);
      dot.setRadius(rPx);

      // velocity arrow (simple line + little head via a second tiny line segment)
      // We'll keep it as a line object (cheap), and add a tiny "head" by rotating the line ends.
      const tipWorld = { x: b.p.x + b.v.x * 0.15, y: b.p.y + b.v.y * 0.15 };
      const T = this.w2s(tipWorld);

      // For Phaser Line: x,y is object position; x1,y1,x2,y2 are in local space.
      // Easiest: set the line object at 0,0 and use absolute screen coords as endpoints.
      vel.setPosition(0, 0);
      vel.setTo(C.x, C.y, T.x, T.y);

      // label above the ball
      const aboveWorld = { x: b.p.x, y: b.p.y + b.r + 0.04 };
      const L = this.w2s(aboveWorld);
      label.setPosition(L.x + 6, L.y + 6);
    }
  }

  // ----------------- Helpers -----------------

  private w2s(p: Vec): Phaser.Math.Vector2 {
    // Phaser y+ is down; world y+ is up
    return new Phaser.Math.Vector2(
      this.originPx.x + p.x * this.scaleWU,
      this.originPx.y - p.y * this.scaleWU,
    );
  }

  private drawSegmentStatic(
    a: Vec,
    b: Vec,
    color: number,
    lineWidthPx: number,
  ) {
    const A = this.w2s(a);
    const B = this.w2s(b);
    this.staticGfx.lineStyle(lineWidthPx, color, 1);
    this.staticGfx.beginPath();
    this.staticGfx.moveTo(A.x, A.y);
    this.staticGfx.lineTo(B.x, B.y);
    this.staticGfx.strokePath();
  }

  private drawPolygonStatic(
    poly: Polygon,
    fillColor: number,
    fillAlpha: number,
    strokeColor: number,
    strokeWidthPx: number,
  ) {
    const pts = poly.map((p) => this.w2s(p));

    this.staticGfx.fillStyle(fillColor, fillAlpha);
    this.staticGfx.lineStyle(strokeWidthPx, strokeColor, 1);

    this.staticGfx.beginPath();
    this.staticGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++)
      this.staticGfx.lineTo(pts[i].x, pts[i].y);
    this.staticGfx.closePath();

    this.staticGfx.fillPath();
    this.staticGfx.strokePath();
  }
}
