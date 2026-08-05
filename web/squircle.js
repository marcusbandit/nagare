// G2-continuous corners. CSS border-radius is G1: the straight edge meets the arc
// with curvature jumping from 0 to 1/r, which the eye reads as a pinch. This builds
// the Figma/Apple squircle instead - a shortened arc with a cubic on each side that
// eases curvature from 0 up to the arc's - and applies it as a clip-path.
//
// Every rounded shape in this app goes through here. A raw border-radius is a bug.
//
// Borders go through here too. An inset box-shadow draws a *rectangular* ring, so
// clipping it to a squircle slices the ring away at exactly the four corners and
// the outline breaks. Instead each bordered element gets an SVG child stroking the
// same path: the stroke follows the curve, and the parent's clip-path trims its
// outer half, leaving a crisp inner border all the way round.

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

  const n = (v) => Math.round(v * 100) / 100;
  return (
    `C ${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(e1x)} ${n(e1y)} ` +
    `A ${n(r)} ${n(r)} 0 0 1 ${n(e2x)} ${n(e2y)} ` +
    `C ${n(c3x)} ${n(c3y)} ${n(c4x)} ${n(c4y)} ${n(e3x)} ${n(e3y)} `
  );
}

/**
 * Squircle path for a w x h box, optionally inset by `pad` on every side.
 * @param {number} r  requested corner radius, clamped to what the box can afford
 * @param {number} s  corner smoothing, 0 = plain rounded rect, 0.6 = iOS
 */
export function squirclePath(w, h, r, s = 0.6, pad = 0) {
  const x0 = pad;
  const y0 = pad;
  const ww = w - pad * 2;
  const hh = h - pad * 2;
  if (ww <= 0 || hh <= 0) return "";
  // The corner reaches (1+s)*r down each side, so two corners must fit on an edge.
  const maxR = Math.min(ww, hh) / (2 * (1 + s));
  const rr = Math.max(Math.min(r - pad, maxR), 0);
  if (rr <= 0.5) return `M ${x0} ${y0} L ${x0 + ww} ${y0} L ${x0 + ww} ${y0 + hh} L ${x0} ${y0 + hh} Z`;
  const p = (1 + s) * rr;
  const n = (v) => Math.round(v * 100) / 100;

  const R = x0 + ww;
  const B = y0 + hh;
  let d = `M ${n(x0 + p)} ${n(y0)} L ${n(R - p)} ${n(y0)} `;
  d += corner(R, y0, 1, 0, 0, 1, rr, s); // top-right
  d += `L ${n(R)} ${n(B - p)} `;
  d += corner(R, B, 0, 1, -1, 0, rr, s); // bottom-right
  d += `L ${n(x0 + p)} ${n(B)} `;
  d += corner(x0, B, -1, 0, 0, -1, rr, s); // bottom-left
  d += `L ${n(x0)} ${n(y0 + p)} `;
  d += corner(x0, y0, 0, -1, 1, 0, rr, s); // top-left
  return d + "Z";
}

const DEFAULT_RADIUS = 15; // matches decoration:rounding in hyprland.conf
const DEFAULT_SMOOTHING = 0.6;
const SVG_NS = "http://www.w3.org/2000/svg";

function ensureBorder(el) {
  let svg = el.querySelector(":scope > svg.sq-edge");
  if (!svg) {
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "sq-edge");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    svg.append(path);
    el.prepend(svg);
  }
  return svg;
}

function apply(el) {
  const rect = el.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w < 1 || h < 1) return;
  const r = parseFloat(el.dataset.radius || DEFAULT_RADIUS);
  const s = parseFloat(el.dataset.smoothing || DEFAULT_SMOOTHING);
  const path = squirclePath(w, h, r, s);
  if (!path) return;

  if (el.dataset.appliedPath !== path) {
    el.dataset.appliedPath = path;
    el.style.clipPath = `path("${path}")`;
  }

  if (el.hasAttribute("data-edge")) {
    const svg = ensureBorder(el);
    if (svg.dataset.forPath !== path) {
      svg.dataset.forPath = path;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      // Stroke sits centred on the path; the parent's clip removes the outer
      // half, so a width of 2 renders as a clean 1px inner edge on the curve.
      svg.firstElementChild.setAttribute("d", path);
    }
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
