/**
 * KIND Clay Custom G-Code Studio — 100% Client-Side High-Speed Geometry & G-Code Engine
 * Runs natively in V8 (Chrome/Edge/Safari/Firefox) with zero server roundtrips.
 * Supports Delta WASP 2040 Clay (LDM) & Creality Ender-5 S1 (FDM/PLA).
 */

export const PRINTER_PROFILES = {
  wasp_2040_clay: {
    id: "wasp_2040_clay",
    name: "Delta WASP 2040 Clay (LDM)",
    short_name: "WASP 2040 Clay",
    kinematics: "delta",
    bed_shape: "circle",
    bed_diameter_mm: 200.0,
    bed_height_mm: 400.0,
    origin_center: [0.0, 0.0],
    heated: false,
    extrusion_mode: "M83",
    default_nozzle_mm: 2.0,
    nozzle_presets_mm: [1.5, 2.0, 3.0, 4.0],
    default_layer_height_mm: 1.2,
    default_line_width_mm: 2.2,
    default_speed_f: 900.0,
    travel_speed_f: 3000.0,
    ooze_speed_f: 240.0,
    max_nozzle_angle_deg: 42.0,
    clay_e_per_mm_ref: 0.25,
    clay_ref_layer_h: 1.5,
    clay_ref_line_w: 2.0,
    end_gcode: [
      "; --- END DELTA WASP 2040 CLAY ---",
      "G91",
      "G1 E-4.0 F600 ; Druck entlasten",
      "G1 Z15 F1500 ; Sicher abheben",
      "G90",
      "G28 ; Delta Home",
      "M84 ; Motoren aus",
    ].join("\n"),
  },
  ender_5_s1: {
    id: "ender_5_s1",
    name: "Creality Ender-5 S1 (FDM / PLA)",
    short_name: "Ender-5 S1 (PLA)",
    kinematics: "cartesian",
    bed_shape: "rect",
    bed_width_mm: 220.0,
    bed_depth_mm: 220.0,
    bed_height_mm: 280.0,
    origin_center: [110.0, 110.0],
    heated: true,
    default_nozzle_temp_c: 205,
    default_bed_temp_c: 60,
    default_fan_pct: 80,
    max_safe_temp_c: 260,
    extrusion_mode: "M83",
    filament_diameter_mm: 1.75,
    default_nozzle_mm: 0.4,
    nozzle_presets_mm: [0.4, 0.6, 0.8, 1.0],
    default_layer_height_mm: 0.24,
    default_line_width_mm: 0.48,
    default_speed_f: 1800.0,
    travel_speed_f: 6000.0,
    ooze_speed_f: 360.0,
    max_nozzle_angle_deg: 28.0,
    end_gcode: [
      "; --- END CREALITY ENDER-5 S1 ---",
      "G91",
      "G1 E-1.2 F2400 ; Retract",
      "G1 Z15 F1200 ; Bett absenken",
      "G90",
      "G1 X10 Y205 F6000 ; Druckkopf parken",
      "M106 S0 ; Luefter aus",
      "M104 S0 ; Duese aus",
      "M140 S0 ; Bett aus",
      "M84 ; Motoren aus",
    ].join("\n"),
  },
};

export function getProfile(id) {
  return PRINTER_PROFILES[id] || PRINTER_PROFILES.wasp_2040_clay;
}

export function computeEPerMm(profile, layerH, lineW, flowMult = 1.0) {
  if (!profile.heated) {
    const refArea = profile.clay_ref_layer_h * profile.clay_ref_line_w;
    const area = Math.max(0.05, layerH * lineW);
    return profile.clay_e_per_mm_ref * (area / refArea) * flowMult;
  }
  const filD = profile.filament_diameter_mm || 1.75;
  const filArea = Math.PI * (filD * 0.5) ** 2;
  const beadArea = (lineW - layerH) * layerH + Math.PI * (layerH * 0.5) ** 2;
  return (beadArea / filArea) * flowMult;
}

export function renderStartGcode(profile, nozzleTemp = 205, bedTemp = 60, fanPct = 80) {
  if (!profile.heated) {
    return [
      "; =========================================================",
      "; KIND Clay Custom G-Code Studio — Delta WASP 2040 Clay",
      "; =========================================================",
      "G21 ; Millimeter",
      "G90 ; Absolute Koordinaten",
      "M83 ; Relative Extrusion (LDM)",
      "G28 ; Delta Home",
      "G92 E0",
    ].join("\n");
  }
  const fanS = Math.max(0, Math.min(255, Math.round((fanPct / 100) * 255)));
  return [
    "; =========================================================",
    "; KIND Clay Custom G-Code Studio — Creality Ender-5 S1",
    "; =========================================================",
    "G21 ; Millimeter",
    "G90 ; Absolute Koordinaten",
    "M83 ; Relative Extrusion",
    `M140 S${Math.round(bedTemp)} ; Bett vorheizen`,
    `M104 S${Math.round(nozzleTemp)} ; Duese vorheizen`,
    "G28 ; Home",
    `M190 S${Math.round(bedTemp)} ; Warten auf Bett`,
    `M109 S${Math.round(nozzleTemp)} ; Warten auf Duese`,
    `M106 S${fanS} ; Bauteilluefter`,
    "G92 E0",
  ].join("\n");
}

function smoothstep(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1.0 : 0.0;
  const t = Math.max(0.0, Math.min(1.0, (x - e0) / (e1 - e0)));
  return t * t * (3.0 - 2.0 * t);
}

function zoneWeight(z, zMin, zMax, fadeMm = 5.0) {
  if (z < zMin || z > zMax) return 0.0;
  const f = Math.max(0.1, fadeMm);
  return Math.min(smoothstep(zMin, zMin + f, z), 1.0 - smoothstep(zMax - f, zMax, z));
}

function evalWaveform(theta, waveform) {
  if (waveform === "triangle") {
    return (2.0 / Math.PI) * Math.asin(Math.max(-1.0, Math.min(1.0, Math.sin(theta))));
  }
  if (waveform === "square") {
    return Math.tanh(3.2 * Math.sin(theta));
  }
  if (waveform === "sawtooth") {
    const u = (((theta / (2.0 * Math.PI)) % 1.0) + 1.0) % 1.0;
    return u < 0.82 ? -1.0 + 2.0 * (u / 0.82) : 1.0 - 2.0 * ((u - 0.82) / 0.18);
  }
  if (waveform === "scales") {
    return 2.0 * Math.abs(Math.sin(0.5 * theta)) - 1.0;
  }
  return Math.sin(theta);
}

// ============================================================================
// HEIGHTMAP CACHE (Client-side Canvas decoding + Procedural Reliefs)
// ============================================================================
const HEIGHTMAP_CACHE = new Map();

export async function registerHeightmapFile(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(16, Math.round(bmp.width * scale));
  const h = Math.max(16, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    // Flip Y so image top = vessel top (high Z)
    const dstY = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const i4 = (y * w + x) * 4;
      grid[dstY * w + x] = (0.299 * data[i4] + 0.587 * data[i4 + 1] + 0.114 * data[i4 + 2]) / 255.0;
    }
  }
  const id = `img_${Date.now().toString(36)}`;
  HEIGHTMAP_CACHE.set(id, { grid, width: w, height: h, name: file.name || "image.png" });
  return { heightmap_id: id, width: w, height: h, name: file.name || "image.png" };
}

export function registerProceduralHeightmap(kind = "voronoi") {
  const w = 160, h = 160;
  const grid = new Float32Array(w * h);

  if (kind === "checker") {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        grid[y * w + x] = ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0) ? 1.0 : 0.0;
      }
    }
    // Gentle smoothing pass
    const tmp = new Float32Array(w * h);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        const ym = (y - 1 + h) % h, yp = (y + 1) % h;
        for (let x = 0; x < w; x++) {
          const xm = (x - 1 + w) % w, xp = (x + 1) % w;
          tmp[y * w + x] = 0.25 * (grid[ym * w + x] + grid[yp * w + x] + grid[y * w + xm] + grid[y * w + xp]);
        }
      }
      grid.set(tmp);
    }
  } else if (kind === "diagonal") {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        grid[y * w + x] = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 6 + v * 4)) * Math.cos(2 * Math.PI * (u * 6 - v * 4));
      }
    }
  } else if (kind === "circles") {
    for (let y = 0; y < h; y++) {
      const dv = ((y / h) * 4) % 1 - 0.5;
      for (let x = 0; x < w; x++) {
        const du = ((x / w) * 4) % 1 - 0.5;
        const d = Math.hypot(du, dv);
        const t = Math.max(0, Math.min(1, 1.0 - d * 2.4));
        grid[y * w + x] = t * t * (3 - 2 * t);
      }
    }
  } else {
    // Deterministic Voronoi cellular ridges
    let seed = 42;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const pts = Array.from({ length: 24 }, () => [rand(), rand()]);
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        let d1 = 1e9, d2 = 1e9;
        for (let k = 0; k < pts.length; k++) {
          let du = Math.abs(u - pts[k][0]); if (du > 0.5) du = 1 - du;
          let dv = Math.abs(v - pts[k][1]); if (dv > 0.5) dv = 1 - dv;
          const dist = Math.hypot(du, dv);
          if (dist < d1) { d2 = d1; d1 = dist; } else if (dist < d2) { d2 = dist; }
        }
        grid[y * w + x] = 1.0 - Math.max(0, Math.min(1, (d2 - d1) * 9.0));
      }
    }
  }

  const id = `proc_${kind}`;
  HEIGHTMAP_CACHE.set(id, { grid, width: w, height: h, name: `Muster: ${kind}` });
  return { heightmap_id: id, width: w, height: h, name: `Muster: ${kind}` };
}

function sampleHeightmap(hm, u, v) {
  const { grid, width: w, height: h } = hm;
  const uf = (((u % 1.0) + 1.0) % 1.0) * (w - 1);
  const vf = Math.max(0.0, Math.min(1.0, v)) * (h - 1);
  const x0 = Math.floor(uf), y0 = Math.floor(vf);
  const x1 = (x0 + 1) % w, y1 = Math.min(h - 1, y0 + 1);
  const tx = uf - x0, ty = vf - y0;
  const v00 = grid[y0 * w + x0], v10 = grid[y0 * w + x1];
  const v01 = grid[y1 * w + x0], v11 = grid[y1 * w + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

// ============================================================================
// BASE GEOMETRY GENERATORS (Presets + Parametric + STL/OBJ + G-Code)
// ============================================================================
function roundedRectRing(halfW, halfD, cornerR, nPts = 128) {
  const r = Math.max(1.0, Math.min(cornerR, halfW - 1.0, halfD - 1.0));
  const straightX = Math.max(0.0, 2.0 * (halfW - r));
  const straightY = Math.max(0.0, 2.0 * (halfD - r));
  const arcLen = 0.5 * Math.PI * r;
  const perim = 2.0 * straightX + 2.0 * straightY + 4.0 * arcLen;
  const segs = [
    ["line", [halfW, 0], [halfW, halfD - r], straightY * 0.5],
    ["arc", [halfW - r, halfD - r], 0, 0.5 * Math.PI, arcLen],
    ["line", [halfW - r, halfD], [-(halfW - r), halfD], straightX],
    ["arc", [-(halfW - r), halfD - r], 0.5 * Math.PI, Math.PI, arcLen],
    ["line", [-halfW, halfD - r], [-halfW, -(halfD - r)], straightY],
    ["arc", [-(halfW - r), -(halfD - r)], Math.PI, 1.5 * Math.PI, arcLen],
    ["line", [-(halfW - r), -halfD], [halfW - r, -halfD], straightX],
    ["arc", [halfW - r, -(halfD - r)], 1.5 * Math.PI, 2.0 * Math.PI, arcLen],
    ["line", [halfW, -(halfD - r)], [halfW, 0], straightY * 0.5],
  ];
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const sTarget = (i / nPts) * perim;
    let acc = 0;
    for (const seg of segs) {
      const segLen = seg[seg.length - 1];
      if (segLen <= 1e-9) continue;
      if (sTarget <= acc + segLen + 1e-9) {
        const t = Math.max(0, Math.min(1, (sTarget - acc) / segLen));
        if (seg[0] === "line") {
          pts.push([seg[1][0] + t * (seg[2][0] - seg[1][0]), seg[1][1] + t * (seg[2][1] - seg[1][1])]);
        } else {
          const a = seg[2] + t * (seg[3] - seg[2]);
          pts.push([seg[1][0] + r * Math.cos(a), seg[1][1] + r * Math.sin(a)]);
        }
        break;
      }
      acc += segLen;
    }
  }
  return pts;
}

function roundedPolygonUnitRing(sides, cornerRound, nPts = 128) {
  const sN = Math.max(3, Math.min(64, Math.round(sides)));
  const cr = Math.max(0, Math.min(1, cornerRound));
  if (sN >= 48 || cr >= 0.99) {
    const out = [];
    for (let i = 0; i < nPts; i++) {
      const a = (2 * Math.PI * i) / nPts;
      out.push([Math.cos(a), Math.sin(a)]);
    }
    return out;
  }
  const rot0 = (sN % 2 === 0) ? Math.PI / sN : -Math.PI * 0.5;
  const verts = [];
  for (let k = 0; k < sN; k++) {
    const a = rot0 + (2 * Math.PI * k) / sN;
    verts.push([Math.cos(a), Math.sin(a)]);
  }
  const dense = [];
  const filletFrac = 0.48 * cr;
  const subArc = 10;
  for (let k = 0; k < sN; k++) {
    const pPrev = verts[(k - 1 + sN) % sN];
    const pCur = verts[k];
    const pNext = verts[(k + 1) % sN];
    if (filletFrac < 0.01) {
      dense.push(pCur);
    } else {
      const ax = pCur[0] + (pPrev[0] - pCur[0]) * filletFrac;
      const ay = pCur[1] + (pPrev[1] - pCur[1]) * filletFrac;
      const bx = pCur[0] + (pNext[0] - pCur[0]) * filletFrac;
      const by = pCur[1] + (pNext[1] - pCur[1]) * filletFrac;
      for (let s = 0; s <= subArc; s++) {
        const u = s / subArc, om = 1 - u;
        dense.push([
          om * om * ax + 2 * om * u * pCur[0] + u * u * bx,
          om * om * ay + 2 * om * u * pCur[1] + u * u * by,
        ]);
      }
    }
  }
  const m = dense.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const p0 = dense[i], p1 = dense[(i + 1) % m];
    cum.push(cum[cum.length - 1] + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
  }
  const perim = Math.max(1e-6, cum[m]);
  const out = [];
  let segI = 0;
  for (let i = 0; i < nPts; i++) {
    const sT = (i / nPts) * perim;
    while (segI < m - 1 && cum[segI + 1] < sT) segI++;
    const dSeg = Math.max(1e-9, cum[segI + 1] - cum[segI]);
    const t = Math.max(0, Math.min(1, (sT - cum[segI]) / dSeg));
    const p0 = dense[segI], p1 = dense[(segI + 1) % m];
    out.push([p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])]);
  }
  return out;
}

function evalProfileRadius(v, pts, smooth = true) {
  if (!pts || !pts.length) return 35.0;
  if (pts.length === 1) return Math.max(8, Math.min(95, pts[0][0]));
  const vc = Math.max(0, Math.min(1, v));
  let idx = 0;
  for (let i = 0; i < pts.length - 1; i++) if (vc >= pts[i][1]) idx = i;
  idx = Math.min(idx, pts.length - 2);
  const z0 = pts[idx][1], z1 = pts[idx + 1][1];
  const t = Math.max(0, Math.min(1, (vc - z0) / Math.max(1e-5, z1 - z0)));
  const r1 = pts[idx][0], r2 = pts[idx + 1][0];
  let r;
  if (!smooth || pts.length < 3) {
    r = r1 + t * (r2 - r1);
  } else {
    const r0 = pts[Math.max(0, idx - 1)][0];
    const r3 = pts[Math.min(pts.length - 1, idx + 2)][0];
    const t2 = t * t, t3 = t2 * t;
    r = 0.5 * ((2 * r1) + (-r0 + r2) * t + (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 + (-r0 + 3 * r1 - 3 * r2 + r3) * t3);
  }
  return Math.max(8.0, Math.min(95.0, r));
}

/**
 * Generate raw base points [{x, y, z, travel, is_base, f_orig, e_orig}] centered at (0,0)
 */
export function generateBasePoints(shape, profileId, opts = {}) {
  const profile = getProfile(profileId);
  const layerH = Math.max(0.08, Number(opts.layer_height_mm) || profile.default_layer_height_mm);
  const lineW = Math.max(0.2, Number(opts.line_width_mm) || profile.default_line_width_mm);
  let includeBase = opts.include_base !== undefined ? Boolean(opts.include_base) : true;
  const speedF = profile.default_speed_f;
  const pts = [];

  const pushPt = (x, y, z, travel, isBase) => {
    pts.push({ x, y, z, travel, is_base: isBase, f_orig: speedF, e_orig: 0 });
  };

  if (shape === "square_vase") {
    // Book-format ceramic wall (110 mm wide x 36 mm deep x 140 mm high, R=6 mm corners)
    const height = 140.0, halfW = 55.0, halfD = 18.0, cornerR = 6.0;
    const baseLayers = includeBase ? (layerH >= 0.8 ? 1 : 2) : 0;
    if (baseLayers > 0) {
      const stepR = Math.max(0.45, lineW * 0.92);
      const ringsN = Math.max(4, Math.round((halfD - 1.5) / stepR));
      for (let bl = 0; bl < baseLayers; bl++) {
        const zb = (bl + 1) * layerH;
        for (let rk = 1; rk <= ringsN; rk++) {
          const frac = rk / ringsN;
          const ring = roundedRectRing(
            Math.max(2.0, halfW - (halfD - 1.5) * (1.0 - frac)),
            1.5 + frac * (halfD - 1.5),
            Math.max(1.0, cornerR * frac),
            56
          );
          for (let i = 0; i < ring.length; i++) {
            pushPt(ring[i][0], ring[i][1], zb, (rk === 1 && i === 0), true);
          }
        }
      }
    }
    const zStart = baseLayers > 0 ? baseLayers * layerH : layerH;
    const wallH = Math.max(10.0, height - zStart);
    const layers = Math.max(12, Math.round(wallH / layerH));
    const ptsPerTurn = 128;
    const ring = roundedRectRing(halfW, halfD, cornerR, ptsPerTurn);
    const total = layers * ptsPerTurn;
    for (let i = 0; i <= total; i++) {
      const v = i / total;
      const p = ring[i % ptsPerTurn];
      pushPt(p[0], p[1], zStart + v * wallH, i === 0 && pts.length === 0, false);
    }
    return pts;
  }

  if (shape === "parametric") {
    const cfg = opts.parametric || {};
    const rawPts = Array.isArray(cfg.profile_points) && cfg.profile_points.length >= 2
      ? cfg.profile_points.map((p) => [Math.max(8, Math.min(95, Number(p[0]))), Math.max(0, Math.min(1, Number(p[1])))]).sort((a, b) => a[1] - b[1])
      : [[34, 0.0], [44, 0.25], [40, 0.50], [32, 0.78], [38, 1.0]];
    const height = Math.max(25, Math.min(320, Number(cfg.height_mm) || 120));
    const sides = Math.max(3, Math.min(64, Math.round(Number(cfg.sides) || 64)));
    const cornerRound = Math.max(0, Math.min(1, cfg.corner_round !== undefined ? Number(cfg.corner_round) : 0.35));
    const twistRad = ((Number(cfg.twist_deg) || 0) * Math.PI) / 180.0;
    const smooth = cfg.smooth !== undefined ? Boolean(cfg.smooth) : true;

    const footR = evalProfileRadius(0, rawPts, smooth);
    const baseLayers = includeBase ? (layerH >= 0.8 ? 1 : 2) : 0;
    if (baseLayers > 0) {
      const stepR = Math.max(0.45, lineW * 0.92);
      const ringsN = Math.max(4, Math.round((footR - 2.0) / stepR));
      const baseUnit = roundedPolygonUnitRing(sides, cornerRound, 48);
      for (let bl = 0; bl < baseLayers; bl++) {
        const zb = (bl + 1) * layerH;
        for (let rk = 1; rk <= ringsN; rk++) {
          const rkVal = 2.0 + (rk / ringsN) * (footR - 2.0);
          for (let i = 0; i < baseUnit.length; i++) {
            pushPt(baseUnit[i][0] * rkVal, baseUnit[i][1] * rkVal, zb, (rk === 1 && i === 0), true);
          }
        }
      }
    }
    const zStart = baseLayers > 0 ? baseLayers * layerH : layerH;
    const wallH = Math.max(10.0, height - zStart);
    const layers = Math.max(12, Math.round(wallH / layerH));
    const ptsPerTurn = 128;
    const unitRing = roundedPolygonUnitRing(sides, cornerRound, ptsPerTurn);
    const total = layers * ptsPerTurn;
    for (let i = 0; i <= total; i++) {
      const v = i / total;
      const r = evalProfileRadius(v, rawPts, smooth);
      const u = unitRing[i % ptsPerTurn];
      let rx = u[0] * r, ry = u[1] * r;
      if (Math.abs(twistRad) > 1e-5) {
        const tw = v * twistRad, ct = Math.cos(tw), st = Math.sin(tw);
        const nx = rx * ct - ry * st;
        ry = rx * st + ry * ct;
        rx = nx;
      }
      pushPt(rx, ry, zStart + v * wallH, i === 0 && pts.length === 0, false);
    }
    return pts;
  }

  // Round presets: espresso, tumbler, vase, lampshade
  let height = 62.0, footR = 24.0;
  let radiusFn = (v) => 24.0 + 6.5 * (v ** 0.85) + 2.2 * Math.sin(v * Math.PI);
  if (shape === "tumbler") {
    height = 98.0; footR = 35.0;
    radiusFn = (v) => 35.0 + 4.0 * (v ** 0.75) + 1.5 * Math.sin(v * Math.PI);
  } else if (shape === "vase") {
    height = 165.0; footR = 32.0;
    radiusFn = (v) => {
      const belly = 27.0 * Math.exp(-(((v - 0.36) / 0.28) ** 2));
      const neck = -9.0 * Math.exp(-(((v - 0.82) / 0.16) ** 2));
      const lip = 6.5 * (Math.max(0, (v - 0.80) / 0.20) ** 1.6);
      return Math.max(20.0, 32.0 + belly + neck + lip);
    };
  } else if (shape === "lampshade") {
    height = 115.0; footR = 55.0; includeBase = false;
    radiusFn = (v) => 55.0 - 21.0 * (v ** 1.2) + 8.0 * Math.sin(v * Math.PI);
  }

  const baseLayers = includeBase ? (layerH >= 0.8 ? 1 : 2) : 0;
  if (baseLayers > 0) {
    const stepR = Math.max(0.42, lineW * 0.92);
    const baseTurns = Math.max(4, Math.round((footR - 1.5) / stepR));
    const tot = baseTurns * 36;
    for (let bl = 0; bl < baseLayers; bl++) {
      const zb = (bl + 1) * layerH;
      for (let i = 0; i <= tot; i++) {
        const frac = i / tot;
        const r = 1.5 + frac * (footR - 1.5);
        const ang = frac * baseTurns * 2 * Math.PI;
        pushPt(r * Math.cos(ang), r * Math.sin(ang), zb, i === 0, true);
      }
    }
  }
  const zStart = baseLayers > 0 ? baseLayers * layerH : layerH;
  const wallH = Math.max(10.0, height - zStart);
  const layers = Math.max(12, Math.round(wallH / layerH));
  const ptsPerTurn = 108;
  const total = layers * ptsPerTurn;
  for (let i = 0; i <= total; i++) {
    const v = i / total;
    const r = radiusFn(v);
    const ang = ((i % ptsPerTurn) / ptsPerTurn) * 2 * Math.PI;
    pushPt(r * Math.cos(ang), r * Math.sin(ang), zStart + v * wallH, i === 0 && pts.length === 0, false);
  }
  return pts;
}

// ============================================================================
// FAST G-CODE PARSER (for uploaded .gcode or edited code)
// ============================================================================
export function parseGcodeToPoints(gcodeText) {
  const lines = gcodeText.split(/\r?\n/);
  let x = 0, y = 0, z = 0, f = 1200, eAbs = 0;
  let relativeE = false, inBase = false;
  const pts = [];
  const meta = { tempsNozzle: [], tempsBed: [] };
  const tokRe = /([A-Z])([-+]?\d*\.?\d+)/g;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li].trim();
    if (!raw) continue;
    const upper = raw.toUpperCase();
    if (upper.includes("BEGIN_BASE")) inBase = true;
    else if (upper.includes("BEGIN_WALL")) inBase = false;

    const code = raw.split(";", 1)[0].trim();
    if (!code) continue;
    if (code.startsWith("M83")) { relativeE = true; continue; }
    if (code.startsWith("M82")) { relativeE = false; continue; }
    if (code.startsWith("G92")) {
      tokRe.lastIndex = 0;
      let m;
      while ((m = tokRe.exec(code)) !== null) if (m[1] === "E") eAbs = parseFloat(m[2]);
      continue;
    }
    if (code.startsWith("M104") || code.startsWith("M109")) {
      const m = /S([-+]?\d*\.?\d+)/i.exec(code);
      if (m) meta.tempsNozzle.push(parseFloat(m[1]));
      continue;
    }
    if (code.startsWith("M140") || code.startsWith("M190")) {
      const m = /S([-+]?\d*\.?\d+)/i.exec(code);
      if (m) meta.tempsBed.push(parseFloat(m[1]));
      continue;
    }
    if (!code.startsWith("G0") && !code.startsWith("G1")) continue;
    const isG0 = code.startsWith("G0");
    let nx = x, ny = y, nz = z, nf = f, eRel = 0;
    let hasXY = false;
    tokRe.lastIndex = 0;
    let m;
    while ((m = tokRe.exec(code)) !== null) {
      const k = m[1], val = parseFloat(m[2]);
      if (k === "X") { nx = val; hasXY = true; }
      else if (k === "Y") { ny = val; hasXY = true; }
      else if (k === "Z") { nz = val; }
      else if (k === "F") { nf = val; }
      else if (k === "E") {
        if (relativeE) eRel = val;
        else { eRel = val - eAbs; eAbs = val; }
      }
    }
    f = nf;
    const dist = Math.hypot(nx - x, ny - y, nz - z);
    if (dist > 1e-5 && (hasXY || Math.abs(nz - z) > 1e-5)) {
      const isExt = !isG0 && eRel > 1e-6;
      if (isExt) {
        if (pts.length === 0) {
          pts.push({ x, y, z, travel: true, is_base: inBase, f_orig: f, e_orig: 0 });
        } else {
          const last = pts[pts.length - 1];
          if (Math.hypot(x - last.x, y - last.y, z - last.z) > 0.25) {
            pts.push({ x, y, z, travel: true, is_base: inBase, f_orig: f, e_orig: 0 });
          }
        }
        pts.push({ x: nx, y: ny, z: nz, travel: false, is_base: inBase, f_orig: f, e_orig: eRel });
      }
    }
    x = nx; y = ny; z = nz;
  }
  return { pts, meta };
}

// ============================================================================
// FAST CLIENT-SIDE STL / OBJ SPIRAL VASE SLICER
// ============================================================================
export function sliceMeshToBasePoints(arrayBuffer, filename, profileId, layerH = 1.2) {
  const lower = (filename || "").toLowerCase();
  const tris = []; // flat [x0,y0,z0, x1,y1,z1, x2,y2,z2]

  if (lower.endsWith(".obj")) {
    const txt = new TextDecoder().decode(arrayBuffer);
    const verts = [];
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("v ")) {
        const p = t.split(/\s+/);
        verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
      } else if (t.startsWith("f ")) {
        const p = t.split(/\s+/).slice(1).map((tok) => parseInt(tok.split("/")[0], 10) - 1);
        for (let k = 1; k + 1 < p.length; k++) {
          const a = verts[p[0]], b = verts[p[k]], c = verts[p[k + 1]];
          if (a && b && c) tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        }
      }
    }
  } else {
    // STL (binary or ASCII)
    const dv = new DataView(arrayBuffer);
    const isBinary = arrayBuffer.byteLength >= 84 && (84 + dv.getUint32(80, true) * 50 === arrayBuffer.byteLength);
    if (isBinary) {
      const nTri = dv.getUint32(80, true);
      for (let i = 0; i < nTri; i++) {
        const o = 84 + i * 50 + 12;
        tris.push(
          dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true),
          dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true),
          dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true)
        );
      }
    } else {
      const txt = new TextDecoder().decode(arrayBuffer);
      const vRe = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
      let m;
      const tmp = [];
      while ((m = vRe.exec(txt)) !== null) tmp.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      for (let i = 0; i + 8 < tmp.length; i += 9) {
        tris.push(tmp[i], tmp[i + 1], tmp[i + 2], tmp[i + 3], tmp[i + 4], tmp[i + 5], tmp[i + 6], tmp[i + 7], tmp[i + 8]);
      }
    }
  }

  if (tris.length < 9) throw new Error("Keine gültigen Dreiecke in der 3D-Datei gefunden.");

  // Compute bounds and center at (0,0, minZ=0)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const vx = tris[i], vy = tris[i + 1], vz = tris[i + 2];
    if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
    if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
    if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
  }
  const cx = 0.5 * (minX + maxX), cy = 0.5 * (minY + maxY);
  const height = Math.max(5.0, maxZ - minZ);
  const effLH = Math.max(0.08, Number(layerH) || 0.24);
  const layers = Math.max(10, Math.min(2500, Math.round(height / effLH)));
  const BINS = 96;
  const profile = getProfile(profileId);
  const speedF = profile.default_speed_f;

  // Slice horizontal planes -> max outer radius per angular bin -> smooth spiral wall
  const rings = [];
  const nT = tris.length / 9;
  for (let l = 0; l <= layers; l++) {
    const zSlice = minZ + (l / layers) * (height - 0.08) + 0.04;
    const maxR = new Float32Array(BINS);
    for (let t = 0; t < nT; t++) {
      const o = t * 9;
      const z0 = tris[o + 2], z1 = tris[o + 5], z2 = tris[o + 8];
      if ((z0 < zSlice && z1 < zSlice && z2 < zSlice) || (z0 > zSlice && z1 > zSlice && z2 > zSlice)) continue;
      const edges = [[0, 3], [3, 6], [6, 0]];
      for (const [a, b] of edges) {
        const za = tris[o + a + 2], zb = tris[o + b + 2];
        if ((za <= zSlice && zb > zSlice) || (zb <= zSlice && za > zSlice)) {
          const f = (zSlice - za) / (zb - za);
          const ix = tris[o + a] + f * (tris[o + b] - tris[o + a]) - cx;
          const iy = tris[o + a + 1] + f * (tris[o + b + 1] - tris[o + a + 1]) - cy;
          const r = Math.hypot(ix, iy);
          const ang = Math.atan2(iy, ix);
          const u = (ang >= 0 ? ang : ang + 2 * Math.PI) / (2 * Math.PI);
          const bin = Math.min(BINS - 1, Math.floor(u * BINS));
          if (r > maxR[bin]) maxR[bin] = r;
        }
      }
    }
    // Fill any sparse angular bin from neighbor
    let filled = 0;
    for (let b = 0; b < BINS; b++) if (maxR[b] > 0) filled++;
    if (filled < BINS * 0.3) continue;
    for (let b = 0; b < BINS; b++) {
      if (maxR[b] <= 0) {
        for (let off = 1; off < BINS; off++) {
          if (maxR[(b + off) % BINS] > 0) { maxR[b] = maxR[(b + off) % BINS]; break; }
          if (maxR[(b - off + BINS) % BINS] > 0) { maxR[b] = maxR[(b - off + BINS) % BINS]; break; }
        }
      }
    }
    rings.push({ z: zSlice - minZ + effLH, r: maxR });
  }

  if (rings.length < 2) throw new Error("Konnte keine geschlossenen Schichten aus dem 3D-Modell schneiden.");

  const pts = [];
  for (let l = 0; l < rings.length - 1; l++) {
    const r0 = rings[l], r1 = rings[l + 1];
    for (let b = 0; b < BINS; b++) {
      const frac = b / BINS;
      const ang = frac * 2 * Math.PI;
      const rad = r0.r[b] * (1 - frac) + r1.r[b] * frac;
      const zz = r0.z * (1 - frac) + r1.z * frac;
      pts.push({ x: rad * Math.cos(ang), y: rad * Math.sin(ang), z: zz, travel: (l === 0 && b === 0), is_base: false, f_orig: speedF, e_orig: 0 });
    }
  }
  return { pts, sliced_layers: rings.length };
}

// ============================================================================
// CORE HIGH-SPEED PROCESSOR (Zero JSON, Direct TypedArrays for Three.js!)
// ============================================================================
export function processToolpath(basePoints, targetProfileId, opts = {}) {
  const profile = getProfile(targetProfileId);
  const nozzleMm = Number(opts.nozzle_mm) || profile.default_nozzle_mm;
  const layerH = Math.max(0.08, Number(opts.layer_height_mm) || profile.default_layer_height_mm);
  const lineW = Math.max(0.2, Number(opts.line_width_mm) || nozzleMm * 1.15);
  const flowMult = Number(opts.flow_multiplier) || 1.0;
  const baseSpeedF = Number(opts.speed_f) || profile.default_speed_f;
  const recalcE = opts.recalc_e !== undefined ? Boolean(opts.recalc_e) : true;
  const includeBase = opts.include_base !== undefined ? Boolean(opts.include_base) : true;
  const angleLimit = Number(opts.max_nozzle_angle_deg) || profile.max_nozzle_angle_deg;

  // Filter base points if open-bottom vase mode
  let srcPts = basePoints;
  if (!includeBase) {
    const wallOnly = basePoints.filter((p) => !p.is_base);
    if (wallOnly.length > 10) srcPts = wallOnly;
  }

  // Compute source bounds & center
  let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity, sMinZ = Infinity, sMaxZ = -Infinity;
  for (let i = 0; i < srcPts.length; i++) {
    const p = srcPts[i];
    if (p.x < sMinX) sMinX = p.x; if (p.x > sMaxX) sMaxX = p.x;
    if (p.y < sMinY) sMinY = p.y; if (p.y > sMaxY) sMaxY = p.y;
    if (p.z < sMinZ) sMinZ = p.z; if (p.z > sMaxZ) sMaxZ = p.z;
  }
  const srcCx = 0.5 * (sMinX + sMaxX);
  const srcCy = 0.5 * (sMinY + sMaxY);
  const [dstCx, dstCy] = profile.origin_center;
  const originX = opts.recenter !== false ? dstCx : srcCx;
  const originY = opts.recenter !== false ? dstCy : srcCy;

  let scaleXY = Number(opts.scale_xy) || 1.0;
  let scaleZ = Number(opts.scale_z) || 1.0;
  const shrinkPct = Math.max(0, Math.min(22, Number(opts.shrinkage_pct) || 0));
  if (opts.shrinkage_compensate && shrinkPct > 0) {
    const comp = 1.0 / (1.0 - shrinkPct / 100.0);
    scaleXY *= comp;
    scaleZ *= comp;
  }

  const ePerMmBase = computeEPerMm(profile, layerH, lineW, flowMult);

  // Modifiers
  const weave = opts.weaving || {};
  const weaveOn = Boolean(weave.enabled);
  const weaveMode = String(weave.mode || "outward");
  const weaveWave = String(weave.waveform || "sine").toLowerCase();
  const weaveBrickDuty = Math.max(0.10, Math.min(0.90, Number(weave.brick_duty) || 0.50));
  const weaveSharp = Math.max(0.5, Math.min(6.0, Number(weave.sharpness) || 1.8));
  const weaveFreq = Number(weave.freq) || 16;
  const weavePhase = Number(weave.phase_shift) || 0.5;
  const weaveH = Number(weave.h_amp_mm) || 2.0;
  const weaveZMin = Number(weave.z_min) || 6.0;
  const weaveZMax = Number(weave.z_max) || 58.0;
  const weaveFade = Number(weave.fade_mm) || 6.0;

  const np = opts.nonplanar || {};
  const npOn = Boolean(np.enabled);
  const npMode = String(np.mode || "waves").toLowerCase();
  const npFreq = Number(np.freq) || 12;
  const npPhase = Number(np.phase_shift) || 0.5;
  const npZ = Number(np.z_amp_mm) || 1.2;
  const npZMin = Number(np.z_min) || 8.0;
  const npZMax = Number(np.z_max) || 58.0;
  const npFade = Number(np.fade_mm) || 6.0;

  const ooze = opts.oozing || {};
  const oozeOn = Boolean(ooze.enabled);
  const oozeCount = Math.max(1, Math.round(Number(ooze.count_per_turn) || 14));
  const oozePhase = Number(ooze.phase_shift) || 0.5;
  const oozeEveryN = Math.max(1, Math.round(Number(ooze.every_n_layers) || 4));
  const oozeZMin = Number(ooze.z_min) || 8.0;
  const oozeZMax = Number(ooze.z_max) || 58.0;
  const oozeFlowMin = Math.max(0.0, Math.min(2.0, ooze.flow_min !== undefined ? Number(ooze.flow_min) : 0.2));
  const oozeFlowMax = Math.max(0.1, Math.min(6.0, ooze.flow_max !== undefined ? Number(ooze.flow_max) : 2.8));
  const oozeSpeedMin = Math.max(0.15, Math.min(1.0, ooze.speed_min !== undefined ? Number(ooze.speed_min) : 0.45));
  const oozeCurve = String(ooze.curve || "smooth").toLowerCase();
  const oozeWidth = Math.max(0.15, Math.min(0.98, Number(ooze.width) || 0.70));

  const hm = opts.heightmap || {};
  const hmEntry = (hm.enabled && hm.heightmap_id) ? HEIGHTMAP_CACHE.get(hm.heightmap_id) : null;
  const hmDepth = Number(hm.depth_mm) || 2.5;
  const hmRepX = Math.max(0.25, Number(hm.repeat_x) || 2.0);
  const hmRepY = Math.max(0.25, Number(hm.repeat_y) || 1.0);
  const hmInvert = Boolean(hm.invert);
  const hmZMin = Number(hm.z_min) || 8.0;
  const hmZMax = Number(hm.z_max) || 100.0;
  const hmFade = Number(hm.fade_mm) || 5.0;

  // Selective 4-wall face mask
  const rawFaces = opts.active_faces;
  const allFour = new Set(["front", "right", "back", "left"]);
  const useFaceMask = Array.isArray(rawFaces) && rawFaces.length < 4;
  const activeFaces = useFaceMask ? new Set(rawFaces.map((f) => String(f).toLowerCase())) : allFour;

  const faceHalfX = Math.max(1.0, 0.5 * (sMaxX - sMinX) * scaleXY);
  const faceHalfY = Math.max(1.0, 0.5 * (sMaxY - sMinY) * scaleXY);

  function faceMaskWeight(rx0, ry0) {
    if (!useFaceMask) return 1.0;
    if (activeFaces.size === 0) return 0.0;
    // Aspect-normalized angle so flat book-format walls split exactly at their real corners
    const angDeg = (Math.atan2(ry0 / faceHalfY, rx0 / faceHalfX) * 180.0) / Math.PI;
    let face, leftNb, rightNb, local;
    if (angDeg >= -45 && angDeg < 45) { face = "right"; leftNb = "back"; rightNb = "front"; local = angDeg; }
    else if (angDeg >= 45 && angDeg < 135) { face = "back"; leftNb = "left"; rightNb = "right"; local = angDeg - 90; }
    else if (angDeg >= -135 && angDeg < -45) { face = "front"; leftNb = "right"; rightNb = "left"; local = angDeg + 90; }
    else { face = "left"; leftNb = "front"; rightNb = "back"; local = angDeg >= 0 ? angDeg - 180 : angDeg + 180; }
    if (!activeFaces.has(face)) return 0.0;
    const fadeDeg = 14.0;
    let w = 1.0;
    const distPos = 45.0 - local, distNeg = local + 45.0;
    if (!activeFaces.has(leftNb) && distPos < fadeDeg) w = Math.min(w, smoothstep(2.0, fadeDeg, distPos));
    if (!activeFaces.has(rightNb) && distNeg < fadeDeg) w = Math.min(w, smoothstep(2.0, fadeDeg, distNeg));
    return Math.max(0.0, Math.min(1.0, w));
  }

  // Enrich points with unwrapped wall revolution & true local outward 2D normals
  const n = srcPts.length;
  const rxArr = new Float32Array(n);
  const ryArr = new Float32Array(n);
  const rzArr = new Float32Array(n);
  const nxArr = new Float32Array(n);
  const nyArr = new Float32Array(n);
  const tTurnArr = new Float32Array(n);
  const turnZSum = new Map();
  const turnZCnt = new Map();

  let wallPrevAng = null, wallUnwrapped = 0;
  let vesselMaxZ = 10.0, vesselMaxR = 10.0;

  for (let i = 0; i < n; i++) {
    const p = srcPts[i];
    const rx = (p.x - srcCx) * scaleXY;
    const ry = (p.y - srcCy) * scaleXY;
    const rz = Math.max(0.05, p.z * scaleZ);
    rxArr[i] = rx; ryArr[i] = ry; rzArr[i] = rz;
    if (rz > vesselMaxZ) vesselMaxZ = rz;
    const r0 = Math.hypot(rx, ry);
    if (r0 > vesselMaxR) vesselMaxR = r0;

    if (p.is_base) {
      tTurnArr[i] = -1.0;
    } else {
      const ang = Math.atan2(ry, rx);
      if (wallPrevAng === null) {
        wallUnwrapped = ang >= 0 ? ang : ang + 2 * Math.PI;
      } else {
        let d = ang - wallPrevAng;
        if (d > Math.PI) d -= 2 * Math.PI;
        else if (d < -Math.PI) d += 2 * Math.PI;
        wallUnwrapped += d;
      }
      wallPrevAng = ang;
      const tTurn = wallUnwrapped / (2 * Math.PI);
      tTurnArr[i] = tTurn;
      if (!p.travel) {
        const ti = Math.floor(tTurn);
        turnZSum.set(ti, (turnZSum.get(ti) || 0) + rz);
        turnZCnt.set(ti, (turnZCnt.get(ti) || 0) + 1);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const rx0 = rxArr[i], ry0 = ryArr[i];
    const r0 = Math.hypot(rx0, ry0);
    const radNx = r0 > 1e-4 ? rx0 / r0 : 1.0;
    const radNy = r0 > 1e-4 ? ry0 / r0 : 0.0;
    const p = srcPts[i];
    if (p.is_base || p.travel || i === 0 || i === n - 1 || srcPts[i - 1].is_base || srcPts[i + 1].is_base || srcPts[i - 1].travel || srcPts[i + 1].travel) {
      nxArr[i] = radNx; nyArr[i] = radNy;
      continue;
    }
    const tx = rxArr[i + 1] - rxArr[i - 1], ty = ryArr[i + 1] - ryArr[i - 1];
    const tlen = Math.hypot(tx, ty);
    if (tlen > 1e-5) {
      let nxL = ty / tlen, nyL = -tx / tlen;
      if (nxL * radNx + nyL * radNy < 0) { nxL = -nxL; nyL = -nyL; }
      nxArr[i] = nxL; nyArr[i] = nyL;
    } else {
      nxArr[i] = radNx; nyArr[i] = radNy;
    }
  }

  // Active Flow-Modulator rows
  const activeRows = new Map();
  if (oozeOn && turnZSum.size > 0) {
    const elig = [];
    for (const [ti, sumZ] of turnZSum.entries()) {
      const cnt = turnZCnt.get(ti) || 0;
      const avgZ = sumZ / Math.max(1, cnt);
      if (cnt >= 8 && avgZ >= oozeZMin && avgZ <= oozeZMax) elig.push(ti);
    }
    elig.sort((a, b) => a - b);
    if (elig.length > 0) {
      const firstT = elig[0];
      let rc = 0;
      for (const ti of elig) {
        if ((ti - firstT) % oozeEveryN === 0) activeRows.set(ti, rc++);
      }
    }
  }

  function evalFlowBell(tTurnVal, isBase) {
    if (!oozeOn || isBase || tTurnVal < 0) return [0.0, false];
    const ti = Math.floor(tTurnVal);
    if (!activeRows.has(ti)) return [0.0, false];
    const rowIdx = activeRows.get(ti);
    const phaseOff = (rowIdx * oozePhase) % 1.0;
    const uLocal = tTurnVal - ti;
    const pos = (((uLocal * oozeCount - phaseOff) % 1.0) + 1.0) % 1.0;
    const dSigned = pos >= 0.5 ? pos - 1.0 : pos;
    const hw = 0.5 * oozeWidth;
    if (Math.abs(dSigned) >= hw) return [0.0, true];
    const q = (dSigned + hw) / (2.0 * hw);
    const cosBell = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * q));
    let val = cosBell;
    if (oozeCurve === "sharp") val = cosBell ** 2.6;
    else if (oozeCurve === "plateau") val = Math.min(1.0, cosBell * 2.2);
    else if (oozeCurve === "ramp_up") val = q < 0.80 ? (q / 0.80) ** 1.4 : Math.max(0, (1 - q) / 0.20);
    else if (oozeCurve === "ramp_down") val = q < 0.20 ? (q / 0.20) : Math.max(0, ((1 - q) / 0.80) ** 1.4);
    return [Math.max(0, Math.min(1, val)), true];
  }

  function applyModsAt(rx0, ry0, rz0, tTurnVal, isBase, nx0, ny0, brickOverride = null) {
    if (isBase || tTurnVal < 0 || (!weaveOn && !npOn && !oozeOn && !hmEntry)) {
      return [rx0, ry0, rz0, 0.0, 0.0, false];
    }
    const fw = faceMaskWeight(rx0, ry0);
    if (fw <= 1e-5) return [rx0, ry0, rz0, 0.0, 0.0, false];

    const ti = Math.floor(tTurnVal);
    const uLocal = tTurnVal - ti;
    let rxOut = rx0, ryOut = ry0, rzOut = rz0;

    if (weaveOn && Math.abs(weaveH) > 1e-6) {
      const wXY = zoneWeight(rz0, weaveZMin, weaveZMax, weaveFade) * fw;
      if (wXY > 0) {
        let hFactor;
        if (weaveWave === "square") {
          const wv = brickOverride !== null
            ? brickOverride
            : (((((uLocal * weaveFreq + ti * weavePhase) % 1.0) + 1.0) % 1.0) < weaveBrickDuty ? 1.0 : -1.0);
          hFactor = weaveMode === "outward" ? (wv > 0 ? 1.0 : 0.0) : wv;
        } else {
          const theta = 2.0 * Math.PI * (uLocal * weaveFreq + ti * weavePhase);
          const wv = evalWaveform(theta, weaveWave);
          hFactor = weaveMode === "outward" ? (Math.max(0, (1 + wv) * 0.5) ** weaveSharp) : wv;
        }
        rxOut += nx0 * (hFactor * weaveH * wXY);
        ryOut += ny0 * (hFactor * weaveH * wXY);
      }
    }

    if (hmEntry && Math.abs(hmDepth) > 1e-6) {
      const wHm = zoneWeight(rz0, hmZMin, hmZMax, hmFade) * fw;
      if (wHm > 0) {
        const angU = (Math.atan2(ry0, rx0) / (2.0 * Math.PI)) + 0.5;
        const vHm = (rz0 - hmZMin) / Math.max(1.0, hmZMax - hmZMin);
        let g = sampleHeightmap(hmEntry, angU * hmRepX, hmRepY > 1.0 ? ((vHm * hmRepY) % 1.0) : vHm);
        if (hmInvert) g = 1.0 - g;
        rxOut += nx0 * (g * hmDepth * wHm);
        ryOut += ny0 * (g * hmDepth * wHm);
      }
    }

    if (npOn && Math.abs(npZ) > 1e-6) {
      if (npMode === "rim_wave") {
        const wZ = smoothstep(npZMin, vesselMaxZ, rz0) * fw;
        if (wZ > 0) rzOut = Math.max(0.15, rzOut + Math.sin(2.0 * Math.PI * (uLocal * npFreq + npPhase)) * npZ * wZ);
      } else if (npMode === "tilt") {
        const wZ = smoothstep(npZMin, vesselMaxZ, rz0) * fw;
        if (wZ > 0) {
          const dir = npPhase * 2.0 * Math.PI;
          const proj = (rx0 * Math.cos(dir) + ry0 * Math.sin(dir)) / vesselMaxR;
          rzOut = Math.max(0.15, rzOut + proj * npZ * wZ);
        }
      } else {
        const wZ = zoneWeight(rz0, npZMin, npZMax, npFade) * fw;
        if (wZ > 0) rzOut = Math.max(0.15, rzOut + Math.sin(2.0 * Math.PI * (uLocal * npFreq + ti * npPhase)) * npZ * wZ);
      }
    }

    const [bellRaw, inRow] = evalFlowBell(tTurnVal, isBase);
    return [rxOut, ryOut, rzOut, bellRaw, fw, inRow];
  }

  // Output flat buffers (pre-sized dynamically via JS arrays -> converted once to TypedArrays)
  const outMoves = []; // {x, y, z, e, f, travel}
  let prevX = 0, prevY = 0, prevZ = 0, hasPrev = false;

  // Live metrics accumulators
  let totalPrintMm = 0, totalE = 0, estTimeS = 0;
  let extCount = 0, collisionCount = 0, maxSlope = 0, outOfBounds = 0;
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;

  const isCircleBed = profile.bed_shape === "circle";
  const radLim = (profile.bed_diameter_mm || 200) * 0.5 + 0.5;
  const bedW = (profile.bed_width_mm || 220) + 0.5;
  const bedD = (profile.bed_depth_mm || 220) + 0.5;
  const bedH = (profile.bed_height_mm || 400) + 0.5;

  function pushSeg(fx, fy, fz, ptF, ptE, eFrac, bellRaw, fw, inRow, isTravel) {
    if (!hasPrev || isTravel) {
      outMoves.push({ x: fx, y: fy, z: fz, e: 0, f: profile.travel_speed_f, travel: true, slope: 0, epm: 0 });
      prevX = fx; prevY = fy; prevZ = fz; hasPrev = true;
      return;
    }
    const dx = fx - prevX, dy = fy - prevY, dz = fz - prevZ;
    const len3d = Math.hypot(dx, dy, dz);
    if (len3d < 1e-5) return;
    const xy = Math.hypot(dx, dy);
    const slope = xy > 1e-5 ? (Math.atan2(Math.abs(dz), xy) * 180.0) / Math.PI : 0.0;

    let localFlow = 1.0;
    let localSpeed = recalcE ? baseSpeedF : ptF;
    if (slope > 12.0) localSpeed *= Math.max(0.35, 1.0 - (slope - 12.0) / 45.0);

    if (inRow && fw > 1e-4) {
      const modFlow = oozeFlowMin + (oozeFlowMax - oozeFlowMin) * bellRaw;
      localFlow *= (1.0 - fw) + modFlow * fw;
      localSpeed *= 1.0 - (1.0 - oozeSpeedMin) * (bellRaw * fw);
    }
    localSpeed = Math.max(120.0, localSpeed);
    const eVal = Math.max(0.0, recalcE ? (len3d * ePerMmBase * localFlow) : (ptE * eFrac * flowMult * localFlow));
    const isExt = eVal > 1e-6;
    const epm = isExt ? eVal / len3d : 0.0;

    outMoves.push({ x: fx, y: fy, z: fz, e: eVal, f: localSpeed, travel: !isExt, slope, epm });

    estTimeS += len3d / Math.max(localSpeed / 60.0, 0.5);
    if (isExt) {
      extCount++;
      totalPrintMm += len3d;
      totalE += eVal;
      if (Math.abs(dz) > 0.02 && xy > 0.05) {
        if (slope > maxSlope) maxSlope = slope;
        if (slope > angleLimit) collisionCount++;
      }
      if (fx < bMinX) bMinX = fx; if (fx > bMaxX) bMaxX = fx;
      if (fy < bMinY) bMinY = fy; if (fy > bMaxY) bMaxY = fy;
      if (fz < bMinZ) bMinZ = fz; if (fz > bMaxZ) bMaxZ = fz;
      if (isCircleBed) {
        if (Math.hypot(fx, fy) > radLim || fz > bedH || fz < -0.05) outOfBounds++;
      } else {
        if (fx < -0.5 || fx > bedW || fy < -0.5 || fy > bedD || fz < -0.05 || fz > bedH) outOfBounds++;
      }
    }
    prevX = fx; prevY = fy; prevZ = fz;
  }

  for (let i = 0; i < n; i++) {
    const en = srcPts[i];
    // Exact 2-point crisp 90-deg Brick corner insertion
    if (
      weaveOn && weaveWave === "square" && Math.abs(weaveH) > 1e-6 &&
      i > 0 && !en.travel && !en.is_base && !srcPts[i - 1].is_base &&
      tTurnArr[i] > tTurnArr[i - 1] + 1e-7
    ) {
      const t0 = tTurnArr[i - 1], t1 = tTurnArr[i];
      const ti0 = Math.floor(t0), ti1 = Math.floor(t1);
      if (ti0 === ti1) {
        const p0 = (t0 - ti0) * weaveFreq + ti0 * weavePhase;
        const p1 = (t1 - ti0) * weaveFreq + ti0 * weavePhase;
        if (p1 > p0 + 1e-7) {
          const kMin = Math.floor(p0) - 1, kMax = Math.ceil(p1) + 1;
          const evs = [];
          for (let k = kMin; k <= kMax; k++) {
            if (p0 < k && k < p1) evs.push([k, 1]);
            const pf = k + weaveBrickDuty;
            if (p0 < pf && pf < p1) evs.push([pf, -1]);
          }
          evs.sort((a, b) => a[0] - b[0]);
          for (const [pCross, kind] of evs) {
            const alpha = Math.max(0, Math.min(1, (pCross - p0) / (p1 - p0)));
            const tCross = t0 + alpha * (t1 - t0);
            const irx = rxArr[i - 1] + alpha * (rxArr[i] - rxArr[i - 1]);
            const iry = ryArr[i - 1] + alpha * (ryArr[i] - ryArr[i - 1]);
            const irz = rzArr[i - 1] + alpha * (rzArr[i] - rzArr[i - 1]);
            if (faceMaskWeight(irx, iry) <= 1e-4 || zoneWeight(irz, weaveZMin, weaveZMax, weaveFade) <= 1e-4) continue;
            let inx = nxArr[i - 1] + alpha * (nxArr[i] - nxArr[i - 1]);
            let iny = nyArr[i - 1] + alpha * (nyArr[i] - nyArr[i - 1]);
            const ilen = Math.hypot(inx, iny);
            if (ilen > 1e-5) { inx /= ilen; iny /= ilen; }
            const seq = kind === 1 ? [-1.0, 1.0] : [1.0, -1.0];
            for (const bOv of seq) {
              const [bx, by, bz, bBell, bFw, bIn] = applyModsAt(irx, iry, irz, tCross, false, inx, iny, bOv);
              pushSeg(originX + bx, originY + by, bz, en.f_orig, en.e_orig, 0.2, bBell, bFw, bIn, false);
            }
          }
        }
      }
    }

    const [wx, wy, wz, bellEnd, fwEnd, inRowEnd] = applyModsAt(rxArr[i], ryArr[i], rzArr[i], tTurnArr[i], en.is_base, nxArr[i], nyArr[i]);
    pushSeg(originX + wx, originY + wy, wz, en.f_orig, en.e_orig, 1.0, bellEnd, fwEnd, inRowEnd, i === 0 || en.travel);
  }

  // Pack compact render data (cap at 90,000 segments for instant 60fps Three.js rendering,
  // ALWAYS connecting previous sampled point so high-layer Ender prints stay 100% continuous!)
  const totalSegs = Math.max(0, outMoves.length - 1);
  const stride = Math.max(1, Math.ceil(totalSegs / 90000));
  const packedCount = Math.ceil(totalSegs / stride);
  const coords = new Float32Array(packedCount * 6);
  const slopes = new Float32Array(packedCount);
  const speeds = new Float32Array(packedCount);
  const flows = new Float32Array(packedCount);
  const extruding = new Uint8Array(packedCount);
  const zs = new Float32Array(packedCount);

  let k = 0;
  for (let i = stride; i < outMoves.length && k < packedCount; i += stride) {
    const a = outMoves[i - stride], b = outMoves[i];
    const o6 = k * 6;
    coords[o6] = a.x; coords[o6 + 1] = a.y; coords[o6 + 2] = a.z;
    coords[o6 + 3] = b.x; coords[o6 + 4] = b.y; coords[o6 + 5] = b.z;
    slopes[k] = b.slope;
    speeds[k] = b.f;
    flows[k] = b.epm;
    extruding[k] = b.travel ? 0 : 1;
    zs[k] = b.z;
    k++;
  }

  const render = {
    count: k,
    total_segments: totalSegs,
    stride,
    coords,
    slopes,
    speeds,
    flows,
    extruding,
    zs,
    ooze_events: [],
  };

  // Build analysis & safety checks
  if (!Number.isFinite(bMinX)) { bMinX = bMaxX = bMinY = bMaxY = bMinZ = bMaxZ = 0; }
  const estLayers = Math.max(1, (bMaxZ - bMinZ) / Math.max(layerH, 0.1));
  const avgLayerTimeS = estTimeS / estLayers;

  let materialLabel;
  if (!profile.heated) {
    const volCm3 = (totalPrintMm * lineW * layerH) / 1000.0;
    materialLabel = `${volCm3.toFixed(1)} cm³ Ton (~${Math.round(volCm3 * 1.9)} g nass)`;
  } else {
    const filArea = Math.PI * (1.75 * 0.5) ** 2;
    const grams = ((totalE * filArea) / 1000.0) * 1.24;
    materialLabel = `${(totalE / 1000.0).toFixed(2)} m PLA (~${grams.toFixed(1)} g)`;
  }

  const checks = [];
  const bedDesc = isCircleBed
    ? `Delta Ø${profile.bed_diameter_mm}×${profile.bed_height_mm} mm`
    : `Bett ${profile.bed_width_mm}×${profile.bed_depth_mm}×${profile.bed_height_mm} mm`;
  checks.push(outOfBounds === 0
    ? { level: "ok", title: "Bauraum", detail: `Alle Punkte innerhalb ${bedDesc}.` }
    : { level: "error", title: "Bauraum überschritten!", detail: `${outOfBounds} Segmente liegen außerhalb von ${bedDesc}.` });
  checks.push(collisionCount === 0
    ? { level: "ok", title: "Non-Planar Kollision", detail: `Max. Steigung ${maxSlope.toFixed(1)}° (Limit: ${angleLimit}°).` }
    : { level: collisionCount < 25 ? "warn" : "error", title: `Kollisionsrisiko (${collisionCount} Segmente)`, detail: `Max. Steigung ${maxSlope.toFixed(1)}° überschreitet Limit (${angleLimit}°).` });
  checks.push(!profile.heated
    ? { level: "ok", title: "Temperaturen (Clay)", detail: "Keine Heizbefehle aktiv – sauber für WASP 2040 LDM." }
    : { level: "ok", title: "Temperaturen (PLA)", detail: `Düse ${opts.nozzle_temp_c || 205} °C, Bett ${opts.bed_temp_c || 60} °C.` });

  // Check actual physical vertical spacing between turns (catches WASP-sliced G-code opened on Ender!)
  const actualTurns = turnZSum.size;
  const actualLayerGap = actualTurns > 2 ? (bMaxZ - bMinZ) / actualTurns : layerH;
  if (actualLayerGap > nozzleMm * 0.95) {
    checks.push({
      level: "error",
      title: `Schichtabstand zu groß (${actualLayerGap.toFixed(2)} mm)!`,
      detail: `Die Druckbahnen liegen bei ${nozzleMm.toFixed(1)} mm Düse nicht aufeinander! Bitte Schichthöhe auf ≤ ${(nozzleMm * 0.75).toFixed(2)} mm setzen oder Vorlage / .stl neu laden.`,
    });
  }

  const analysis = {
    profile_id: profile.id,
    profile_name: profile.name,
    bounds: {
      min_x: Number(bMinX.toFixed(2)), max_x: Number(bMaxX.toFixed(2)),
      min_y: Number(bMinY.toFixed(2)), max_y: Number(bMaxY.toFixed(2)),
      min_z: Number(bMinZ.toFixed(2)), max_z: Number(bMaxZ.toFixed(2)),
      cx: Number((0.5 * (bMinX + bMaxX)).toFixed(2)),
      cy: Number((0.5 * (bMinY + bMaxY)).toFixed(2)),
    },
    stats: {
      segment_count: totalSegs,
      extruding_count: extCount,
      ooze_count: activeRows.size * oozeCount,
      print_length_m: Number((totalPrintMm / 1000.0).toFixed(2)),
      total_e_mm: Number(totalE.toFixed(1)),
      est_time_s: Number(estTimeS.toFixed(1)),
      est_time_min: Number((estTimeS / 60.0).toFixed(1)),
      avg_layer_time_s: Number(avgLayerTimeS.toFixed(1)),
      max_slope_deg: Number(maxSlope.toFixed(1)),
      angle_limit_deg: angleLimit,
      collision_count: collisionCount,
      material_label: materialLabel,
    },
    checks,
  };

  return {
    render,
    analysis,
    buildGcode: () => serializeMovesToGcode(outMoves, profile, { ...opts, _total_e_mm: totalE, _est_time_s: estTimeS, _layer_h: layerH }),
  };
}

function serializeMovesToGcode(moves, profile, opts = {}) {
  const lines = [
    `;TIME:${Math.round(opts._est_time_s || 0)}`,
    `;Filament used: ${((opts._total_e_mm || 0) / 1000.0).toFixed(3)}m`,
    `;Layer height: ${(opts._layer_h || profile.default_layer_height_mm).toFixed(2)}`,
    renderStartGcode(profile, opts.nozzle_temp_c || 205, opts.bed_temp_c || 60, opts.fan_pct || 80),
    "; --- BEGIN CUSTOM TOOLPATH ---",
  ];
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (i === 0) {
      lines.push(`G1 Z${(m.z + 5.0).toFixed(3)} F${Math.round(profile.travel_speed_f)} ; Sichere Anfahrt`);
      lines.push(`G1 X${m.x.toFixed(3)} Y${m.y.toFixed(3)} F${Math.round(profile.travel_speed_f)}`);
      lines.push(`G1 Z${m.z.toFixed(3)} F600`);
    } else if (m.travel && m.e <= 0) {
      lines.push(`G0 X${m.x.toFixed(3)} Y${m.y.toFixed(3)} Z${m.z.toFixed(3)} F${Math.round(m.f)}`);
    } else {
      lines.push(`G1 X${m.x.toFixed(3)} Y${m.y.toFixed(3)} Z${m.z.toFixed(3)} E${m.e.toFixed(4)} F${Math.round(m.f)}`);
    }
  }
  lines.push("; --- END CUSTOM TOOLPATH ---");
  lines.push(profile.end_gcode);
  return lines.join("\n") + "\n";
}

// ============================================================================
// SPIRAL LAYER RESAMPLER
// Re-spaces a loaded spiral G-code (e.g. sliced with 1.2 mm clay layers) to the
// target layer height of the current printer (e.g. 0.12 mm on the Ender-5 S1).
// Returns null if no resampling is needed or the toolpath is not a spiral vessel.
// ============================================================================
export function resampleSpiralPoints(pts, layerH, nozzleMm = 0.4) {
  const wall = pts.filter((p) => !p.is_base && !p.travel);
  if (wall.length < 200) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of wall) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const cx = 0.5 * (minX + maxX);
  const cy = 0.5 * (minY + maxY);

  const BINS = 128;
  const TWO_PI = 2 * Math.PI;
  const turns = new Map();
  let prevAng = null;
  let unwrapped = 0;

  for (const p of wall) {
    const ang = Math.atan2(p.y - cy, p.x - cx);
    if (prevAng === null) {
      unwrapped = ang >= 0 ? ang : ang + TWO_PI;
    } else {
      let d = ang - prevAng;
      if (d > Math.PI) d -= TWO_PI;
      else if (d < -Math.PI) d += TWO_PI;
      unwrapped += d;
    }
    prevAng = ang;
    const ti = Math.floor(unwrapped / TWO_PI);
    let row = turns.get(ti);
    if (!row) {
      row = { r: new Float32Array(BINS), zSum: 0, n: 0 };
      turns.set(ti, row);
    }
    const angPos = ang >= 0 ? ang : ang + TWO_PI;
    const b = Math.min(BINS - 1, Math.floor((angPos / TWO_PI) * BINS));
    const rr = Math.hypot(p.x - cx, p.y - cy);
    if (rr > row.r[b]) row.r[b] = rr;
    row.zSum += p.z;
    row.n += 1;
  }

  const direction = unwrapped >= 0 ? 1 : -1;
  const rings = [];
  for (const row of turns.values()) {
    let filled = 0;
    for (let b = 0; b < BINS; b++) if (row.r[b] > 0) filled++;
    if (filled < BINS * 0.4) continue;
    for (let b = 0; b < BINS; b++) {
      if (row.r[b] > 0) continue;
      for (let off = 1; off < BINS; off++) {
        const a = row.r[(b + off) % BINS];
        if (a > 0) { row.r[b] = a; break; }
        const c = row.r[(b - off + BINS) % BINS];
        if (c > 0) { row.r[b] = c; break; }
      }
    }
    rings.push({ z: row.zSum / row.n, r: row.r });
  }
  if (rings.length < 3) return null;
  rings.sort((a, b) => a.z - b.z);

  const actualGap = (maxZ - minZ) / rings.length;
  const targetH = Math.max(0.08, Number(layerH) || 0.2);
  // Only resample when the source spacing clearly does not match the target layer height
  if (actualGap < Math.max(targetH * 1.5, nozzleMm * 0.9)) return null;

  const z0 = rings[0].z;
  const z1 = rings[rings.length - 1].z;
  const layers = Math.max(10, Math.min(4000, Math.round((z1 - z0) / targetH)));
  const total = layers * BINS;
  const speedF = wall[0].f_orig || 1800;
  const out = [];

  // Keep original base / floor points untouched
  for (const p of pts) if (p.is_base) out.push({ ...p });

  let ri = 0;
  for (let i = 0; i <= total; i++) {
    const v = i / total;
    const z = z0 + v * (z1 - z0);
    while (ri < rings.length - 2 && rings[ri + 1].z < z) ri++;
    const ra = rings[ri];
    const rb = rings[ri + 1];
    const f = Math.max(0, Math.min(1, (z - ra.z) / Math.max(1e-6, rb.z - ra.z)));
    const step = i % BINS;
    const b = direction > 0 ? step : (BINS - step) % BINS;
    const rad = ra.r[b] * (1 - f) + rb.r[b] * f;
    const ang = (b / BINS) * TWO_PI;
    out.push({
      x: cx + rad * Math.cos(ang),
      y: cy + rad * Math.sin(ang),
      z,
      travel: out.length === 0,
      is_base: false,
      f_orig: speedF,
      e_orig: 0,
    });
  }
  return { pts: out, layers, source_gap: actualGap };
}
