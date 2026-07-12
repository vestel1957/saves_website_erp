import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../../LOGO BHDC Completo.png");
const PUB = path.resolve(__dirname, "../public");

// Turn the solid white background into transparency, feathering anti-aliased edges.
function whiteToAlpha(data, info) {
  const { width, height, channels } = info;
  const out = Buffer.from(data); // copy
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const min = Math.min(r, g, b);
    let a = 255;
    if (min >= 238) a = 0;
    else if (min >= 205) a = Math.round(((238 - min) / 33) * 255);
    out[o + 3] = a;
  }
  return out;
}

async function process({ extract, outName }) {
  let img = sharp(SRC).ensureAlpha();
  if (extract) img = sharp(SRC).extract(extract).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const px = whiteToAlpha(data, info);
  // trim the now-transparent margins for a tight, ready-to-use asset
  await sharp(px, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .trim()
    .toFile(path.join(PUB, outName));
  console.log(`saved ${outName} (from ${info.width}x${info.height})`);
}

// Full lockup
await process({ outName: "logo-bhdc-full.png" });
// Emblem (sun symbol only — top-left, above the CNPC wordmark)
await process({ extract: { left: 8, top: 6, width: 246, height: 206 }, outName: "logo-bhdc-mark.png" });

// Favicon: emblem centered on a 256x256 transparent square
await sharp(path.join(PUB, "logo-bhdc-mark.png"))
  .resize(220, 220, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: 18, bottom: 18, left: 18, right: 18, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(path.resolve(__dirname, "../src/app/icon.png"));
console.log("saved src/app/icon.png (256x256)");
console.log("done");
