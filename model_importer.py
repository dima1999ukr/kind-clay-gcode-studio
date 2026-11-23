"""3D model importer & continuous spiral slicer for KIND Custom G-Code Studio.

Supports:
- Rhino .3dm (via rhino3dm: NURBS surfaces, Breps, Extrusions, Meshes)
- .stl, .obj, .3mf, .ply (via trimesh)

Converts any uploaded 3D vessel / lampshade / cup geometry into a clean,
continuous, seam-free spiral G-code (with optional closed spiral bottom)
ready for Weaving, Outward-Only Weaving, Non-Planar Z, Oozing, and WASP/Ender printing.
"""

from __future__ import annotations
import io
import math
import tempfile
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np
import trimesh

try:
    import rhino3dm
except ImportError:
    rhino3dm = None

from profiles import compute_e_per_mm, get_profile, render_start_gcode


def _rhino_mesh_to_trimesh(rmesh) -> Optional[trimesh.Trimesh]:
    if rmesh is None or len(rmesh.Vertices) == 0 or len(rmesh.Faces) == 0:
        return None
    verts = np.array([[v.X, v.Y, v.Z] for v in rmesh.Vertices], dtype=np.float64)
    faces = []
    for i in range(len(rmesh.Faces)):
        f = rmesh.Faces[i]
        # rhino3dm MeshFaceList returns (A, B, C, D) tuple
        a, b, c, d = f[0], f[1], f[2], f[3]
        faces.append([a, b, c])
        if c != d:
            faces.append([a, c, d])
    if not faces:
        return None
    return trimesh.Trimesh(vertices=verts, faces=np.array(faces, dtype=np.int64), process=False)


def _nurbs_surface_to_trimesh(srf, u_steps: int = 72, v_steps: int = 48) -> Optional[trimesh.Trimesh]:
    """Tessellate a rhino3dm NurbsSurface / Surface directly into a clean trimesh."""
    try:
        u_dom = srf.Domain(0)
        v_dom = srf.Domain(1)
        us = np.linspace(u_dom.T0, u_dom.T1, u_steps)
        vs = np.linspace(v_dom.T0, v_dom.T1, v_steps)
        verts = []
        for v in vs:
            for u in us:
                pt = srf.PointAt(float(u), float(v))
                verts.append([pt.X, pt.Y, pt.Z])
        faces = []
        for j in range(v_steps - 1):
            for i in range(u_steps - 1):
                p00 = j * u_steps + i
                p10 = p00 + 1
                p01 = p00 + u_steps
                p11 = p01 + 1
                faces.append([p00, p10, p11])
                faces.append([p00, p11, p01])
        return trimesh.Trimesh(vertices=np.array(verts, dtype=np.float64), faces=np.array(faces, dtype=np.int64), process=False)
    except Exception:
        return None


def _load_3dm_to_trimesh(data: bytes) -> trimesh.Trimesh:
    if rhino3dm is None:
        raise RuntimeError("rhino3dm ist nicht installiert.")
    with tempfile.NamedTemporaryFile(suffix=".3dm", delete=False) as tf:
        tf.write(data)
        tmp_path = Path(tf.name)
    try:
        model = rhino3dm.File3dm.Read(str(tmp_path))
        if model is None:
            raise ValueError("Konnte .3dm Datei nicht lesen.")

        meshes: List[trimesh.Trimesh] = []
        for obj in model.Objects:
            geom = obj.Geometry
            if geom is None:
                continue
            if isinstance(geom, rhino3dm.Mesh):
                m = _rhino_mesh_to_trimesh(geom)
                if m is not None:
                    meshes.append(m)
            elif isinstance(geom, rhino3dm.Brep):
                got_render = False
                for fi in range(len(geom.Faces)):
                    face = geom.Faces[fi]
                    rm = face.GetMesh(rhino3dm.MeshType.Any)
                    m = _rhino_mesh_to_trimesh(rm)
                    if m is not None:
                        meshes.append(m)
                        got_render = True
                if not got_render:
                    # Fallback: tessellate underlying NURBS surfaces directly
                    for si in range(len(geom.Surfaces)):
                        m = _nurbs_surface_to_trimesh(geom.Surfaces[si])
                        if m is not None:
                            meshes.append(m)
            elif isinstance(geom, rhino3dm.Extrusion):
                rm = geom.GetMesh(rhino3dm.MeshType.Any)
                m = _rhino_mesh_to_trimesh(rm)
                if m is not None:
                    meshes.append(m)
            elif isinstance(geom, rhino3dm.Surface):
                m = _nurbs_surface_to_trimesh(geom)
                if m is not None:
                    meshes.append(m)

        if not meshes:
            raise ValueError("Keine 3D-Geometrie (Mesh/Brep/Surface) in der .3dm Datei gefunden.")

        # If a .3dm contains multiple separated demo objects (e.g. Custom_GCode_Demo.3dm),
        # pick the first valid object closest to the world origin (0,0) so we don't bridge two objects!
        if len(meshes) > 1:
            # Check if bounding boxes are separated in XY
            centers = [m.bounds.mean(axis=0) for m in meshes]
            dists = [math.hypot(c[0], c[1]) for c in centers]
            # Cluster meshes whose XY bbox overlaps with the closest mesh
            best_idx = int(np.argmin(dists))
            b0 = meshes[best_idx].bounds
            pad = 15.0
            chosen = []
            for m in meshes:
                bm = m.bounds
                overlap_x = (bm[0][0] <= b0[1][0] + pad) and (bm[1][0] >= b0[0][0] - pad)
                overlap_y = (bm[0][1] <= b0[1][1] + pad) and (bm[1][1] >= b0[0][1] - pad)
                if overlap_x and overlap_y:
                    chosen.append(m)
            return trimesh.util.concatenate(chosen) if len(chosen) > 1 else chosen[0]

        return meshes[0]
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def load_3d_mesh(data: bytes, filename: str) -> trimesh.Trimesh:
    """Load .3dm, .stl, .obj, .3mf, or .ply into a single normalized trimesh."""
    ext = Path(filename).suffix.lower()
    if ext == ".3dm":
        mesh = _load_3dm_to_trimesh(data)
    else:
        file_type = ext.lstrip(".")
        loaded = trimesh.load(io.BytesIO(data), file_type=file_type, force="mesh")
        if isinstance(loaded, trimesh.Scene):
            geoms = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.vertices) > 0]
            if not geoms:
                raise ValueError(f"Keine 3D-Geometrie in {filename} gefunden.")
            mesh = trimesh.util.concatenate(geoms)
        elif isinstance(loaded, trimesh.Trimesh):
            mesh = loaded
        else:
            raise ValueError(f"Nicht unterstuetzter 3D-Typ in {filename}.")

    if mesh is None or len(mesh.vertices) < 3 or len(mesh.faces) < 1:
        raise ValueError(f"Leeres 3D-Mesh in {filename}.")

    # Center XY at (0, 0) and place Z_min at 0.0
    bounds = mesh.bounds
    cx = 0.5 * (bounds[0][0] + bounds[1][0])
    cy = 0.5 * (bounds[0][1] + bounds[1][1])
    zmin = bounds[0][2]
    mesh = mesh.copy()
    mesh.apply_translation([-cx, -cy, -zmin])
    return mesh


def _resample_closed_ring(pts_2d: np.ndarray, n_pts: int = 96) -> Optional[np.ndarray]:
    """Ensure CCW winding, align start to angle=0 (positive X), and resample to n_pts uniform points."""
    if pts_2d is None or len(pts_2d) < 3:
        return None
    # Remove duplicate closing vertex if present
    if np.linalg.norm(pts_2d[0] - pts_2d[-1]) < 1e-6:
        pts_2d = pts_2d[:-1]
    if len(pts_2d) < 3:
        return None

    # Signed area -> enforce CCW
    x = pts_2d[:, 0]
    y = pts_2d[:, 1]
    area = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))
    if area < 0:
        pts_2d = pts_2d[::-1].copy()

    # Rotate vertex index so start is closest to angle 0 (+X axis)
    angles = np.arctan2(pts_2d[:, 1], pts_2d[:, 0])
    angles_pos = np.mod(angles, 2.0 * math.pi)
    start_idx = int(np.argmin(angles_pos))
    pts_2d = np.roll(pts_2d, -start_idx, axis=0)

    # Close loop for arc-length interpolation
    closed = np.vstack([pts_2d, pts_2d[0:1]])
    seg_lens = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg_lens)])
    total_len = float(cum[-1])
    if total_len < 1e-3:
        return None

    targets = np.linspace(0.0, total_len, n_pts, endpoint=False)
    rx = np.interp(targets, cum, closed[:, 0])
    ry = np.interp(targets, cum, closed[:, 1])
    return np.column_stack([rx, ry])


def _extract_outer_ring_2d(section) -> Optional[np.ndarray]:
    """Extract the largest (outer) closed 2D polygon from a trimesh Path2D slice."""
    if section is None:
        return None
    try:
        polys = section.discrete
    except Exception:
        return None
    best_poly = None
    best_perim = 0.0
    for p in polys:
        if p is None or len(p) < 3:
            continue
        pts2 = np.asarray(p)[:, :2]
        perim = float(np.sum(np.linalg.norm(np.diff(pts2, axis=0), axis=1)))
        if perim > best_perim:
            best_perim = perim
            best_poly = pts2
    return best_poly


def slice_3d_model_to_spiral_gcode(
    data: bytes,
    filename: str,
    profile_id: str = "ender_5_s1",
    layer_height_mm: Optional[float] = None,
    line_width_mm: Optional[float] = None,
    include_base: bool = True,
    pts_per_turn: int = 96,
) -> Tuple[str, dict]:
    """Slice a .3dm/.stl/.obj/.3mf 3D model into a continuous spiral M83 G-code."""
    mesh = load_3d_mesh(data, filename)
    profile = get_profile(profile_id)
    cx, cy = profile["origin_center"]

    bounds = mesh.bounds
    width_x = float(bounds[1][0] - bounds[0][0])
    depth_y = float(bounds[1][1] - bounds[0][1])
    height_z = float(bounds[1][2] - bounds[0][2])

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

    # Slice heights from 0.5*layer_h up to height_z - 0.25*layer_h
    n_layers = max(4, int(round(height_z / layer_h)))
    # Cap slice count for extreme micro-layers on huge models to keep interactive slicing fast
    n_layers = min(n_layers, 800)
    z_levels = np.linspace(layer_h * 0.5, max(layer_h, height_z - layer_h * 0.25), n_layers)

    sections = mesh.section_multiplane(
        plane_origin=[0.0, 0.0, 0.0],
        plane_normal=[0.0, 0.0, 1.0],
        heights=z_levels,
    )

    rings: List[Tuple[float, np.ndarray]] = []
    for z_val, sec in zip(z_levels, sections):
        poly = _extract_outer_ring_2d(sec)
        ring = _resample_closed_ring(poly, pts_per_turn) if poly is not None else None
        if ring is not None:
            rings.append((float(z_val), ring))

    if len(rings) < 2:
        raise ValueError(f"Konnte keine geschlossenen Schnittkurven aus {filename} erzeugen (Hoehe={height_z:.1f} mm).")

    base_tag = "mit Spiralboden" if include_base else "Vasenmodus OHNE Boden"
    lines = [
        render_start_gcode(profile).rstrip(),
        f"; --- 3D IMPORT: {filename} ({width_x:.1f}x{depth_y:.1f}x{height_z:.1f} mm, LH={layer_h:.2f} mm, {base_tag}) ---",
    ]

    px = py = pz = None
    first_move = True

    # 1. Optional closed spiral base inscribed into the first ring's minimum radius
    if include_base:
        first_ring = rings[0][1]
        base_r = max(3.0, float(np.median(np.linalg.norm(first_ring, axis=1))) - line_w * 0.4)
        base_layers = 1 if layer_h >= 0.8 else 2
        step_r = max(0.42, line_w * 0.92)
        base_turns = max(3, int(round((base_r - 1.5) / step_r)))
        pts_base = 36
        lines.append("; --- BEGIN_BASE ---")
        for bl in range(base_layers):
            z_b = (bl + 1) * layer_h
            tot = base_turns * pts_base
            for i in range(tot + 1):
                frac = i / float(tot)
                r = 1.5 + frac * (base_r - 1.5)
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

    # 2. Continuous spiralized wall across all sliced rings
    lines.append("; --- BEGIN_WALL ---")
    for r_idx in range(len(rings) - 1):
        z0, ring0 = rings[r_idx]
        z1, ring1 = rings[r_idx + 1]
        for j in range(pts_per_turn):
            u = j / float(pts_per_turn)
            pt = (1.0 - u) * ring0[j] + u * ring1[j]
            z = z0 + u * (z1 - z0)
            x = cx + float(pt[0])
            y = cy + float(pt[1])
            if first_move:
                lines.append(f"G1 Z{z + 5.0:.3f} F{profile['travel_speed_f']:.0f}")
                lines.append(f"G1 X{x:.3f} Y{y:.3f} F{profile['travel_speed_f']:.0f}")
                lines.append(f"G1 Z{z:.3f} F600")
                first_move = False
            else:
                dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2)
                lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
            px, py, pz = x, y, z

    # Close top rim cleanly at final height
    z_top, ring_top = rings[-1]
    for j in range(pts_per_turn + 1):
        pt = ring_top[j % pts_per_turn]
        x = cx + float(pt[0])
        y = cy + float(pt[1])
        dist = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z_top - pz) ** 2)
        if dist > 1e-5:
            lines.append(f"G1 X{x:.3f} Y{y:.3f} Z{z_top:.3f} E{dist * e_per_mm:.4f} F{speed_f:.0f}")
            px, py, pz = x, y, z_top

    lines.append(profile["end_gcode"].rstrip())
    gcode = "\n".join(lines) + "\n"
    info = {
        "width_x": round(width_x, 1),
        "depth_y": round(depth_y, 1),
        "height_z": round(height_z, 1),
        "sliced_layers": len(rings),
    }
    return gcode, info
