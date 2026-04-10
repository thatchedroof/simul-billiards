import { Scene } from "phaser";
import {
  applyIceDrag,
  cloneWorld,
  GameRoomState,
  physicsToPix,
  Player,
  pointInGround,
  predictTrajectory,
  stateFromRigidBody,
  worldFromSnapshot,
  type Coordinate,
  type GameState,
  type Move,
  type MoveSchema,
  type PhysicsVec,
  type PhysicsWorld,
  type PhysicsWorldSnapshot,
  type PixelVec,
  type PlayerData,
  type PlayerId,
  type PlayerView,
  type PredictionResult,
  type Program,
  type PuckId,
} from "@siturbi/shared";
import RAPIER, { init } from "@dimforge/rapier2d-compat";
import { Callbacks, Client, Room } from "@colyseus/sdk";
import Vector from "victor";
import { pixelVector } from "../utils.ts";

export class Game extends Scene {
  program!: Program;
  state!: GameState;
  world!: PhysicsWorld;

  gameStarted: boolean = false;
  ready: boolean = false;
  waiting: boolean = false;

  /* Server */
  client!: Client;
  room!: Room<GameRoomState>;

  /* Players */
  playerId!: PlayerId;
  playerData: Record<PlayerId, PlayerData> = {};
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

  /* Simulation */
  simulationResult: Record<PuckId, PredictionResult> = {};
  simulating = false;
  simStartTime: number | null = null;

  /* Config */
  predictStride = 1;

  async create({ program, url }: { program: Program; url: string }) {
    await RAPIER.init();

    this.client = new Client(url);
    console.log("Connecting to server at", url);

    // Join the room
    try {
      this.room = await this.client.joinOrCreate("game_room");
      this.playerId = this.room.sessionId as PlayerId;
      console.log("Joined successfully!");
    } catch (e) {
      console.error(e);
    }

    // Set up program state
    this.program = program;
    this.state = program.initialState({}, {});
    this.world = program.initialPhysics({}, this.state, {});
    this.playerViews = this.program.stateToPlayerViews(this.state);

    const callbacks = Callbacks.get(this.room);

    callbacks.onAdd("players", (player: Player, key: string) => {
      console.log("Player added:", key, player);
      this.state.playerData[key as PlayerId] = player;
      this.initPlayerData();
    });

    callbacks.onRemove("players", (player: Player, key: string) => {
      console.log("Player removed:", key, player);
      delete this.state.playerData[key as PlayerId];
      this.initPlayerData();
    });

    callbacks.listen("gameStarted", (value: boolean) => {
      console.log("Game started:", value);
      this.gameStarted = value;
    });

    this.room.onMessage(
      "turn",
      ({
        simulationResult,
        snapshot,
      }: {
        simulationResult: Record<PuckId, PredictionResult>;
        snapshot: PhysicsWorldSnapshot;
      }) => {
        // Start the visualization
        this.simulating = true;
        this.simStartTime = null;
        this.waiting = false;

        this.simulationResult = simulationResult;

        // Sync the local physics world
        this.world = worldFromSnapshot(snapshot);
      },
    );

    // Graphics
    this.mapGraphics = this.add.graphics();
    this.aimGraphics = this.add.graphics();
    this.aimGraphics.setDepth(1000);

    this.cameras.main.centerOn(0, 0);

    this.initMap();
    this.initPanZoom();
    this.initTurns();
    this.initPucks();
  }

  initPlayerData() {
    this.state = this.program.initialState({}, this.state.playerData);
    this.world = this.program.initialPhysics(
      {},
      this.state,
      this.state.playerData,
    );
    this.playerViews = this.program.stateToPlayerViews(this.state);

    this.aimGraphics.clear();
    this.puckMoves = {};

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
    for (const puck of Object.values(this.puckSprites)) {
      puck.sprite.destroy();
      puck.aimLine.destroy();
    }

    for (const [puckId, puck] of Object.entries(this.state.puckData)) {
      const pos = puck.position;
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
      const world = pixelVector(cam.getWorldPoint(p.x, p.y));
      const hit = this?.findPuckAtWorldPoint(world);

      if (!this.simulating && hit && p.leftButtonDown()) {
        this.selectPuck(hit);
        this.isDragging = false;
        return;
      }

      this.isAiming = false;
      // this.selectedPuck = undefined;

      this.isDragging = true;
      this.dragStart = new Vector(p.x, p.y);
      this.camStart = new Vector(cam.scrollX, cam.scrollY);
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      this.isDragging = false;
      this.isAiming = false;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      const point = pixelVector(cam.getWorldPoint(p.x, p.y));

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
          [this.playerId]: Object.entries(this.puckMoves).map(
            ([puckId, velocity]) => ({
              type: "velocity",
              puckId: puckId as PuckId,
              velocity: new Vector(velocity.x / 50, velocity.y / 50),
            }),
          ),
        };

        const pts = this.predictTrajectory(moves);
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
      if (!this.gameStarted) {
        console.log("Signaling ready...");
        this.room.send("ready", true);
        this.ready = true;
        return;
      }

      if (this.simulating || this.waiting) return;

      const moves: Move[] = [];

      for (const [puckId, velocity] of Object.entries(this.puckMoves)) {
        // If puck isn't movable by player, continue
        if (
          !this.playerViews[this.playerId].moveSchemas.some(
            (ms) => ms.puckId === puckId && ms.type === "velocity",
          )
        ) {
          continue;
        }
        moves.push({
          type: "velocity",
          puckId: puckId as PuckId,
          velocity: new Vector(velocity.x / 50, velocity.y / 50),
        });
      }

      // Clear puckMoves for the next turn
      this.puckMoves = {};
      this.aimGraphics.clear();

      this.room.send("move", moves);
      this.waiting = true;
      console.log("Sent move, waiting for others");
    });
  }

  findPuckAtWorldPoint(worldC: PixelVec): PuckId | undefined {
    let best: { puckId: PuckId; dist: number } | undefined = undefined;

    for (const [puckId, _] of Object.entries(this.state.puckData)) {
      const puck = this.state.puckData[puckId as PuckId];
      const pos = puck.position;
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
      const thisPlayer = playerId === this.playerId;

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
      this.aimStartWorld = this.state.puckData[puckId as PuckId].position;
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
    moves: Record<PuckId, MoveSchema[]>,
  ): Record<PuckId, PredictionResult> {
    return predictTrajectory(
      cloneWorld(this.world),
      moves,
      this.program,
      this.state,
      {
        predictStride: this.predictStride,
      },
    );
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

  endTurn() {
    // Update the positions of the pucks
    for (const [puckId, result] of Object.entries(this.simulationResult)) {
      // Delete OOB pucks
      if (result.events.some((e) => e.type === "oob")) {
        delete this.world.pucks[puckId as PuckId];
        delete this.state.puckData[puckId as PuckId];

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
      puck.position = finalPos;
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
