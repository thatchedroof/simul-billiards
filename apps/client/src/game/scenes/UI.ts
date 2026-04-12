import type { Game } from "./Game.ts";

export class UIScene extends Phaser.Scene {
  gameScene!: Game;

  /* UI Elements */
  resetViewButton!: Phaser.GameObjects.Text;
  startGameButton!: Phaser.GameObjects.Text;
  readyText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "UIScene", active: false });
  }

  setGameScene(scene: Game) {
    this.gameScene = scene;
  }

  create() {
    this.resetViewButton = this.add
      .text(20, 20, "Reset View", {
        font: "40px",
        color: "#ffffff",
        backgroundColor: "#404040",
        padding: { left: 20, right: 20, top: 10, bottom: 10 },
      })
      .setScrollFactor(0)
      .setDepth(1000)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => {
        const cam = this.gameScene.cameras.main;
        cam.zoom = 1;
        cam.centerOn(0, 0);
      });

    this.startGameButton = this.add
      .text(20, 95, "Not Ready", {
        font: "40px",
        color: "#ffffff",
        backgroundColor: "#800000",
        padding: { left: 20, right: 20, top: 10, bottom: 10 },
      })
      .setScrollFactor(0)
      .setDepth(1000)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => {
        this.gameScene.sendBroadcast();
      });
  }

  buttonReadyState(ready: boolean) {
    if (ready) {
      this.startGameButton.setText("Not ready yet");
      this.startGameButton.setBackgroundColor("#000080");
    } else {
      this.startGameButton.setText("I'm ready!");
      this.startGameButton.setBackgroundColor("#000080");
    }
  }

  buttonSubmitState(submitted: boolean) {
    if (submitted) {
      this.startGameButton.setText("Unsubmit move");
      this.startGameButton.setBackgroundColor("#800000");
    } else {
      this.startGameButton.setText("Submit move");
      this.startGameButton.setBackgroundColor("#000080");
    }
  }
}
