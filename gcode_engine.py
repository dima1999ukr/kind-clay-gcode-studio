"""Core G-code parsing, collision/safety analysis, non-planar & creative
post-processing (Weaving + Intentional Oozing), and WASP <-> Ender-5 S1 conversion.
"""

from __future__ import annotations
import io
import math
import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from profiles import PRINTER_PROFILES, compute_e_per_mm, get_profile, render_start_gcode

_HEIGHTMAP_CACHE: Dict[str, Dict[str, Any]] = {}


def register_heightmap_bytes(raw_bytes: bytes, filename: str = "heightmap.png") -> Dict[str, Any]:
    """Decode an uploaded image (.png/.jpg/.webp) into a normalized 256x256 grayscale heightmap."""
    import hashlib
    from PIL import Image

    img = Image.open(io.BytesIO(raw_bytes)).convert("L")
    img.thumbnail((256, 256))
    arr = np.asarray(img, dtype=np.float32) / 255.0
    # Flip vertically so image top corresponds to vessel top (high Z)
    arr = np.flipud(arr)
    hm_id = hashlib.md5(raw_bytes[:65536] + filename.encode("utf-8", errors="ignore")).hexdigest()[:12]
    _HEIGHTMAP_CACHE[hm_id] = {
        "grid": arr,
        "width": int(arr.shape[1]),
        "height": int(arr.shape[0]),
        "name": filename,
    }
    return {"heightmap_id": hm_id, "width": int(arr.shape[1]), "height": int(arr.shape[0]), "name": filename}


def register_procedural_heightmap(kind: str = "voronoi") -> Dict[str, Any]:
    """Generate a crisp procedural 192x192 grayscale heightmap for instant testing."""
    h, w = 192, 192
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / float(w)
    v = yy / float(h)

    if kind == "checker":
        grid = (((np.floor(u * 8.0) + np.floor(v * 8.0)) % 2.0) == 0).astype(np.float32)
        # Mild blur for smooth clay transitions
        for _ in range(3):
            grid = 0.25 * np.roll(grid, 1, 0) + 0.25 * np.roll(grid, -1, 0) + 0.25 * np.roll(grid, 1, 1) + 0.25 * np.roll(grid, -1, 1)
    elif kind == "diagonal":
        grid = 0.5 + 0.5 * np.sin(2.0 * np.pi * (u * 6.0 + v * 4.0)) * np.cos(2.0 * np.pi * (u * 6.0 - v * 4.0))
    elif kind == "circles":
        du = (u * 4.0) % 1.0 - 0.5
        dv = (v * 4.0) % 1.0 - 0.5
        d = np.sqrt(du * du + dv * dv)
        grid = np.clip(1.0 - d * 2.4, 0.0, 1.0)
        grid = grid * grid * (3.0 - 2.0 * grid)
    else:  # voronoi / organic cellular
        rng = np.random.RandomState(42)
        pts = rng.rand(24, 2).astype(np.float32)
        d1 = np.full((h, w), 1e9, dtype=np.float32)
        d2 = np.full((h, w), 1e9, dtype=np.float32)
        for px, py in pts:
            du = np.abs(u - px)
            du = np.minimum(du, 1.0 - du)
            dv = np.abs(v - py)
            dv = np.minimum(dv, 1.0 - dv)
            dist = np.sqrt(du * du + dv * dv)
            closer = dist < d1
            d2 = np.where(closer, d1, np.minimum(d2, dist))
            d1 = np.where(closer, dist, d1)
        edge = np.clip((d2 - d1) * 9.0, 0.0, 1.0)
        grid = 1.0 - edge  # Raised cellular ridges

    hm_id = f"proc_{kind}"
    _HEIGHTMAP_CACHE[hm_id] = {
        "grid": grid.astype(np.float32),
        "width": w,
        "height": h,
        "name": f"Muster: {kind}",
    }
    return {"heightmap_id": hm_id, "width": w, "height": h, "name": f"Muster: {kind}"}


def _sample_heightmap(grid: np.ndarray, u: float, v: float) -> float:
    """Fast bilinear sampling of a [0, 1] grayscale heightmap with wrap-X and clamp-Y."""
    h, w = grid.shape
    uf = (u % 1.0) * (w - 1)
    vf = max(0.0, min(1.0, v)) * (h - 1)
    x0 = int(uf)
    y0 = int(vf)
    x1 = (x0 + 1) % w
    y1 = min(h - 1, y0 + 1)
    tx = uf - x0
    ty = vf - y0
    v00 = float(grid[y0, x0])
    v10 = float(grid[y0, x1])
    v01 = float(grid[y1, x0])
    v11 = float(grid[y1, x1])
    return (v00 * (1.0 - tx) + v10 * tx) * (1.0 - ty) + (v01 * (1.0 - tx) + v11 * tx) * ty


def _eval_waveform(theta: float, waveform: str) -> float:
    """Evaluate a periodic waveform in [-1, +1] at phase angle theta (radians)."""
    if waveform == "triangle":
        return (2.0 / math.pi) * math.asin(max(-1.0, min(1.0, math.sin(theta))))
    if waveform == "square":
        # Smooth-edged brick/ribbed wave so clay extrusion stays continuous
        return math.tanh(3.2 * math.sin(theta))
    if waveform == "sawtooth":
        # Clay-friendly directional sawtooth: linear rise over 82%, smooth return over 18%
        u = (theta / (2.0 * math.pi)) % 1.0
        if u < 0.82:
            return -1.0 + 2.0 * (u / 0.82)
        return 1.0 - 2.0 * ((u - 0.82) / 0.18)
    if waveform == "scales":
        # Half-wave staggered arches (ceramic fish-scale / shingle look)
        return 2.0 * abs(math.sin(0.5 * theta)) - 1.0
    return math.sin(theta)

_PARAM_RE = re.compile(r"([A-Za-z])([-+]?\d*\.?\d+)")


def _parse_params(code_part: str) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for letter, val in _PARAM_RE.findall(code_part):
        try:
            out[letter.upper()] = float(val)
        except ValueError:
            pass
    return out


def parse_gcode(gcode_text: str) -> Dict[str, Any]:
    """Parse G-code text into structured motion segments and machine metadata."""
    lines = gcode_text.splitlines()
    abs_xyz = True
    rel_e = False
    x = y = z = 0.0
    e_abs = 0.0
    f = 1200.0
    has_g28 = False
    has_g90 = False
    has_m83 = False
    has_m82 = False
    temps_nozzle: List[float] = []
    temps_bed: List[float] = []
    fan_values: List[float] = []
    has_moved_xy = False

    segments: List[Dict[str, Any]] = []
    ooze_events: List[Dict[str, Any]] = []
    in_base_section = False

    for idx, raw_line in enumerate(lines, start=1):
        parts = raw_line.split(";", 1)
        code_part = parts[0].strip()
        comment = parts[1].strip() if len(parts) > 1 else ""
        c_up = comment.upper()
        if "BEGIN_BASE" in c_up:
            in_base_section = True
        elif "BEGIN_WALL" in c_up:
            in_base_section = False
        is_prime_comment = "PRIME" in c_up
        if not code_part:
            continue

        tokens = code_part.split()
        cmd = tokens[0].upper()
        params = _parse_params(code_part[len(cmd):])

        if cmd == "G90":
            abs_xyz = True
            has_g90 = True
        elif cmd == "G91":
            abs_xyz = False
        elif cmd == "M83":
            rel_e = True
            has_m83 = True
        elif cmd == "M82":
            rel_e = False
            has_m82 = True
        elif cmd == "G28":
            has_g28 = True
            x = y = z = 0.0
        elif cmd == "G92":
            if "X" in params:
                x = params["X"]
            if "Y" in params:
                y = params["Y"]
            if "Z" in params:
                z = params["Z"]
            if "E" in params:
                e_abs = params["E"]
        elif cmd in ("M104", "M109") and "S" in params:
            temps_nozzle.append(params["S"])
        elif cmd in ("M140", "M190") and "S" in params:
            temps_bed.append(params["S"])
        elif cmd == "M106" and "S" in params:
            fan_values.append(params["S"])
        elif cmd == "G4":
            ms = params.get("P", 0.0) + params.get("S", 0.0) * 1000.0
            if ms > 0 and has_moved_xy and z > 0.05:
                ooze_events.append({
                    "x": round(x, 3),
                    "y": round(y, 3),
                    "z": round(z, 3),
                    "dwell_ms": round(ms, 1),
                    "extra_e": 0.0,
                    "line_no": idx,
                })
        elif cmd in ("G0", "G1"):
            if "F" in params and params["F"] > 0:
                f = params["F"]

            nx = (params["X"] if abs_xyz else x + params["X"]) if "X" in params else x
            ny = (params["Y"] if abs_xyz else y + params["Y"]) if "Y" in params else y
            nz = (params["Z"] if abs_xyz else z + params["Z"]) if "Z" in params else z

            if "E" in params:
                if rel_e:
                    e_rel = params["E"]
                    e_abs += e_rel
                else:
                    e_rel = params["E"] - e_abs
                    e_abs = params["E"]
            else:
                e_rel = 0.0

            dx = nx - x
            dy = ny - y
            dz = nz - z
            xy_dist = math.hypot(dx, dy)
            length_3d = math.sqrt(dx * dx + dy * dy + dz * dz)

            # Pure in-place extrusion (ooze/blob pulse after dwell or stationary)
            if length_3d < 1e-6 and e_rel > 0.01 and has_moved_xy and z > 0.05:
                if ooze_events and abs(ooze_events[-1]["x"] - x) < 0.05 and abs(ooze_events[-1]["y"] - y) < 0.05 and abs(ooze_events[-1]["z"] - z) < 0.05:
                    ooze_events[-1]["extra_e"] = round(ooze_events[-1]["extra_e"] + e_rel, 4)
                else:
                    ooze_events.append({
                        "x": round(x, 3),
                        "y": round(y, 3),
                        "z": round(z, 3),
                        "dwell_ms": 0.0,
                        "extra_e": round(e_rel, 4),
                        "line_no": idx,
                    })
            elif length_3d > 1e-6:
                slope_deg = math.degrees(math.atan2(abs(dz), xy_dist)) if xy_dist > 1e-6 else (90.0 if abs(dz) > 1e-6 else 0.0)
                is_extruding = e_rel > 1e-6
                # Ignore prime lines at X < 5 when bed center is 110
                segments.append({
                    "x0": x, "y0": y, "z0": z,
                    "x1": nx, "y1": ny, "z1": nz,
                    "e": e_rel,
                    "f": f,
                    "len3d": length_3d,
                    "xy": xy_dist,
                    "dz": dz,
                    "slope": slope_deg,
                    "extruding": is_extruding,
                    "is_prime": is_prime_comment,
                    "is_base": in_base_section,
                    "e_per_mm": (e_rel / length_3d) if (is_extruding and length_3d > 1e-6) else 0.0,
                    "line_no": idx,
                })
                if "X" in params or "Y" in params:
                    has_moved_xy = True

            x, y, z = nx, ny, nz

    return {
        "segments": segments,
        "ooze_events": ooze_events,
        "meta": {
            "line_count": len(lines),
            "has_g28": has_g28,
            "has_g90": has_g90,
            "has_m83": has_m83,
            "has_m82": has_m82,
            "extrusion_mode": "M83" if has_m83 and not has_m82 else ("M82" if has_m82 else "unknown"),
            "nozzle_temps": temps_nozzle,
            "bed_temps": temps_bed,
            "fan_values": fan_values,
        },
    }


def _compute_print_bounds(segments: List[Dict[str, Any]]) -> Dict[str, float]:
    ext = [s for s in segments if s["extruding"] and not s.get("is_prime")]
    if not ext:
        ext = [s for s in segments if s["extruding"]]
    pts = ext if ext else segments
    if not pts:
        return {"min_x": 0, "max_x": 0, "min_y": 0, "max_y": 0, "min_z": 0, "max_z": 0, "cx": 0, "cy": 0, "max_r": 0}
    xs = [s["x0"] for s in pts] + [s["x1"] for s in pts]
    ys = [s["y0"] for s in pts] + [s["y1"] for s in pts]
    zs = [s["z0"] for s in pts] + [s["z1"] for s in pts]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    cx = 0.5 * (min_x + max_x)
    cy = 0.5 * (min_y + max_y)
    max_r = max(math.hypot(x - cx, y - cy) for x, y in zip(xs, ys))
    return {
        "min_x": round(min_x, 2), "max_x": round(max_x, 2),
        "min_y": round(min_y, 2), "max_y": round(max_y, 2),
        "min_z": round(min_z, 2), "max_z": round(max_z, 2),
        "cx": round(cx, 2), "cy": round(cy, 2),
        "max_r": round(max_r, 2),
    }


def analyze_gcode(
    parsed: Dict[str, Any],
    profile_id: str,
    max_nozzle_angle_deg: Optional[float] = None,
) -> Dict[str, Any]:
    """Run safety, collision, build-volume, and material/time analysis."""
    profile = get_profile(profile_id)
    segs = parsed["segments"]
    ooze = parsed["ooze_events"]
    meta = parsed["meta"]
    angle_limit = float(max_nozzle_angle_deg if max_nozzle_angle_deg is not None else profile["max_nozzle_angle_deg"])

    ext_segs = [s for s in segs if s["extruding"] and not s.get("is_prime")]
    if not ext_segs:
        ext_segs = [s for s in segs if s["extruding"]]
    bounds = _compute_print_bounds(segs)

    total_print_mm = sum(s["len3d"] for s in ext_segs)
    total_travel_mm = sum(s["len3d"] for s in segs if not s["extruding"])
    total_e = sum(s["e"] for s in ext_segs) + sum(o["extra_e"] for o in ooze)

    est_time_s = sum((s["len3d"] / max(s["f"] / 60.0, 0.5)) for s in segs) + sum(o["dwell_ms"] / 1000.0 for o in ooze)

    # Non-planar stats & collision risks (only on extruding segments with xy > 0.1mm)
    nonplanar_segs = [s for s in ext_segs if abs(s["dz"]) > 0.02 and s["xy"] > 0.05]
    collision_segs = [s for s in nonplanar_segs if s["slope"] > angle_limit]
    max_slope = max((s["slope"] for s in nonplanar_segs), default=0.0)

    # Average layer printing time (Breseghello et al. 2021 buildability metric for wet clay/paste)
    est_lh = _estimate_layer_height(ext_segs, profile["default_layer_height_mm"])
    est_layers = max(1.0, (bounds["max_z"] - bounds["min_z"]) / max(est_lh, 0.1))
    avg_layer_time_s = est_time_s / est_layers

    # Material estimation
    if profile["id"] == "wasp_2040_clay":
        # Rough ceramic volume from bead cross-section (default ~2.2mm x 1.2mm -> ~2.64 mm^2)
        bead_area_mm2 = profile["default_line_width_mm"] * profile["default_layer_height_mm"]
        volume_cm3 = (total_print_mm * bead_area_mm2) / 1000.0
        material_label = f"{volume_cm3:.1f} cm³ Ton (~{volume_cm3 * 1.9:.0f} g nass)"
    else:
        fil_area = math.pi * (1.75 * 0.5) ** 2
        volume_cm3 = (total_e * fil_area) / 1000.0
        grams = volume_cm3 * 1.24
        material_label = f"{total_e / 1000.0:.2f} m PLA (~{grams:.1f} g)"

    # Safety & pre-flight checks
    checks: List[Dict[str, str]] = []

    # 1. Build volume check
    out_of_bounds = 0
    if profile["bed_shape"] == "circle":
        rad_lim = profile["bed_diameter_mm"] * 0.5
        for s in ext_segs:
            if math.hypot(s["x1"], s["y1"]) > rad_lim + 0.5 or s["z1"] > profile["bed_height_mm"] or s["z1"] < -0.05:
                out_of_bounds += 1
        bed_desc = f"Delta Ø{profile['bed_diameter_mm']:.0f}×{profile['bed_height_mm']:.0f} mm (Ursprung 0,0)"
    else:
        w, d, h = profile["bed_width_mm"], profile["bed_depth_mm"], profile["bed_height_mm"]
        for s in ext_segs:
            if not (-0.5 <= s["x1"] <= w + 0.5 and -0.5 <= s["y1"] <= d + 0.5 and -0.05 <= s["z1"] <= h + 0.5):
                out_of_bounds += 1
        bed_desc = f"Bett {w:.0f}×{d:.0f}×{h:.0f} mm"

    if out_of_bounds == 0 and ext_segs:
        checks.append({"level": "ok", "title": "Bauraum", "detail": f"Alle Punkte innerhalb {bed_desc}."})
    elif not ext_segs:
        checks.append({"level": "warn", "title": "Bauraum", "detail": "Keine Extrusions-Segmente erkannt."})
    else:
        checks.append({
            "level": "error",
            "title": "Bauraum überschritten!",
            "detail": f"{out_of_bounds} Segmente liegen außerhalb von {bed_desc}. Tipp: 1-Klick-Profil-Konvertierung nutzen!",
        })

    # 2. Collision / slope check
    if len(collision_segs) == 0:
        checks.append({
            "level": "ok",
            "title": "Non-Planar Kollision",
            "detail": f"Max. Steigung {max_slope:.1f}° (Limit: {angle_limit:.0f}°).",
        })
    else:
        checks.append({
            "level": "warn" if len(collision_segs) < 25 else "error",
            "title": f"Kollisionsrisiko ({len(collision_segs)} Segmente)",
            "detail": f"Max. Steigung {max_slope:.1f}° überschreitet Düsen-Freiwinkel ({angle_limit:.0f}°). Amplitude verringern oder Lüfterabdeckung prüfen.",
        })

    # 3. Temperature check
    nonzero_nozzle = [t for t in meta["nozzle_temps"] if t > 0]
    nonzero_bed = [t for t in meta["bed_temps"] if t > 0]
    if profile["heated"]:
        if not nonzero_nozzle:
            checks.append({"level": "error", "title": "Düsentemperatur fehlt", "detail": "Kein M104/M109 > 0 °C für Ender-5 S1 gefunden (Cold-Extrusion-Fehler!)."})
        elif max(nonzero_nozzle) > profile["max_safe_temp_c"]:
            checks.append({"level": "error", "title": "Übertemperatur!", "detail": f"Düsentemperatur {max(nonzero_nozzle):.0f} °C liegt über Limit ({profile['max_safe_temp_c']:.0f} °C)!"})
        else:
            bed_str = f", Bett {max(nonzero_bed):.0f} °C" if nonzero_bed else ""
            checks.append({"level": "ok", "title": "Temperaturen (FDM)", "detail": f"Düse {max(nonzero_nozzle):.0f} °C{bed_str}."})
    else:
        if nonzero_nozzle or nonzero_bed:
            checks.append({"level": "error", "title": "Heizbefehle auf WASP Clay!", "detail": "M104/M109/M140/M190 gefunden – für Ton-Drucker entfernen (Profil konvertieren)."})
        else:
            checks.append({"level": "ok", "title": "Temperaturen (Clay)", "detail": "Keine Heizbefehle aktiv – sauber für WASP 2040 LDM."})

    # 4. Homing & Extrusion mode
    if meta["has_g28"] and meta["has_g90"]:
        checks.append({"level": "ok", "title": "Init & Modus", "detail": f"G28 Homing, G90 Absolut, Extrusion: {meta['extrusion_mode']}."})
    else:
        missing = []
        if not meta["has_g28"]:
            missing.append("G28")
        if not meta["has_g90"]:
            missing.append("G90")
        checks.append({"level": "warn", "title": "Init unvollständig", "detail": f"Fehlend im Header: {', '.join(missing)}."})

    # 5. Negative Z safety
    if bounds["min_z"] < -0.05:
        checks.append({"level": "error", "title": "Negatives Z!", "detail": f"Minimaler Z-Wert ist {bounds['min_z']:.2f} mm – Gefahr von Druckbett-Crash!"})

    return {
        "profile_id": profile_id,
        "bounds": bounds,
        "stats": {
            "segment_count": len(segs),
            "extruding_count": len(ext_segs),
            "nonplanar_count": len(nonplanar_segs),
            "collision_count": len(collision_segs),
            "ooze_count": len(ooze),
            "total_print_mm": round(total_print_mm, 1),
            "total_travel_mm": round(total_travel_mm, 1),
            "total_e": round(total_e, 2),
            "max_slope_deg": round(max_slope, 1),
            "angle_limit_deg": angle_limit,
            "est_time_s": round(est_time_s, 1),
            "avg_layer_time_s": round(avg_layer_time_s, 1),
            "material_label": material_label,
        },
        "checks": checks,
    }


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 <= edge0:
        return 1.0 if x >= edge0 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def _zone_weight(z: float, z_min: float, z_max: float, fade_mm: float = 6.0) -> float:
    if z < z_min or z > z_max:
        return 0.0
    if fade_mm <= 0.0:
        return 1.0
    w_low = _smoothstep(z_min, z_min + fade_mm, z)
    w_high = 1.0 - _smoothstep(z_max - fade_mm, z_max, z)
    return max(0.0, min(1.0, w_low * w_high))


def _estimate_layer_height(ext_segs: List[Dict[str, Any]], fallback: float) -> float:
    if len(ext_segs) < 10:
        return fallback
    zs = sorted({round(s["z1"], 2) for s in ext_segs if s["z1"] > 0.05})
    if len(zs) < 3:
        return fallback
    diffs = [zs[i + 1] - zs[i] for i in range(len(zs) - 1) if 0.08 <= (zs[i + 1] - zs[i]) <= 5.0]
    if not diffs:
        return fallback
    diffs.sort()
    return diffs[len(diffs) // 2]


def process_and_generate_gcode(
    gcode_text: str,
    target_profile_id: str,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Apply creative post-processing modifiers (Weaving, Non-Planar Z, Oozing,
    Flow/Speed) and cleanly convert to the target printer profile (WASP <-> Ender-5 S1).
    """
    opts = options or {}
    profile = get_profile(target_profile_id)

    # Printer & extrusion parameters
    nozzle_mm = float(opts.get("nozzle_mm", profile["default_nozzle_mm"]))
    req_layer_h = opts.get("layer_height_mm")
    req_line_w = opts.get("line_width_mm")
    line_w = float(req_line_w if req_line_w is not None else nozzle_mm * 1.15)
    flow_mult = float(opts.get("flow_multiplier", 1.0))
    base_speed_f = float(opts.get("speed_f", profile["default_speed_f"]))
    recalc_e = bool(opts.get("recalc_e", True))
    nozzle_temp = int(opts.get("nozzle_temp_c", profile.get("default_nozzle_temp_c", 205)))
    bed_temp = int(opts.get("bed_temp_c", profile.get("default_bed_temp_c", 60)))
    fan_pct = int(opts.get("fan_pct", profile.get("default_fan_pct", 80)))

    # If editing a built-in preset shape, regenerate its base spiral natively at the exact
    # target layer_height_mm & line_width_mm so switching Ender-5 S1 <-> WASP 2040 Clay
    # produces real physical layer counts (e.g. ~50 thick clay coils instead of 192 thin FDM layers)!
    include_base = bool(opts.get("include_base", True))
    preset_shape = opts.get("preset_shape")
    base_gcode_regenerated: Optional[str] = None
    if preset_shape == "parametric":
        lh_gen = float(req_layer_h) if req_layer_h else profile["default_layer_height_mm"]
        param_cfg = opts.get("parametric") or {}
        gcode_text = generate_parametric_gcode(
            param_cfg,
            profile_id=target_profile_id,
            layer_height_mm=lh_gen,
            line_width_mm=line_w,
            include_base=include_base,
        )
        base_gcode_regenerated = gcode_text
    elif preset_shape in ("espresso", "tumbler", "vase", "lampshade", "square_vase"):
        lh_gen = float(req_layer_h) if req_layer_h else profile["default_layer_height_mm"]
        gcode_text = generate_preset_gcode(
            preset_shape,
            profile_id=target_profile_id,
            layer_height_mm=lh_gen,
            line_width_mm=line_w,
            include_base=include_base,
        )

    parsed = parse_gcode(gcode_text)
    segs = parsed["segments"]
    ext_segs = [s for s in segs if s["extruding"] and not s.get("is_prime")]
    if not include_base:
        wall_only = [s for s in ext_segs if not s.get("is_base")]
        if wall_only:
            ext_segs = wall_only
    if not ext_segs:
        ext_segs = [s for s in segs if s["extruding"]]

    if not ext_segs:
        analysis = analyze_gcode(parsed, target_profile_id)
        return {"gcode": gcode_text, "parsed": parsed, "analysis": analysis}

    # Filter out prime-line segments near X<5 on cartesian prints when converting
    if len(ext_segs) > 20:
        xs_sorted = sorted(s["x1"] for s in ext_segs)
        median_x = xs_sorted[len(xs_sorted) // 2]
        filtered = [s for s in ext_segs if not (median_x > 40 and s["x0"] < 6.0 and s["x1"] < 6.0 and s["z1"] < 0.6)]
        if filtered:
            ext_segs = filtered

    bounds = _compute_print_bounds(ext_segs)
    src_cx, src_cy = bounds["cx"], bounds["cy"]
    dst_cx, dst_cy = profile["origin_center"]

    recenter = bool(opts.get("recenter", True))
    scale_xy = float(opts.get("scale_xy", 1.0))
    scale_z = float(opts.get("scale_z", 1.0))

    # Optional ceramic drying + firing shrinkage compensation: scale up by 1 / (1 - s)
    shrinkage_pct = max(0.0, min(22.0, float(opts.get("shrinkage_pct", 0.0))))
    shrinkage_comp = bool(opts.get("shrinkage_compensate", False))
    if shrinkage_comp and shrinkage_pct > 0.0:
        comp_factor = 1.0 / (1.0 - shrinkage_pct / 100.0)
        scale_xy *= comp_factor
        scale_z *= comp_factor

    layer_h = float(req_layer_h if req_layer_h is not None else _estimate_layer_height(ext_segs, profile["default_layer_height_mm"]))
    e_per_mm_base = compute_e_per_mm(profile, layer_h, line_w, flow_mult)

    # Modifier A: Horizontal Weaving (XY)
    weave = opts.get("weaving", {}) or {}
    weave_on = bool(weave.get("enabled", False))
    weave_mode = str(weave.get("mode", "symmetric"))  # "symmetric" (±) | "outward" (nur nach aussen +)
    weave_waveform = str(weave.get("waveform", "sine")).lower()  # sine | triangle | square | sawtooth | scales
    weave_brick_duty = max(0.10, min(0.90, float(weave.get("brick_duty", 0.50))))
    weave_sharpness = max(0.5, min(6.0, float(weave.get("sharpness", 1.8))))
    weave_freq = float(weave.get("freq", 16.0))
    weave_phase = float(weave.get("phase_shift", 0.5))
    weave_h_amp = float(weave.get("h_amp_mm", 2.0))
    weave_z_min = float(weave.get("z_min", max(3.0, bounds["min_z"] + 3.0)))
    weave_z_max = float(weave.get("z_max", max(bounds["max_z"] - 3.0, weave_z_min + 1.0)))
    weave_fade = float(weave.get("fade_mm", 6.0))

    # Modifier B: Dedicated Non-Planar (Z-Waves / Rim-Wave / Layer Tilt)
    nonplanar = opts.get("nonplanar")
    if isinstance(nonplanar, dict):
        np_on = bool(nonplanar.get("enabled", False))
        np_mode = str(nonplanar.get("mode", "waves")).lower()  # waves | rim_wave | tilt
        np_freq = float(nonplanar.get("freq", 8.0))
        np_phase = float(nonplanar.get("phase_shift", 0.5))
        np_z_amp = float(nonplanar.get("z_amp_mm", 1.2))
        np_z_min = float(nonplanar.get("z_min", max(4.0, bounds["min_z"] + 4.0)))
        np_z_max = float(nonplanar.get("z_max", max(bounds["max_z"] - 3.0, np_z_min + 1.0)))
        np_fade = float(nonplanar.get("fade_mm", 6.0))
    else:
        legacy_z = float(weave.get("z_amp_mm", 0.0))
        np_on = weave_on and abs(legacy_z) > 1e-6
        np_mode = "waves"
        np_freq = weave_freq
        np_phase = weave_phase
        np_z_amp = legacy_z
        np_z_min = weave_z_min
        np_z_max = weave_z_max
        np_fade = weave_fade

    # Modifier D: Image-Heightmap Relief (2D grayscale image mapped onto vessel wall)
    hm = opts.get("heightmap", {}) or {}
    hm_on = bool(hm.get("enabled", False))
    hm_id = str(hm.get("heightmap_id", "") or "")
    hm_entry = _HEIGHTMAP_CACHE.get(hm_id) if (hm_on and hm_id) else None
    hm_grid = hm_entry["grid"] if hm_entry is not None else None
    hm_depth_mm = float(hm.get("depth_mm", 2.5))
    hm_repeat_x = max(0.25, float(hm.get("repeat_x", 1.0)))
    hm_repeat_y = max(0.25, float(hm.get("repeat_y", 1.0)))
    hm_invert = bool(hm.get("invert", False))
    hm_z_min = float(hm.get("z_min", max(4.0, bounds["min_z"] + 4.0)))
    hm_z_max = float(hm.get("z_max", max(bounds["max_z"] - 4.0, hm_z_min + 2.0)))
    hm_fade = float(hm.get("fade_mm", 5.0))
    vessel_max_z = max(10.0, bounds["max_z"] * scale_z)
    vessel_max_r = max(10.0, bounds["max_r"] * scale_xy)

    ooze = opts.get("oozing", {}) or {}
    ooze_on = bool(ooze.get("enabled", False))
    ooze_count = max(1, int(ooze.get("count_per_turn", 14)))
    ooze_phase = float(ooze.get("phase_shift", 0.5))
    ooze_every_n = max(1, int(ooze.get("every_n_layers", 4 if not profile["heated"] else 8)))
    ooze_dwell_ms = float(ooze.get("dwell_ms", 0.0))
    ooze_extra_e = float(ooze.get("extra_e", 0.5 if profile["heated"] else 1.5))
    ooze_push_mm = float(ooze.get("push_mm", 0.8))
    ooze_speed_f = float(ooze.get("speed_f", profile["ooze_speed_f"]))
    ooze_z_min = float(ooze.get("z_min", max(4.0, bounds["min_z"] + 4.0)))
    ooze_z_max = float(ooze.get("z_max", max(bounds["max_z"] - 4.0, ooze_z_min + 1.0)))
    # True Flow-Modulator parameters (backwards-compatible defaults if omitted)
    ooze_has_flow_mod = ("flow_min" in ooze) or ("flow_max" in ooze)
    ooze_flow_min = max(0.0, min(2.0, float(ooze.get("flow_min", 1.0))))
    ooze_flow_max = max(0.1, min(6.0, float(ooze.get("flow_max", 1.0 + min(3.2, 0.55 + ooze_extra_e * 0.85)))))
    ooze_speed_min = max(0.15, min(1.0, float(ooze.get("speed_min", 0.45))))
    ooze_curve = str(ooze.get("curve", "smooth")).lower()  # smooth | sharp | plateau | ramp_up | ramp_down
    ooze_width = max(0.15, min(0.98, float(ooze.get("width", 0.72))))

    zone_flow = opts.get("zone_override", {}) or {}
    zf_on = bool(zone_flow.get("enabled", False))
    zf_z_min = float(zone_flow.get("z_min", 0.0))
    zf_z_max = float(zone_flow.get("z_max", bounds["max_z"] + 10.0))
    zf_flow_mult = float(zone_flow.get("flow_mult", 1.0))
    zf_speed_mult = float(zone_flow.get("speed_mult", 1.0))
    slope_slowdown = bool(opts.get("slope_slowdown", True))

    # Map incoming ooze events by quantized (x, y, z) so existing GH blobs survive 1-click profile conversion
    incoming_ooze: Dict[Tuple[float, float, float], Dict[str, Any]] = {}
    if not ooze_on and parsed.get("ooze_events"):
        for ev in parsed["ooze_events"]:
            key = (round(ev["x"], 2), round(ev["y"], 2), round(ev["z"], 2))
            incoming_ooze[key] = ev

    # Build ordered point list preserving base vs wall distinction
    raw_points: List[Dict[str, Any]] = []
    for i, s in enumerate(ext_segs):
        is_base = bool(s.get("is_base", False))
        if i == 0:
            raw_points.append({"x": s["x0"], "y": s["y0"], "z": s["z0"], "e_orig": 0.0, "f_orig": s["f"], "travel": True, "is_base": is_base, "ooze": None})
        else:
            prev = ext_segs[i - 1]
            gap = math.sqrt((s["x0"] - prev["x1"]) ** 2 + (s["y0"] - prev["y1"]) ** 2 + (s["z0"] - prev["z1"]) ** 2)
            if gap > 0.25:
                raw_points.append({"x": s["x0"], "y": s["y0"], "z": s["z0"], "e_orig": 0.0, "f_orig": profile["travel_speed_f"], "travel": True, "is_base": is_base, "ooze": None})
        okey = (round(s["x1"], 2), round(s["y1"], 2), round(s["z1"], 2))
        raw_points.append({"x": s["x1"], "y": s["y1"], "z": s["z1"], "e_orig": s["e"], "f_orig": s["f"], "travel": False, "is_base": is_base, "ooze": incoming_ooze.get(okey)})

    # Optional selective face mask ("front"=-Y, "right"=+X, "back"=+Y, "left"=-X)
    # When None or all 4 faces are active, the entire 360-degree perimeter is modulated seamlessly.
    raw_faces = opts.get("active_faces")
    all_four = {"front", "right", "back", "left"}
    if isinstance(raw_faces, list) and len(raw_faces) < 4:
        active_faces = {str(f).lower() for f in raw_faces} & all_four
        use_face_mask = True
    else:
        active_faces = all_four
        use_face_mask = False

    def face_mask_weight(rx0: float, ry0: float) -> float:
        """Return smooth C1 mask weight in [0, 1] for selective wall/face modulation.
        Faces by quadrant angle:
          right: [-45°, +45°]   (+X)
          back:  [+45°, +135°]  (+Y)
          left:  [+135°, +225°] (-X)
          front: [-135°, -45°]  (-Y)
        Fades smoothly to 0 near corners between an active and an inactive face so
        unselected walls stay 100% untouched and corners remain structurally clean.
        """
        if not use_face_mask:
            return 1.0
        if not active_faces:
            return 0.0
        ang_deg = math.degrees(math.atan2(ry0, rx0))  # -180..+180
        # Determine primary face + signed distance (deg) to nearest 45-deg corner
        if -45.0 <= ang_deg < 45.0:
            face, left_nb, right_nb, local = "right", "back", "front", ang_deg
        elif 45.0 <= ang_deg < 135.0:
            face, left_nb, right_nb, local = "back", "left", "right", ang_deg - 90.0
        elif -135.0 <= ang_deg < -45.0:
            face, left_nb, right_nb, local = "front", "right", "left", ang_deg + 90.0
        else:
            face, left_nb, right_nb = "left", "front", "back"
            local = (ang_deg - 180.0) if ang_deg >= 0 else (ang_deg + 180.0)

        if face not in active_faces:
            return 0.0

        # Smooth fade margin near corners (14 deg) only if the adjacent face is INACTIVE
        fade_deg = 14.0
        w = 1.0
        dist_to_pos = 45.0 - local  # distance to +45 deg boundary (left_nb)
        dist_to_neg = local + 45.0  # distance to -45 deg boundary (right_nb)
        if left_nb not in active_faces and dist_to_pos < fade_deg:
            w = min(w, _smoothstep(2.0, fade_deg, dist_to_pos))
        if right_nb not in active_faces and dist_to_neg < fade_deg:
            w = min(w, _smoothstep(2.0, fade_deg, dist_to_neg))
        return max(0.0, min(1.0, w))

    # Pre-pass: assign clean local coordinates (rx, ry, rz) & continuous wall revolution t_turn
    # Base layers stay untouched; wall revolution counter starts cleanly at 0.0 on the first wall point!
    enriched: List[Dict[str, Any]] = []
    wall_prev_ang: Optional[float] = None
    wall_unwrapped_ang = 0.0
    turn_z_acc: Dict[int, List[float]] = {}

    for pt in raw_points:
        rx = (pt["x"] - src_cx) * scale_xy
        ry = (pt["y"] - src_cy) * scale_xy
        rz = max(0.05, pt["z"] * scale_z)
        ang = math.atan2(ry, rx)  # -pi..pi

        if pt["is_base"]:
            t_turn = -1.0
            turn_idx = -1
        else:
            if wall_prev_ang is None:
                # Start unwrapped angle cleanly in [0, 2*pi) on first wall point
                wall_unwrapped_ang = ang if ang >= 0.0 else (ang + 2.0 * math.pi)
            else:
                d_ang = ang - wall_prev_ang
                if d_ang > math.pi:
                    d_ang -= 2.0 * math.pi
                elif d_ang < -math.pi:
                    d_ang += 2.0 * math.pi
                wall_unwrapped_ang += d_ang
            wall_prev_ang = ang
            t_turn = wall_unwrapped_ang / (2.0 * math.pi)
            turn_idx = int(math.floor(t_turn))
            if not pt["travel"]:
                turn_z_acc.setdefault(turn_idx, []).append(rz)

        enriched.append({
            **pt,
            "rx": rx, "ry": ry, "rz": rz,
            "t_turn": t_turn,
            "turn_idx": turn_idx,
            "nx": 1.0, "ny": 0.0,
        })

    # Compute true local outward 2D curve normal (perpendicular to flat walls on square vase!)
    n_en = len(enriched)
    for i in range(n_en):
        e_cur = enriched[i]
        rx0, ry0 = e_cur["rx"], e_cur["ry"]
        r0 = math.hypot(rx0, ry0)
        rad_nx = (rx0 / r0) if r0 > 1e-4 else 1.0
        rad_ny = (ry0 / r0) if r0 > 1e-4 else 0.0
        if e_cur["is_base"] or e_cur["travel"] or i == 0 or i == n_en - 1:
            e_cur["nx"], e_cur["ny"] = rad_nx, rad_ny
            continue
        ep = enriched[i - 1]
        en_next = enriched[i + 1]
        if ep["is_base"] or en_next["is_base"] or ep["travel"] or en_next["travel"]:
            e_cur["nx"], e_cur["ny"] = rad_nx, rad_ny
            continue
        tx = en_next["rx"] - ep["rx"]
        ty = en_next["ry"] - ep["ry"]
        tlen = math.hypot(tx, ty)
        if tlen > 1e-5:
            # For CCW curve, outward normal is (ty, -tx) / tlen; align sign with radial vector
            nx_loc, ny_loc = ty / tlen, -tx / tlen
            if nx_loc * rad_nx + ny_loc * rad_ny < 0.0:
                nx_loc, ny_loc = -nx_loc, -ny_loc
            e_cur["nx"], e_cur["ny"] = nx_loc, ny_loc
        else:
            e_cur["nx"], e_cur["ny"] = rad_nx, rad_ny

    # Determine which COMPLETE wall turns are active Oozing Blob rows (based on unmodified base Z!)
    # Every active turn gets ALL ooze_count blobs at exact interpolated angles -> ZERO crooked or partial rows!
    active_blob_rows: Dict[int, int] = {}
    if ooze_on and turn_z_acc:
        eligible_turns = sorted(
            ti for ti, zs_list in turn_z_acc.items()
            if len(zs_list) >= 8 and ooze_z_min <= (sum(zs_list) / len(zs_list)) <= ooze_z_max
        )
        if eligible_turns:
            first_t = eligible_turns[0]
            row_counter = 0
            for ti in eligible_turns:
                if (ti - first_t) % ooze_every_n == 0:
                    active_blob_rows[ti] = row_counter
                    row_counter += 1

    # Continuous Flow-Modulator envelope: returns (bell in [0..1], in_active_row bool)
    def eval_ooze_bell(t_turn_val: float, is_base_pt: bool) -> Tuple[float, bool]:
        if not ooze_on or is_base_pt or t_turn_val < 0.0:
            return 0.0, False
        ti_local = int(math.floor(t_turn_val))
        if ti_local not in active_blob_rows:
            return 0.0, False
        row_idx = active_blob_rows[ti_local]
        phase_off = (row_idx * ooze_phase) % 1.0
        u_local = t_turn_val - ti_local
        # Signed cyclic slot offset d_signed in [-0.5, +0.5) centered on crest
        pos = (u_local * ooze_count - phase_off) % 1.0
        d_signed = pos - 1.0 if pos >= 0.5 else pos
        hw = 0.5 * ooze_width
        if abs(d_signed) >= hw:
            return 0.0, True
        q = (d_signed + hw) / (2.0 * hw)  # 0..1 across active pulse (0.5 = crest)
        cos_bell = 0.5 * (1.0 - math.cos(2.0 * math.pi * q))
        if ooze_curve == "sharp":
            val = cos_bell ** 2.6
        elif ooze_curve == "plateau":
            val = min(1.0, cos_bell * 2.2)
        elif ooze_curve == "ramp_up":
            val = ((q / 0.80) ** 1.4) if q < 0.80 else max(0.0, (1.0 - q) / 0.20)
        elif ooze_curve == "ramp_down":
            val = (q / 0.20) if q < 0.20 else max(0.0, ((1.0 - q) / 0.80) ** 1.4)
        else:
            val = cos_bell
        return max(0.0, min(1.0, val)), True

    # Helper to apply Horizontal Weaving (XY) + Independent Non-Planar (Z) + Flow-Modulator Push
    # Respects selective face_mask_weight so unselected faces stay 100% untouched!
    def apply_weave_at(
        rx0: float, ry0: float, rz0: float, t_turn_val: float, is_base_pt: bool,
        nx_in: Optional[float] = None, ny_in: Optional[float] = None,
        brick_override: Optional[float] = None,
    ) -> Tuple[float, float, float, float, float, float, float, bool]:
        if nx_in is not None and ny_in is not None:
            nx0, ny0 = nx_in, ny_in
        else:
            r0 = math.hypot(rx0, ry0)
            nx0 = (rx0 / r0) if r0 > 1e-4 else 1.0
            ny0 = (ry0 / r0) if r0 > 1e-4 else 0.0
        if is_base_pt or t_turn_val < 0.0 or (not weave_on and not np_on and not ooze_on and hm_grid is None):
            return rx0, ry0, rz0, nx0, ny0, 0.0, 0.0, False

        fw = face_mask_weight(rx0, ry0)
        if fw <= 1e-5:
            return rx0, ry0, rz0, nx0, ny0, 0.0, 0.0, False

        ti_local = int(math.floor(t_turn_val))
        u_local = t_turn_val - ti_local
        rx_out, ry_out, rz_out = rx0, ry0, rz0

        if weave_on and abs(weave_h_amp) > 1e-6:
            w_xy = _zone_weight(rz0, weave_z_min, weave_z_max, weave_fade) * fw
            if w_xy > 0.0:
                if weave_waveform == "square":
                    if brick_override is not None:
                        wave_val = brick_override
                    else:
                        cyc = (u_local * weave_freq + ti_local * weave_phase) % 1.0
                        wave_val = 1.0 if cyc < weave_brick_duty else -1.0
                    h_factor = (1.0 if wave_val > 0.0 else 0.0) if weave_mode == "outward" else wave_val
                else:
                    theta_xy = 2.0 * math.pi * (u_local * weave_freq + ti_local * weave_phase)
                    wave_val = _eval_waveform(theta_xy, weave_waveform)
                    if weave_mode == "outward":
                        h_factor = (max(0.0, (1.0 + wave_val) * 0.5)) ** weave_sharpness
                    else:
                        h_factor = wave_val
                rx_out += nx0 * (h_factor * weave_h_amp * w_xy)
                ry_out += ny0 * (h_factor * weave_h_amp * w_xy)

        if hm_grid is not None and abs(hm_depth_mm) > 1e-6:
            w_hm = _zone_weight(rz0, hm_z_min, hm_z_max, hm_fade) * fw
            if w_hm > 0.0:
                ang_u = (math.atan2(ry0, rx0) / (2.0 * math.pi)) + 0.5
                v_hm = (rz0 - hm_z_min) / max(1.0, hm_z_max - hm_z_min)
                g_val = _sample_heightmap(hm_grid, ang_u * hm_repeat_x, (v_hm * hm_repeat_y) % 1.0 if hm_repeat_y > 1.0 else v_hm)
                if hm_invert:
                    g_val = 1.0 - g_val
                rx_out += nx0 * (g_val * hm_depth_mm * w_hm)
                ry_out += ny0 * (g_val * hm_depth_mm * w_hm)

        if np_on and abs(np_z_amp) > 1e-6:
            if np_mode == "rim_wave":
                w_z = _smoothstep(np_z_min, vessel_max_z, rz0) * fw
                if w_z > 0.0:
                    theta_z = 2.0 * math.pi * (u_local * np_freq + np_phase)
                    rz_out = max(0.15, rz_out + math.sin(theta_z) * np_z_amp * w_z)
            elif np_mode == "tilt":
                w_z = _smoothstep(np_z_min, vessel_max_z, rz0) * fw
                if w_z > 0.0:
                    dir_ang = np_phase * 2.0 * math.pi
                    proj = (rx0 * math.cos(dir_ang) + ry0 * math.sin(dir_ang)) / vessel_max_r
                    rz_out = max(0.15, rz_out + proj * np_z_amp * w_z)
            else:
                w_z = _zone_weight(rz0, np_z_min, np_z_max, np_fade) * fw
                if w_z > 0.0:
                    theta_z = 2.0 * math.pi * (u_local * np_freq + ti_local * np_phase)
                    rz_out = max(0.15, rz_out + math.sin(theta_z) * np_z_amp * w_z)

        ooze_bell_raw, in_ooze_row = eval_ooze_bell(t_turn_val, is_base_pt)
        ooze_bell = ooze_bell_raw * fw
        # Pure Flow-Modulator never alters XYZ geometry; legacy push_mm only applies when flow_min/flow_max aren't used
        if (not ooze_has_flow_mod) and ooze_bell > 0.0 and ooze_push_mm != 0.0:
            rx_out += nx0 * (ooze_push_mm * ooze_bell)
            ry_out += ny0 * (ooze_push_mm * ooze_bell)

        return rx_out, ry_out, rz_out, nx0, ny0, ooze_bell_raw, fw, in_ooze_row

    out_lines: List[str] = [render_start_gcode(profile, nozzle_temp=nozzle_temp, bed_temp=bed_temp, fan_pct=fan_pct).rstrip()]
    out_lines.append("; --- BEGIN CUSTOM TOOLPATH ---")

    origin_x = dst_cx if recenter else src_cx
    origin_y = dst_cy if recenter else src_cy

    prev_x = prev_y = prev_z = None
    prev_en: Optional[Dict[str, Any]] = None
    emitted_blob_keys: set = set()

    def emit_move_to(
        fx: float, fy: float, fz: float, pt_f_orig: float, pt_e_orig: float,
        e_scale_fraction: float = 1.0, ooze_bell: float = 0.0, fw: float = 1.0, in_ooze_row: bool = False,
    ) -> None:
        nonlocal prev_x, prev_y, prev_z
        dx = fx - prev_x
        dy = fy - prev_y
        dz = fz - prev_z
        len3d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if len3d < 1e-6:
            return
        xy = math.hypot(dx, dy)
        slope_deg = math.degrees(math.atan2(abs(dz), xy)) if xy > 1e-5 else 0.0

        local_flow = 1.0
        local_speed = base_speed_f if recalc_e else pt_f_orig
        if zf_on and zf_z_min <= fz <= zf_z_max:
            local_flow *= zf_flow_mult
            local_speed *= zf_speed_mult
        if slope_slowdown and slope_deg > 12.0:
            factor = max(0.35, 1.0 - (slope_deg - 12.0) / 45.0)
            local_speed *= factor

        # True Flow-Modulator: smoothly varies extrusion from flow_min (down to 0.0x!) up to flow_max (up to 5.0x!)
        # and decelerates nozzle at high flow so the LDM clay extruder builds thick bulges cleanly.
        if in_ooze_row and fw > 1e-4:
            if ooze_has_flow_mod:
                mod_flow = ooze_flow_min + (ooze_flow_max - ooze_flow_min) * ooze_bell
                local_flow *= (1.0 - fw) + mod_flow * fw
                spd_factor = 1.0 - (1.0 - ooze_speed_min) * (ooze_bell * fw)
                local_speed *= spd_factor
            elif ooze_bell > 0.0:
                swell_gain = min(3.2, 0.55 + ooze_extra_e * 0.85)
                local_flow *= (1.0 + swell_gain * ooze_bell * fw)
                local_speed = local_speed * (1.0 - 0.55 * ooze_bell * fw) + ooze_speed_f * (0.55 * ooze_bell * fw)

        if recalc_e:
            e_val = max(0.0, len3d * e_per_mm_base * local_flow)
        else:
            e_val = max(0.0, pt_e_orig * e_scale_fraction * flow_mult * local_flow)

        out_lines.append(f"G1 X{fx:.3f} Y{fy:.3f} Z{fz:.3f} E{e_val:.4f} F{max(120.0, local_speed):.0f}")
        prev_x, prev_y, prev_z = fx, fy, fz

    for idx, en in enumerate(enriched):
        # 1. Exact 2-point crisp 90-deg Brick corner insertion on (prev_en -> en)
        if (
            weave_on
            and weave_waveform == "square"
            and abs(weave_h_amp) > 1e-6
            and prev_en is not None
            and not en["travel"]
            and not en["is_base"]
            and not prev_en["is_base"]
            and en["t_turn"] > prev_en["t_turn"] + 1e-7
        ):
            t0 = prev_en["t_turn"]
            t1 = en["t_turn"]
            ti0 = int(math.floor(t0))
            ti1 = int(math.floor(t1))
            if ti0 == ti1:
                p0 = (t0 - ti0) * weave_freq + ti0 * weave_phase
                p1 = (t1 - ti0) * weave_freq + ti0 * weave_phase
                if p1 > p0 + 1e-7:
                    k_min = int(math.floor(p0)) - 1
                    k_max = int(math.ceil(p1)) + 1
                    brick_events: List[Tuple[float, str]] = []  # (p_cross, "rise"|"fall")
                    for k in range(k_min, k_max + 1):
                        if p0 < float(k) < p1:
                            brick_events.append((float(k), "rise"))
                        p_fall = float(k) + weave_brick_duty
                        if p0 < p_fall < p1:
                            brick_events.append((p_fall, "fall"))
                    brick_events.sort(key=lambda item: item[0])
                    for p_cross, ev_kind in brick_events:
                        alpha = max(0.0, min(1.0, (p_cross - p0) / (p1 - p0)))
                        t_cross = t0 + alpha * (t1 - t0)
                        irx = prev_en["rx"] + alpha * (en["rx"] - prev_en["rx"])
                        iry = prev_en["ry"] + alpha * (en["ry"] - prev_en["ry"])
                        irz = prev_en["rz"] + alpha * (en["rz"] - prev_en["rz"])
                        if face_mask_weight(irx, iry) <= 1e-4 or _zone_weight(irz, weave_z_min, weave_z_max, weave_fade) <= 1e-4:
                            continue
                        inx = prev_en["nx"] + alpha * (en["nx"] - prev_en["nx"])
                        iny = prev_en["ny"] + alpha * (en["ny"] - prev_en["ny"])
                        inlen = math.hypot(inx, iny)
                        if inlen > 1e-5:
                            inx, iny = inx / inlen, iny / inlen
                        # Emit exact 90-degree step: Base_1 -> Out_1 on rise, Out_2 -> Base_2 on fall!
                        seq = (-1.0, 1.0) if ev_kind == "rise" else (1.0, -1.0)
                        for b_ov in seq:
                            brx, bry, brz, _, _, b_bell, b_fw, b_in = apply_weave_at(
                                irx, iry, irz, t_cross, False, inx, iny, brick_override=b_ov
                            )
                            emit_move_to(origin_x + brx, origin_y + bry, brz, en["f_orig"], en["e_orig"], 0.2, ooze_bell=b_bell, fw=b_fw, in_ooze_row=b_in)

        # 2. Exact interpolated legacy Oozing Blob crests (skipped in pure Flow-Modulator mode so XYZ path stays 100% untouched!)
        if (
            ooze_on
            and not ooze_has_flow_mod
            and prev_en is not None
            and not en["travel"]
            and not en["is_base"]
            and not prev_en["is_base"]
            and en["t_turn"] > prev_en["t_turn"] + 1e-7
        ):
            t0 = prev_en["t_turn"]
            t1 = en["t_turn"]
            ti_start = int(math.floor(t0))
            ti_end = int(math.floor(t1))
            hits: List[Tuple[float, int, int]] = []  # (t_target, ti, slot_j)
            for ti in range(ti_start, ti_end + 1):
                if ti not in active_blob_rows:
                    continue
                row_idx = active_blob_rows[ti]
                phase_off = (row_idx * ooze_phase) % 1.0
                for j in range(ooze_count):
                    t_target = ti + (j + phase_off) / float(ooze_count)
                    if t0 <= t_target <= t1 and (ti, j) not in emitted_blob_keys:
                        hits.append((t_target, ti, j))
            hits.sort(key=lambda item: item[0])

            for t_target, ti, j in hits:
                emitted_blob_keys.add((ti, j))
                alpha = max(0.0, min(1.0, (t_target - t0) / (t1 - t0)))
                irx = prev_en["rx"] + alpha * (en["rx"] - prev_en["rx"])
                iry = prev_en["ry"] + alpha * (en["ry"] - prev_en["ry"])
                irz = prev_en["rz"] + alpha * (en["rz"] - prev_en["rz"])
                if face_mask_weight(irx, iry) < 0.35:
                    continue
                inx = prev_en["nx"] + alpha * (en["nx"] - prev_en["nx"])
                iny = prev_en["ny"] + alpha * (en["ny"] - prev_en["ny"])
                inlen = math.hypot(inx, iny)
                if inlen > 1e-5:
                    inx, iny = inx / inlen, iny / inlen
                wrx, wry, wrz, _, _, bell_crest, fw_crest, in_row_crest = apply_weave_at(irx, iry, irz, t_target, False, inx, iny)
                emit_move_to(origin_x + wrx, origin_y + wry, wrz, en["f_orig"], en["e_orig"], alpha, ooze_bell=bell_crest, fw=fw_crest, in_ooze_row=in_row_crest)
                out_lines.append(";OOZE_BLOB")
                # Only emit dwell if actively extruding at crest (per physical LDM clay behavior)
                if ooze_extra_e > 0 and not ooze_has_flow_mod:
                    if ooze_dwell_ms > 0:
                        out_lines.append(f"G4 P{ooze_dwell_ms:.0f}")
                    out_lines.append(f"G1 E{ooze_extra_e * 0.45:.4f} F{max(60.0, ooze_speed_f):.0f}")

        # Emit endpoint en
        wrx, wry, wrz, _, _, bell_end, fw_end, in_row_end = apply_weave_at(en["rx"], en["ry"], en["rz"], en["t_turn"], en["is_base"], en["nx"], en["ny"])
        fx = origin_x + wrx
        fy = origin_y + wry
        fz = wrz

        if idx == 0 or en["travel"]:
            if idx == 0:
                out_lines.append(f"G1 Z{fz + 5.0:.3f} F{profile['travel_speed_f']:.0f} ; Sichere Anfahrt")
                out_lines.append(f"G1 X{fx:.3f} Y{fy:.3f} F{profile['travel_speed_f']:.0f}")
                out_lines.append(f"G1 Z{fz:.3f} F600")
            else:
                out_lines.append(f"G0 X{fx:.3f} Y{fy:.3f} Z{fz:.3f} F{profile['travel_speed_f']:.0f}")
            prev_x, prev_y, prev_z = fx, fy, fz
        else:
            emit_move_to(fx, fy, fz, en["f_orig"], en["e_orig"], 1.0, ooze_bell=bell_end, fw=fw_end, in_ooze_row=in_row_end)
            if not ooze_on and en.get("ooze"):
                ev = en["ooze"]
                out_lines.append(";OOZE_BLOB")
                if ev.get("dwell_ms", 0) > 0:
                    out_lines.append(f"G4 P{ev['dwell_ms']:.0f}")
                if ev.get("extra_e", 0) > 0:
                    scaled_e = ev["extra_e"] * (3.0 if profile["id"] == "wasp_2040_clay" else 1.0)
                    out_lines.append(f"G1 E{scaled_e:.4f} F{max(60.0, profile['ooze_speed_f']):.0f}")

        prev_en = en

    out_lines.append("; --- END CUSTOM TOOLPATH ---")
    out_lines.append(profile["end_gcode"].rstrip())
    new_gcode = "\n".join(out_lines) + "\n"

    new_parsed = parse_gcode(new_gcode)
    new_analysis = analyze_gcode(
        new_parsed,
        target_profile_id,
        max_nozzle_angle_deg=opts.get("max_nozzle_angle_deg"),
    )
    res_out: Dict[str, Any] = {"gcode": new_gcode, "parsed": new_parsed, "analysis": new_analysis}
    if base_gcode_regenerated is not None:
        res_out["base_parsed"] = parsed
    return res_out


def _eval_profile_radius(v: float, pts: List[Tuple[float, float]], smooth: bool = True) -> float:
    """Evaluate vessel radius (mm) at normalized height v in [0, 1] from sorted (r_mm, z_norm) control points."""
    if not pts:
        return 35.0
    if len(pts) == 1:
        return max(8.0, min(95.0, pts[0][0]))
    v = max(0.0, min(1.0, v))
    # Find enclosing segment [i, i+1]
    idx = 0
    for i in range(len(pts) - 1):
        if v >= pts[i][1]:
            idx = i
    idx = min(idx, len(pts) - 2)
    z0, z1 = pts[idx][1], pts[idx + 1][1]
    span = max(1e-5, z1 - z0)
    t = max(0.0, min(1.0, (v - z0) / span))
    r1 = pts[idx][0]
    r2 = pts[idx + 1][0]
    if not smooth or len(pts) < 3:
        r = r1 + t * (r2 - r1)
    else:
        # Catmull-Rom spline through profile handles
        r0 = pts[max(0, idx - 1)][0]
        r3 = pts[min(len(pts) - 1, idx + 2)][0]
        t2 = t * t
        t3 = t2 * t
        r = 0.5 * (
            (2.0 * r1)
            + (-r0 + r2) * t
            + (2.0 * r0 - 5.0 * r1 + 4.0 * r2 - r3) * t2
            + (-r0 + 3.0 * r1 - 3.0 * r2 + r3) * t3
        )
    return max(8.0, min(95.0, r))


def _rounded_polygon_unit_ring(sides: int, corner_round: float, n_pts: int = 128) -> List[Tuple[float, float]]:
    """Return n_pts uniformly arc-length-spaced CCW points on a unit-radius regular N-gon
    with smooth corner rounding in [0.0, 1.0]. For sides >= 48 or corner_round >= 0.99, returns exact circle.
    """
    sides = max(3, min(64, int(sides)))
    cr = max(0.0, min(1.0, float(corner_round)))
    if sides >= 48 or cr >= 0.99:
        return [(math.cos(2.0 * math.pi * i / n_pts), math.sin(2.0 * math.pi * i / n_pts)) for i in range(n_pts)]

    # Build regular polygon vertices rotated so flat side faces -Y ("front") for even sides (like 4-wall square!)
    rot0 = math.pi / float(sides) if (sides % 2 == 0) else -math.pi * 0.5
    verts = [(math.cos(rot0 + 2.0 * math.pi * k / sides), math.sin(rot0 + 2.0 * math.pi * k / sides)) for k in range(sides)]

    # Subdivide & smooth corners using quadratic Bezier fillet at each vertex
    dense: List[Tuple[float, float]] = []
    fillet_frac = 0.48 * cr
    sub_arc = 10
    for k in range(sides):
        p_prev = verts[(k - 1) % sides]
        p_cur = verts[k]
        p_next = verts[(k + 1) % sides]
        if fillet_frac < 0.01:
            dense.append(p_cur)
        else:
            a = (p_cur[0] + (p_prev[0] - p_cur[0]) * fillet_frac, p_cur[1] + (p_prev[1] - p_cur[1]) * fillet_frac)
            b = (p_cur[0] + (p_next[0] - p_cur[0]) * fillet_frac, p_cur[1] + (p_next[1] - p_cur[1]) * fillet_frac)
            for s in range(sub_arc + 1):
                u = s / float(sub_arc)
                om = 1.0 - u
                qx = om * om * a[0] + 2.0 * om * u * p_cur[0] + u * u * b[0]
                qy = om * om * a[1] + 2.0 * om * u * p_cur[1] + u * u * b[1]
                dense.append((qx, qy))

    # Resample uniformly by arc length
    m = len(dense)
    cum = [0.0]
    for i in range(m):
        p0 = dense[i]
        p1 = dense[(i + 1) % m]
        cum.append(cum[-1] + math.hypot(p1[0] - p0[0], p1[1] - p0[1]))
    perim = max(1e-6, cum[-1])

    out: List[Tuple[float, float]] = []
    seg_i = 0
    for i in range(n_pts):
        s_target = (i / float(n_pts)) * perim
        while seg_i < m - 1 and cum[seg_i + 1] < s_target:
            seg_i += 1
        d_seg = max(1e-9, cum[seg_i + 1] - cum[seg_i])
        t = max(0.0, min(1.0, (s_target - cum[seg_i]) / d_seg))
        p0 = dense[seg_i]
        p1 = dense[(seg_i + 1) % m]
        out.append((p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])))
    return out


def generate_parametric_gcode(
    param_cfg: Dict[str, Any],
    profile_id: str = "wasp_2040_clay",
    layer_height_mm: Optional[float] = None,
    line_width_mm: Optional[float] = None,
    include_base: bool = True,
) -> str:
    """Generate a continuous spiral clay G-code from user-sculpted 2D profile handles (A-E),
    height, polygon sides (3..64), corner rounding, and Z-twist.
    """
    profile = get_profile(profile_id)
    cx, cy = profile["origin_center"]
    layer_h = float(layer_height_mm if (layer_height_mm is not None and layer_height_mm > 0.05) else profile["default_layer_height_mm"])
    line_w = float(line_width_mm if (line_width_mm is not None and line_width_mm > 0.1) else profile["default_line_width_mm"])
    e_per_mm = compute_e_per_mm(profile, layer_h, line_w, 1.0)
    speed_f = profile["default_speed_f"]

    raw_pts = param_cfg.get("profile_points")
    if isinstance(raw_pts, list) and len(raw_pts) >= 2:
        pts = sorted([(max(8.0, min(95.0, float(p[0]))), max(0.0, min(1.0, float(p[1])))) for p in raw_pts], key=lambda q: q[1])
    else:
        pts = [(34.0, 0.0), (44.0, 0.25), (40.0, 0.50), (32.0, 0.78), (38.0, 1.0)]

    height = max(25.0, min(320.0, float(param_cfg.get("height_mm", 120.0))))
    sides = max(3, min(64, int(param_cfg.get("sides", 64))))
    corner_round = max(0.0, min(1.0, float(param_cfg.get("corner_round", 0.35))))
    twist_deg = max(-360.0, min(360.0, float(param_cfg.get("twist_deg", 0.0))))
    smooth = bool(param_cfg.get("smooth", True))

    pts_per_turn = 128
    unit_ring = _rounded_polygon_unit_ring(sides, corner_round, pts_per_turn)
    foot_r = _eval_profile_radius(0.0, pts, smooth=smooth)

    base_tag = "mit Spiralboden" if include_base else "Vasenmodus OHNE Boden"
    lines = [
        render_start_gcode(profile).rstrip(),
        f"; --- PARAMETRIC VESSEL (H={height:.0f}mm, Sides={sides}, Twist={twist_deg:.0f}deg, LH={layer_h:.2f}mm, {base_tag}) ---",
    ]

    px = py = pz = None
    first_move = True
    base_layers = (1 if layer_h >= 0.8 else 2) if include_base else 0
    if base_layers > 0:
        lines.append("; --- BEGIN_BASE ---")
        step_r = max(0.45, line_w * 0.92)
        rings_n = max(4, int(round((foot_r - 2.0) / step_r)))
        base_unit = _rounded_polygon_unit_ring(sides, corner_round, 48)
        for bl in range(base_layers):
            z_b = (bl + 1) * layer_h
            for rk in range(1, rings_n + 1):
                r_k = 2.0 + (rk / float(rings_n)) * (foot_r - 2.0)
                for i_p, (ux, uy) in enumerate(base_unit):
                    x = cx + ux * r_k
                    y = cy + uy * r_k
                    if first_move:
                        lines.append(f"G1 Z{z_b + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                        lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                        lines.append(f"G1 Z{z_b:.3f} F600")
                        first_move = False
                    elif rk == 1 and i_p == 0 and bl > 0:
                        lines.append(f"G0 X{x:.3f} Y{y:.3f} Z{z_b:.3f} F{profile['travel_speed_f']:.0f}")
                    else:
                        dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z_b - pz) ** 2)
                        lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z_b:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
                    px, py, pz = x, y, z_b

    lines.append("; --- BEGIN_WALL ---")
    z_start = (base_layers * layer_h) if base_layers > 0 else layer_h
    wall_h = max(10.0, height - z_start)
    layers = max(12, int(round(wall_h / layer_h)))
    total_pts = layers * pts_per_turn
    twist_rad_total = math.radians(twist_deg)

    for i in range(total_pts + 1):
        t = i / float(pts_per_turn)
        v = t / float(layers)
        r = _eval_profile_radius(v, pts, smooth=smooth)
        ux, uy = unit_ring[i % pts_per_turn]
        if abs(twist_rad_total) > 1e-5:
            tw = v * twist_rad_total
            ct, st = math.cos(tw), math.sin(tw)
            rx_p = (ux * ct - uy * st) * r
            ry_p = (ux * st + uy * ct) * r
        else:
            rx_p = ux * r
            ry_p = uy * r
        z = z_start + v * wall_h
        x = cx + rx_p
        y = cy + ry_p
        if first_move:
            lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 Z{z:.3f} F600")
            first_move = False
        else:
            dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
        px, py, pz = x, y, z

    lines.append(profile["end_gcode"].rstrip())
    return "\n".join(lines) + "\n"


def _rounded_square_ring(half_w: float, corner_r: float, n_pts: int = 128) -> List[Tuple[float, float]]:
    """Generate n_pts uniformly arc-length-spaced CCW points on a rounded square
    starting at (+half_w, 0) (angle = 0) so flat walls have clean uniform point spacing.
    """
    r = max(1.0, min(corner_r, half_w - 1.0))
    straight = max(0.0, 2.0 * (half_w - r))
    arc_len = 0.5 * math.pi * r
    perim = 4.0 * (straight + arc_len)
    # Walk CCW starting from (+half_w, 0) -> half of +X wall -> TR arc -> +Y wall -> TL arc -> -X wall -> BL arc -> -Y wall -> BR arc -> bottom half of +X wall
    segs = [
        ("line", (half_w, 0.0), (half_w, half_w - r), straight * 0.5),
        ("arc",  (half_w - r, half_w - r), 0.0, 0.5 * math.pi, arc_len),
        ("line", (half_w - r, half_w), (-(half_w - r), half_w), straight),
        ("arc",  (-(half_w - r), half_w - r), 0.5 * math.pi, math.pi, arc_len),
        ("line", (-half_w, half_w - r), (-half_w, -(half_w - r)), straight),
        ("arc",  (-(half_w - r), -(half_w - r)), math.pi, 1.5 * math.pi, arc_len),
        ("line", (-(half_w - r), -half_w), (half_w - r, -half_w), straight),
        ("arc",  (half_w - r, -(half_w - r)), 1.5 * math.pi, 2.0 * math.pi, arc_len),
        ("line", (half_w, -(half_w - r)), (half_w, 0.0), straight * 0.5),
    ]
    pts: List[Tuple[float, float]] = []
    for i in range(n_pts):
        s_target = (i / float(n_pts)) * perim
        acc = 0.0
        for seg in segs:
            seg_len = seg[-1]
            if seg_len <= 1e-9:
                continue
            if s_target <= acc + seg_len + 1e-9:
                t = max(0.0, min(1.0, (s_target - acc) / seg_len))
                if seg[0] == "line":
                    p0, p1 = seg[1], seg[2]
                    pts.append((p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])))
                else:
                    c0, a0, a1 = seg[1], seg[2], seg[3]
                    a = a0 + t * (a1 - a0)
                    pts.append((c0[0] + r * math.cos(a), c0[1] + r * math.sin(a)))
                break
            acc += seg_len
    return pts


def generate_preset_gcode(
    shape: str = "espresso",
    profile_id: str = "wasp_2040_clay",
    layer_height_mm: Optional[float] = None,
    line_width_mm: Optional[float] = None,
    include_base: bool = True,
) -> str:
    """Generate clean spiral M83 G-code for built-in ceramic presets:
    - espresso:    compact espresso cup (Ø48-62 mm, H=62 mm)
    - tumbler:     modern ceramic coffee tumbler (Ø72-78 mm, H=98 mm)
    - vase:        bulbous organic amphora vase (Ø64 -> Ø118 belly -> Ø58 neck -> Ø68 lip, H=165 mm)
    - lampshade:   tapered pendant lampshade (Ø110 -> Ø126 -> Ø68 mm, H=115 mm)
    - square_vase: 4-wall rounded square architectural vase (84x84 mm, R=10 mm, H=120 mm)
    """
    if shape == "espresso":
        return generate_demo_espresso_cup_gcode(
            profile_id=profile_id,
            pattern="smooth",
            layer_height_mm=layer_height_mm,
            line_width_mm=line_width_mm,
            include_base=include_base,
        )

    profile = get_profile(profile_id)
    cx, cy = profile["origin_center"]
    layer_h = float(
        layer_height_mm
        if layer_height_mm is not None and layer_height_mm > 0.05
        else (profile["default_layer_height_mm"] if profile_id == "wasp_2040_clay" else max(0.28, profile["default_layer_height_mm"]))
    )
    line_w = float(
        line_width_mm
        if line_width_mm is not None and line_width_mm > 0.1
        else profile["default_line_width_mm"]
    )
    e_per_mm = compute_e_per_mm(profile, layer_h, line_w, 1.0)
    speed_f = profile["default_speed_f"]

    if shape == "square_vase":
        label = "VIERECKIGE VASE / 4 WAENDE (84x84 mm, R10, H=120 mm)"
        height = 120.0
        half_w = 42.0
        corner_r = 10.0
        base_tag = "mit Spiralboden" if include_base else "Vasenmodus OHNE Boden"
        lines = [
            render_start_gcode(profile).rstrip(),
            f"; --- PRESET: {label}, LH={layer_h:.2f} mm, {base_tag} ---",
        ]
        px = py = pz = None
        first_move = True

        base_layers = (1 if layer_h >= 0.8 else 2) if include_base else 0
        if base_layers > 0:
            lines.append("; --- BEGIN_BASE ---")
            step_r = max(0.45, line_w * 0.92)
            rings_n = max(4, int(round((half_w - 2.0) / step_r)))
            for bl in range(base_layers):
                z_b = (bl + 1) * layer_h
                for rk in range(1, rings_n + 1):
                    frac = rk / float(rings_n)
                    hw_k = 2.0 + frac * (half_w - 2.0)
                    cr_k = max(1.0, corner_r * frac)
                    ring_pts = _rounded_square_ring(hw_k, cr_k, 48)
                    for i_p, (rx_p, ry_p) in enumerate(ring_pts):
                        x = cx + rx_p
                        y = cy + ry_p
                        if first_move:
                            lines.append(f"G1 Z{z_b + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                            lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                            lines.append(f"G1 Z{z_b:.3f} F600")
                            first_move = False
                        elif rk == 1 and i_p == 0 and bl > 0:
                            lines.append(f"G0 X{x:.3f} Y{y:.3f} Z{z_b:.3f} F{profile['travel_speed_f']:.0f}")
                        else:
                            dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z_b - pz) ** 2)
                            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z_b:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
                        px, py, pz = x, y, z_b

        lines.append("; --- BEGIN_WALL ---")
        z_start = (base_layers * layer_h) if base_layers > 0 else layer_h
        wall_h = max(10.0, height - z_start)
        layers = max(12, int(round(wall_h / layer_h)))
        pts_per_turn = 128
        ring_template = _rounded_square_ring(half_w, corner_r, pts_per_turn)
        total_pts = layers * pts_per_turn

        for i in range(total_pts + 1):
            t = i / float(pts_per_turn)
            v = t / float(layers)
            rx_p, ry_p = ring_template[i % pts_per_turn]
            z = z_start + v * wall_h
            x = cx + rx_p
            y = cy + ry_p
            if first_move:
                lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                lines.append(f"G1 Z{z:.3f} F600")
                first_move = False
            else:
                dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
                lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
            px, py, pz = x, y, z

        lines.append(profile["end_gcode"].rstrip())
        return "\n".join(lines) + "\n"

    if shape == "tumbler":
        label = "BECHER / TUMBLER (Ø72-78 mm, H=98 mm)"
        height = 98.0
        foot_r = 35.0
        def radius_fn(v: float) -> float:
            return 35.0 + 4.0 * (v ** 0.75) + 1.5 * math.sin(v * math.pi)
    elif shape == "vase":
        label = "BAUCHIGE VASE (Ø64-118 mm, H=165 mm)"
        height = 165.0
        foot_r = 32.0
        def radius_fn(v: float) -> float:
            # Smooth sculptural amphora: rounded belly at v~0.38, narrow neck at v~0.82, gentle lip flare
            belly = 27.0 * math.exp(-((v - 0.36) / 0.28) ** 2)
            neck = -9.0 * math.exp(-((v - 0.82) / 0.16) ** 2)
            lip = 6.5 * (max(0.0, (v - 0.80) / 0.20) ** 1.6)
            return max(20.0, 32.0 + belly + neck + lip)
    else:  # lampshade
        label = "LAMPENSCHIRM (Ø68-126 mm, H=115 mm)"
        height = 115.0
        foot_r = 55.0
        include_base = False  # Lampshade is naturally open at bottom/top
        def radius_fn(v: float) -> float:
            return 55.0 - 21.0 * (v ** 1.2) + 8.0 * math.sin(v * math.pi)

    base_tag = "mit Spiralboden" if include_base else "Vasenmodus OHNE Boden"
    lines = [
        render_start_gcode(profile).rstrip(),
        f"; --- PRESET: {label}, LH={layer_h:.2f} mm, {base_tag} ---",
    ]

    px = py = pz = None
    first_move = True

    base_layers = (1 if layer_h >= 0.8 else 2) if include_base else 0
    if base_layers > 0:
        lines.append("; --- BEGIN_BASE ---")
        step_r = max(0.42, line_w * 0.92)
        base_turns = max(4, int(round((foot_r - 1.5) / step_r)))
        pts_base = 36
        for bl in range(base_layers):
            z_b = (bl + 1) * layer_h
            tot = base_turns * pts_base
            for i in range(tot + 1):
                frac = i / float(tot)
                r = 1.5 + frac * (foot_r - 1.5)
                ang = frac * base_turns * 2.0 * math.pi
                x = cx + r * math.cos(ang)
                y = cy + r * math.sin(ang)
                if first_move:
                    lines.append(f"G1 Z{z_b + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                    lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                    lines.append(f"G1 Z{z_b:.3f} F600")
                    first_move = False
                elif i == 0 and bl > 0:
                    lines.append(f"G0 X{x:.3f} Y{y:.3f} Z{z_b:.3f} F{profile['travel_speed_f']:.0f}")
                else:
                    dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z_b - pz) ** 2)
                    lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z_b:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
                px, py, pz = x, y, z_b

    lines.append("; --- BEGIN_WALL ---")
    z_start = (base_layers * layer_h) if base_layers > 0 else layer_h
    wall_h = max(10.0, height - z_start)
    layers = max(12, int(round(wall_h / layer_h)))
    pts_per_turn = 108
    total_pts = layers * pts_per_turn

    for i in range(total_pts + 1):
        t = i / float(pts_per_turn)
        u = t % 1.0
        v = t / float(layers)
        r = radius_fn(v)
        z = z_start + v * wall_h
        ang = u * 2.0 * math.pi
        x = cx + r * math.cos(ang)
        y = cy + r * math.sin(ang)
        if first_move:
            lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 Z{z:.3f} F600")
            first_move = False
        else:
            dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
        px, py, pz = x, y, z

    lines.append(profile["end_gcode"].rstrip())
    return "\n".join(lines) + "\n"


def generate_demo_espresso_cup_gcode(
    profile_id: str = "ender_5_s1",
    pattern: str = "smooth",
    layer_height_mm: Optional[float] = None,
    line_width_mm: Optional[float] = None,
    include_base: bool = True,
) -> str:
    """Generate a realistic preset espresso cup G-code (optional closed spiral base + cup wall).

    Dimensions: ~Ø48 mm foot, ~Ø62 mm rim, 62 mm height (inspired by ceramic 3D printed cups).
    When include_base=False, generates a pure open-bottom vase-mode spiral wall (for slip-poured clay bases).
    """
    profile = get_profile(profile_id)
    cx, cy = profile["origin_center"]
    height = 62.0
    foot_r = 24.0
    layer_h = float(
        layer_height_mm
        if layer_height_mm is not None and layer_height_mm > 0.05
        else (profile["default_layer_height_mm"] if profile_id == "wasp_2040_clay" else max(0.28, profile["default_layer_height_mm"]))
    )
    line_w = float(
        line_width_mm
        if line_width_mm is not None and line_width_mm > 0.1
        else profile["default_line_width_mm"]
    )
    e_per_mm = compute_e_per_mm(profile, layer_h, line_w, 1.0)
    speed_f = profile["default_speed_f"]

    base_tag = "mit Spiralboden" if include_base else "Vasenmodus OHNE Boden"
    lines = [
        render_start_gcode(profile).rstrip(),
        f"; --- PRESET: ESPRESSOTASSE (Ø48-62 mm, H=62 mm, LH={layer_h:.2f} mm, {base_tag}) ---",
    ]

    px = py = pz = None
    first_move = True

    # 1. Optional closed concentric Archimedean spiral base
    base_layers = (1 if layer_h >= 0.8 else 2) if include_base else 0
    if base_layers > 0:
        lines.append("; --- BEGIN_BASE ---")
        step_r = max(0.42, line_w * 0.92)
        base_turns = max(4, int(round((foot_r - 1.5) / step_r)))
        pts_per_base_turn = 36

        for bl in range(base_layers):
            z_b = (bl + 1) * layer_h
            total_b_pts = base_turns * pts_per_base_turn
            for i in range(total_b_pts + 1):
                frac = i / float(total_b_pts)
                r = 1.5 + frac * (foot_r - 1.5)
                ang = frac * base_turns * 2.0 * math.pi
                x = cx + r * math.cos(ang)
                y = cy + r * math.sin(ang)
                if first_move:
                    lines.append(f"G1 Z{z_b + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                    lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                    lines.append(f"G1 Z{z_b:.3f} F600")
                    first_move = False
                elif i == 0 and bl > 0:
                    lines.append(f"G0 X{x:.3f} Y{y:.3f} Z{z_b:.3f} F{profile['travel_speed_f']:.0f}")
                else:
                    dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z_b - pz) ** 2)
                    lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z_b:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
                px, py, pz = x, y, z_b

    # 2. Continuous spiral cup wall rising smoothly from z_start to height
    lines.append("; --- BEGIN_WALL ---")
    z_start = (base_layers * layer_h) if base_layers > 0 else layer_h
    wall_h = max(10.0, height - z_start)
    layers = max(12, int(round(wall_h / layer_h)))
    pts_per_turn = 108
    total_pts = layers * pts_per_turn

    for i in range(total_pts + 1):
        t = i / float(pts_per_turn)
        u = t % 1.0
        v = t / float(layers)
        k = int(math.floor(t))
        # Classic espresso cup profile: gentle rounded foot, slight belly, comfortable drinking rim
        r_base = foot_r + 6.5 * (v ** 0.85) + 2.2 * math.sin(v * math.pi)
        z_base = z_start + v * wall_h
        mask = _zone_weight(z_base, z_start + 4.0, height - 5.0, 5.0)

        ang = u * 2.0 * math.pi
        r = r_base
        z = z_base
        if pattern in ("weaving", "nonplanar"):
            w = math.sin(2.0 * math.pi * (u * 12.0 + k * 0.5))
            r += w * 1.4 * mask
            if pattern == "nonplanar":
                z += w * (layer_h * 0.7) * mask

        x = cx + r * math.cos(ang)
        y = cy + r * math.sin(ang)
        if first_move:
            lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 Z{z:.3f} F600")
            first_move = False
        else:
            dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
        px, py, pz = x, y, z

    lines.append(profile["end_gcode"].rstrip())
    return "\n".join(lines) + "\n"


def generate_demo_lampshade_gcode(
    profile_id: str = "ender_5_s1",
    pattern: str = "weaving",
    layer_height_mm: Optional[float] = None,
    line_width_mm: Optional[float] = None,
) -> str:
    """Generate a built-in demo lampshade G-code (for instant studio preview & unit tests)."""
    profile = get_profile(profile_id)
    cx, cy = profile["origin_center"]
    height = 100.0
    layer_h = float(
        layer_height_mm
        if layer_height_mm is not None and layer_height_mm > 0.05
        else (profile["default_layer_height_mm"] if profile_id == "wasp_2040_clay" else max(0.32, profile["default_layer_height_mm"]))
    )
    layers = max(16, int(round(height / layer_h)))
    pts_per_turn = 72
    total_pts = layers * pts_per_turn
    line_w = float(
        line_width_mm
        if line_width_mm is not None and line_width_mm > 0.1
        else profile["default_line_width_mm"]
    )
    e_per_mm = compute_e_per_mm(profile, layer_h, line_w, 1.0)
    speed_f = profile["default_speed_f"]

    lines = [
        render_start_gcode(profile).rstrip(),
        f"; --- DEMO LAMPSHADE (LH={layer_h:.2f} mm) ---",
        "; --- BEGIN_WALL ---",
    ]
    px = py = pz = None
    for i in range(total_pts + 1):
        t = i / float(pts_per_turn)
        u = t % 1.0
        v = t / float(layers)
        k = int(math.floor(t))
        r_base = 55.0 - 22.0 * (v ** 1.2) + 8.0 * math.sin(v * math.pi)
        z_base = max(layer_h * 0.8, v * height)
        mask = _zone_weight(z_base, 6.0, height - 6.0, 8.0)

        ang = u * 2.0 * math.pi
        r = r_base
        z = z_base
        if pattern in ("weaving", "nonplanar"):
            w = math.sin(2.0 * math.pi * (u * 14.0 + k * 0.5))
            r += w * 2.4 * mask
            if pattern == "nonplanar":
                z += w * (layer_h * 0.9) * mask

        x = cx + r * math.cos(ang)
        y = cy + r * math.sin(ang)
        if i == 0:
            lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
            lines.append(f"G1 Z{z:.3f} F600")
        else:
            dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
        px, py, pz = x, y, z

    lines.append(profile["end_gcode"].rstrip())
    return "\n".join(lines) + "\n"
