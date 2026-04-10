import { MapSchema, Schema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") color: number = 0;
  @type("number") secondaryColor: number = 0;
  @type("boolean") ready: boolean = false;
}

export class GameRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("boolean") gameStarted: boolean = false;
}
