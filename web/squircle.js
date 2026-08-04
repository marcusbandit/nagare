// G2-continuous corners. CSS border-radius is G1: the straight edge meets the arc
// with curvature jumping from 0 to 1/r, which the eye reads as a pinch. This builds
// the Figma/Apple squircle instead - a shortened arc with a cubic on each side that
// eases curvature from 0 up to the arc's - and applies it as a clip-path.
//
// Every rounded shape in this app goes through here. A raw border-radius is a bug.

const RAD = Math.PI / 180;

// One corner, expressed in the basis (u = direction arriving, v = direction leaving).
// Returns SVG path commands in absolute coordinates.
function corner(cx, cy, ux, uy, vx, vy, r, s) {
  const p = (1 + s) * r;
  const arcMeasure = 90 * (1 - s);
  const arcSection = Math.sin((arcMeasure / 2) * RAD) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = r * Math.tan((alpha / 2) * RAD);
  const beta = 45 * s;
  const c = p3p4 * Math.cos(beta * RAD);
  const d = c * Math.tan(beta * RAD);
  const b = (p - arcSection - c - d) / 3;
  const a = 2 * b;

  // Start of the corner: p back along the incoming edge.
  const sx = cx - p * ux;
  const sy = cy - p * uy;
  // Map a local (along-u, along-v) offset to absolute coordinates.
  const at = (du, dv) => [sx + du * ux + dv * vx, sy + du * uy + dv * vy];

  const [c1x, c1y] = at(a, 0);
  const [c2x, c2y] = at(a + b, 0);
  const [e1x, e1y] = at(a + b + c, d);
  const [e2x, e2y] = at(a + b + c + arcSection, d + arcSection);
  const [c3x, c3y] = at(a + b + c + arcSection + d, d + arcSection + c);
  const [c4x, c4y] = at(a + b + c + arcSection + d, d + arcSection + b + c);
  const [e3x, e3y] = at(a + b + c + arcSection + d, d + arcSection + a + b + c);

  return (
    `C ${c1x} ${c1y} ${c2x} ${c2y} ${e1x} ${e1y} ` +
    `A ${r} ${r} 0 0 1 ${e2x} ${e2y} ` +
    `C ${c3x} ${c3y} ${c4x} ${c4y} ${e3x} ${e3y} `
  );
}

/**
 * Squircle path for a w x h box.
 * @param {number} r  requested corner radius, clamped to what the box can afford
 * @param {number} s  corner smoothing, 0 = plain rounded rect, 0.6 = iOS
 */
export function squirclePath(w, h, r, s = 0.6) {
  if (w <= 0 || h <= 0) return "";
  // The corner reaches (1+s)*r down each side, so two corners must fit on an edge.
  const maxR = Math.min(w, h) / (2 * (1 + s));
  const rr = Math.max(Math.min(r, maxR), 0);
  if (rr <= 0.5) return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  const p = (1 + s) * rr;

  let d = `M ${p} 0 L ${w - p} 0 `;
  d += corner(w, 0, 1, 0, 0, 1, rr, s); // top-right
  d += `L ${w} ${h - p} `;
  d += corner(w, h, 0, 1, -1, 0, rr, s); // bottom-right
  d += `L ${p} ${h} `;
  d += corner(0, h, -1, 0, 0, -1, rr, s); // bottom-left
  d += `L 0 ${p} `;
  d += corner(0, 0, 0, -1, 1, 0, rr, s); // top-left
  return d + "Z";
}

const DEFAULT_RADIUS = 15; // matches decoration:rounding in hyprland.conf
const DEFAULT_SMOOTHING = 0.6;

function apply(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const r = parseFloat(el.dataset.radius || DEFAULT_RADIUS);
  const s = parseFloat(el.dataset.smoothing || DEFAULT_SMOOTHING);
  const path = squirclePath(rect.width, rect.height, r, s);
  if (path && el.dataset.appliedPath !== path) {
    el.dataset.appliedPath = path;
    el.style.clipPath = `path("${path}")`;
  }
}

const observer = new ResizeObserver((entries) => {
  for (const entry of entries) apply(entry.target);
});

/** Watch the subtree for [data-squircle] and keep every one of them clipped. */
export function squircleAll(root = document) {
  root.querySelectorAll("[data-squircle]").forEach((el) => {
    if (el.dataset.squircleBound) return;
    el.dataset.squircleBound = "1";
    observer.observe(el);
    apply(el);
  });
}

// Elements added later (search results, queue rows) get picked up automatically.
new MutationObserver(() => squircleAll()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
