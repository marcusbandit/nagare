// Draw electron/icon.png: the 流 mark on a squircle, in the app's own palette.
//
// Rendered by Electron rather than by an image library because Chromium is
// already a dependency and it is the only thing here that can lay out a CJK
// glyph with the system font. Run it on a machine whose fonts have 流 (any mac,
// or a linux box with Noto CJK) and commit the result, so packaging never has to
// care what fonts the build host happens to have:
//
//     ./node_modules/.bin/electron scripts/make-icon.js
//
// 1024px because that is what macOS wants for the largest .icns slot; every
// smaller size is derived from it at package time.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
const OUT = path.resolve(__dirname, "..", "electron", "icon.png");

/** A superellipse, which is the same corner the UI draws everywhere else. A
    plain border-radius would be the one rounded thing in the project not coming
    from the squircle primitive. */
function squirclePath(size, inset, n = 5) {
  const r = size / 2 - inset;
  const c = size / 2;
  const steps = 720;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = c + r * Math.sign(cos) * Math.abs(cos) ** (2 / n);
    const y = c + r * Math.sign(sin) * Math.abs(sin) ** (2 / n);
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${points.join(" ")} Z`;
}

const page = `
<!doctype html>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="18" result="blur" />
      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>
  <path d="${squirclePath(SIZE, 92)}" fill="#0D1512" stroke="#33493F" stroke-width="10" />
  <text x="${SIZE / 2}" y="${SIZE / 2}" fill="#8CFFC0" filter="url(#glow)"
        font-size="470" text-anchor="middle" dominant-baseline="central"
        font-family="'Hiragino Sans', 'Noto Sans CJK JP', 'PingFang SC', 'Yu Gothic', sans-serif">流</text>
</svg>
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((r) => setTimeout(r, 400)); // let the font land
  // A retina display captures at 2x, so pin the size rather than shipping
  // whatever the build machine's scale factor happened to be.
  const image = (await win.capturePage()).resize({ width: SIZE, height: SIZE, quality: "best" });
  fs.writeFileSync(OUT, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`wrote ${OUT} (${width}x${height})`);
  app.quit();
});
