// ============================================================
// Alpha Bot — Icon Generator
// Run with: node generate-icons.js
// Requires: npm install canvas (or use sharp)
// Outputs to: public/icons/
// ============================================================
// Alternative: use https://realfavicongenerator.net/ to upload
// a 512x512 PNG and download all icon sizes automatically.
// ============================================================

import { createCanvas } from "canvas";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "public", "icons");
mkdirSync(OUT, { recursive: true });

const SIZES = [72, 96, 128, 192, 256, 512];

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#060b14");
  grad.addColorStop(1, "#0d1b2a");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();

  // Border glow
  ctx.strokeStyle = "rgba(0,255,157,0.35)";
  ctx.lineWidth = size * 0.025;
  ctx.beginPath();
  ctx.roundRect(size * 0.025, size * 0.025, size * 0.95, size * 0.95, size * 0.16);
  ctx.stroke();

  // Lightning bolt ⚡
  const s = size * 0.55;
  const ox = (size - s) / 2;
  const oy = (size - s) / 2;

  ctx.fillStyle = "#00ff9d";
  ctx.shadowColor = "#00ff9d";
  ctx.shadowBlur = size * 0.12;
  ctx.beginPath();
  ctx.moveTo(ox + s * 0.62, oy);
  ctx.lineTo(ox + s * 0.22, oy + s * 0.52);
  ctx.lineTo(ox + s * 0.50, oy + s * 0.52);
  ctx.lineTo(ox + s * 0.38, oy + s * 1.0);
  ctx.lineTo(ox + s * 0.80, oy + s * 0.48);
  ctx.lineTo(ox + s * 0.52, oy + s * 0.48);
  ctx.closePath();
  ctx.fill();

  return canvas.toBuffer("image/png");
}

SIZES.forEach(size => {
  const buf = drawIcon(size);
  const out = join(OUT, `icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`✓ icon-${size}.png`);
});

// Badge (small monochrome icon for notification badge)
function drawBadge(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff9d";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#060b14";
  ctx.font = `bold ${size * 0.55}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("⚡", size / 2, size / 2 + size * 0.04);
  return canvas.toBuffer("image/png");
}

writeFileSync(join(OUT, "badge-72.png"), drawBadge(72));
console.log("✓ badge-72.png");
console.log("\nAll icons generated in public/icons/");
