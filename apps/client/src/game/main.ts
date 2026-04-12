import { AUTO, Game } from "phaser";
import { Game as MainGame } from "./scenes/Game.ts";
import { testProgram } from "@siturbi/shared";
import { UIScene } from "./scenes/UI.ts";

type StartGameOptions = {
  parent: string | HTMLElement;
  url: string;
  width?: number;
  height?: number;
  backgroundColor?: string;
};

export function StartGame({
  parent,
  url,
  width = 960,
  height = 540,
  backgroundColor = "#0b5a2a",
}: StartGameOptions): Phaser.Game {
  // Create fresh scene instances per Phaser game instance.
  // This avoids accidental cross-instance state.
  const mainGameScene = new MainGame({ key: "MainGame" });
  const uiScene = new UIScene();

  const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width,
    height,
    parent,
    backgroundColor,
    dom: {
      createContainer: true,
    },
    scale: {
      mode: Phaser.Scale.RESIZE, // Better for multi-instance layouts
      autoCenter: Phaser.Scale.NO_CENTER,
    },
    scene: [mainGameScene, uiScene],
  };

  const game = new Game(config);

  game.scene.start("MainGame", {
    program: testProgram,
    url,
  });

  game.scene.start("UIScene");

  return game;
}
