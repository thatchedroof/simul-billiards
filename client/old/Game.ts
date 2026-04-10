import RAPIER from "@dimforge/rapier2d-compat";
// https://www.npmjs.com/package/@dimforge/rapier2d-deterministic-compat
import { Scene } from "phaser";
import {
  hexCorners,
  hexToPixel,
  parseGameConfigYaml,
  pixelToHex,
  type GameConfig,
  type Puck,
} from "../src/game/config.ts";
import { applyIceDrag, vectorFrom } from "../src/game/utils.ts";

type Vector = Phaser.Math.Vector2;
const Vector = Phaser.Math.Vector2;

const config = parseGameConfigYaml(`
dim: [800, 600]
grid:
  type: hex
  size: 50
players:
  player1: { color: "#ff0000" }
  player2: { color: "#0000ff" }
tiles:
  - [0, 0]
  - [4, 5]
  - [-6, 3]
initialPucks:
  - puck: { playerId: player1, radius: 20 }
    coord: [0, 0]
  - puck: { playerId: player2, radius: 20 }
    coord: [4, 5]
  - puck: { playerId: player1, radius: 20 }
    coord: [-6, 3]
rules:
  - on: turnEnd
    if: players[.pucks.length != 0].length == 1
    do:
      - type: win
        playerId: players[.pucks.length != 0][0].id
`);

const PPM = 50; // pixels per meter, for physics scaling

export class Game extends Scene {
  config!: GameConfig;

  /* Physics */
  rapierWorld!: RAPIER.World;
  pucks: Map<
    number,
    { def: Puck; puck: RAPIER.RigidBody; currentMove?: RAPIER.Vector2 }
  > = new Map();

  /* Drag state */
  isDragging = false;
  dragStart = new Vector(0, 0);
  camStart = new Vector(0, 0);

  /* Aiming state */
  selectedPuck?: number;
  isAiming = false;
  aimStartWorld = new Vector(0, 0);

  /* Game state */
  turn = 0;
  simulating: boolean = false;

  /* Graphics */
  gridGraphics!: Phaser.GameObjects.Graphics;
  aimGraphics!: Phaser.GameObjects.Graphics;

  /* Utils */
  coordToPos!: (v: Vector, origin?: Vector) => Vector;
  posToCoord!: (v: Vector, origin?: Vector) => Vector;

  /* Config */
  origin = new Vector(0, 0);
  impulseScale = 1.0;
  predictStride = 1;

  constructor() {
    super("Game");
  }

  async create() {
    await RAPIER.init();

    this.rapierWorld = new RAPIER.World(new RAPIER.Vector2(0.0, 0.0));
    // this.cameras.main.setBackgroundColor(0x00ff00);

    this.config = config;

    console.log("Parsed config:", this.config);

    this.coordToPos =
      config.grid.type === "hex"
        ? (v: Vector, origin?: Vector) =>
            hexToPixel(v, config.grid.size, origin)
        : (v: Vector, origin: Vector = new Vector(0, 0)) =>
            new Vector(v.x, v.y).scale(config.grid.size).add(origin);

    this.posToCoord =
      config.grid.type === "hex"
        ? (v: Vector, origin?: Vector) =>
            pixelToHex(v, config.grid.size, origin)
        : (v: Vector, origin: Vector = new Vector(0, 0)) =>
            new Vector(v.x / config.grid.size, v.y / config.grid.size).subtract(
              origin,
            );

    this.gridGraphics = this.add.graphics();
    this.aimGraphics = this.add.graphics();
    this.aimGraphics.setDepth(1000);

    this.drawGrid();

    this.initPanZoom();

    this.initPucks();

    this.cameras.main.centerOn(0, 0);
  }

  initPucks() {
    for (const [id, puckDef] of this.config.initialPucks.entries()) {
      const pos = this.coordToPos(puckDef.coord);
      const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setCcdEnabled(true)
        .setTranslation(pos.x / PPM, pos.y / PPM)
        .setAngularDamping(0.9)
        .setLinearDamping(0.9);

      const playerId = puckDef.puck.playerId;

      const player = playerId ? this.config.players[playerId] : undefined;

      const puck = this.rapierWorld.createRigidBody(rigidBodyDesc);
      const radius = puckDef.puck.radius;
      const circle = this.add.circle(
        pos.x,
        pos.y,
        radius,
        player?.color
          ? Phaser.Display.Color.ValueToColor(player.color).color
          : 0x808080,
      );

      circle.setStrokeStyle(0, 0xffffff, 0);

      const line = this.add.rectangle(pos.x, pos.y, radius, 4, 0xffffff);
      line.setOrigin(0, 0.5);

      puck.userData = { circle, line, radius };
      this.pucks.set(id, { def: puckDef.puck, puck });

      const colliderDesc = RAPIER.ColliderDesc.ball(
        radius / PPM,
      ).setRestitution(0.7);
      this.rapierWorld.createCollider(colliderDesc, puck);
    }
  }

  drawGrid() {
    const g = this.gridGraphics;
    g.clear();

    g.lineStyle(2, 0x222222, 1);

    for (const { tile, coord } of this.config.tiles) {
      const v = this.coordToPos(coord, this.origin);
      const corners = hexCorners(v, this.config.grid.size);

      g.fillStyle(tile?.data?.color || 0x808080, 1);

      g.beginPath();
      g.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) g.lineTo(corners[i].x, corners[i].y);
      g.closePath();
      g.fillPath();
      g.strokePath();
    }
  }

  initPanZoom() {
    const cam = this.cameras.main;

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const world = cam.getWorldPoint(p.x, p.y);
      const hit = this.findPuckAtWorldPoint(world);

      // Left click on puck => aim
      if (!this.simulating && hit !== undefined && p.leftButtonDown()) {
        this.setSelectedPuck(hit);
        this.isAiming = true;
        this.isDragging = false;

        const puck = this.pucks.get(hit)!.puck;
        const t = puck.translation();
        this.aimStartWorld = new Vector(t.x * PPM, t.y * PPM); // aim from puck center
        this.drawAimPreview(world);
        return;
      }

      // Otherwise => pan
      this.isAiming = false;

      this.isDragging = true;
      this.dragStart.x = p.x;
      this.dragStart.y = p.y;
      this.camStart.x = cam.scrollX;
      this.camStart.y = cam.scrollY;
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      this.isAiming = false;
      this.isDragging = false;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      const world = cam.getWorldPoint(p.x, p.y);

      if (this.isAiming && this.selectedPuck !== undefined) {
        this.aimGraphics.clear();
        // this.drawAimPreview(world);

        const velocity = this.computeVelocity(world, this.rapierWorld.timestep); // convert to physics units
        this.pucks.set(this.selectedPuck, {
          ...this.pucks.get(this.selectedPuck)!,
          currentMove: velocity,
        });
        const snapshot = this.rapierWorld.takeSnapshot();
        const pts = this.predictTrajectory(snapshot);
        const radius = 20;
        for (const [id, [path, _]] of pts.entries()) {
          this.drawPredictedTrajectory(world, path, radius * 2);
        }
        for (const [id, [_, collisions]] of pts.entries()) {
          this.drawCollisions(collisions, radius);
        }

        return;
      }

      if (!this.isDragging) return;
      const dx = (p.x - this.dragStart.x) / cam.zoom;
      const dy = (p.y - this.dragStart.y) / cam.zoom;
      cam.scrollX = this.camStart.x - dx;
      cam.scrollY = this.camStart.y - dy;
    });

    this.input.on(
      "wheel",
      (pointer: Phaser.Input.Pointer, dx: number, dy: number) => {
        const zoomFactor = 1.0015;
        const oldZoom = cam.zoom;
        let newZoom = oldZoom * Math.pow(zoomFactor, -dy);
        newZoom = Phaser.Math.Clamp(newZoom, 0.2, 3.5);
        if (newZoom === oldZoom) return;

        const worldBefore = cam.getWorldPoint(pointer.x, pointer.y);
        cam.setZoom(newZoom);
        const worldAfter = cam.getWorldPoint(pointer.x, pointer.y);

        cam.scrollX += worldBefore.x - worldAfter.x;
        cam.scrollY += worldBefore.y - worldAfter.y;
      },
    );

    // On spacebar, start sim
    this.input.keyboard?.on("keydown-SPACE", () => {
      this.startSimulation();
    });
  }

  startSimulation() {
    if (!this.simulating) {
      this.simulating = true;
      this.aimGraphics.clear();
      this.isAiming = false;

      this.pucks.forEach((value) => {
        if (value.currentMove) {
          value.puck.setLinvel(value.currentMove, true);
          value.currentMove = undefined;
        }
      });
    }
  }

  findPuckAtWorldPoint(worldC: Vector): number | undefined {
    let best: { id: number; d2: number } | undefined;

    for (const [id, { puck }] of this.pucks.entries()) {
      const ud: any = puck.userData;
      if (!ud) continue;

      const t = puck.translation();
      const d2 = worldC.distanceSq(new Vector(t.x * PPM, t.y * PPM));

      if (d2 <= ud.radius * ud.radius) {
        // pick the closest if overlapping
        if (!best || d2 < best.d2) best = { id, d2 };
      }
    }

    return best?.id;
  }

  setSelectedPuck(p?: number) {
    if (this.selectedPuck !== undefined) {
      const ud: any = this.pucks.get(this.selectedPuck)?.puck.userData;
      ud?.circle?.setStrokeStyle(0, 0xffffff, 0);
    }

    this.selectedPuck = p;

    if (this.selectedPuck !== undefined) {
      const ud: any = this.pucks.get(this.selectedPuck)?.puck.userData;
      ud?.circle?.setStrokeStyle(3, 0xffff00, 1);
    }
  }

  computeVelocity(pointerWorld: Vector, dt: number): RAPIER.Vector2 {
    const dx = pointerWorld.clone().subtract(this.aimStartWorld);
    const d = 0.9;

    const v0 = dx.scale(d / (1.0 + d * dt));

    return new RAPIER.Vector2(v0.x / PPM, v0.y / PPM);
  }

  drawAimPreview(pointerWorld: Vector) {
    if (this.selectedPuck === undefined) return;

    const g = this.aimGraphics;

    // Aim line
    g.lineStyle(2, 0xffffff, 0.9);
    g.beginPath();
    g.moveTo(this.aimStartWorld.x, this.aimStartWorld.y);
    g.lineTo(pointerWorld.x, pointerWorld.y);
    g.strokePath();
  }

  drawPredictedTrajectory(pointerWorld: Vector, pts: Vector[], radius: number) {
    const g = this.aimGraphics;

    if (pts.length >= 2) {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      let color = 0xffff00;
      for (let i = 1; i < pts.length; i++) {
        g.lineTo(pts[i].x, pts[i].y);
        if (i % 10 === 0) {
          color = color === 0xffff00 ? 0xff0000 : 0xffff00;
          g.lineStyle(radius, color, 1);
          g.strokePath();
          g.beginPath();
          g.moveTo(pts[i].x, pts[i].y);
        }
      }
      g.strokePath();
    }
  }

  drawCollisions(pts: Vector[], radius: number) {
    const g = this.aimGraphics;
    g.fillStyle(0x00ffff, 1);
    pts.forEach((p) => {
      g.fillCircle(p.x, p.y, radius);
    });
  }

  predictTrajectory(snapshot: any): Map<number, [Vector[], Vector[]]> {
    const out: Map<number, [Vector[], Vector[]]> = new Map(); // [trajectoryPts, collisionCenterPts]

    const pucksById: Map<number, RAPIER.RigidBody> = new Map();
    const idByRbHandle: Map<number, number> = new Map(); // rbHandle -> id

    const predictWorld = RAPIER.World.restoreSnapshot(snapshot);

    // Important: collision events only fire if colliders have ActiveEvents.COLLISION_EVENTS enabled.
    // We enable it for each puck's colliders in the prediction world.
    for (const [id, { puck, currentMove }] of this.pucks.entries()) {
      const newPuck = predictWorld.getRigidBody(puck.handle);

      out.set(id, [[], []]);
      pucksById.set(id, newPuck);
      idByRbHandle.set(newPuck.handle, id);

      // Enable collision events on all colliders attached to this rigid-body.
      for (let i = 0; i < newPuck.numColliders(); i++) {
        const col = predictWorld.getCollider(newPuck.collider(i));
        col.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      }

      const velocity = currentMove ?? new RAPIER.Vector2(0, 0);
      try {
        newPuck.setLinvel(velocity, true);
      } catch (e) {
        console.error("Error in predictTrajectory:", e);
      }
    }

    const eventQueue = new RAPIER.EventQueue(true);
    const maxSteps = 60000;

    for (let step = 0; step < maxSteps; step++) {
      let pucksSleeping = 0;

      for (const puck of pucksById.values()) {
        const sleeping = applyIceDrag(puck, predictWorld.timestep);
        if (sleeping) pucksSleeping++;
      }

      // Step *with* events
      predictWorld.step(eventQueue);

      // Record trajectory samples
      for (const [id, puck] of pucksById.entries()) {
        if (step % this.predictStride === 0) {
          const t = puck.translation();
          out.get(id)![0].push(new Vector(t.x * PPM, t.y * PPM));
        }
      }

      // Drain collision-start events; record puck centers at that step
      eventQueue.drainCollisionEvents((c1, c2, started) => {
        if (!started) return;

        const col1 = predictWorld.getCollider(c1);
        const col2 = predictWorld.getCollider(c2);

        const rb1Handle = col1.parent()?.handle; // rigid-body handle
        const rb2Handle = col2.parent()?.handle;

        // Parent() can be null/undefined for static colliders; ignore those.
        if (rb1Handle == null || rb2Handle == null) return;

        const id1 = idByRbHandle.get(rb1Handle);
        const id2 = idByRbHandle.get(rb2Handle);

        const rb1 = predictWorld.getRigidBody(rb1Handle);
        const rb2 = predictWorld.getRigidBody(rb2Handle);

        const p1 = rb1.translation();
        const p2 = rb2.translation();

        // Push “collision centers” (not contact points)
        out.get(id1)![1].push(new Vector(p1.x * PPM, p1.y * PPM));
        out.get(id2)![1].push(new Vector(p2.x * PPM, p2.y * PPM));
      });

      if (pucksSleeping === pucksById.size) break;
    }

    return out;
  }

  update() {
    if (this.simulating && this.rapierWorld !== undefined) {
      let pucksSleeping = 0;

      this.pucks.forEach(({ puck }) => {
        const sleeping = applyIceDrag(puck, this.rapierWorld.timestep);
        if (sleeping) pucksSleeping++;
      });

      this.rapierWorld.step();

      this.pucks.forEach(({ puck }) => {
        const ud: any = puck.userData;
        if (!ud) return;

        const position = puck.translation();
        const angle = puck.rotation();

        ud.circle.setPosition(position.x * PPM, position.y * PPM);
        ud.circle.setRotation(angle);

        ud.line.setPosition(position.x * PPM, position.y * PPM);
        ud.line.setRotation(angle);
      });

      // If all pucks are sleeping, end turn
      if (pucksSleeping === this.pucks.size) {
        this.simulating = false;
        console.log("Turn ended, all pucks sleeping");
      }
    }
  }
}

function applyIceDrag(
  rb: RAPIER.RigidBody,
  dt: number,
  opts = {
    fastDecel: 0.8,
    slowDecel: 3.5,
    slowSpeed: 1.2,
    stopSpeed: 0.05,
    angStopSpeed: 0.1,
  },
): boolean {
  if (rb.isSleeping()) return true;

  const v = rb.linvel();
  const speed = Math.hypot(v.x, v.y);
  const angvel = rb.angvel();
  const absAngvel = Math.abs(angvel);

  if (speed < opts.stopSpeed) {
    rb.setLinvel({ x: 0, y: 0 }, true);

    if (absAngvel < opts.angStopSpeed) {
      rb.setAngvel(0, true);
      rb.sleep();
      return true;
    } else {
      return false;
    }
  }

  return false;

  const decel = speed < opts.slowSpeed ? opts.slowDecel : opts.fastDecel;
  let dv = decel * dt;
  if (dv > speed) dv = speed; // don't reverse

  const invSpeed = 1.0 / speed;
  const dirx = v.x * invSpeed;
  const diry = v.y * invSpeed;

  const mass = rb.mass(); // available in rapier-js
  const j = mass * dv;
  const impulse = new RAPIER.Vector2(-dirx * j, -diry * j);
  console.log(mass);
  rb.applyImpulse(impulse, true);
  console.log(
    `Applying drag impulse: (${impulse.x.toFixed(2)}, ${impulse.y.toFixed(2)})`,
  );
  console.log(
    `Speed: ${speed.toFixed(2)}, Angular Velocity: ${angvel.toFixed(2)}`,
  );

  return false;
}
