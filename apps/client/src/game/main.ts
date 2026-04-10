import { AUTO, Game } from "phaser";
import { Game as MainGame } from "./scenes/Game.ts";
import { testProgram } from "@siturbi/shared";
import { UIScene } from "./scenes/UI.ts";

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  width: 1920,
  height: 1080,
  parent: "game-container",
  dom: {
    createContainer: true,
  },
  backgroundColor: "#0b5a2a",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [
    new MainGame({
      key: "MainGame",
    }),
    UIScene,
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
