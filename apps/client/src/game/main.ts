import { AUTO, Game } from "phaser";
import { Game as MainGame } from "./scenes/Game.ts";
import { testProgram } from "@siturbi/shared";

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  width: 1920,
  height: 1080,
  parent: "game-container",
  backgroundColor: "#0b5a2a",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [
    new MainGame({
      key: "MainGame",
    }),
  ],
};

const StartGame = (parent: string, url: string) => {
  const game = new Game({ ...config, parent });

  game.scene.start("MainGame", {
    program: testProgram,
    url,
  });

  return game;
};

export default StartGame;
