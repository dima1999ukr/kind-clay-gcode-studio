import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import {
  PRINTER_PROFILES,
  generateBasePoints,
  processToolpath,
  parseGcodeToPoints,
  sliceMeshToBasePoints,
  resampleSpiralPoints,
  registerHeightmapFile,
  registerProceduralHeightmap,
} from "./engine.js";

const state = {
  profiles: PRINTER_PROFILES,
  activeProfileId: "wasp_2040_clay",
  presetShape: "espresso", // "espresso" | "tumbler" | "vase" | "lampshade" | "square_vase" | "parametric" | null
  uploadedModelId: null,
  uploadedMesh: null,      // { buf, name, lastLayerH } -> auto re-sliced when layerH or printer changes!
  rawGcodePts: null,       // Points of a loaded .gcode file -> auto re-spaced to the current layer height
  faceAspect: [1, 1],      // Half extents (x, y) of the current object for aspect-correct wall picking
  sourcePoints: null,      // Base unmodified polyline points (zero re-parsing!)
  buildCurrentGcode: null, // Lazy G-code text serializer (only runs on Save or Editor open!)
  sourceGcode: "",
  currentGcode: "",
  filename: "espressotasse.gcode",
  renderData: null,
  ghostRenderData: null,   // Unmodified base geometry for translucent ghost comparison
  showGhost: true,
  activeFaces: new Set(["front", "right", "back", "left"]),
  heightmapId: null,
  profilePoints: [
    [34, 0.0],
    [44, 0.25],
    [40, 0.50],
    [32, 0.78],
    [38, 1.0],
  ],
  analysis: null,
  viewMode: "toolpath",    // toolpath | render
  renderMaterial: "terracotta",
  colorMode: "slope",      // slope | z | speed | flow
  playing: false,
  playbackRatio: 1.0,
  lastGhMtime: 0,
};

const RENDER_MATERIALS = {
  terracotta: { color: 0xc9764f, roughness: 0.78, metalness: 0.02 },
  porcelain:  { color: 0xebe5da, roughness: 0.48, metalness: 0.03 },
  stoneware:  { color: 0x383e47, roughness: 0.72, metalness: 0.06 },
  pla:        { color: 0xd9d2c5, roughness: 0.36, metalness: 0.08 },
};

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ============================================================================
// THREE.JS 3D VIEWPORT (Z-up printer coordinates mapped cleanly to Three Y-up)
// ============================================================================
const container = $("viewport3d");
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const hemiLight = new THREE.HemisphereLight(0xf2f5ff, 0x2a2420, 0.95);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xfff5e8, 1.15);
dirLight.position.set(170, 260, 190);
scene.add(dirLight);
const rimLight = new THREE.DirectionalLight(0xa8c8ff, 0.55);
rimLight.position.set(-180, 140, -160);
scene.add(rimLight);
const fillLight = new THREE.DirectionalLight(0xffdfb8, 0.35);
fillLight.position.set(40, -80, 140);
scene.add(fillLight);

const bedGroup = new THREE.Group();
scene.add(bedGroup);

const pathGroup = new THREE.Group();
scene.add(pathGroup);

const ghostGroup = new THREE.Group();
scene.add(ghostGroup);

// Nozzle indicator cone
const nozzleGeo = new THREE.ConeGeometry(2.6, 8, 16);
nozzleGeo.rotateX(Math.PI);
const nozzleMat = new THREE.MeshStandardMaterial({
  color: 0xe8844c,
  emissive: 0x552208,
  metalness: 0.4,
  roughness: 0.3,
});
const nozzleMesh = new THREE.Mesh(nozzleGeo, nozzleMat);
nozzleMesh.visible = false;
scene.add(nozzleMesh);

let activeLines = null;
let activeSolidMesh = null;
let activeTotalIndices = 0;
let currentBedCenter = [0, 0];

// Convert printer (X, Y, Z_up) -> Three.js (X, Z_up, -Y) centered around bed
function toThree(px, py, pz) {
  return new THREE.Vector3(px - currentBedCenter[0], pz, -(py - currentBedCenter[1]));
}

function buildPrinterBed(profile) {
  clearGroup(bedGroup);
  currentBedCenter = profile.origin_center || [0, 0];
  const isRhinoLight = state.viewMode === "toolpath";

  if (profile.bed_shape === "circle") {
    const r = (profile.bed_diameter_mm || 200) * 0.5;
    const h = profile.bed_height_mm || 400;

    // Circular build plate
    const discGeo = new THREE.CircleGeometry(r, 72);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = new THREE.MeshBasicMaterial({
      color: isRhinoLight ? 0xd9dee6 : 0x1b202b,
      transparent: true,
      opacity: isRhinoLight ? 0.55 : 0.85,
    });
    bedGroup.add(new THREE.Mesh(discGeo, discMat));

    // Crisp Rhino-style orthogonal grid clipped inside circle
    const gridPts = [];
    for (let g = -r; g <= r; g += 10) {
      const span = Math.sqrt(Math.max(0, r * r - g * g));
      if (span < 1) continue;
      gridPts.push(new THREE.Vector3(g, 0.06, -span), new THREE.Vector3(g, 0.06, span));
      gridPts.push(new THREE.Vector3(-span, 0.06, g), new THREE.Vector3(span, 0.06, g));
    }
    bedGroup.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({ color: isRhinoLight ? 0xbec5d1 : 0x252c3b, transparent: true, opacity: isRhinoLight ? 0.7 : 0.55 })
    ));

    // Concentric rings
    for (const frac of [0.5, 1.0]) {
      const ringPts = [];
      const rr = r * frac;
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * rr, 0.12, Math.sin(a) * rr));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({
          color: frac === 1 ? (isRhinoLight ? 0xc86432 : 0xe8844c) : (isRhinoLight ? 0x9aa4b4 : 0x2c3445),
        })
      );
      bedGroup.add(line);
    }

    // Top height ring + 3 delta pillars
    const topPts = [];
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      topPts.push(new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r));
    }
    bedGroup.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(topPts),
      new THREE.LineBasicMaterial({ color: isRhinoLight ? 0xaab2c0 : 0x2b3242, transparent: true, opacity: 0.45 })
    ));
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3 + Math.PI / 6;
      const pGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
        new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r),
      ]);
      bedGroup.add(new THREE.Line(pGeo, new THREE.LineBasicMaterial({ color: isRhinoLight ? 0xb0b8c6 : 0x333c50, transparent: true, opacity: 0.5 })));
    }
  } else {
    const w = profile.bed_width_mm || 220;
    const d = profile.bed_depth_mm || 220;
    const h = profile.bed_height_mm || 280;

    const planeGeo = new THREE.PlaneGeometry(w, d);
    planeGeo.rotateX(-Math.PI / 2);
    const planeMat = new THREE.MeshBasicMaterial({ color: isRhinoLight ? 0xd9dee6 : 0x1b202b, transparent: true, opacity: 0.8 });
    bedGroup.add(new THREE.Mesh(planeGeo, planeMat));

    const grid = new THREE.GridHelper(w, 22, isRhinoLight ? 0x9ea7b8 : 0x3a4459, isRhinoLight ? 0xc2c9d4 : 0x242a38);
    grid.position.y = 0.08;
    bedGroup.add(grid);

    const boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const boxLines = new THREE.LineSegments(boxGeo, new THREE.LineBasicMaterial({ color: isRhinoLight ? 0xaab2c0 : 0x323b4e }));
    boxLines.position.y = h * 0.5;
    bedGroup.add(boxLines);
  }

  // Rhino CPlane Axis arrows at origin (Red X, Green Y, Blue Z)
  const axLen = 35;
  const orig = toThree(0, 0, 0.25);
  bedGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([orig, orig.clone().add(new THREE.Vector3(axLen, 0, 0))]),
    new THREE.LineBasicMaterial({ color: 0xdc2626 })
  ));
  bedGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([orig, orig.clone().add(new THREE.Vector3(0, 0, -axLen))]),
    new THREE.LineBasicMaterial({ color: 0x16a34a })
  ));
  bedGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([orig, orig.clone().add(new THREE.Vector3(0, axLen, 0))]),
    new THREE.LineBasicMaterial({ color: 0x2563eb })
  ));
}

function colorRamp(t) {
  const c = Math.max(0, Math.min(1, t));
  if (state.viewMode === "toolpath") {
    // High-contrast Rhino/Grasshopper palette on light grey CAD viewport:
    // Deep emerald green -> rich amber -> Grasshopper crimson red
    if (c < 0.5) {
      const k = c * 2;
      return [0.06 + (0.88 - 0.06) * k, 0.60 + (0.48 - 0.60) * k, 0.28 + (0.04 - 0.28) * k];
    }
    const k = (c - 0.5) * 2;
    return [0.88 + (0.86 - 0.88) * k, 0.48 + (0.14 - 0.48) * k, 0.04 + (0.16 - 0.04) * k];
  }
  if (c < 0.5) {
    const k = c * 2;
    return [0.22 + (0.94 - 0.22) * k, 0.79 + (0.71 - 0.79) * k, 0.46 + (0.16 - 0.46) * k];
  }
  const k = (c - 0.5) * 2;
  return [0.94 + (0.94 - 0.94) * k, 0.71 + (0.33 - 0.71) * k, 0.16 + (0.31 - 0.16) * k];
}

const FACE_LABELS = {
  front: "Vorne",
  right: "Rechts",
  back: "Hinten",
  left: "Links",
};

function getFaceFromPrinterXY(px, py) {
  const [hx, hy] = state.faceAspect || [1, 1];
  const ang = Math.atan2(py / Math.max(1, hy), px / Math.max(1, hx));
  if (ang >= -Math.PI * 0.25 && ang < Math.PI * 0.25) return "right";
  if (ang >= Math.PI * 0.25 && ang < Math.PI * 0.75) return "back";
  if (ang >= -Math.PI * 0.75 && ang < -Math.PI * 0.25) return "front";
  return "left";
}

function clearGroup(grp) {
  while (grp.children.length) {
    const ch = grp.children.pop();
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) ch.material.dispose();
  }
}

/**
 * Build a smooth translucent 3D ghost shell from the unmodified base spiral
 * so deviations from Weaving / Non-Planar / Oozing are immediately visible.
 */
function buildGhostMesh(ghostData) {
  clearGroup(ghostGroup);
  if (!state.showGhost || !ghostData || ghostData.count < 20) return;

  const { count, coords, extruding } = ghostData;
  const cx = currentBedCenter[0];
  const cy = currentBedCenter[1];

  // Collect extruding wall points grouped into revolutions via unwrapped angle
  const pts = [];
  for (let i = 0; i < count; i++) {
    if (!extruding[i]) continue;
    const o6 = i * 6;
    const x = coords[o6 + 3] - cx;
    const y = coords[o6 + 4] - cy;
    const z = coords[o6 + 5];
    const r = Math.hypot(x, y);
    pts.push({ x, y, z, r });
  }
  if (pts.length < 24) return;

  // Detect wall start (skip flat base spiral points whose Z is near minimum while radius grows from center)
  let maxZ = 0;
  for (let i = 0; i < pts.length; i++) if (pts[i].z > maxZ) maxZ = pts[i].z;
  const zBaseCut = Math.min(3.0, maxZ * 0.045);

  const wallPts = pts.filter((p) => p.z > zBaseCut || p.r > 14.0);
  if (wallPts.length < 24) return;

  // Unwrap angles into turns and sample N=64 angular bins per turn (crisp corners on square vase)
  const BINS = 64;
  const turns = new Map();
  let prevAng = null;
  let unwrapped = 0;

  for (let i = 0; i < wallPts.length; i++) {
    const p = wallPts[i];
    const ang = Math.atan2(p.y, p.x);
    if (prevAng === null) {
      unwrapped = ang >= 0 ? ang : ang + Math.PI * 2;
    } else {
      let d = ang - prevAng;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      unwrapped += d;
    }
    prevAng = ang;
    const tFloat = unwrapped / (Math.PI * 2);
    const tIdx = Math.floor(tFloat);
    const u = tFloat - tIdx;
    const bin = Math.min(BINS - 1, Math.floor(u * BINS));
    if (!turns.has(tIdx)) turns.set(tIdx, new Array(BINS).fill(null));
    turns.get(tIdx)[bin] = p;
  }

  // Keep complete rings (at least 75% bins filled), fill any sparse bin by neighbor
  const sortedKeys = Array.from(turns.keys()).sort((a, b) => a - b);
  const rings = [];
  for (const k of sortedKeys) {
    const row = turns.get(k);
    let filled = 0;
    for (let b = 0; b < BINS; b++) if (row[b]) filled++;
    if (filled < BINS * 0.65) continue;
    for (let b = 0; b < BINS; b++) {
      if (!row[b]) {
        for (let off = 1; off < BINS; off++) {
          if (row[(b + off) % BINS]) { row[b] = row[(b + off) % BINS]; break; }
          if (row[(b - off + BINS) % BINS]) { row[b] = row[(b - off + BINS) % BINS]; break; }
        }
      }
    }
    rings.push(row);
  }
  if (rings.length < 2) return;

  // Subsample rings vertically to max ~40 bands so the ghost shell stays ultra-light
  const stepR = Math.max(1, Math.floor(rings.length / 40));
  const sampledRings = [];
  for (let i = 0; i < rings.length; i += stepR) sampledRings.push(rings[i]);
  if (sampledRings[sampledRings.length - 1] !== rings[rings.length - 1]) {
    sampledRings.push(rings[rings.length - 1]);
  }

  // Build smooth indexed BufferGeometry with per-face active highlight
  const nR = sampledRings.length;
  const verts = new Float32Array(nR * BINS * 3);
  const vColors = new Float32Array(nR * BINS * 3);
  const isRhinoLight = state.viewMode === "toolpath";
  const selectiveMode = state.activeFaces.size < 4;

  // Base neutral ghost vs. warm highlight on selected wall(s)
  const baseCol = isRhinoLight ? [0.76, 0.79, 0.83] : [0.55, 0.77, 1.0];
  const selCol = isRhinoLight ? [0.95, 0.62, 0.42] : [0.96, 0.60, 0.36];

  for (let r = 0; r < nR; r++) {
    for (let b = 0; b < BINS; b++) {
      const p = sampledRings[r][b];
      const o = (r * BINS + b) * 3;
      verts[o] = p.x;
      verts[o + 1] = p.z;
      verts[o + 2] = -p.y;
      const isAct = selectiveMode && state.activeFaces.has(getFaceFromPrinterXY(p.x, p.y));
      const c = isAct ? selCol : baseCol;
      vColors[o] = c[0];
      vColors[o + 1] = c[1];
      vColors[o + 2] = c[2];
    }
  }
  const indices = [];
  for (let r = 0; r < nR - 1; r++) {
    for (let b = 0; b < BINS; b++) {
      const bn = (b + 1) % BINS;
      const a = r * BINS + b;
      const c = r * BINS + bn;
      const d = (r + 1) * BINS + b;
      const e = (r + 1) * BINS + bn;
      indices.push(a, c, e, a, e, d);
    }
  }

  const surfGeo = new THREE.BufferGeometry();
  surfGeo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  surfGeo.setAttribute("color", new THREE.BufferAttribute(vColors, 3));
  surfGeo.setIndex(indices);
  surfGeo.computeVertexNormals();

  const surfMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.04,
    transparent: true,
    opacity: isRhinoLight ? 0.56 : 0.18,
    side: THREE.DoubleSide,
    depthWrite: isRhinoLight,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const surfMesh = new THREE.Mesh(surfGeo, surfMat);
  surfMesh.userData.isGhostSurface = true;
  ghostGroup.add(surfMesh);

  // Rhino-style U (horizontal) & V (vertical) NURBS isocurves on the Ghosted surface
  const ringStep = Math.max(1, Math.floor(nR / 7));
  const isoMat = new THREE.LineBasicMaterial({
    color: isRhinoLight ? 0x5f6b7d : 0xaad6ff,
    transparent: true,
    opacity: isRhinoLight ? 0.34 : 0.22,
  });
  for (let r = 0; r < nR; r += ringStep) {
    const rPts = [];
    for (let b = 0; b <= BINS; b++) {
      const p = sampledRings[r][b % BINS];
      rPts.push(new THREE.Vector3(p.x, p.z, -p.y));
    }
    ghostGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rPts), isoMat));
  }
  // Top rim isocurve
  const topPts = [];
  for (let b = 0; b <= BINS; b++) {
    const p = sampledRings[nR - 1][b % BINS];
    topPts.push(new THREE.Vector3(p.x, p.z, -p.y));
  }
  ghostGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(topPts), isoMat));

  // Vertical V-isocurves (8 clean meridians like Rhino NURBS surfaces)
  const vStep = Math.max(1, Math.floor(BINS / 8));
  for (let b = 0; b < BINS; b += vStep) {
    const vPts = [];
    for (let r = 0; r < nR; r++) {
      const p = sampledRings[r][b];
      vPts.push(new THREE.Vector3(p.x, p.z, -p.y));
    }
    ghostGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vPts), isoMat));
  }
}

/**
 * Build ONE single continuous, smooth, mitered swept 3D tube mesh along all
 * extruded polylines (zero cylinder caps, zero jagged V-notches, zero spheres!).
 * Local extrusion flow & ooze swells smoothly thicken and taper the strand itself.
 */
function buildContinuousTubeMesh(renderData, analysis, isRenderMode) {
  const { count, coords, slopes, speeds, flows, extruding, zs, ooze_events } = renderData;
  const cx = currentBedCenter[0];
  const cy = currentBedCenter[1];
  const isClay = state.activeProfileId === "wasp_2040_clay";

  const lineW = Math.max(0.35, Number($("inLineW").value) || (isClay ? 2.2 : 0.48));
  const layerH = Math.max(0.18, Number($("inLayerH").value) || (isClay ? 1.2 : 0.28));

  // Build spatial lookup for ooze events so dwell/extra_e swells the continuous strand smoothly
  const oozeByKey = new Map();
  if (ooze_events && ooze_events.length > 0) {
    for (let i = 0; i < ooze_events.length; i++) {
      const ev = ooze_events[i];
      const key = `${Math.round((ev.x - cx) * 5)}_${Math.round((ev.y - cy) * 5)}_${Math.round(ev.z * 5)}`;
      const boost = (ev.extra_e || 0) * (isClay ? 0.55 : 1.2) + (ev.dwell_ms || 0) / 1400.0;
      oozeByKey.set(key, (oozeByKey.get(key) || 0) + boost);
    }
  }

  // Extract continuous extruding chains + stats (zero-stack loops)
  const chains = [];
  let cur = null;
  let minSpeed = Infinity, maxSpeed = 301, maxFlow = 0.01;
  const flowSamples = [];
  const travelCoords = [];

  for (let i = 0; i < count; i++) {
    const o6 = i * 6;
    const x0 = coords[o6] - cx, y0 = coords[o6 + 2], z0 = -(coords[o6 + 1] - cy);
    const x1 = coords[o6 + 3] - cx, y1 = coords[o6 + 5], z1 = -(coords[o6 + 4] - cy);

    if (!extruding[i]) {
      cur = null;
      if (!isRenderMode) {
        travelCoords.push(x0, y0, z0, x1, y1, z1);
      }
      continue;
    }

    const sp = speeds[i];
    if (sp < minSpeed) minSpeed = sp;
    if (sp > maxSpeed) maxSpeed = sp;
    const fl = flows[i] || 0;
    if (fl > maxFlow) maxFlow = fl;
    if (fl > 1e-6) flowSamples.push(fl);

    const kEnd = `${Math.round(x1 * 5)}_${Math.round((-z1) * 5)}_${Math.round(y1 * 5)}`;
    const oozeBoost = oozeByKey.get(kEnd) || 0;

    if (!cur) {
      cur = [
        { x: x0, y: y0, z: z0, flow: fl, slope: slopes[i], speed: sp, rawZ: coords[o6 + 2], ooze: 0 },
        { x: x1, y: y1, z: z1, flow: fl, slope: slopes[i], speed: sp, rawZ: coords[o6 + 5], ooze: oozeBoost },
      ];
      chains.push(cur);
    } else {
      const last = cur[cur.length - 1];
      const gap = Math.hypot(x0 - last.x, y0 - last.y, z0 - last.z);
      if (gap > 0.6) {
        cur = [
          { x: x0, y: y0, z: z0, flow: fl, slope: slopes[i], speed: sp, rawZ: coords[o6 + 2], ooze: 0 },
          { x: x1, y: y1, z: z1, flow: fl, slope: slopes[i], speed: sp, rawZ: coords[o6 + 5], ooze: oozeBoost },
        ];
        chains.push(cur);
      } else {
        const segD = Math.hypot(x1 - last.x, y1 - last.y, z1 - last.z);
        if (segD > 1e-3) {
          cur.push({ x: x1, y: y1, z: z1, flow: fl, slope: slopes[i], speed: sp, rawZ: coords[o6 + 5], ooze: oozeBoost });
        } else if (oozeBoost > 0) {
          last.ooze += oozeBoost;
        }
      }
    }
  }

  if (!Number.isFinite(minSpeed)) minSpeed = 300;
  if (maxSpeed <= minSpeed) maxSpeed = minSpeed + 1;

  // Baseline normal flow (50th percentile median -> stays anchored at 1.0x even when flow_min=0 or flow_max=5!)
  let baseFlow = 0.25;
  if (flowSamples.length > 0) {
    flowSamples.sort((a, b) => a - b);
    baseFlow = Math.max(1e-5, flowSamples[Math.floor(flowSamples.length * 0.50)]);
  }

  // Smoothly diffuse flow & ooze swell along each chain so transitions are 100% gradual
  for (const chain of chains) {
    const n = chain.length;
    const rawScale = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const flRatio = chain[i].flow > 1e-6 ? (chain[i].flow / baseFlow) : 0.08;
      rawScale[i] = Math.max(0.08, Math.min(4.8, flRatio));
    }
    // Diffuse discrete ooze crest boosts smoothly over +/- 3 neighboring vertices (bell kernel)
    const kernel = [0.18, 0.52, 1.0, 0.52, 0.18];
    for (let i = 0; i < n; i++) {
      const ob = chain[i].ooze;
      if (ob > 0) {
        for (let k = -2; k <= 2; k++) {
          const j = i + k;
          if (j >= 0 && j < n) {
            rawScale[j] = Math.min(3.8, rawScale[j] + ob * kernel[k + 2]);
          }
        }
      }
    }
    // Two gentle smoothing passes along the strand for silky organic tapering
    let a = rawScale;
    let b = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const p = a[Math.max(0, i - 1)];
        const c = a[i];
        const q = a[Math.min(n - 1, i + 1)];
        b[i] = 0.25 * p + 0.5 * c + 0.25 * q;
      }
      const tmp = a; a = b; b = tmp;
    }
    for (let i = 0; i < n; i++) chain[i].swell = a[i];
  }

  // Radial cross-section detail: 10-sided smooth flattened bead in Render, 6-sided crisp tube in Toolpath
  const RADIAL = isRenderMode ? 10 : 6;
  const ringCos = new Float32Array(RADIAL);
  const ringSin = new Float32Array(RADIAL);
  for (let s = 0; s < RADIAL; s++) {
    const a = (s / RADIAL) * Math.PI * 2;
    ringCos[s] = Math.cos(a);
    ringSin[s] = Math.sin(a);
  }

  let totalVerts = 0;
  let totalTris = 0;
  for (const chain of chains) {
    if (chain.length < 2) continue;
    totalVerts += chain.length * RADIAL;
    totalTris += (chain.length - 1) * RADIAL * 2;
  }
  if (totalVerts === 0) return;

  const positions = new Float32Array(totalVerts * 3);
  const colors = isRenderMode ? null : new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalTris * 3);

  const angleLim = (analysis && analysis.stats && analysis.stats.angle_limit_deg) || 42;
  const maxZ = Math.max(1, (analysis && analysis.bounds && analysis.bounds.max_z) || 100);

  if (!isRenderMode) {
    if (state.colorMode === "slope") {
      $("legendLow").textContent = "0°";
      $("legendHigh").textContent = `${angleLim}°+`;
    } else if (state.colorMode === "z") {
      $("legendLow").textContent = "0 mm";
      $("legendHigh").textContent = `${maxZ.toFixed(0)} mm`;
    } else if (state.colorMode === "speed") {
      $("legendLow").textContent = `F${minSpeed.toFixed(0)}`;
      $("legendHigh").textContent = `F${maxSpeed.toFixed(0)}`;
    } else {
      $("legendLow").textContent = "0";
      $("legendHigh").textContent = `${maxFlow.toFixed(2)} E/mm`;
    }
  }

  const tPrev = new THREE.Vector3();
  const tNext = new THREE.Vector3();
  const tang = new THREE.Vector3();
  const side = new THREE.Vector3();
  const upLoc = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const altUp = new THREE.Vector3(1, 0, 0);

  const baseW = isRenderMode ? lineW : Math.max(0.32, Math.min(0.95, lineW * 0.34));
  const baseH = isRenderMode ? Math.max(layerH * 1.06, lineW * 0.50) : baseW;

  let vOffset = 0;
  let iOffset = 0;

  for (const chain of chains) {
    const n = chain.length;
    if (n < 2) continue;
    const chainStartVert = vOffset;

    for (let i = 0; i < n; i++) {
      const p = chain[i];
      if (i === 0) {
        tang.set(chain[1].x - p.x, chain[1].y - p.y, chain[1].z - p.z).normalize();
      } else if (i === n - 1) {
        tang.set(p.x - chain[n - 2].x, p.y - chain[n - 2].y, p.z - chain[n - 2].z).normalize();
      } else {
        tPrev.set(p.x - chain[i - 1].x, p.y - chain[i - 1].y, p.z - chain[i - 1].z).normalize();
        tNext.set(chain[i + 1].x - p.x, chain[i + 1].y - p.y, chain[i + 1].z - p.z).normalize();
        tang.addVectors(tPrev, tNext);
        if (tang.lengthSq() < 1e-6) tang.copy(tNext);
        else tang.normalize();
      }

      const upRef = Math.abs(tang.y) > 0.96 ? altUp : worldUp;
      side.crossVectors(upRef, tang).normalize();
      upLoc.crossVectors(tang, side).normalize();

      // Gradual physical bead swell from smoothed flow/ooze (zero discrete spheres!)
      const sw = p.swell || 1.0;
      const wScale = Math.pow(sw, isRenderMode ? 0.68 : 0.60);
      const hScale = Math.pow(sw, isRenderMode ? 0.50 : 0.45);
      const rx = 0.5 * baseW * wScale;
      const ry = 0.5 * baseH * hScale;
      // Subtle downward gravity droop only where the clay swells thicker
      const sagY = isRenderMode ? -Math.max(0, hScale - 1.0) * layerH * 0.22 : 0;

      let cr = 1, cg = 1, cb = 1;
      if (!isRenderMode) {
        if (state.colorMode === "slope") {
          [cr, cg, cb] = colorRamp(p.slope / Math.max(angleLim, 1));
        } else if (state.colorMode === "z") {
          [cr, cg, cb] = colorRamp(p.rawZ / maxZ);
        } else if (state.colorMode === "speed") {
          [cr, cg, cb] = colorRamp((p.speed - minSpeed) / Math.max(1, maxSpeed - minSpeed));
        } else {
          [cr, cg, cb] = colorRamp(p.flow / maxFlow);
        }
      }

      for (let s = 0; s < RADIAL; s++) {
        const cxOff = ringCos[s] * rx;
        const cyOff = ringSin[s] * ry;
        const vo = (vOffset + s) * 3;
        positions[vo]     = p.x + side.x * cxOff + upLoc.x * cyOff;
        positions[vo + 1] = p.y + side.y * cxOff + upLoc.y * cyOff + sagY;
        positions[vo + 2] = p.z + side.z * cxOff + upLoc.z * cyOff;
        if (colors) {
          colors[vo] = cr;
          colors[vo + 1] = cg;
          colors[vo + 2] = cb;
        }
      }

      if (i > 0) {
        const prevRing = chainStartVert + (i - 1) * RADIAL;
        const currRing = chainStartVert + i * RADIAL;
        for (let s = 0; s < RADIAL; s++) {
          const sn = (s + 1) % RADIAL;
          const a = prevRing + s;
          const b = prevRing + sn;
          const c = currRing + s;
          const d = currRing + sn;
          indices[iOffset++] = a;
          indices[iOffset++] = c;
          indices[iOffset++] = b;
          indices[iOffset++] = b;
          indices[iOffset++] = c;
          indices[iOffset++] = d;
        }
      }

      vOffset += RADIAL;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (colors) {
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();

  let mat;
  if (isRenderMode) {
    const matCfg = RENDER_MATERIALS.terracotta;
    mat = new THREE.MeshStandardMaterial({
      color: matCfg.color,
      roughness: matCfg.roughness,
      metalness: matCfg.metalness,
    });
  } else {
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.45,
      metalness: 0.06,
    });
  }

  activeSolidMesh = new THREE.Mesh(geo, mat);
  activeTotalIndices = iOffset;
  pathGroup.add(activeSolidMesh);

  if (!isRenderMode && travelCoords.length > 0) {
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(travelCoords), 3));
    const tMat = new THREE.LineBasicMaterial({ color: 0x4c6085, transparent: true, opacity: 0.45 });
    activeLines = new THREE.LineSegments(tGeo, tMat);
    pathGroup.add(activeLines);
  }
}

function buildToolpathMesh(renderData, analysis) {
  clearGroup(pathGroup);
  activeLines = null;
  activeSolidMesh = null;
  activeTotalIndices = 0;
  nozzleMesh.visible = false;

  if (!renderData || renderData.count === 0) return;

  buildGhostMesh(state.ghostRenderData);
  buildContinuousTubeMesh(renderData, analysis, state.viewMode === "render");
  updatePlaybackDrawRange();
}

function syncScrubVisuals() {
  const pct = Math.max(0, Math.min(100, state.playbackRatio * 100));
  if ($("scrubFill")) $("scrubFill").style.width = `${pct.toFixed(3)}%`;
  if ($("scrubThumb")) $("scrubThumb").style.left = `${pct.toFixed(3)}%`;
}

function updatePlaybackDrawRange() {
  syncScrubVisuals();
  if (!state.renderData || state.renderData.count === 0) return;
  const totalSegs = state.renderData.count;
  const shown = Math.max(1, Math.min(totalSegs, Math.round(totalSegs * state.playbackRatio)));

  if (activeSolidMesh && activeTotalIndices > 0) {
    // Round drawCount to a multiple of 3 (full triangles)
    const rawCount = Math.round(activeTotalIndices * state.playbackRatio);
    const triCount = Math.max(3, Math.min(activeTotalIndices, rawCount - (rawCount % 3)));
    activeSolidMesh.geometry.setDrawRange(0, triCount);
  }

  const lastIdx = Math.max(0, shown - 1);
  const o6 = lastIdx * 6;
  const coords = state.renderData.coords;
  const p = toThree(coords[o6 + 3], coords[o6 + 4], coords[o6 + 5]);
  nozzleMesh.position.set(p.x, p.y + 4.2, p.z);
  nozzleMesh.visible = state.playbackRatio < 0.999 || state.playing;

  const zVal = coords[o6 + 5] || 0;
  $("playbackInfo").textContent = `${(state.playbackRatio * 100).toFixed(1)}% · Z ${zVal.toFixed(1)} mm`;
}

function resetCamera() {
  const b = state.analysis && state.analysis.bounds;
  const h = b ? Math.max(40, b.max_z) : 120;
  const r = b ? Math.max(25, b.max_r || 45) : 60;
  const dist = Math.max(h * 1.45, r * 3.1, 115);
  camera.position.set(dist * 0.85, h * 0.85 + 35, dist * 0.95);
  controls.target.set(0, h * 0.48, 0);
  controls.update();
}

function resizeViewport() {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 480;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener("resize", resizeViewport);

function animate() {
  requestAnimationFrame(animate);
  if (state.playing && state.renderData && state.renderData.count > 0) {
    state.playbackRatio += 0.004;
    if (state.playbackRatio >= 1.0) {
      state.playbackRatio = 1.0;
      state.playing = false;
      $("btnPlay").textContent = "▶ Play";
    }
    updatePlaybackDrawRange();
  }
  controls.update();
  renderer.render(scene, camera);
}

// ============================================================================
// UI SYNC & API CALLS
// ============================================================================
function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function renderAnalysisUI(analysis) {
  if (!analysis) return;
  const st = analysis.stats;
  const b = analysis.bounds;

  $("stTime").textContent = formatDuration(st.est_time_s);
  if ($("stLayerTime")) {
    const lt = st.avg_layer_time_s || 0;
    $("stLayerTime").textContent = `${lt.toFixed(1)} s`;
  }
  $("stMat").textContent = st.material_label;
  $("stSlope").textContent = `${st.max_slope_deg}° / ${st.angle_limit_deg}°`;
  $("stSlope").style.color = st.collision_count > 0 ? "var(--err)" : "var(--ok)";
  $("stOoze").textContent = `${st.ooze_count}`;
  $("stHeight").textContent = `${b.min_z}–${b.max_z} mm`;
  if ($("stSegs")) $("stSegs").textContent = `${st.extruding_count.toLocaleString("de-DE")}`;
  updateShrinkageDimensions(b);

  const list = $("checksList");
  list.innerHTML = "";
  for (const ch of analysis.checks) {
    const div = document.createElement("div");
    div.className = `check-item ${ch.level}`;
    const icon = ch.level === "ok" ? "✓ " : ch.level === "warn" ? "⚠ " : "✕ ";
    const strong = document.createElement("strong");
    strong.textContent = icon + ch.title;
    const p = document.createElement("div");
    p.textContent = ch.detail;
    div.append(strong, p);
    list.appendChild(div);
  }
}

function selectProfile(profileId, applyDefaults = true) {
  const prof = state.profiles[profileId];
  if (!prof) return;
  state.activeProfileId = profileId;

  // Rebuild nozzle preset chips
  const presetsEl = $("nozzlePresets");
  presetsEl.innerHTML = "";
  for (const n of prof.nozzle_presets_mm || [1.5, 2.0, 3.0, 4.0]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = `${n}`;
    b.onclick = () => {
      $("inNozzle").value = n;
      $("valNozzle").textContent = `${n} mm`;
      $("inLineW").value = (n * 1.15).toFixed(2);
      $("inLayerH").value = (n * 0.6).toFixed(2);
      updateOozeEveryLabel();
      updatePrinterSummaryBadge();
      scheduleLiveUpdate(true);
    };
    presetsEl.appendChild(b);
  }

  if (applyDefaults) {
    $("inNozzle").value = prof.default_nozzle_mm;
    $("valNozzle").textContent = `${prof.default_nozzle_mm} mm`;
    $("inLayerH").value = prof.default_layer_height_mm;
    $("inLineW").value = prof.default_line_width_mm;
    $("inSpeed").value = prof.default_speed_f;
    $("inMaxAngle").value = prof.max_nozzle_angle_deg;
    if ($("inNozzleTemp") && prof.default_nozzle_temp_c) $("inNozzleTemp").value = prof.default_nozzle_temp_c;
    if ($("inBedTemp") && prof.default_bed_temp_c !== undefined) $("inBedTemp").value = prof.default_bed_temp_c;
    if ($("inFanPct") && prof.default_fan_pct !== undefined) $("inFanPct").value = prof.default_fan_pct;
    if ($("inBedAdhesion")) {
      $("inBedAdhesion").value = prof.heated ? "brim" : "none";
      if ($("wrapBrimWidth")) $("wrapBrimWidth").style.display = prof.heated ? "flex" : "none";
    }
    $("oozeEvery").value = prof.heated ? 8 : 4;
    updateOozeEveryLabel();
  }

  if ($("printerSelect")) $("printerSelect").value = profileId;
  if ($("fdmTempsRow")) $("fdmTempsRow").style.display = prof.heated ? "flex" : "none";
  updatePrinterSummaryBadge();

  buildPrinterBed(prof);
  if (state.renderData) buildToolpathMesh(state.renderData, state.analysis);
}

let _editorSyncTimer = null;

function syncGcodeEditorIfOpen() {
  const ed = $("gcodeEditor");
  if (!ed) return;
  const card = ed.closest(".card.collapsible");
  if (card && card.classList.contains("collapsed")) return; // Lazy: don't build 10MB string while editor is collapsed!
  if (!state.currentGcode && typeof state.buildCurrentGcode === "function") {
    state.currentGcode = state.buildCurrentGcode();
  }
  const gc = state.currentGcode || "";
  ed.value = gc.length > 400000
    ? gc.slice(0, 400000) + "\n; ... [Ansicht gekuerzt – vollstaendige Datei wird exportiert]"
    : gc;
}

function loadResultIntoView(filename, gcodeOrBuilder, renderData, analysis, updateSource = true, deferEditor = false, ghostOverride = null) {
  state.filename = filename;
  if (typeof gcodeOrBuilder === "function") {
    state.buildCurrentGcode = gcodeOrBuilder;
    state.currentGcode = ""; // Lazily built only when saving or opening editor!
  } else {
    state.buildCurrentGcode = null;
    state.currentGcode = String(gcodeOrBuilder || "");
    if (updateSource) state.sourceGcode = state.currentGcode;
  }
  if (updateSource) {
    state.ghostRenderData = renderData; // Keep original unmodified base geometry for ghost overlay
  } else if (ghostOverride) {
    state.ghostRenderData = ghostOverride;
  }
  state.renderData = renderData;
  state.analysis = analysis;

  $("currentFileBadge").textContent = filename;

  clearTimeout(_editorSyncTimer);
  if (deferEditor) {
    _editorSyncTimer = setTimeout(syncGcodeEditorIfOpen, 220);
  } else {
    syncGcodeEditorIfOpen();
  }

  if (analysis && analysis.bounds) {
    const zMax = Math.max(10, Math.round(analysis.bounds.max_z - 4));
    if (updateSource) {
      state.faceAspect = [
        Math.max(1, 0.5 * (analysis.bounds.max_x - analysis.bounds.min_x)),
        Math.max(1, 0.5 * (analysis.bounds.max_y - analysis.bounds.min_y)),
      ];
      $("weaveZMax").value = zMax;
      $("npZMax").value = zMax;
      $("oozeZMax").value = zMax;
      if ($("hmZMax")) $("hmZMax").value = zMax;
    }
  }

  renderAnalysisUI(analysis);
  buildToolpathMesh(renderData, analysis);
}

function analyzeRawGcode(gcode, updateSource = false) {
  const { pts } = parseGcodeToPoints(gcode);
  if (updateSource) {
    state.sourcePoints = pts;
    state.rawGcodePts = pts;
    state.rawGcodeLayerKey = null;
  }
  const res = processToolpath(pts, state.activeProfileId, {
    recenter: false,
    recalc_e: false,
    max_nozzle_angle_deg: Number($("inMaxAngle").value) || 28,
  });
  loadResultIntoView(state.filename, gcode, res.render, res.analysis, updateSource);

  // Loaded spiral G-code with too coarse layers for the current printer (e.g. 1.2 mm clay file on Ender-5 S1)?
  if (updateSource) {
    const lh = Number($("inLayerH").value) || 0.2;
    const noz = Number($("inNozzle").value) || 0.4;
    const test = resampleSpiralPoints(pts, lh, noz);
    if (test) {
      applyProcessing(true);
      showToast(`Schichtabstand ${test.source_gap.toFixed(2)} mm → automatisch auf ${lh.toFixed(2)} mm umgerechnet (${test.layers} Schichten)`);
    }
  }
}

let _liveDebounceTimer = null;

function scheduleLiveUpdate(immediate = false) {
  if (!$("chkLiveUpdate") || !$("chkLiveUpdate").checked) return;
  if (!state.sourcePoints && !state.presetShape) return;
  clearTimeout(_liveDebounceTimer);
  _liveDebounceTimer = setTimeout(() => {
    applyProcessing(true);
  }, immediate ? 5 : 22);
}

function collectCurrentOptions() {
  return {
    preset_shape: state.presetShape,
    include_base: $("chkIncludeBase").checked,
    active_faces: Array.from(state.activeFaces),
    parametric: state.presetShape === "parametric" ? {
      profile_points: state.profilePoints,
      height_mm: Number($("paramH").value) || 120,
      sides: Number($("paramSides").value) || 64,
      corner_round: (Number($("paramRound").value) || 35) / 100.0,
      twist_deg: Number($("paramTwist").value) || 0,
      smooth: $("paramSmooth").checked,
    } : null,
    recenter: true,
    recalc_e: $("chkRecalcE").checked,
    scale_xy: Number($("inScaleXY").value) || 1.0,
    shrinkage_pct: $("inShrinkPct") ? Number($("inShrinkPct").value) || 0 : 0,
    shrinkage_compensate: $("chkShrinkComp") ? $("chkShrinkComp").checked : false,
    nozzle_mm: Number($("inNozzle").value) || 2.0,
    layer_height_mm: Number($("inLayerH").value) || 1.2,
    line_width_mm: Number($("inLineW").value) || 2.2,
    flow_multiplier: Number($("inFlow").value) || 1.0,
    speed_f: Number($("inSpeed").value) || 900,
    max_nozzle_angle_deg: Number($("inMaxAngle").value) || 42,
    nozzle_temp_c: $("inNozzleTemp") ? Number($("inNozzleTemp").value) || 205 : 205,
    bed_temp_c: $("inBedTemp") ? Number($("inBedTemp").value) || 60 : 60,
    fan_pct: $("inFanPct") ? Number($("inFanPct").value) || 80 : 80,
    wall_loops: $("inWallLoops") ? Number($("inWallLoops").value) || 1 : 1,
    bed_adhesion: $("inBedAdhesion") ? $("inBedAdhesion").value : "none",
    brim_width_mm: $("inBrimWidth") ? Number($("inBrimWidth").value) || 6.0 : 6.0,
    weaving: {
      enabled: $("weaveOn").checked,
      waveform: $("weaveWaveform") ? $("weaveWaveform").value : "sine",
      brick_duty: $("weaveBrickDuty") ? (Number($("weaveBrickDuty").value) / 100.0) : 0.50,
      mode: $("weaveMode").value,
      sharpness: Number($("weaveSharp").value),
      freq: Number($("weaveFreq").value),
      phase_shift: Number($("weavePhase").value),
      every_n_layers: $("weaveEvery") ? Number($("weaveEvery").value) || 1 : 1,
      h_amp_mm: Number($("weaveH").value),
      z_min: Number($("weaveZMin").value),
      z_max: Number($("weaveZMax").value),
      fade_mm: 6.0,
    },
    nonplanar: {
      enabled: $("npOn").checked,
      mode: $("npMode") ? $("npMode").value : "waves",
      freq: Number($("npFreq").value),
      phase_shift: Number($("npPhase").value),
      every_n_layers: $("npEvery") ? Number($("npEvery").value) || 1 : 1,
      z_amp_mm: Number($("npZ").value),
      z_min: Number($("npZMin").value),
      z_max: Number($("npZMax").value),
      fade_mm: 6.0,
    },
    oozing: {
      enabled: $("oozeOn").checked,
      curve: $("oozeCurve") ? $("oozeCurve").value : "smooth",
      flow_min: $("oozeFlowMin") ? Number($("oozeFlowMin").value) : 0.2,
      flow_max: $("oozeFlowMax") ? Number($("oozeFlowMax").value) : 2.8,
      width: $("oozeWidth") ? (Number($("oozeWidth").value) / 100.0) : 0.70,
      speed_min: $("oozeSpeedMin") ? (Number($("oozeSpeedMin").value) / 100.0) : 0.45,
      count_per_turn: Number($("oozeCount").value),
      every_n_layers: Number($("oozeEvery").value),
      phase_shift: Number($("oozePhase").value),
      dwell_ms: 0,
      extra_e: 0,
      push_mm: 0,
      z_min: Number($("oozeZMin").value),
      z_max: Number($("oozeZMax").value),
    },
    heightmap: {
      enabled: $("hmOn") ? $("hmOn").checked : false,
      heightmap_id: state.heightmapId,
      depth_mm: $("hmDepth") ? Number($("hmDepth").value) : 2.5,
      repeat_x: $("hmRepX") ? Number($("hmRepX").value) : 2.0,
      repeat_y: $("hmRepY") ? Number($("hmRepY").value) : 1.0,
      invert: $("hmInvert") ? $("hmInvert").checked : false,
      z_min: $("hmZMin") ? Number($("hmZMin").value) : 8,
      z_max: $("hmZMax") ? Number($("hmZMax").value) : 100,
      fade_mm: 5.0,
    },
  };
}

function applyProcessing(isLive = false) {
  const options = collectCurrentOptions();
  let basePts = state.sourcePoints;
  let ghostOverride = null;

  if (state.presetShape) {
    basePts = generateBasePoints(state.presetShape, state.activeProfileId, options);
    state.sourcePoints = basePts;
    if (state.presetShape === "parametric" || options.shrinkage_compensate) {
      // Update ghost shell live when sculpting profile or scaling shrinkage
      ghostOverride = processToolpath(basePts, state.activeProfileId, {
        ...options,
        weaving: { enabled: false },
        nonplanar: { enabled: false },
        oozing: { enabled: false },
        heightmap: { enabled: false },
      }).render;
    }
  } else if (state.uploadedMesh && Math.abs((state.uploadedMesh.lastLayerH || 0) - options.layer_height_mm) > 1e-4) {
    // Auto re-slice uploaded .stl/.obj when switching WASP <-> Ender-5 S1 or changing layer height!
    const { pts } = sliceMeshToBasePoints(state.uploadedMesh.buf, state.uploadedMesh.name, state.activeProfileId, options.layer_height_mm);
    state.uploadedMesh.lastLayerH = options.layer_height_mm;
    state.sourcePoints = pts;
    basePts = pts;
    ghostOverride = processToolpath(basePts, state.activeProfileId, {
      ...options,
      weaving: { enabled: false },
      nonplanar: { enabled: false },
      oozing: { enabled: false },
      heightmap: { enabled: false },
    }).render;
  } else if (state.rawGcodePts) {
    // Loaded .gcode: re-space spiral layers to the current layer height when they don't match
    const key = `${state.activeProfileId}_${options.layer_height_mm}_${options.nozzle_mm}`;
    if (state.rawGcodeLayerKey !== key) {
      const rs = resampleSpiralPoints(state.rawGcodePts, options.layer_height_mm, options.nozzle_mm);
      state.sourcePoints = rs ? rs.pts : state.rawGcodePts;
      state.rawGcodeLayerKey = key;
      basePts = state.sourcePoints;
      ghostOverride = processToolpath(basePts, state.activeProfileId, {
        ...options,
        weaving: { enabled: false },
        nonplanar: { enabled: false },
        oozing: { enabled: false },
        heightmap: { enabled: false },
      }).render;
    }
  }
  if (!basePts || !basePts.length) {
    if (!isLive) showToast("Bitte zuerst eine Vorlage oder Datei laden.");
    return;
  }

  const res = processToolpath(basePts, state.activeProfileId, options);
  loadResultIntoView(state.filename, res.buildGcode, res.render, res.analysis, false, isLive, ghostOverride);
  if (!isLive) showToast(`Aktualisiert (${state.profiles[state.activeProfileId].short_name})`);
}

async function loadFromGrasshopper(silent = false) {
  const res = await fetch("/api/gh-latest");
  if (!res.ok) {
    if (!silent) showToast("Noch keine Datei aus Grasshopper (Data Dam auslösen).");
    return;
  }
  const data = await res.json();
  state.presetShape = null;
  state.uploadedModelId = null;
  state.lastGhMtime = data.mtime;
  loadResultIntoView(data.filename, data.gcode, data.render, data.analysis, true);
  resetCamera();
  showToast("Live-Update aus Grasshopper geladen!");
}

async function pollGrasshopper() {
  try {
    const res = await fetch("/api/gh-status");
    const st = await res.json();
    const pill = $("ghStatusPill");
    if (st.exists) {
      pill.classList.add("live");
      const dt = new Date(st.mtime * 1000).toLocaleTimeString("de-DE");
      $("ghStatusText").textContent = `GH bereit (${dt})`;
      if ($("autoSyncGh").checked && state.lastGhMtime > 0 && st.mtime > state.lastGhMtime) {
        await loadFromGrasshopper(true);
      } else if (state.lastGhMtime === 0) {
        state.lastGhMtime = st.mtime;
      }
    } else {
      pill.classList.remove("live");
      $("ghStatusText").textContent = "GH: noch kein Export";
    }
  } catch (_) {}
}

// ============================================================================
// WIRE EVENTS & INIT
// ============================================================================
function bindRange(inputId, labelId, fmt = (v) => v) {
  const el = $(inputId);
  const out = $(labelId);
  const sync = () => {
    out.textContent = fmt(el.value);
    scheduleLiveUpdate(false);
  };
  el.addEventListener("input", sync);
  out.textContent = fmt(el.value);
}

function updateOozeEveryLabel() {
  const lh = Number($("inLayerH").value) || 0.24;
  const n = Number($("oozeEvery").value) || 1;
  $("valOozeEvery").textContent = `${n} (${(n * lh).toFixed(1)} mm)`;
  if ($("weaveEvery") && $("valWeaveEvery")) {
    const nw = Number($("weaveEvery").value) || 1;
    $("valWeaveEvery").textContent = nw === 1 ? "Jede (1)" : `${nw} (${(nw * lh).toFixed(1)} mm)`;
  }
  if ($("npEvery") && $("valNpEvery")) {
    const nn = Number($("npEvery").value) || 1;
    $("valNpEvery").textContent = nn === 1 ? "Jede (1)" : `${nn} (${(nn * lh).toFixed(1)} mm)`;
  }
}

bindRange("inFlow", "valFlow", (v) => `${Number(v).toFixed(2)}×`);
bindRange("weaveSharp", "valWeaveSharp", (v) => Number(v).toFixed(1));
if ($("weaveBrickDuty")) bindRange("weaveBrickDuty", "valBrickDuty", (v) => `${v}%`);
bindRange("weaveFreq", "valWeaveFreq");
bindRange("weavePhase", "valWeavePhase", (v) => Number(v).toFixed(2));
bindRange("weaveH", "valWeaveH", (v) => Number(v).toFixed(1));
bindRange("npFreq", "valNpFreq");
bindRange("npPhase", "valNpPhase", (v) => Number(v).toFixed(2));
bindRange("npZ", "valNpZ", (v) => Number(v).toFixed(1));
bindRange("oozeCount", "valOozeCount");
$("oozeEvery").addEventListener("input", () => {
  updateOozeEveryLabel();
  scheduleLiveUpdate(false);
});
["weaveEvery", "npEvery"].forEach((id) => {
  if ($(id)) {
    $(id).addEventListener("input", () => {
      updateOozeEveryLabel();
      scheduleLiveUpdate(false);
    });
  }
});
$("inLayerH").addEventListener("input", () => {
  updateOozeEveryLabel();
  scheduleLiveUpdate(false);
});
updateOozeEveryLabel();
bindRange("oozePhase", "valOozePhase", (v) => Number(v).toFixed(2));
if ($("oozeFlowMin")) bindRange("oozeFlowMin", "valOozeFlowMin", (v) => `${Number(v).toFixed(2)}×`);
if ($("oozeFlowMax")) bindRange("oozeFlowMax", "valOozeFlowMax", (v) => `${Number(v).toFixed(2)}×`);
if ($("oozeWidth")) bindRange("oozeWidth", "valOozeWidth", (v) => `${v}%`);
if ($("oozeSpeedMin")) bindRange("oozeSpeedMin", "valOozeSpeedMin", (v) => `${v}%`);
if ($("oozePush")) bindRange("oozePush", "valOozePush", (v) => Number(v).toFixed(1));

// Show Brick-Breite slider specifically when Brick (square) waveform is selected
function syncWeaveWaveformUI() {
  const isBrick = $("weaveWaveform") && $("weaveWaveform").value === "square";
  if ($("wrapBrickDuty")) $("wrapBrickDuty").style.display = isBrick ? "flex" : "none";
  if ($("wrapWeaveSharp")) $("wrapWeaveSharp").style.display = isBrick ? "none" : "flex";
}
if ($("weaveWaveform")) {
  $("weaveWaveform").addEventListener("change", syncWeaveWaveformUI);
  syncWeaveWaveformUI();
}
if ($("oozeCurve")) {
  $("oozeCurve").addEventListener("change", () => scheduleLiveUpdate(true));
}

$("inNozzle").addEventListener("input", (e) => {
  $("valNozzle").textContent = `${e.target.value} mm`;
  scheduleLiveUpdate(false);
});

function updateShrinkageDimensions(bounds) {
  const b = bounds || (state.analysis && state.analysis.bounds);
  const pct = $("inShrinkPct") ? (Number($("inShrinkPct").value) || 0) : 0;
  const compOn = $("chkShrinkComp") ? $("chkShrinkComp").checked : false;
  const keep = Math.max(0.75, 1.0 - pct / 100.0);
  const compFactor = 1.0 / keep;

  if ($("valShrinkPct")) $("valShrinkPct").textContent = `${pct.toFixed(1)}%`;
  if ($("valShrinkFactor")) $("valShrinkFactor").textContent = `×${compFactor.toFixed(3)}`;
  if ($("shrinkBadge")) $("shrinkBadge").textContent = compOn ? `${pct.toFixed(1)}% · Kompensiert` : `${pct.toFixed(1)}%`;

  document.querySelectorAll("[data-shrink]").forEach((btn) => {
    btn.classList.toggle("active", Math.abs(Number(btn.dataset.shrink) - pct) < 0.05);
  });

  if (!b) return;
  const wWet = Math.max(0, (b.max_x || 0) - (b.min_x || 0));
  const dWet = Math.max(0, (b.max_y || 0) - (b.min_y || 0));
  const hWet = Math.max(0, (b.max_z || 0) - Math.min(0, b.min_z || 0));
  const diamWet = 0.5 * (wWet + dWet);

  const diamFired = diamWet * keep;
  const hFired = hWet * keep;

  if ($("stDimWet")) $("stDimWet").textContent = `Ø ${diamWet.toFixed(1)} × H ${hWet.toFixed(1)} mm`;
  if ($("stDimFired")) $("stDimFired").textContent = `Ø ${diamFired.toFixed(1)} × H ${hFired.toFixed(1)} mm`;
}

if ($("inShrinkPct")) {
  $("inShrinkPct").addEventListener("input", () => {
    updateShrinkageDimensions();
    if ($("chkShrinkComp") && $("chkShrinkComp").checked) scheduleLiveUpdate(false);
  });
}
if ($("chkShrinkComp")) {
  $("chkShrinkComp").addEventListener("change", () => {
    updateShrinkageDimensions();
    scheduleLiveUpdate(true);
  });
}
document.querySelectorAll("[data-shrink]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if ($("inShrinkPct")) $("inShrinkPct").value = btn.dataset.shrink;
    updateShrinkageDimensions();
    if ($("chkShrinkComp") && $("chkShrinkComp").checked) scheduleLiveUpdate(true);
  });
});
updateShrinkageDimensions();

// Wire live updates to all numeric inputs & toggles
[
  "inLineW", "inSpeed", "inScaleXY", "inMaxAngle",
  "weaveZMin", "weaveZMax", "npZMin", "npZMax", "oozeZMin", "oozeZMax", "hmZMin", "hmZMax",
].forEach((id) => {
  if ($(id)) $(id).addEventListener("input", () => scheduleLiveUpdate(false));
});

[
  "chkRecalcE", "chkIncludeBase", "inWallLoops", "inBedAdhesion", "weaveOn", "weaveWaveform", "weaveMode", "npOn", "npMode", "oozeOn", "hmOn", "hmInvert",
].forEach((id) => {
  if ($(id)) $(id).addEventListener("change", () => scheduleLiveUpdate(true));
});

if ($("inBedAdhesion")) {
  $("inBedAdhesion").addEventListener("change", () => {
    if ($("wrapBrimWidth")) $("wrapBrimWidth").style.display = $("inBedAdhesion").value === "none" ? "none" : "flex";
  });
}
if ($("inBrimWidth")) bindRange("inBrimWidth", "valBrimWidth", (v) => `${Number(v).toFixed(1)} mm`);

if ($("hmDepth")) bindRange("hmDepth", "valHmDepth", (v) => Number(v).toFixed(1));
if ($("hmRepX")) bindRange("hmRepX", "valHmRepX", (v) => `${Number(v).toFixed(1)}×`);
if ($("hmRepY")) bindRange("hmRepY", "valHmRepY", (v) => `${Number(v).toFixed(1)}×`);

// Image-Heightmap upload + procedural pattern buttons (100% browser Canvas!)
if ($("btnHmUpload") && $("hmFileInput")) {
  $("btnHmUpload").onclick = () => $("hmFileInput").click();
  $("hmFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await registerHeightmapFile(file);
      state.heightmapId = data.heightmap_id;
      $("hmStatusBadge").textContent = `${data.name.slice(0, 14)}`;
      $("hmOn").checked = true;
      scheduleLiveUpdate(true);
      showToast(`Heightmap geladen: ${data.name} (${data.width}×${data.height})`);
    } catch (err) {
      showToast(`Fehler: ${err.message || err}`);
    }
  });
}

document.querySelectorAll("[data-hm-proc]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.hmProc;
    const data = registerProceduralHeightmap(kind);
    state.heightmapId = data.heightmap_id;
    $("hmStatusBadge").textContent = btn.textContent;
    $("hmOn").checked = true;
    scheduleLiveUpdate(true);
    showToast(`Relief-Muster aktiv: ${btn.textContent}`);
  });
});

// Interactive 2D Profile Curve Editor (A-E handles + Sides + Rounding + Twist)
(function setupProfileEditor() {
  const canvas = $("profileCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const PAD_X = 24;
  const PAD_Y = 16;
  const CX = W * 0.5;
  const MAX_R = 88; // mm
  const SCALE_X = (CX - PAD_X) / MAX_R;
  const LABELS = ["E", "D", "C", "B", "A"]; // E=Foot .. A=Rim

  const PROFILE_PRESETS = {
    cylinder:  [[38, 0.0], [38, 0.25], [38, 0.50], [38, 0.75], [38, 1.0]],
    amphora:   [[32, 0.0], [52, 0.28], [50, 0.52], [30, 0.80], [38, 1.0]],
    chalice:   [[26, 0.0], [22, 0.25], [34, 0.52], [50, 0.78], [56, 1.0]],
    hourglass: [[44, 0.0], [34, 0.25], [24, 0.50], [36, 0.75], [48, 1.0]],
  };

  function toCanvas(r, zNorm) {
    return {
      xR: CX + r * SCALE_X,
      xL: CX - r * SCALE_X,
      y: H - PAD_Y - zNorm * (H - PAD_Y * 2),
    };
  }

  function updateParamBadge() {
    const badge = $("paramBadge");
    if (!badge) return;
    const h = Number($("paramH").value) || 120;
    const maxR = Math.max(...state.profilePoints.map((p) => p[0]));
    const sides = Number($("paramSides").value) || 64;
    badge.textContent = `H${h} · Ø${Math.round(maxR * 2)}${sides < 48 ? ` · ${sides}K` : ""}`;
  }

  function drawProfile() {
    ctx.clearRect(0, 0, W, H);
    // Subtle architectural grid
    ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
    ctx.lineWidth = 1;
    for (let r = 20; r <= 80; r += 20) {
      const dx = r * SCALE_X;
      ctx.beginPath(); ctx.moveTo(CX + dx, PAD_Y); ctx.lineTo(CX + dx, H - PAD_Y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(CX - dx, PAD_Y); ctx.lineTo(CX - dx, H - PAD_Y); ctx.stroke();
    }
    for (let i = 0; i <= 4; i++) {
      const y = H - PAD_Y - (i / 4) * (H - PAD_Y * 2);
      ctx.beginPath(); ctx.moveTo(PAD_X, y); ctx.lineTo(W - PAD_X, y); ctx.stroke();
    }
    // Center symmetry axis
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.30)";
    ctx.beginPath(); ctx.moveTo(CX, 8); ctx.lineTo(CX, H - 8); ctx.stroke();
    ctx.setLineDash([]);

    const pts = state.profilePoints;
    const smooth = $("paramSmooth").checked;
    const sampleR = (v) => {
      let idx = 0;
      for (let i = 0; i < pts.length - 1; i++) if (v >= pts[i][1]) idx = i;
      idx = Math.min(idx, pts.length - 2);
      const z0 = pts[idx][1], z1 = pts[idx + 1][1];
      const t = Math.max(0, Math.min(1, (v - z0) / Math.max(1e-5, z1 - z0)));
      const r1 = pts[idx][0], r2 = pts[idx + 1][0];
      if (!smooth || pts.length < 3) return r1 + t * (r2 - r1);
      const r0 = pts[Math.max(0, idx - 1)][0];
      const r3 = pts[Math.min(pts.length - 1, idx + 2)][0];
      const t2 = t * t, t3 = t2 * t;
      return Math.max(8, Math.min(MAX_R, 0.5 * ((2 * r1) + (-r0 + r2) * t + (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 + (-r0 + 3 * r1 - 3 * r2 + r3) * t3)));
    };

    // Filled vessel silhouette
    const N = 48;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const v = i / N;
      const p = toCanvas(sampleR(v), v);
      if (i === 0) ctx.moveTo(p.xR, p.y); else ctx.lineTo(p.xR, p.y);
    }
    for (let i = N; i >= 0; i--) {
      const v = i / N;
      const p = toCanvas(sampleR(v), v);
      ctx.lineTo(p.xL, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(232, 132, 76, 0.16)";
    ctx.fill();

    // Left mirrored outline (muted) + Right interactive curve (accent)
    ctx.strokeStyle = "rgba(148, 163, 184, 0.45)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const v = i / N;
      const p = toCanvas(sampleR(v), v);
      if (i === 0) ctx.moveTo(p.xL, p.y); else ctx.lineTo(p.xL, p.y);
    }
    ctx.stroke();

    ctx.strokeStyle = "#e8844c";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const v = i / N;
      const p = toCanvas(sampleR(v), v);
      if (i === 0) ctx.moveTo(p.xR, p.y); else ctx.lineTo(p.xR, p.y);
    }
    ctx.stroke();

    // Draggable control handles A-E on right side
    pts.forEach((pt, idx) => {
      const c = toCanvas(pt[0], pt[1]);
      ctx.beginPath();
      ctx.arc(c.xR, c.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = idx === draggingIdx ? "#ffffff" : "#e8844c";
      ctx.fill();
      ctx.strokeStyle = "#0d1118";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#cbd5e1";
      ctx.font = "600 10px Inter, sans-serif";
      ctx.fillText(`${LABELS[idx] || idx} ${Math.round(pt[0])}`, c.xR + 9, c.y + 3);
    });
    updateParamBadge();
  }

  function ensureParametricActive() {
    if (state.presetShape !== "parametric") {
      state.presetShape = "parametric";
      state.uploadedModelId = null;
      state.filename = "eigene_form_wasp_2040_clay.gcode";
      $("presetSelect").value = "parametric";
      $("currentFileBadge").textContent = "Eigene Form";
    }
  }

  let draggingIdx = -1;
  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height),
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    const pos = getCanvasPos(e);
    let best = -1, bestD = 18;
    state.profilePoints.forEach((pt, idx) => {
      const c = toCanvas(pt[0], pt[1]);
      const d = Math.hypot(pos.x - c.xR, pos.y - c.y);
      if (d < bestD) { bestD = d; best = idx; }
    });
    if (best >= 0) {
      draggingIdx = best;
      canvas.setPointerCapture(e.pointerId);
      ensureParametricActive();
      drawProfile();
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (draggingIdx < 0) return;
    const pos = getCanvasPos(e);
    const rMm = Math.max(12, Math.min(MAX_R, Math.round((pos.x - CX) / SCALE_X)));
    state.profilePoints[draggingIdx][0] = rMm;
    // Allow subtle vertical nudging for interior points B, C, D
    if (draggingIdx > 0 && draggingIdx < state.profilePoints.length - 1) {
      const zMin = state.profilePoints[draggingIdx - 1][1] + 0.08;
      const zMax = state.profilePoints[draggingIdx + 1][1] - 0.08;
      const zNorm = (H - PAD_Y - pos.y) / (H - PAD_Y * 2);
      state.profilePoints[draggingIdx][1] = Math.max(zMin, Math.min(zMax, Number(zNorm.toFixed(2))));
    }
    drawProfile();
    scheduleLiveUpdate(false);
  });

  const endDrag = (e) => {
    if (draggingIdx < 0) return;
    draggingIdx = -1;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    drawProfile();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  const onParamControl = (immediate = false) => {
    ensureParametricActive();
    if ($("valParamH")) $("valParamH").textContent = $("paramH").value;
    if ($("valParamSides")) $("valParamSides").textContent = Number($("paramSides").value) >= 48 ? "Rund" : $("paramSides").value;
    if ($("valParamRound")) $("valParamRound").textContent = `${$("paramRound").value}%`;
    if ($("valParamTwist")) $("valParamTwist").textContent = `${$("paramTwist").value}°`;
    const hVal = Number($("paramH").value) || 120;
    const zMax = Math.max(15, Math.round(hVal - 5));
    $("weaveZMax").value = zMax;
    $("npZMax").value = zMax;
    $("oozeZMax").value = zMax;
    if ($("hmZMax")) $("hmZMax").value = zMax;
    drawProfile();
    scheduleLiveUpdate(immediate);
  };

  ["paramH", "paramSides", "paramRound", "paramTwist"].forEach((id) => {
    if ($(id)) $(id).addEventListener("input", () => onParamControl(false));
  });
  if ($("paramSmooth")) $("paramSmooth").addEventListener("change", () => onParamControl(true));

  document.querySelectorAll("[data-prof]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = PROFILE_PRESETS[btn.dataset.prof];
      if (!p) return;
      state.profilePoints = p.map(([r, z]) => [r, z]);
      ensureParametricActive();
      drawProfile();
      scheduleLiveUpdate(true);
    });
  });

  drawProfile();
})();

$("btnApplyProcess").onclick = () => applyProcessing(false);
$("btnResetCam").onclick = resetCamera;

function syncFaceMaskUI() {
  const faces = state.activeFaces;
  document.querySelectorAll(".face-btn[data-face]").forEach((btn) => {
    btn.classList.toggle("active", faces.has(btn.dataset.face));
  });
  const isAll = faces.size === 4;
  const isFrontOnly = faces.size === 1 && faces.has("front");
  const isFrontBack = faces.size === 2 && faces.has("front") && faces.has("back");
  if ($("btnFaceAll")) $("btnFaceAll").classList.toggle("active", isAll);
  if ($("btnFaceFrontOnly")) $("btnFaceFrontOnly").classList.toggle("active", isFrontOnly);
  if ($("btnFaceFrontBack")) $("btnFaceFrontBack").classList.toggle("active", isFrontBack);

  const badge = $("faceMaskBadge");
  if (badge) {
    if (isAll) badge.textContent = "Alle 4";
    else if (faces.size === 0) badge.textContent = "Keine (glatt)";
    else badge.textContent = Array.from(faces).map((f) => FACE_LABELS[f] || f).join(" + ");
  }
}

function setActiveFaces(list, triggerUpdate = true) {
  state.activeFaces = new Set(list);
  syncFaceMaskUI();
  if (state.ghostRenderData) buildGhostMesh(state.ghostRenderData);
  if (triggerUpdate) scheduleLiveUpdate(true);
}

function toggleFace(face, announce = false) {
  if (state.activeFaces.has(face)) {
    state.activeFaces.delete(face);
  } else {
    state.activeFaces.add(face);
  }
  syncFaceMaskUI();
  if (state.ghostRenderData) buildGhostMesh(state.ghostRenderData);
  scheduleLiveUpdate(true);
  if (announce) {
    const on = state.activeFaces.has(face);
    const activeNames = state.activeFaces.size
      ? Array.from(state.activeFaces).map((f) => FACE_LABELS[f]).join(", ")
      : "keine (alle glatt)";
    showToast(`Wand ${FACE_LABELS[face]} ${on ? "aktiviert" : "deaktiviert"} · Aktiv: ${activeNames}`);
  }
}

document.querySelectorAll(".face-btn[data-face]").forEach((btn) => {
  btn.addEventListener("click", () => toggleFace(btn.dataset.face, false));
});
if ($("btnFaceFrontOnly")) $("btnFaceFrontOnly").onclick = () => setActiveFaces(["front"], true);
if ($("btnFaceFrontBack")) $("btnFaceFrontBack").onclick = () => setActiveFaces(["front", "back"], true);
if ($("btnFaceAll")) $("btnFaceAll").onclick = () => setActiveFaces(["front", "right", "back", "left"], true);
syncFaceMaskUI();

// Direct 3D viewport click-to-toggle on ghosted wall surface (ignores drags/orbits)
(function setup3DFacePicking() {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0, downY = 0, downBtn = -1;

  renderer.domElement.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
    downBtn = e.button;
  });

  renderer.domElement.addEventListener("pointerup", (e) => {
    if (downBtn !== 0 || e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;

    let targets = ghostGroup.children.filter((ch) => ch.userData && ch.userData.isGhostSurface);
    if (!targets.length && activeSolidMesh) targets = [activeSolidMesh];
    if (!targets.length) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      const pt = hits[0].point;
      // Ghost mesh vertices are stored in Three.js as (px, pz, -py)
      const face = getFaceFromPrinterXY(pt.x, -pt.z);
      toggleFace(face, true);
    }
  });
})();

function loadPresetShape(shape) {
  state.presetShape = shape;
  state.uploadedModelId = null;
  state.uploadedMesh = null;
  state.rawGcodePts = null;
  if (shape === "parametric" && $("cardParametric")) {
    $("cardParametric").classList.remove("collapsed");
  }
  if (shape === "square_vase") {
    if ($("cardFaceMask")) $("cardFaceMask").classList.remove("collapsed");
    setActiveFaces(["front"], false);
    if (!$("weaveOn").checked && !$("npOn").checked && !$("oozeOn").checked) {
      $("weaveOn").checked = true;
      if ($("cardWeave")) $("cardWeave").classList.remove("collapsed");
    }
  } else {
    setActiveFaces(["front", "right", "back", "left"], false);
  }

  const names = {
    espresso: "espressotasse",
    tumbler: "becher_tumbler",
    vase: "bauchige_vase",
    lampshade: "lampenschirm",
    square_vase: "viereckige_vase",
    parametric: "eigene_form",
  };
  const fname = `${names[shape] || shape}.gcode`;
  const opts = collectCurrentOptions();
  const basePts = generateBasePoints(shape, state.activeProfileId, opts);
  state.sourcePoints = basePts;

  const baseRes = processToolpath(basePts, state.activeProfileId, {
    ...opts,
    weaving: { enabled: false },
    nonplanar: { enabled: false },
    oozing: { enabled: false },
    heightmap: { enabled: false },
  });
  loadResultIntoView(fname, baseRes.buildGcode, baseRes.render, baseRes.analysis, true);

  if (shape === "parametric" || $("weaveOn").checked || $("npOn").checked || $("oozeOn").checked || ($("hmOn") && $("hmOn").checked)) {
    applyProcessing(true);
  }
  resetCamera();
  const label = $("presetSelect").options[$("presetSelect").selectedIndex]?.text || shape;
  showToast(shape === "square_vase"
    ? `Vorlage geladen: ${label} (Muster nur auf Vorne – klicke beliebige Wand im 3D!)`
    : `Vorlage geladen: ${label}`);
}

$("presetSelect").addEventListener("change", (e) => {
  loadPresetShape(e.target.value);
});

$("btnReanalyzeEditor").onclick = () => {
  const txt = $("gcodeEditor").value;
  if (txt.trim()) {
    state.presetShape = null;
    state.uploadedModelId = null;
    analyzeRawGcode(txt, true);
    showToast("Editor-G-Code neu geprüft!");
  }
};

$("btnSaveGcode").onclick = async () => {
  if (!state.currentGcode && typeof state.buildCurrentGcode === "function") {
    state.currentGcode = state.buildCurrentGcode();
  }
  if (!state.currentGcode) return;
  const base = state.filename.replace(/\.(gcode|gco|3dm|stl|obj|3mf|ply)$/i, "");
  const suffix = state.activeProfileId === "ender_5_s1" ? "ender5s1" : "wasp2040";
  const suggested = `${base}_${suffix}.gcode`;

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{
          description: "G-Code Datei",
          accept: { "text/plain": [".gcode", ".gco"] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(state.currentGcode);
      await writable.close();
      showToast(`Gespeichert: ${handle.name}`);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  // Fallback for browsers without showSaveFilePicker
  const chosen = window.prompt("Dateiname für den G-Code:", suggested);
  if (!chosen) return;
  const fname = chosen.toLowerCase().endsWith(".gcode") ? chosen : `${chosen}.gcode`;
  const blob = new Blob([state.currentGcode], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`Download gestartet: ${fname}`);
};

// Drag & drop + file picker
const dz = $("dropzone");
dz.onclick = () => $("fileInput").click();
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) readLocalFile(file);
});
$("fileInput").addEventListener("change", (e) => {
  if (e.target.files[0]) readLocalFile(e.target.files[0]);
});

async function readLocalFile(file) {
  const name = file.name || "upload";
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const is3d = [".3dm", ".stl", ".obj", ".3mf", ".ply"].includes(ext);

  if (is3d) {
    showToast(`Importiere & slice 3D-Modell (${name})…`);
    try {
      const buf = await file.arrayBuffer();
      const lh = Number($("inLayerH").value) || 1.2;
      if (ext === ".stl" || ext === ".obj") {
        // 100% client-side fast spiral slicer (works offline & on GitHub Pages!)
        const { pts, sliced_layers } = sliceMeshToBasePoints(buf, name, state.activeProfileId, lh);
        state.presetShape = null;
        state.uploadedModelId = null;
        state.uploadedMesh = { buf, name, lastLayerH: lh };
        state.rawGcodePts = null;
        state.sourcePoints = pts;
        const baseRes = processToolpath(pts, state.activeProfileId, {
          ...collectCurrentOptions(),
          weaving: { enabled: false },
          nonplanar: { enabled: false },
          oozing: { enabled: false },
          heightmap: { enabled: false },
        });
        loadResultIntoView(name, baseRes.buildGcode, baseRes.render, baseRes.analysis, true);
        if ($("weaveOn").checked || $("npOn").checked || $("oozeOn").checked || ($("hmOn") && $("hmOn").checked)) {
          applyProcessing(true);
        }
        resetCamera();
        showToast(`3D importiert: ${name} (${sliced_layers} Schichten)`);
        return;
      }
      // Fallback for .3dm/.3mf/.ply if running with local Python backend
      const lw = Number($("inLineW").value) || 2.2;
      const baseFlag = $("chkIncludeBase").checked ? "1" : "0";
      const url = `/api/import-model?profile=${encodeURIComponent(state.activeProfileId)}&layer_h=${lh}&line_w=${lw}&base=${baseFlag}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(name),
        },
        body: buf,
      });
      if (!res.ok) {
        showToast(`${ext} benötigt lokalen Python-Server – Tipp: in Rhino kurz als .stl oder .obj exportieren!`);
        return;
      }
      const data = await res.json();
      state.presetShape = null;
      state.uploadedModelId = data.model_id;
      const { pts } = parseGcodeToPoints(data.gcode);
      state.sourcePoints = pts;
      loadResultIntoView(data.filename, data.gcode, data.render, data.analysis, true);
      resetCamera();
      const mi = data.model_info || {};
      showToast(`3D importiert: ${name} (${mi.sliced_layers || "?"} Layer)`);
    } catch (err) {
      showToast(`${ext === ".3dm" ? "Rhino .3dm bitte als .stl oder .obj exportieren" : `3D-Import Fehler: ${err.message || err}`}`);
    }
    return;
  }

  // G-Code file
  const mb = (file.size / (1024 * 1024)).toFixed(1);
  showToast(`Lade & analysiere ${name} (${mb} MB)…`);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      state.presetShape = null;
      state.uploadedModelId = null;
      state.filename = name;
      await analyzeRawGcode(String(reader.result || ""), true);
      resetCamera();
      showToast(`Geladen: ${name}`);
    } catch (err) {
      showToast(`Fehler beim Laden: ${err.message || err}`);
    }
  };
  reader.readAsText(file);
}

function updatePrinterSummaryBadge() {
  const el = $("printerSummaryBadge");
  if (!el) return;
  const n = Number($("inNozzle").value) || 2.0;
  const lh = Number($("inLayerH").value) || 1.2;
  const pTag = state.activeProfileId === "ender_5_s1" ? "Ender-5 S1" : "WASP";
  el.textContent = `${pTag} · ${n.toFixed(1)} mm · LH ${lh.toFixed(2)}`;
}

if ($("printerSelect")) {
  $("printerSelect").addEventListener("change", (e) => {
    selectProfile(e.target.value, true);
    scheduleLiveUpdate(true);
    const prof = state.profiles[e.target.value];
    if (prof) showToast(`Drucker gewechselt: ${prof.name}`);
  });
}
["inNozzleTemp", "inBedTemp", "inFanPct"].forEach((id) => {
  if ($(id)) $(id).addEventListener("input", () => scheduleLiveUpdate(false));
});

// Collapsible module cards (clicking header toggles collapse; interactive controls inside header stay clickable)
document.querySelectorAll(".card.collapsible .card-header").forEach((hdr) => {
  hdr.addEventListener("click", (e) => {
    if (e.target.closest("input, label, button, select")) return;
    const card = hdr.closest(".card");
    card.classList.toggle("collapsed");
    if (!card.classList.contains("collapsed") && card.querySelector("#gcodeEditor")) {
      syncGcodeEditorIfOpen();
    }
  });
});

// Auto-expand any modifier card when its "An" checkbox is switched ON
["weaveOn", "npOn", "oozeOn", "hmOn"].forEach((id) => {
  const chk = $(id);
  if (!chk) return;
  chk.addEventListener("change", () => {
    const card = chk.closest(".card.collapsible");
    if (chk.checked && card) card.classList.remove("collapsed");
  });
});

["inNozzle", "inLayerH", "inSpeed"].forEach((id) => {
  $(id).addEventListener("input", updatePrinterSummaryBadge);
});
updatePrinterSummaryBadge();

// View mode toggle (Rhino/GH Ghosted Toolpath vs. Solid 3D Druck-Render in Terrakotta)
function setViewMode(mode) {
  state.viewMode = mode;
  $("btnViewToolpath").classList.toggle("active", mode === "toolpath");
  $("btnViewRender").classList.toggle("active", mode === "render");
  $("toolpathColorGroup").style.display = mode === "toolpath" ? "flex" : "none";
  $("legendWrap").style.display = mode === "toolpath" ? "flex" : "none";
  const vw = document.querySelector(".viewport-wrap");
  if (vw) vw.classList.toggle("render-bg", mode === "render");
  if (state.profiles[state.activeProfileId]) {
    buildPrinterBed(state.profiles[state.activeProfileId]);
  }
  if (state.renderData) buildToolpathMesh(state.renderData, state.analysis);
}

$("btnViewToolpath").onclick = () => setViewMode("toolpath");
$("btnViewRender").onclick = () => setViewMode("render");

$("btnToggleGhost").onclick = () => {
  state.showGhost = !state.showGhost;
  $("btnToggleGhost").classList.toggle("active", state.showGhost);
  buildGhostMesh(state.ghostRenderData);
};

// Live update bead size in Druck-Render when user changes line width or layer height
["inLineW", "inLayerH"].forEach((id) => {
  $(id).addEventListener("change", () => {
    if (state.viewMode === "render" && state.renderData) {
      buildToolpathMesh(state.renderData, state.analysis);
    }
  });
});

// Color mode buttons
document.querySelectorAll("[data-color]").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("[data-color]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.colorMode = btn.dataset.color;
    if (state.renderData) buildToolpathMesh(state.renderData, state.analysis);
  };
});

// YouTube / iOS-style vertical fine-scrubbing playback track
(function setupFineScrubber() {
  const track = $("scrubTrack");
  const hud = $("scrubHud");
  let scrubbing = false;
  let lastX = 0;
  let baseY = 0;
  let trackWidth = 300;

  function getPrecisionTier(liftPx) {
    if (liftPx < 32)  return { factor: 1.0,   label: "Normal (1×) · ↑ hochziehen = feiner" };
    if (liftPx < 95)  return { factor: 0.2,   label: "Fein (1/5×) · ↑ weiter hoch = noch feiner" };
    if (liftPx < 165) return { factor: 0.04,  label: "Sehr fein (1/25×) · Layer-Modus" };
    return                   { factor: 0.008, label: "Segment-genau (1/125×) · Punkt für Punkt" };
  }

  function updateHud(tier) {
    const total = (state.renderData && state.renderData.count) || 0;
    const curSeg = Math.max(1, Math.round(total * state.playbackRatio));
    hud.textContent = `${tier.label} · Seg ${curSeg.toLocaleString("de-DE")}/${total.toLocaleString("de-DE")}`;
  }

  track.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    trackWidth = Math.max(120, rect.width);
    baseY = rect.top + rect.height * 0.5;
    lastX = e.clientX;
    scrubbing = true;
    state.playing = false;
    $("btnPlay").textContent = "▶ Simulieren";
    track.classList.add("scrubbing");
    track.setPointerCapture(e.pointerId);

    // Jump cleanly to clicked spot on the bar
    state.playbackRatio = Math.max(0.0002, Math.min(1.0, (e.clientX - rect.left) / trackWidth));
    updatePlaybackDrawRange();
    updateHud(getPrecisionTier(0));
  });

  track.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    const liftPx = Math.max(0, baseY - e.clientY);
    const tier = getPrecisionTier(liftPx);
    const deltaRatio = (dx / trackWidth) * tier.factor;
    state.playbackRatio = Math.max(0.0002, Math.min(1.0, state.playbackRatio + deltaRatio));
    updatePlaybackDrawRange();
    updateHud(tier);
  });

  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    track.classList.remove("scrubbing");
    try { track.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  track.addEventListener("pointerup", endScrub);
  track.addEventListener("pointercancel", endScrub);

  // Bonus: Left/Right arrow keys when track is focused step cleanly segment-by-segment
  track.addEventListener("keydown", (e) => {
    const total = (state.renderData && state.renderData.count) || 1000;
    const step = (e.shiftKey ? 20 : 1) / total;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      state.playbackRatio = Math.min(1.0, state.playbackRatio + step);
      updatePlaybackDrawRange();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      state.playbackRatio = Math.max(0.0002, state.playbackRatio - step);
      updatePlaybackDrawRange();
    }
  });
})();

$("btnPlay").onclick = () => {
  state.playing = !state.playing;
  if (state.playing && state.playbackRatio >= 0.999) state.playbackRatio = 0.01;
  $("btnPlay").textContent = state.playing ? "⏸ Pause" : "▶ Simulieren";
};

function init() {
  resizeViewport();
  state.profiles = PRINTER_PROFILES;
  selectProfile("wasp_2040_clay", true);

  // Instant 100% client-side startup (zero server wait!)
  const initialShape = $("presetSelect").value || "espresso";
  loadPresetShape(initialShape);

  animate();
}

init();
