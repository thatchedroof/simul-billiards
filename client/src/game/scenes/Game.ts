import { Scene } from "phaser";
import {
  pointInGround,
  type Coordinate,
  type GameState,
  type Move,
  type MoveSchema,
  type PhysicsVec,
  type PhysicsWorld,
  type PixelVec,
  type PlayerView,
  type Program,
} from "../program.ts";
import RAPIER, { init } from "@dimforge/rapier2d-compat";
import type { PlayerId, PuckId } from "../config.ts";
import {
  applyIceDrag,
  cloneWorld,
  physicsToPix,
  PPM,
  stateFromRigidBody,
  Vector,
  type PredictionResult,
} from "../utils.ts";

export class Game extends Scene {
  program!: Program;
  state!: GameState;
  world!: PhysicsWorld;

  /* Players */
  playerOrder: PlayerId[] = [];
  currentPlayerIndex = 0;
  playerViews!: Record<PlayerId, PlayerView>;

  /* Graphics */
  mapGraphics!: Phaser.GameObjects.Graphics;
  aimGraphics!: Phaser.GameObjects.Graphics;
  puckSprites: Record<
    PuckId,
    { sprite: Phaser.GameObjects.Arc; aimLine: Phaser.GameObjects.Rectangle }
  > = {};

  /* Drag state */
  isDragging = false;
  dragStart = new Vector(0, 0);
  camStart = new Vector(0, 0);

  /* Aim state */
  selectedPuck?: PuckId;
  isAiming = false;
  aimStartWorld = new Vector(0, 0) as PixelVec;

  /* Player moves */
  puckMoves: Record<PuckId, Vector> = {};

  /* Global moves */
  moves: Record<PlayerId, Move[]> = {};

  /* Simulation */
  simulationResult: Record<PuckId, PredictionResult> = {};
  simulating = false;
  simStartTime: number | null = null;

  /* Config */
  predictStride = 1;

  async create(program: Program) {
    await RAPIER.init();

    this.program = program;
    this.state = program.initialState({});
    this.world = program.initialPhysics({}, this.state);

    this.playerOrder = Object.keys(this.state.playerData) as PlayerId[];
    this.playerViews = this.program.stateToPlayerViews(this.state);

    this.mapGraphics = this.add.graphics();
    this.aimGraphics = this.add.graphics();
    this.aimGraphics.setDepth(1000);

    this.cameras.main.centerOn(0, 0);

    this.initMap();
    this.initPanZoom();
    this.initTurns();
    this.initPucks();
  }

  initMap() {
    const g = this.mapGraphics;
    g.clear();
    g.lineStyle(1, 0xffffff, 1);
    for (const wall of this.state.mapData.walls) {
      const a = this.program.coordToPos(wall.a);
      const b = this.program.coordToPos(wall.b);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokePath();
    }

    for (const groundArea of this.state.mapData.groundAreas) {
      g.fillStyle(0x00ff00, 0.5);
      g.beginPath();
      const start = this.program.coordToPos(groundArea[0]);
      g.moveTo(start.x, start.y);
      for (let i = 1; i < groundArea.length; i++) {
        const point = this.program.coordToPos(groundArea[i]);
        g.lineTo(point.x, point.y);
      }
      g.closePath();
      g.fillPath();
    }
  }

  initPucks() {
    for (const [puckId, puck] of Object.entries(this.state.puckData)) {
      const pos = this.program.coordToPos(puck.position);
      const player = puck.player ? this.state.playerData[puck.player] : null;
      const circle = this.add.circle(
        pos.x,
        pos.y,
        puck.radius,
        player?.color || 0x808080,
      );
      circle.setStrokeStyle(0, 0xffffff, 0);

      const line = this.add.rectangle(pos.x, pos.y, puck.radius, 4, 0xffffff);
      line.setOrigin(0, 0.5);

      this.world.pucks[puckId as PuckId].userData = {
        sprite: circle,
        aimLine: line,
      };
      this.puckSprites[puckId as PuckId] = { sprite: circle, aimLine: line };
    }
  }

  initPanZoom() {
    const cam = this.cameras.main;

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const world = cam.getWorldPoint(p.x, p.y);
      const hit = this?.findPuckAtWorldPoint(world as PixelVec);

      if (!this.simulating && hit && p.leftButtonDown()) {
        this.selectPuck(hit);
        this.isDragging = false;
        return;
      }

      this.isAiming = false;
      // this.selectedPuck = undefined;

      this.isDragging = true;
      this.dragStart.set(p.x, p.y);
      this.camStart.set(cam.scrollX, cam.scrollY);
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      this.isDragging = false;
      this.isAiming = false;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      const point = cam.getWorldPoint(p.x, p.y) as PixelVec;

      if (this.isDragging) {
        const dx = (p.x - this.dragStart.x) / cam.zoom;
        const dy = (p.y - this.dragStart.y) / cam.zoom;
        cam.scrollX = this.camStart.x - dx;
        cam.scrollY = this.camStart.y - dy;
      }

      if (
        !this.simulating &&
        this.isAiming &&
        this.selectedPuck !== undefined
      ) {
        this.aimGraphics.clear();
        this.drawAimPreview(point);

        const aimVec = point.clone().subtract(this.aimStartWorld);
        this.puckMoves[this.selectedPuck] = aimVec;

        const moves: Record<PlayerId, Move[]> = {
          [this.playerOrder[this.currentPlayerIndex]]: Object.entries(
            this.puckMoves,
          ).map(([puckId, velocity]) => ({
            type: "velocity",
            puckId: puckId as PuckId,
            velocity: new Vector(velocity.x / 50, velocity.y / 50),
          })),
        };

        const pts = this.predictTrajectory(cloneWorld(this.world), moves);
        this.drawPredictedTrajectory(pts);
      }
    });

    this.input.on(
      "wheel",
      (pointer: Phaser.Input.Pointer, dx: number, dy: number) => {
        const zoomFactor = 1.015;
        if (dy > 0) {
          cam.zoom /= zoomFactor;
        } else if (dy < 0) {
          cam.zoom *= zoomFactor;
        }

        // Optional: Zoom towards the pointer
        const world = cam.getWorldPoint(pointer.x, pointer.y);
        const newWorld = cam.getWorldPoint(pointer.x, pointer.y);
        cam.scrollX += world.x - newWorld.x;
        cam.scrollY += world.y - newWorld.y;
      },
    );
  }

  initTurns() {
    this.input.keyboard?.on("keydown-SPACE", () => {
      if (this.simulating) return;

      // Add the puckMoves to global moves
      const playerId = this.playerOrder[this.currentPlayerIndex];
      if (!this.moves[playerId]) {
        this.moves[playerId] = [];
      }

      for (const [puckId, velocity] of Object.entries(this.puckMoves)) {
        // If puck isn't movable by player, continue
        if (
          !this.playerViews[playerId].moveSchemas.some(
            (ms) => ms.puckId === puckId && ms.type === "velocity",
          )
        ) {
          continue;
        }
        this.moves[playerId].push({
          type: "velocity",
          puckId: puckId as PuckId,
          velocity: new Vector(velocity.x / 50, velocity.y / 50),
        });
      }

      // Clear puckMoves for the next turn
      this.puckMoves = {};
      this.aimGraphics.clear();

      // Run turn if all players have moved
      if (this.currentPlayerIndex === this.playerOrder.length - 1) {
        this.runTurn();
        return;
      }

      // Advance to next player
      this.currentPlayerIndex =
        (this.currentPlayerIndex + 1) % this.playerOrder.length;

      console.log(`Player ${this.playerOrder[this.currentPlayerIndex]}'s turn`);
    });
  }

  findPuckAtWorldPoint(worldC: PixelVec): PuckId | undefined {
    let best: { puckId: PuckId; dist: number } | undefined = undefined;

    for (const [puckId, _] of Object.entries(this.world.pucks)) {
      const puck = this.state.puckData[puckId as PuckId];
      const pos = this.program.coordToPos(puck.position);
      const dist = Phaser.Math.Distance.Between(
        pos.x,
        pos.y,
        worldC.x,
        worldC.y,
      );
      if (dist <= puck.radius) {
        if (!best || dist < best.dist) {
          best = { puckId: puckId as PuckId, dist };
        }
      }
    }

    return best?.puckId;
  }

  moveOptions(puckId: PuckId): { move: MoveSchema; thisPlayer: boolean }[] {
    const options: { move: MoveSchema; thisPlayer: boolean }[] = [];

    for (const [playerId, playerView] of Object.entries(this.playerViews)) {
      const thisPlayer = playerId === this.playerOrder[this.currentPlayerIndex];

      for (const moveSchema of playerView.moveSchemas) {
        if (moveSchema.puckId === puckId) {
          options.push({ move: moveSchema, thisPlayer });
        }
      }
    }

    return options;
  }

  selectPuck(puckId: PuckId) {
    const options = this.moveOptions(puckId);
    if (options.length === 0) {
      return;
    }

    this.selectedPuck = puckId;

    for (const [puckId, { sprite }] of Object.entries(this.puckSprites)) {
      if (puckId === this.selectedPuck) {
        sprite.setStrokeStyle(3, 0xffff00, 1);
      } else {
        sprite.setStrokeStyle(0, 0xffffff, 0);
      }
    }

    if (options.some((o) => o.move.type === "velocity")) {
      this.isAiming = true;
      const t = this.world.pucks[puckId].translation();
      this.aimStartWorld = physicsToPix(t);
    }
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

  predictTrajectory(
    world: PhysicsWorld,
    moves: Record<PuckId, MoveSchema[]>,
  ): Record<PuckId, PredictionResult> {
    const results: Record<PuckId, PredictionResult> = {};
    const idByRBHandle: Record<number, PuckId> = {};

    this.program.runTurn(this.state, world, moves);

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
      eventQueue.drainCollisionEvents((c1, c2, started) => {
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
        const pos = this.program.posToCoord(physicsToPix(p.position));
        if (!pointInGround(pos, this.state.mapData.groundAreas)) {
          world.rapierWorld.removeRigidBody(puck);

          inactivePucks.add(puckId as PuckId);
          results[puckId as PuckId].events.push({
            type: "oob",
            state: p,
          });
          continue;
        }

        if (step % this.predictStride === 0) {
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

  drawPredictedTrajectory(predictions: Record<PuckId, PredictionResult>) {
    const g = this.aimGraphics;

    for (const [puckId, { points, events }] of Object.entries(predictions)) {
      const pts = points.map((p) => physicsToPix(p.position));
      const puck = this.state.puckData[puckId as PuckId];
      const { color, secondaryColor } = puck.player
        ? this.state.playerData[puck.player]
        : { color: 0x808080, secondaryColor: 0xaaaaaa };

      g.lineStyle(puck.radius * 2, color!, 1);

      const stripe = Math.ceil(5 / this.predictStride);

      if (pts.length >= 2) {
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        let currentColor = true;
        for (let i = 1; i < pts.length; i++) {
          g.lineTo(pts[i].x, pts[i].y);
          if (i % stripe === 0) {
            currentColor = !currentColor;
            g.lineStyle(
              puck.radius * 2,
              // 2,
              currentColor ? color! : secondaryColor!,
              1,
            );
            g.strokePath();
            g.beginPath();
            g.moveTo(pts[i].x, pts[i].y);
          }
        }
        g.strokePath();
      }

      for (const event of events) {
        const pos = physicsToPix(event.state.position);
        const innerRadius = Math.max(puck.radius - 3, 2);

        g.fillStyle(color!, 1);
        g.fillCircle(pos.x, pos.y, puck.radius);

        g.fillStyle(secondaryColor!, 1);
        g.fillCircle(pos.x, pos.y, innerRadius);

        g.fillStyle(color!, 1);

        if (event.type === "oob") {
          // Center X
          g.fillRect(pos.x - 5, pos.y - 1, 10, 2);
          g.fillRect(pos.x - 1, pos.y - 5, 2, 10);
        } else {
          // Center circle
          g.fillCircle(pos.x, pos.y, 3);
        }
      }
    }
  }

  runTurn() {
    if (this.simulating) return;
    this.simulating = true;
    this.simStartTime = null;

    this.simulationResult = this.predictTrajectory(this.world, this.moves);
    console.log(this.simulationResult);
  }

  endTurn() {
    this.moves = {};
    this.currentPlayerIndex = 0;

    // Update the positions of the pucks
    for (const [puckId, result] of Object.entries(this.simulationResult)) {
      // Delete OOB pucks
      if (result.events.some((e) => e.type === "oob")) {
        const puck = this.world.pucks[puckId as PuckId];
        delete this.world.pucks[puckId as PuckId];

        const { sprite, aimLine } = this.puckSprites[puckId as PuckId];
        sprite.destroy();
        aimLine.destroy();
        delete this.puckSprites[puckId as PuckId];
        continue;
      }

      const finalPos = physicsToPix(
        result.points[result.points.length - 1].position,
      );
      const puck = this.state.puckData[puckId as PuckId];
      puck.position = this.program.posToCoord(finalPos);
      const { sprite, aimLine } = this.puckSprites[puckId as PuckId];
      sprite.setPosition(finalPos.x, finalPos.y);
      aimLine.setPosition(finalPos.x, finalPos.y);
    }
  }

  update(time: number) {
    if (this.simulating) {
      if (this.simStartTime === null) {
        this.simStartTime = time;
      }

      const rapierTimestep = 1 / 60;
      const elapsedMs = (time - this.simStartTime) / 1000;
      const speed = 0.75;
      const currentTimestep = Math.floor((elapsedMs / rapierTimestep) * speed);
      console.log(currentTimestep);

      const finished: PuckId[] = [];

      for (const [puckId, result] of Object.entries(this.simulationResult)) {
        const sprite = this.puckSprites[puckId as PuckId].sprite;
        const aimLine = this.puckSprites[puckId as PuckId].aimLine;

        const points = result.points;

        // If this puck's trajectory is finished, skip it
        if (currentTimestep >= points.length) {
          finished.push(puckId as PuckId);
          continue;
        }

        const pos = physicsToPix(points[currentTimestep].position);
        sprite.setPosition(pos.x, pos.y);
        aimLine.setPosition(pos.x, pos.y);
        aimLine.setRotation(points[currentTimestep].angle);
      }

      // If all pucks are finished, end the simulation
      if (finished.length === Object.keys(this.simulationResult).length) {
        this.simulating = false;
        this.endTurn();
        console.log("Simulation finished");
      }
    }
  }
}
