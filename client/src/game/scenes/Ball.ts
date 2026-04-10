import Phaser from "phaser";

// Phaser Box2D v3 (from phaser-box2d dist or copied file)
import {
  CreateWorld,
  CreateCircle,
  b2Vec2,
  b2BodyType,
  b2DefaultBodyDef,
  b2DefaultShapeDef,
  b2CreateBody,
  b2MakeOffsetBox,
  b2CreatePolygonShape,
  b2World_Step,
  b2Body_GetPosition,
  b2Body_SetLinearVelocity,
  b2DefaultWorldDef,
  b2Body_SetBullet,
} from "phaser-box2d"; // <- adjust path to wherever you placed it

const SCALE = 30; // pixels per meter

export class BilliardsScene extends Phaser.Scene {
  aimGfx: Phaser.GameObjects.Graphics;
  worldId: number;
  balls: Phaser.GameObjects.Arc[];
  aiming: boolean;
  aimBall: Phaser.GameObjects.Arc | null;
  aimStart: Phaser.Math.Vector2;
  aimEnd: Phaser.Math.Vector2;
  maxPullPx: number;
  power: number;
  _accum: number;
  _fixed: number;
  _subSteps: number;

  constructor() {
    super("BilliardsScene");
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;

    // ---- visuals
    this.add.rectangle(W / 2, H / 2, W, H, 0x0b5a2a);

    const border = this.add.graphics();
    border.lineStyle(8, 0x1b2b1d, 1);
    border.strokeRect(10, 10, W - 20, H - 20);

    this.aimGfx = this.add.graphics();

    // ---- Box2D world (no gravity for top-down billiards)
    const worldDef = b2DefaultWorldDef(); // CreateWorld can be called empty, but we want to override gravity cleanly
    worldDef.gravity = new b2Vec2(0, 0);

    const world = CreateWorld({ worldDef });
    this.worldId = world.worldId;

    // ---- static walls (a single static body with 4 box shapes)
    // pattern based on official tutorial approach :contentReference[oaicite:7]{index=7}
    const staticBodyDef = b2DefaultBodyDef();
    staticBodyDef.type = b2BodyType.b2_staticBody;
    staticBodyDef.position = new b2Vec2(0, 0);
    const staticBodyId = b2CreateBody(this.worldId, staticBodyDef);

    const shapeDef = b2DefaultShapeDef();
    // Restitution on walls is controlled by shapeDef.restitution if you set it;
    // If you want "bouncier", you can set: shapeDef.restitution = 0.9;

    // Build walls in *meters*
    const pad = 18; // pixels inside border
    const left = pad / SCALE;
    const top = pad / SCALE;
    const right = (W - pad) / SCALE;
    const bottom = (H - pad) / SCALE;

    const thickness = 0.35; // meters
    const halfT = thickness / 2;

    // Horizontal walls
    const ground = b2MakeOffsetBox(
      (right - left) / 2,
      halfT,
      new b2Vec2((left + right) / 2, bottom),
      0,
    );
    b2CreatePolygonShape(staticBodyId, shapeDef, ground);

    const ceiling = b2MakeOffsetBox(
      (right - left) / 2,
      halfT,
      new b2Vec2((left + right) / 2, top),
      0,
    );
    b2CreatePolygonShape(staticBodyId, shapeDef, ceiling);

    // Vertical walls
    const leftWall = b2MakeOffsetBox(
      halfT,
      (bottom - top) / 2,
      new b2Vec2(left, (top + bottom) / 2),
      0,
    );
    b2CreatePolygonShape(staticBodyId, shapeDef, leftWall);

    const rightWall = b2MakeOffsetBox(
      halfT,
      (bottom - top) / 2,
      new b2Vec2(right, (top + bottom) / 2),
      0,
    );
    b2CreatePolygonShape(staticBodyId, shapeDef, rightWall);

    // ---- balls
    this.balls = [];
    const radiusPx = 14;
    const radiusM = radiusPx / SCALE;

    const positionsPx = [
      { x: W * 0.25, y: H * 0.5 }, // cue-ish
      { x: W * 0.65, y: H * 0.45 },
      { x: W * 0.69, y: H * 0.5 },
      { x: W * 0.73, y: H * 0.55 },
      { x: W * 0.67, y: H * 0.58 },
    ];

    positionsPx.forEach((p, i) => {
      const circle = this.add.circle(
        p.x,
        p.y,
        radiusPx,
        i === 0 ? 0xffffff : 0xffd166,
      );
      circle.setStrokeStyle(2, 0x000000, 0.25);

      circle.setInteractive(
        new Phaser.Geom.Circle(0, 0, radiusPx),
        Phaser.Geom.Circle.Contains,
      );

      // Create dynamic circle body in Box2D (meters)
      const body = CreateCircle({
        worldId: this.worldId,
        type: b2BodyType.b2_dynamicBody,
        position: new b2Vec2(p.x / SCALE, p.y / SCALE),
        radius: radiusM,
        density: 1.0,
        friction: 0.002,
        restitution: 0.95, // bouncy balls
      });
      b2Body_SetBullet(body.bodyId, true); // continuous collision for fast-moving small objects like billiard balls

      // store mapping
      circle.bodyId = body.bodyId;

      this.balls.push(circle);
    });

    // ---- aiming controls
    this.aiming = false;
    this.aimBall = null;
    this.aimStart = new Phaser.Math.Vector2();
    this.aimEnd = new Phaser.Math.Vector2();
    this.maxPullPx = 180;
    this.power = 10; // (m/s) per (meter of pull). Tune to taste.

    this.input.on("gameobjectdown", (pointer, obj) => {
      this.aiming = true;
      this.aimBall = obj;
      this.aimStart.set(obj.x, obj.y);
      this.aimEnd.set(pointer.worldX, pointer.worldY);
    });

    this.input.on("pointermove", (pointer) => {
      if (!this.aiming) return;
      this.aimEnd.set(pointer.worldX, pointer.worldY);
    });

    this.input.on("pointerup", () => {
      if (!this.aiming || !this.aimBall) return;

      const pull = new Phaser.Math.Vector2(
        this.aimEnd.x - this.aimStart.x,
        this.aimEnd.y - this.aimStart.y,
      );

      const pullLenPx = Phaser.Math.Clamp(pull.length(), 0, this.maxPullPx);
      if (pullLenPx > 0.001) {
        const dir = pull.clone().normalize().negate(); // pull back to shoot forward

        const pullLenM = pullLenPx / SCALE;
        const speed = pullLenM * this.power; // m/s

        const v = new b2Vec2(dir.x * speed, dir.y * speed);
        b2Body_SetLinearVelocity(this.aimBall.bodyId, v); // :contentReference[oaicite:8]{index=8}
      }

      this.aiming = false;
      this.aimBall = null;
      this.aimGfx.clear();
    });

    // ---- fixed timestep stepping
    this._accum = 0;
    this._fixed = 1 / 60;
    this._subSteps = 4;
  }

  update(_, deltaMs) {
    // Step physics with a fixed timestep for stability :contentReference[oaicite:9]{index=9}
    this._accum += deltaMs / 1000;

    // avoid spiral-of-death if tab was inactive
    this._accum = Math.min(this._accum, 0.25);

    while (this._accum >= this._fixed) {
      b2World_Step(this.worldId, this._fixed, this._subSteps);
      this._accum -= this._fixed;
    }

    // Sync Phaser circles from Box2D bodies
    for (const ball of this.balls) {
      const p = b2Body_GetPosition(ball.bodyId);
      ball.x = p.x * SCALE;
      ball.y = p.y * SCALE;
    }

    // Draw aim arrow
    this.aimGfx.clear();
    if (this.aiming && this.aimBall) {
      const start = this.aimStart;
      const end = this.aimEnd;

      const pull = new Phaser.Math.Vector2(end.x - start.x, end.y - start.y);
      if (pull.length() > this.maxPullPx) pull.setLength(this.maxPullPx);

      const tip = new Phaser.Math.Vector2(start.x + pull.x, start.y + pull.y);

      this.aimGfx.lineStyle(3, 0xfff1a8, 1);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(start.x, start.y);
      this.aimGfx.lineTo(tip.x, tip.y);
      this.aimGfx.strokePath();

      // simple arrowhead
      const angle = Phaser.Math.Angle.Between(start.x, start.y, tip.x, tip.y);
      const head = 12;
      const left = new Phaser.Math.Vector2(
        tip.x - head * Math.cos(angle - Math.PI / 6),
        tip.y - head * Math.sin(angle - Math.PI / 6),
      );
      const right = new Phaser.Math.Vector2(
        tip.x - head * Math.cos(angle + Math.PI / 6),
        tip.y - head * Math.sin(angle + Math.PI / 6),
      );

      this.aimGfx.fillStyle(0xfff1a8, 1);
      this.aimGfx.beginPath();
      this.aimGfx.moveTo(tip.x, tip.y);
      this.aimGfx.lineTo(left.x, left.y);
      this.aimGfx.lineTo(right.x, right.y);
      this.aimGfx.closePath();
      this.aimGfx.fillPath();
    }
  }
}
