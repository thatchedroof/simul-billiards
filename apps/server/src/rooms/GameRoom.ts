import { Room, Client, CloseCode } from "colyseus";
import {
  GameState,
  generateColor,
  PhysicsWorld,
  Program,
  testProgram,
  GameRoomState,
  Player,
  PlayerId,
  Move,
  predictTrajectory,
  snapshotFromWorld,
} from "@siturbi/shared";
import RAPIER from "@dimforge/rapier2d-compat";

export class GameRoom extends Room {
  state = new GameRoomState();

  /* State */
  program!: Program;
  gameState!: GameState;
  physicsWorld!: PhysicsWorld;
  moves: Record<PlayerId, Move[]> = {};

  messages = {
    ready: (client: Client, isReady: boolean) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.ready = isReady;
        console.log(
          `%c${client.sessionId} is ${isReady ? "ready" : "not ready"}`,
          `color: #${player.color.toString(16)}`,
        );

        // If all players are ready, start the game.
        const allReady = Array.from(this.state.players.values()).every(
          (player) => player.ready,
        );
        // const minPlayers = this.program.minPlayers ?? 2;
        const minPlayers = 2;

        if (allReady && this.state.players.size >= minPlayers) {
          console.log("All players are ready! Starting game...");
          this.state.gameStarted = true;
          this.lock();
        }
      }
    },
    move: (client: Client, moves: Move[]) => {
      if (!this.state.gameStarted) {
        console.log("Game hasn't started yet. Ignoring move.");
        return;
      }

      const playerId = client.sessionId as PlayerId;
      this.moves[playerId] = moves;

      // If all players have moved, run turn
      if (Object.keys(this.moves).length === this.state.players.size) {
        console.log("All players have moved! Running turn...");
        const simulationResult = predictTrajectory(
          this.physicsWorld,
          this.moves,
          this.program,
          this.gameState,
          {
            predictStride: 1,
          },
        );

        const snapshot = snapshotFromWorld(this.physicsWorld);

        this.broadcast("turn", {
          simulationResult,
          snapshot,
        });

        // Clear moves for next turn
        this.moves = {};
      }
    },
    undoMove: (client: Client) => {
      const playerId = client.sessionId as PlayerId;
      delete this.moves[playerId];

      console.log(`Player ${playerId} has undone their move.`);
    },
  };

  async onCreate(options: any) {
    await RAPIER.init();

    this.program = testProgram;
    this.gameState = this.program.initialState({}, {});
    this.physicsWorld = this.program.initialPhysics({}, this.gameState, {});
    this.maxClients = this.program.maxPlayers;
  }

  onJoin(client: Client, options: any) {
    const player = new Player();

    const { color, secondaryColor } = generateColor(this.state.players.size);
    player.color = color;
    player.secondaryColor = secondaryColor;

    this.state.players.set(client.sessionId, player);
    console.log(
      `%c${client.sessionId} joined!`,
      `color: #${player.color.toString(16)}`,
    );
    const playerData = Object.fromEntries(
      this.state.players
        .entries()
        .map(([id, player]) => [
          id,
          { color: player.color, secondaryColor: player.secondaryColor },
        ]),
    );

    this.gameState = this.program.initialState({}, playerData);
    this.physicsWorld = this.program.initialPhysics(
      {},
      this.gameState,
      playerData,
    );
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }
}
