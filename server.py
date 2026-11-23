"""Local HTTP server for KIND Custom G-Code Studio.

Runs purely on Python 3.12 standard library (no Node/npm needed).
Serves the interactive 3D G-Code Studio UI and exposes REST endpoints for
parsing, analyzing, modifying, converting (WASP 2040 <-> Ender-5 S1), and
live-watching the Grasshopper export file.
"""

from __future__ import annotations
import json
import os
import sys
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
WORKSPACE_DIR = BASE_DIR / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

GH_WATCH_FILE = WORKSPACE_DIR / "latest_from_gh.gcode"
KIND_CLAY_DIR = Path(r"C:\Users\dimag\OneDrive - hochschule-trier.de\11.Semester\KIND CLAY")

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from gcode_engine import (
    analyze_gcode,
    generate_demo_espresso_cup_gcode,
    generate_demo_lampshade_gcode,
    generate_parametric_gcode,
    generate_preset_gcode,
    parse_gcode,
    process_and_generate_gcode,
    register_heightmap_bytes,
    register_procedural_heightmap,
)
from model_importer import slice_3d_model_to_spiral_gcode
from profiles import PRINTER_PROFILES

# Cache last uploaded 3D models in memory so live slider/layer-height changes re-slice instantly
_MODEL_CACHE: Dict[str, Dict[str, Any]] = {}


def _compact_segments(parsed: Dict[str, Any], max_segments: int = 65000) -> Dict[str, Any]:
    """Pack parsed segments into flat numeric arrays for fast 60-FPS Three.js upload."""
    segs = parsed["segments"]
    step = 1
    if len(segs) > max_segments:
        step = max(1, len(segs) // max_segments)
        segs = segs[::step]

    coords = []
    slopes = []
    speeds = []
    flows = []
    extruding = []
    zs = []
    for s in segs:
        coords.extend([
            round(s["x0"], 3), round(s["y0"], 3), round(s["z0"], 3),
            round(s["x1"], 3), round(s["y1"], 3), round(s["z1"], 3),
        ])
        slopes.append(round(s["slope"], 2))
        speeds.append(round(s["f"], 1))
        flows.append(round(s["e_per_mm"], 5))
        extruding.append(1 if s["extruding"] else 0)
        zs.append(round(0.5 * (s["z0"] + s["z1"]), 2))

    return {
        "decimation": step,
        "count": len(segs),
        "coords": coords,
        "slopes": slopes,
        "speeds": speeds,
        "flows": flows,
        "extruding": extruding,
        "zs": zs,
        "ooze_events": parsed["ooze_events"],
    }


class StudioRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Keep console clean
        pass

    def _send_json(self, payload: Dict[str, Any], status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/profiles":
            self._send_json({"profiles": PRINTER_PROFILES})
            return

        if path in ("/api/preset", "/api/demo"):
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)
            profile_id = params.get("profile", "wasp_2040_clay")
            shape = params.get("shape", "espresso")
            if profile_id not in PRINTER_PROFILES:
                profile_id = "wasp_2040_clay"
            include_base = params.get("base", "1") != "0"
            lh = float(params["layer_h"]) if "layer_h" in params else None
            lw = float(params["line_w"]) if "line_w" in params else None
            names = {
                "espresso": "espressotasse",
                "tumbler": "becher_tumbler",
                "vase": "bauchige_vase",
                "lampshade": "lampenschirm",
                "square_vase": "viereckige_vase",
                "parametric": "eigene_form",
            }
            if shape not in names:
                shape = "espresso"
            if shape == "parametric":
                gcode = generate_parametric_gcode(
                    {},
                    profile_id=profile_id,
                    layer_height_mm=lh,
                    line_width_mm=lw,
                    include_base=include_base,
                )
            else:
                gcode = generate_preset_gcode(
                    shape,
                    profile_id=profile_id,
                    layer_height_mm=lh,
                    line_width_mm=lw,
                    include_base=include_base,
                )
            fname = f"{names[shape]}_preset_{profile_id}.gcode"
            parsed = parse_gcode(gcode)
            analysis = analyze_gcode(parsed, profile_id)
            self._send_json({
                "filename": fname,
                "gcode": gcode,
                "render": _compact_segments(parsed),
                "analysis": analysis,
            })
            return

        if path == "/api/procedural-heightmap":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)
            kind = params.get("kind", "voronoi")
            info = register_procedural_heightmap(kind)
            self._send_json(info)
            return

        if path == "/api/gh-status":
            if GH_WATCH_FILE.exists() and GH_WATCH_FILE.stat().st_size > 10:
                st = GH_WATCH_FILE.stat()
                self._send_json({
                    "exists": True,
                    "path": str(GH_WATCH_FILE),
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                })
            else:
                self._send_json({"exists": False, "path": str(GH_WATCH_FILE), "mtime": 0, "size": 0})
            return

        if path == "/api/gh-latest":
            if not GH_WATCH_FILE.exists():
                self._send_json({"error": f"Noch keine Grasshopper-Datei unter {GH_WATCH_FILE} gefunden."}, HTTPStatus.NOT_FOUND)
                return
            gcode = GH_WATCH_FILE.read_text(encoding="utf-8", errors="ignore")
            # Auto-detect profile from header
            profile_id = "wasp_2040_clay" if "WASP" in gcode[:600].upper() else "ender_5_s1"
            parsed = parse_gcode(gcode)
            analysis = analyze_gcode(parsed, profile_id)
            self._send_json({
                "filename": GH_WATCH_FILE.name,
                "mtime": GH_WATCH_FILE.stat().st_mtime,
                "profile_id": profile_id,
                "gcode": gcode,
                "render": _compact_segments(parsed),
                "analysis": analysis,
            })
            return

        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        qparams = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)

        # Raw binary upload for 2D heightmap images (.png, .jpg, .webp)
        if path == "/api/upload-heightmap":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    self._send_json({"error": "Leere Bilddatei hochgeladen."}, HTTPStatus.BAD_REQUEST)
                    return
                raw_bytes = self.rfile.read(length)
                from urllib.parse import unquote
                fname = unquote(self.headers.get("X-Filename", "heightmap.png"))
                info = register_heightmap_bytes(raw_bytes, fname)
                self._send_json(info)
            except Exception as exc:
                self._send_json({"error": f"Bild-Import fehlgeschlagen: {exc}"}, HTTPStatus.BAD_REQUEST)
            return

        # Raw binary upload for 3D models (.3dm, .stl, .obj, .3mf, .ply)
        if path == "/api/import-model":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    self._send_json({"error": "Leere Datei hochgeladen."}, HTTPStatus.BAD_REQUEST)
                    return
                raw_bytes = self.rfile.read(length)
                from urllib.parse import unquote
                fname = unquote(self.headers.get("X-Filename", "model.stl"))
                profile_id = qparams.get("profile", "ender_5_s1")
                if profile_id not in PRINTER_PROFILES:
                    profile_id = "ender_5_s1"
                lh = float(qparams["layer_h"]) if "layer_h" in qparams else None
                lw = float(qparams["line_w"]) if "line_w" in qparams else None
                include_base = qparams.get("base", "1") != "0"

                gcode, info = slice_3d_model_to_spiral_gcode(
                    raw_bytes, fname, profile_id=profile_id,
                    layer_height_mm=lh, line_width_mm=lw, include_base=include_base,
                )
                import hashlib
                model_id = hashlib.md5(raw_bytes[:65536] + fname.encode("utf-8")).hexdigest()[:12]
                _MODEL_CACHE.clear()
                _MODEL_CACHE[model_id] = {"bytes": raw_bytes, "filename": fname}

                parsed = parse_gcode(gcode)
                analysis = analyze_gcode(parsed, profile_id)
                self._send_json({
                    "model_id": model_id,
                    "filename": fname,
                    "model_info": info,
                    "gcode": gcode,
                    "render": _compact_segments(parsed),
                    "analysis": analysis,
                })
            except Exception as exc:
                self._send_json({"error": f"3D-Import fehlgeschlagen: {exc}"}, HTTPStatus.BAD_REQUEST)
            return

        try:
            body = self._read_json()
        except Exception as exc:
            self._send_json({"error": f"Ungueltiges JSON: {exc}"}, HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/analyze":
            gcode = str(body.get("gcode", ""))
            profile_id = str(body.get("profile_id", "ender_5_s1"))
            angle_lim = body.get("max_nozzle_angle_deg")
            parsed = parse_gcode(gcode)
            analysis = analyze_gcode(parsed, profile_id, max_nozzle_angle_deg=angle_lim)
            self._send_json({
                "render": _compact_segments(parsed),
                "analysis": analysis,
            })
            return

        if path == "/api/process":
            gcode = str(body.get("gcode", ""))
            target_profile = str(body.get("target_profile_id", "ender_5_s1"))
            options = body.get("options", {})
            model_id = options.get("model_id")
            if model_id and model_id in _MODEL_CACHE:
                cached = _MODEL_CACHE[model_id]
                gcode, _ = slice_3d_model_to_spiral_gcode(
                    cached["bytes"],
                    cached["filename"],
                    profile_id=target_profile,
                    layer_height_mm=options.get("layer_height_mm"),
                    line_width_mm=options.get("line_width_mm"),
                    include_base=bool(options.get("include_base", True)),
                )
            res = process_and_generate_gcode(gcode, target_profile, options)
            payload: Dict[str, Any] = {
                "gcode": res["gcode"],
                "render": _compact_segments(res["parsed"]),
                "analysis": res["analysis"],
            }
            if "base_parsed" in res:
                payload["ghost_render"] = _compact_segments(res["base_parsed"])
            self._send_json(payload)
            return

        if path == "/api/save":
            gcode = str(body.get("gcode", ""))
            filename = os.path.basename(str(body.get("filename", "custom_output.gcode"))).strip()
            if not filename.lower().endswith(".gcode"):
                filename += ".gcode"
            target_dir = KIND_CLAY_DIR if (body.get("to_kind_clay") and KIND_CLAY_DIR.exists()) else WORKSPACE_DIR
            out_path = target_dir / filename
            out_path.write_text(gcode, encoding="utf-8")
            self._send_json({"saved": True, "path": str(out_path), "bytes": len(gcode.encode("utf-8"))})
            return

        self._send_json({"error": f"Unbekannter Endpunkt: {path}"}, HTTPStatus.NOT_FOUND)


def create_server(host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), StudioRequestHandler)


def main() -> None:
    # Cloud hosts (Render, Railway, Fly.io, Hugging Face Spaces) inject PORT; bind 0.0.0.0 when PORT is set
    in_cloud = "PORT" in os.environ
    port = int(os.environ.get("PORT", os.environ.get("GCODE_STUDIO_PORT", "8765")))
    host = os.environ.get("GCODE_STUDIO_HOST", "0.0.0.0" if in_cloud else "127.0.0.1")
    no_browser = ("--no-browser" in sys.argv) or in_cloud
    server = create_server(host, port)
    url = f"http://{host}:{port}"
    print(f"KIND Clay Custom G-Code Studio laeuft auf {url}")
    if not no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer beendet.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
