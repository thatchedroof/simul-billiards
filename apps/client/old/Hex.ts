export class HexScene extends Phaser.Scene {
  constructor() {
    super("HexScene");
  }

  create() {
    // ---- grid config ----
    this.hexSize = 32;
    this.originX = 0;
    this.originY = 0;

    // ---- data ----
    this.hexMap = new Map();
    const radius = 12; // hex "disk" radius in axial space
    for (let q = -radius; q <= radius; q++) {
      for (let r = -radius; r <= radius; r++) {
        // optional: keep it roughly circular in cube space
        const s = -q - r;
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) > radius) continue;

        this.hexMap.set(`${q},${r}`, {
          q,
          r,
          color: Phaser.Display.Color.RandomRGB().color,
        });
      }
    }

    // ---- single graphics ----
    this.gridGraphics = this.add.graphics();
    this.gridGraphics.setScrollFactor(1); // default, but explicit

    // Center the camera on the grid
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.centerOn(0, 0);

    // Initial draw
    this.drawGrid();

    // ---- drag pan ----
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.camStart = { scrollX: 0, scrollY: 0 };

    this.input.on("pointerdown", (p) => {
      this.isDragging = true;
      this.dragStart.x = p.x;
      this.dragStart.y = p.y;
      this.camStart.scrollX = cam.scrollX;
      this.camStart.scrollY = cam.scrollY;
    });

    this.input.on("pointerup", () => {
      this.isDragging = false;
    });

    this.input.on("pointermove", (p) => {
      if (!this.isDragging) return;
      // screen delta -> camera scroll delta (account for zoom)
      const dx = (p.x - this.dragStart.x) / cam.zoom;
      const dy = (p.y - this.dragStart.y) / cam.zoom;
      cam.scrollX = this.camStart.scrollX - dx;
      cam.scrollY = this.camStart.scrollY - dy;
    });

    // ---- wheel zoom (zoom toward pointer) ----
    this.input.on("wheel", (pointer, dx, dy) => {
      const zoomFactor = 1.0015; // sensitivity
      const oldZoom = cam.zoom;
      let newZoom = oldZoom * Math.pow(zoomFactor, -dy);

      newZoom = Phaser.Math.Clamp(newZoom, 0.2, 3.5);

      if (newZoom === oldZoom) return;

      // World point under mouse before zoom
      const worldBefore = cam.getWorldPoint(pointer.x, pointer.y);

      cam.setZoom(newZoom);

      // World point under mouse after zoom
      const worldAfter = cam.getWorldPoint(pointer.x, pointer.y);

      // Adjust scroll to keep the same world point under cursor
      cam.scrollX += worldBefore.x - worldAfter.x;
      cam.scrollY += worldBefore.y - worldAfter.y;
    });

    // ---- click pick (example: paint hex) ----
    this.input.on("pointerup", (pointer) => {
      // if it was a drag, ignore “click”
      if (pointer.getDistance() > 6) return;

      const world = cam.getWorldPoint(pointer.x, pointer.y);
      const { q, r } = pixelToAxial(
        world.x,
        world.y,
        this.hexSize,
        this.originX,
        this.originY,
      );

      const key = `${q},${r}`;
      const hex = this.hexMap.get(key);
      if (hex) {
        hex.color = 0xffc107; // highlight
        this.drawGrid();
      }
    });

    // Optional: redraw on zoom/pan? Not necessary for Graphics in world space.
    // Only redraw when data changes, which is what we do.
  }

  drawGrid() {
    const g = this.gridGraphics;
    g.clear();

    g.lineStyle(2, 0x222222, 1);

    for (const hex of this.hexMap.values()) {
      const { x, y } = axialToPixel(
        hex.q,
        hex.r,
        this.hexSize,
        this.originX,
        this.originY,
      );
      const corners = hexCorners(x, y, this.hexSize);

      g.fillStyle(hex.color, 1);

      g.beginPath();
      g.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) g.lineTo(corners[i].x, corners[i].y);
      g.closePath();
      g.fillPath();
      g.strokePath();
    }
  }
}

// ---------- math helpers (pointy-top axial) ----------
function axialToPixel(q, r, size, originX, originY) {
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = ((size * 3) / 2) * r;
  return { x: x + originX, y: y + originY };
}

function pixelToAxial(x, y, size, originX, originY) {
  x -= originX;
  y -= originY;

  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;

  return hexRound(q, r);
}

// cube rounding
function hexRound(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;

  return { q: rx, r: rz };
}

function hexCorners(cx, cy, size) {
  const corners = [];
  const startAngle = -Math.PI / 6; // pointy-top
  for (let i = 0; i < 6; i++) {
    const a = startAngle + i * (Math.PI / 3);
    corners.push({ x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) });
  }
  return corners;
}
