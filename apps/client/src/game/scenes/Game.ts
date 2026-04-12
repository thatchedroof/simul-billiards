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
import { makeRoundedButton, pixelVector } from "../utils.ts";
import type { UIScene } from "./UI.ts";

export class Game extends Scene {
  program!: Program;
  state!: GameState;
  world!: PhysicsWorld;

  gameStarted: boolean = false;
  ready: boolean = false;
  waiting: boolean = false;

  /* UI */
  ui!: UIScene;

  /* Server */
  client!: Client;
  room!: Room<GameRoomState>;

  /* Players */
  playerId!: PlayerId;
  playerData: Record<PlayerId, PlayerData> = {};
  playerViews!: Record<PlayerId, PlayerView>;

  /* Graphics */
  mapGraphics!: Phaser.GameObjects.Graphics;
  aimGraphics: Record<PuckId, Phaser.GameObjects.Graphics> = {};
  puckSprites: Record<
    PuckId,
    { sprite: Phaser.GameObjects.Arc; aimLine: Phaser.GameObjects.Rectangle }
  > = {};

  /* Drag state */
  isDragging = false;
  dragStart = new Vector(0, 0);
  camStart = new Vector(0, 0);

  /* Pinch state */
  pinchStartDistance: number | null = null;
  pinchStartZoom: number | null = null;
  pinchWorldCenter = new Vector(0, 0);

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

      if (this.gameStarted) {
        this.ui.buttonSubmitState(false);
      } else {
        this.ready = false;
        this.ui.buttonReadyState(false);
      }
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
        this.clearAimGraphics();

        this.simulationResult = simulationResult;

        // Sync the local physics world
        this.world = worldFromSnapshot(snapshot);

        // Hide the start game button during simulation
        this.ui.startGameButton.setVisible(false);
        this.ui.buttonSubmitState(false);
      },
    );

    // Graphics
    this.mapGraphics = this.add.graphics();
    this.scale.on("resize", (gameSize: any) => {
      const { width, height } = gameSize;
      this.cameras.resize(width, height);
    });

    this.cameras.main.centerOn(0, 0);

    // Launch UI scene and pass reference to this scene
    this.scene.launch("UIScene");
    this.ui = this.scene.get("UIScene") as UIScene;
    this.ui.setGameScene(this);

    this.initMap();
    this.initPanZoom();
    // this.initUI();
    this.initTurns();
    this.initPucks();
  }

  clearAimGraphics() {
    for (const g of Object.values(this.aimGraphics)) {
      g.clear();
    }
  }

  initPlayerData() {
    // Re-run the program's initial state and physics with the new player data
    this.state = this.program.initialState({}, this.state.playerData);
    this.world = this.program.initialPhysics(
      {},
      this.state,
      this.state.playerData,
    );
    this.playerViews = this.program.stateToPlayerViews(this.state);

    this.puckMoves = {};

    this.initPucks();

    // Draw initial prediction
    const pts = this.predictTrajectory({});
    this.drawPredictedTrajectory(pts);
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
      circle.setDepth(2);

      const line = this.add.rectangle(pos.x, pos.y, puck.radius, 4, 0xffffff);
      line.setOrigin(0, 0.5);
      line.setDepth(2);

      this.world.pucks[puckId as PuckId].userData = {
        sprite: circle,
        aimLine: line,
      };
      this.puckSprites[puckId as PuckId] = { sprite: circle, aimLine: line };
    }
  }

  initPanZoom() {
    const cam = this.cameras.main;

    // Needed so Phaser tracks 2 simultaneous touches
    this.input.addPointer(1);

    const getTouchPointers = () =>
      this.input.manager.pointers.filter((p) => p.isDown);

    const clampZoom = (zoom: number) => Phaser.Math.Clamp(zoom, 0.25, 3);

    const getPinchDistance = (
      a: Phaser.Input.Pointer,
      b: Phaser.Input.Pointer,
    ) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const getPinchCenter = (a: Phaser.Input.Pointer, b: Phaser.Input.Pointer) =>
      new Vector((a.x + b.x) / 2, (a.y + b.y) / 2);

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const touches = getTouchPointers();

      // Two-finger gesture starts pinch zoom
      if (touches.length >= 2) {
        const [a, b] = touches;
        this.isDragging = false;
        this.isAiming = false;
        this.deselectPuck();

        this.pinchStartDistance = getPinchDistance(a, b);
        this.pinchStartZoom = cam.zoom;

        const center = getPinchCenter(a, b);
        const worldCenter = cam.getWorldPoint(center.x, center.y);
        this.pinchWorldCenter = new Vector(worldCenter.x, worldCenter.y);
        return;
      }

      const world = pixelVector(cam.getWorldPoint(p.x, p.y));
      const hit = this?.findPuckAtWorldPoint(world);

      // Mouse click or single-touch on puck selects it
      if (!this.simulating && hit) {
        // For mouse, respect left button. For touch, button is irrelevant.
        if (!p.wasTouch || p.leftButtonDown()) {
          this.selectPuck(hit);
          this.isDragging = false;
          return;
        }
      }

      this.isAiming = false;
      this.deselectPuck();

      // Start panning
      this.isDragging = true;
      this.dragStart = new Vector(p.x, p.y);
      this.camStart = new Vector(cam.scrollX, cam.scrollY);
    });

    this.input.on("pointerup", () => {
      const touches = getTouchPointers();

      if (touches.length < 2) {
        this.pinchStartDistance = null;
        this.pinchStartZoom = null;
      }

      if (touches.length === 0) {
        this.isDragging = false;
        this.isAiming = false;
        this.deselectPuck();
      }
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      const touches = getTouchPointers();

      // Pinch zoom
      if (
        touches.length >= 2 &&
        this.pinchStartDistance !== null &&
        this.pinchStartZoom !== null
      ) {
        const [a, b] = touches;
        const currentDistance = getPinchDistance(a, b);

        if (currentDistance > 0) {
          cam.zoom = clampZoom(
            this.pinchStartZoom * (currentDistance / this.pinchStartDistance),
          );

          // Keep zoom centered on the pinch center
          const center = getPinchCenter(a, b);
          const newWorldCenter = cam.getWorldPoint(center.x, center.y);
          cam.scrollX += this.pinchWorldCenter.x - newWorldCenter.x;
          cam.scrollY += this.pinchWorldCenter.y - newWorldCenter.y;
        }

        return;
      }

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
      (pointer: Phaser.Input.Pointer, _dx: number, dy: number) => {
        const oldWorld = cam.getWorldPoint(pointer.x, pointer.y);
        const zoomFactor = 1.015;

        if (dy > 0) {
          cam.zoom = clampZoom(cam.zoom / zoomFactor);
        } else if (dy < 0) {
          cam.zoom = clampZoom(cam.zoom * zoomFactor);
        }

        const newWorld = cam.getWorldPoint(pointer.x, pointer.y);
        cam.scrollX += oldWorld.x - newWorld.x;
        cam.scrollY += oldWorld.y - newWorld.y;
      },
    );
  }

  initTurns() {
    this.input.keyboard?.on("keydown-SPACE", () => {
      this.sendBroadcast();
    });
  }

  sendBroadcast() {
    if (!this.gameStarted) {
      this.ready = !this.ready;
      this.room.send("ready", this.ready);

      console.log("Signaling ready:", this.ready);

      if (this.ready) {
        this.ui.buttonReadyState(true);
      } else {
        this.ui.buttonReadyState(false);
      }

      return;
    }

    if (this.simulating) return;

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
    this.deselectPuck();

    if (!this.waiting) {
      this.room.send("move", moves);
      this.waiting = true;
      this.ui.buttonSubmitState(true);
      console.log("Sent move, waiting for others");
    } else {
      this.room.send("undoMove");
      this.waiting = false;
      this.ui.buttonSubmitState(false);
      this.clearAimGraphics();
      console.log("Unsubmitted move");
    }
  }

  initUI() {
    // makeRoundedButton(this, 20, 20, 200, 40, "Reset View", () => {
    //   const cam = this.cameras.main;
    //   cam.zoom = 1;
    //   cam.centerOn(0, 0);
    // });
    // const panel = this.add
    //   .dom(100, 100)
    //   .createFromHTML(
    //     `
    //       <div class="menu">
    //         <h2>Pause</h2>
    //         <button class="ui-btn" id="resumeBtn">Resume</button>
    //         <button class="ui-btn" id="quitBtn">Quit</button>
    //       </div>
    //     `,
    //   )
    //   .setScrollFactor(0);
    // const node = panel.node as HTMLElement;
    // node.style.position = "fixed";
    // node.style.left = "100px";
    // node.style.top = "100px";
    // node.querySelector("#resumeBtn")!.addEventListener("click", () => {
    //   console.log("resume");
    // });
    // node.querySelector("#quitBtn")!.addEventListener("click", () => {
    //   console.log("quit");
    // });
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

  deselectPuck() {
    this.selectedPuck = undefined;

    for (const { sprite } of Object.values(this.puckSprites)) {
      sprite.setStrokeStyle(0, 0xffffff, 0);
    }
  }

  // drawAimPreview(pointerWorld: Vector) {
  //   if (this.selectedPuck === undefined) return;

  //   const g = this.aimGraphics;

  //   // Aim line
  //   g.lineStyle(2, 0xffffff, 0.9);
  //   g.beginPath();
  //   g.moveTo(this.aimStartWorld.x, this.aimStartWorld.y);
  //   g.lineTo(pointerWorld.x, pointerWorld.y);
  //   g.strokePath();
  // }

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
    this.clearAimGraphics();
    for (const [puckId, { points, events }] of Object.entries(predictions)) {
      const g = this.aimGraphics[puckId as PuckId] || this.add.graphics();
      this.aimGraphics[puckId as PuckId] = g;
      g.setDepth(0);

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
              puck.player && puck.player !== this.playerId ? 0.5 : 1,
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

      // Redraw puck and aimline

      // If puck isn't current player, add opacity to graphics
      // if (puck.player && puck.player !== this.playerId) {
      //   g.setAlpha(0.5);
      // } else {
      //   g.setAlpha(1);
      // }
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

    // Draw the initial trajectory prediction
    const pts = this.predictTrajectory({});
    this.drawPredictedTrajectory(pts);

    // Show the start game button again
    this.ui.startGameButton.setVisible(true);
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
