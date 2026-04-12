import "./style.css";
import { StartGame } from "./game/main";

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("server-url") as HTMLInputElement;
  const button = document.getElementById("start-btn")!;

  // Load saved URL if it exists
  const saved = localStorage.getItem("serverUrl");
  if (saved) input.value = saved;

  button.addEventListener("click", () => {
    const url = input.value.trim();

    if (!url) {
      alert("Please enter a server URL");
      return;
    }

    // Save for next time
    localStorage.setItem("serverUrl", url);

    // Hide UI (optional)
    document.getElementById("ui")!.style.display = "none";

    // Start the game with the URL
    StartGame({ parent: "game-container", url });
    // StartGame({ parent: "game-container-2", url });
  });
});
