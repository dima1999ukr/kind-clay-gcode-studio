"""Automated test suite for KIND Custom G-Code Studio (engine + REST API)."""

from __future__ import annotations
import json
import math
import sys
import threading
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from gcode_engine import (
    analyze_gcode,
    generate_demo_espresso_cup_gcode,
    generate_demo_lampshade_gcode,
    parse_gcode,
    process_and_generate_gcode,
)
from profiles import compute_e_per_mm, get_profile
from server import create_server

KIND_CLAY = Path(r"C:\Users\dimag\OneDrive - hochschule-trier.de\11.Semester\KIND CLAY")


def test_real_wasp_puzzle_gcode():
    p = KIND_CLAY / "Puzzle_1_Slavynskyy.gcode"
    if not p.exists():
        print("[SKIP] Puzzle_1_Slavynskyy.gcode not found")
        return
    txt = p.read_text(encoding="utf-8", errors="ignore")
    parsed = parse_gcode(txt)
    analysis = analyze_gcode(parsed, "wasp_2040_clay")
    assert analysis["stats"]["extruding_count"] == 1, f"Expected 1 extruding line, got {analysis['stats']}"
    assert abs(analysis["stats"]["total_print_mm"] - 80.0) < 0.1
    assert abs(analysis["stats"]["total_e"] - 20.0) < 0.01
    errors = [c for c in analysis["checks"] if c["level"] == "error"]
    assert not errors, f"Unexpected errors on real WASP file: {errors}"
    print("[PASS] test_real_wasp_puzzle_gcode")


def test_real_ender_header_gcode():
    p = KIND_CLAY / "Schirm_druck_PLA_4h0m.gcode"
    if not p.exists():
        print("[SKIP] Schirm_druck_PLA_4h0m.gcode not found")
        return
    with p.open("r", encoding="utf-8", errors="ignore") as f:
        sample = "".join(f.readline() for _ in range(300))
    parsed = parse_gcode(sample)
    analysis = analyze_gcode(parsed, "ender_5_s1")
    assert parsed["meta"]["has_g28"]
    assert parsed["meta"]["has_m83"]
    assert 190.0 in parsed["meta"]["nozzle_temps"]
    errors = [c for c in analysis["checks"] if c["level"] == "error"]
    assert not errors, f"Unexpected errors on real Ender-5 S1 sample: {errors}"
    print("[PASS] test_real_ender_header_gcode")


def test_weaving_oozing_and_profile_conversion():
    # Start on Ender-5 S1
    src = generate_demo_lampshade_gcode("ender_5_s1", "weaving")
    res_ender = process_and_generate_gcode(
        src,
        "ender_5_s1",
        {
            "nozzle_mm": 0.4,
            "layer_height_mm": 0.28,
            "line_width_mm": 0.48,
            "weaving": {"enabled": True, "freq": 16, "phase_shift": 0.5, "h_amp_mm": 2.0, "z_amp_mm": 0.8, "z_min": 8, "z_max": 92},
            "oozing": {"enabled": True, "count_per_turn": 12, "dwell_ms": 400, "extra_e": 0.5, "push_mm": 0.8, "z_min": 10, "z_max": 90},
        },
    )
    st_e = res_ender["analysis"]["stats"]
    b_e = res_ender["analysis"]["bounds"]
    assert st_e["nonplanar_count"] > 100, "Non-planar segments must be generated"
    assert st_e["ooze_count"] > 20, f"Expected ooze blobs, got {st_e['ooze_count']}"
    assert abs(b_e["cx"] - 110.0) < 3.0 and abs(b_e["cy"] - 110.0) < 3.0, f"Ender-5 S1 must center at (110,110), got {b_e}"
    assert "M109 S" in res_ender["gcode"]
    assert "G4 P400" in res_ender["gcode"]

    # 1-Click conversion from Ender-5 S1 -> WASP 2040 Clay (2.0 mm nozzle)
    res_wasp = process_and_generate_gcode(
        res_ender["gcode"],
        "wasp_2040_clay",
        {
            "recenter": True,
            "recalc_e": True,
            "nozzle_mm": 2.0,
            "layer_height_mm": 1.2,
            "line_width_mm": 2.3,
        },
    )
    b_w = res_wasp["analysis"]["bounds"]
    assert abs(b_w["cx"]) < 3.0 and abs(b_w["cy"]) < 3.0, f"WASP must center at (0,0), got {b_w}"
    assert "M104" not in res_wasp["gcode"] and "M109" not in res_wasp["gcode"] and "M140" not in res_wasp["gcode"]
    errors_w = [c for c in res_wasp["analysis"]["checks"] if c["level"] == "error"]
    assert not errors_w, f"Unexpected errors after WASP conversion: {errors_w}"
    print(f"[PASS] test_weaving_oozing_and_profile_conversion (blobs={st_e['ooze_count']}, max_slope={st_e['max_slope_deg']} deg)")


def test_safety_checks_catch_hazards():
    # Overtemperature + negative Z + out of bounds + steep collision
    bad_gcode = "\n".join([
        "G90",
        "M83",
        "M109 S999",
        "G1 X0 Y0 Z-1.0 F1200",
        "G1 X250 Y0 Z20.0 E5.0 F1200",
        "G1 X252 Y0 Z25.0 E1.0 F1200",
    ])
    parsed = parse_gcode(bad_gcode)
    analysis = analyze_gcode(parsed, "ender_5_s1", max_nozzle_angle_deg=28.0)
    err_titles = [c["title"] for c in analysis["checks"] if c["level"] == "error"]
    assert any("Übertemperatur" in t for t in err_titles), f"Missed overtemp: {err_titles}"
    assert any("Bauraum" in t for t in err_titles), f"Missed bounds: {err_titles}"
    assert any("Negatives Z" in t for t in err_titles), f"Missed neg Z: {err_titles}"
    assert analysis["stats"]["collision_count"] >= 1, "Missed steep non-planar slope"
    print("[PASS] test_safety_checks_catch_hazards")


def test_nozzle_diameter_scaling():
    p_wasp = get_profile("wasp_2040_clay")
    e_2mm = compute_e_per_mm(p_wasp, 1.2, 2.2, 1.0)
    e_4mm = compute_e_per_mm(p_wasp, 2.4, 4.4, 1.0)
    assert math.isclose(e_4mm / e_2mm, 4.0, rel_tol=1e-3), "Doubling layer+width should 4x extrusion volume"
    p_ender = get_profile("ender_5_s1")
    e_04 = compute_e_per_mm(p_ender, 0.24, 0.45, 1.0)
    e_08 = compute_e_per_mm(p_ender, 0.48, 0.90, 1.0)
    assert math.isclose(e_08 / e_04, 4.0, rel_tol=1e-3)
    print("[PASS] test_nozzle_diameter_scaling")


def test_http_api():
    srv = create_server("127.0.0.1", 0)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        base = f"http://127.0.0.1:{port}"
        with urllib.request.urlopen(f"{base}/api/profiles") as r:
            d = json.loads(r.read().decode("utf-8"))
            assert "wasp_2040_clay" in d["profiles"] and "ender_5_s1" in d["profiles"]

        with urllib.request.urlopen(f"{base}/api/demo?profile=ender_5_s1") as r:
            esp = json.loads(r.read().decode("utf-8"))
            assert "espressotasse" in esp["filename"]
            assert esp["render"]["count"] > 500
            assert 58.0 <= esp["analysis"]["bounds"]["max_z"] <= 64.0
            assert not [c for c in esp["analysis"]["checks"] if c["level"] == "error"]

        with urllib.request.urlopen(f"{base}/api/demo?shape=lampshade&profile=wasp_2040_clay&pattern=nonplanar") as r:
            demo = json.loads(r.read().decode("utf-8"))
            assert demo["render"]["count"] > 100

        req = urllib.request.Request(
            f"{base}/api/process",
            data=json.dumps({
                "gcode": demo["gcode"],
                "target_profile_id": "ender_5_s1",
                "options": {
                    "nozzle_mm": 0.4,
                    "oozing": {"enabled": True, "count_per_turn": 10, "dwell_ms": 300, "extra_e": 0.4},
                },
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as r:
            proc = json.loads(r.read().decode("utf-8"))
            assert proc["analysis"]["stats"]["ooze_count"] > 10
            assert "Ender-5 S1" in proc["gcode"]
        print("[PASS] test_http_api")
    finally:
        srv.shutdown()
        srv.server_close()


def test_ooze_exact_angular_precision_and_wasp_layer_reslicing():
    # Exact scenario from user screenshots: start Ender-5 S1, switch to WASP 2040 Clay (1.2 mm layer),
    # enable Weaving + Oozing with 14 blobs/turn, every 4 layers, phase 0.0 and phase 0.5
    src_ender = generate_demo_espresso_cup_gcode("ender_5_s1", "smooth")
    for phase in (0.0, 0.5):
        res = process_and_generate_gcode(
            src_ender,
            "wasp_2040_clay",
            {
                "preset_shape": "espresso",
                "nozzle_mm": 2.0,
                "layer_height_mm": 1.2,
                "line_width_mm": 2.2,
                "weaving": {"enabled": True, "freq": 16, "phase_shift": 0.5, "h_amp_mm": 1.8, "z_amp_mm": 0.6, "z_min": 6, "z_max": 58},
                "oozing": {"enabled": True, "count_per_turn": 14, "every_n_layers": 4, "phase_shift": phase, "dwell_ms": 350, "extra_e": 1.5, "push_mm": 0.0, "z_min": 8, "z_max": 58},
            },
        )
        evs = res["parsed"]["ooze_events"]
        # Must be an EXACT multiple of 14 (no partial rows!) and real 1.2mm clay spacing (~10-12 rows, NOT 50!)
        assert len(evs) > 0 and len(evs) % 14 == 0, f"Partial row! len={len(evs)}"
        num_rows = len(evs) // 14
        assert 8 <= num_rows <= 14, f"Expected ~11 clay rows at 4.8mm spacing, got {num_rows}"
        # Verify EVERY single blob angle matches exact mathematical target to < 0.2 degrees!
        for r_idx in range(num_rows):
            row = evs[r_idx * 14 : (r_idx + 1) * 14]
            phase_off = (r_idx * phase) % 1.0
            for j, ev in enumerate(row):
                ang_deg = math.degrees(math.atan2(ev["y"], ev["x"])) % 360.0
                expected_deg = ((j + phase_off) * 360.0 / 14.0) % 360.0
                diff = abs((ang_deg - expected_deg + 180.0) % 360.0 - 180.0)
                assert diff < 0.2, f"Row {r_idx} blob {j} drifted! got {ang_deg:.2f} expected {expected_deg:.2f} (diff={diff:.2f})"
    print("[PASS] test_ooze_exact_angular_precision_and_wasp_layer_reslicing (<0.2 deg error on every blob!)")


def test_vase_mode_without_base():
    # Toggle include_base=False -> pure open-bottom vase mode (no center spiral points!)
    g_with = generate_demo_espresso_cup_gcode("wasp_2040_clay", "smooth", include_base=True)
    g_open = generate_demo_espresso_cup_gcode("wasp_2040_clay", "smooth", include_base=False)
    p_with = parse_gcode(g_with)
    p_open = parse_gcode(g_open)
    assert any(math.hypot(s["x1"], s["y1"]) < 10.0 for s in p_with["segments"] if s["extruding"]), "Base should spiral near center"
    assert all(math.hypot(s["x1"], s["y1"]) > 20.0 for s in p_open["segments"] if s["extruding"]), "Open-bottom vase mode must have zero center base points!"

    # Also verify stripping base via process_and_generate_gcode (for uploaded/existing G-code)
    res_strip = process_and_generate_gcode(g_with, "wasp_2040_clay", {"include_base": False})
    assert all(math.hypot(s["x1"], s["y1"]) > 20.0 for s in res_strip["parsed"]["segments"] if s["extruding"])
    print("[PASS] test_vase_mode_without_base")


def test_outward_only_weaving_never_bends_inward():
    base_gc = generate_demo_espresso_cup_gcode("wasp_2040_clay", "smooth", layer_height_mm=1.2, include_base=False)
    base_segs = [s for s in parse_gcode(base_gc)["segments"] if s["extruding"]]
    res_out = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "espresso",
            "include_base": False,
            "layer_height_mm": 1.2,
            "weaving": {"enabled": True, "mode": "outward", "sharpness": 2.2, "freq": 12, "phase_shift": 0.5, "h_amp_mm": 3.0, "z_amp_mm": 0.0, "z_min": 6, "z_max": 58},
        },
    )
    out_segs = [s for s in res_out["parsed"]["segments"] if s["extruding"]]
    assert len(base_segs) == len(out_segs)
    diffs = [math.hypot(o["x1"], o["y1"]) - math.hypot(b["x1"], b["y1"]) for b, o in zip(base_segs, out_segs)]
    assert min(diffs) >= -0.05, f"Outward-only weaving bent inward! min_diff={min(diffs):.3f}"
    assert max(diffs) >= 2.5, f"Outward-only weaving peaks too small! max_diff={max(diffs):.3f}"
    print(f"[PASS] test_outward_only_weaving_never_bends_inward (min_dr={min(diffs):.3f} mm, max_dr=+{max(diffs):.2f} mm)")


def test_3dm_and_stl_import():
    from model_importer import slice_3d_model_to_spiral_gcode
    for fname in ("Custom_GCode_Demo.3dm", "Schirm.stl"):
        p = KIND_CLAY / fname
        if not p.exists():
            continue
        gc, info = slice_3d_model_to_spiral_gcode(p.read_bytes(), fname, "wasp_2040_clay", layer_height_mm=1.5, include_base=False)
        parsed = parse_gcode(gc)
        assert len(parsed["segments"]) > 500
        assert info["sliced_layers"] >= 10
    print("[PASS] test_3dm_and_stl_import")


def test_square_vase_selective_face_mask():
    from gcode_engine import generate_preset_gcode

    base_gc = generate_preset_gcode("square_vase", "wasp_2040_clay", layer_height_mm=1.5, include_base=False)
    base_segs = [s for s in parse_gcode(base_gc)["segments"] if s["extruding"]]

    # Apply Weaving + Non-Planar Z + Oozing ONLY to the front wall (-Y)
    res = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "square_vase",
            "include_base": False,
            "layer_height_mm": 1.5,
            "active_faces": ["front"],
            "weaving": {"enabled": True, "mode": "outward", "sharpness": 1.8, "freq": 16, "phase_shift": 0.5, "h_amp_mm": 3.0, "z_min": 10, "z_max": 105},
            "nonplanar": {"enabled": True, "freq": 12, "phase_shift": 0.5, "z_amp_mm": 1.2, "z_min": 10, "z_max": 105},
            "oozing": {"enabled": True, "count_per_turn": 16, "every_n_layers": 4, "phase_shift": 0.5, "dwell_ms": 200, "extra_e": 1.2, "push_mm": 1.5, "z_min": 15, "z_max": 100},
        },
    )
    out_segs = [s for s in res["parsed"]["segments"] if s["extruding"]]

    # Check front wall (-Y, |x| < 25, z in 25..95) has strong outward -Y push (> 2.0 mm beyond base -42 mm)
    front_y = [s["y1"] for s in out_segs if abs(s["x1"]) < 25.0 and s["y1"] < -30.0 and 25.0 < s["z1"] < 95.0]
    assert front_y and min(front_y) < -44.2, f"Front wall should weave outward past -44.2 mm, got min_y={min(front_y) if front_y else None}"

    # Check back (+Y), right (+X), left (-X) walls remain 100% smooth (exactly 42.0 mm +/- 0.05 mm)
    back_y = [s["y1"] for s in out_segs if abs(s["x1"]) < 25.0 and s["y1"] > 30.0 and 25.0 < s["z1"] < 95.0]
    right_x = [s["x1"] for s in out_segs if abs(s["y1"]) < 25.0 and s["x1"] > 30.0 and 25.0 < s["z1"] < 95.0]
    left_x = [s["x1"] for s in out_segs if abs(s["y1"]) < 25.0 and s["x1"] < -30.0 and 25.0 < s["z1"] < 95.0]
    assert back_y and max(abs(y - 42.0) for y in back_y) < 0.05, f"Back wall deviated! max err={max(abs(y - 42.0) for y in back_y):.3f}"
    assert right_x and max(abs(x - 42.0) for x in right_x) < 0.05, f"Right wall deviated! max err={max(abs(x - 42.0) for x in right_x):.3f}"
    assert left_x and max(abs(x + 42.0) for x in left_x) < 0.05, f"Left wall deviated! max err={max(abs(x + 42.0) for x in left_x):.3f}"

    # Check oozing blobs ONLY fired on the front wall (y < -20), NEVER on back/left/right!
    ooze_evs = res["parsed"]["ooze_events"]
    assert len(ooze_evs) > 0, "Expected oozing blobs on front wall!"
    bad_ooze = [ev for ev in ooze_evs if ev["y"] > -20.0]
    assert not bad_ooze, f"Oozing leaked onto inactive wall(s)! count={len(bad_ooze)}, sample={bad_ooze[0]}"

    print(f"[PASS] test_square_vase_selective_face_mask (front_min_y={min(front_y):.2f} mm, other 3 walls exact 42.00 mm, {len(ooze_evs)} front-only blobs)")


def test_parametric_waveforms_heightmap_and_rim():
    from gcode_engine import generate_parametric_gcode, register_procedural_heightmap

    # 1. Parametric hexagon with 90 deg twist + custom A-E profile
    param_cfg = {
        "profile_points": [[30, 0.0], [48, 0.3], [44, 0.6], [34, 0.85], [40, 1.0]],
        "height_mm": 110.0,
        "sides": 6,
        "corner_round": 0.3,
        "twist_deg": 90.0,
        "smooth": True,
    }
    base_gc = generate_parametric_gcode(param_cfg, "wasp_2040_clay", layer_height_mm=1.5, include_base=False)
    p_base = parse_gcode(base_gc)
    ext = [s for s in p_base["segments"] if s["extruding"]]
    assert len(ext) > 5000
    assert 105.0 <= max(s["z1"] for s in ext) <= 115.0

    # 2. All 5 waveforms execute cleanly and produce distinct radial displacements
    for wf in ("sine", "triangle", "square", "sawtooth", "scales"):
        r_wf = process_and_generate_gcode(
            base_gc,
            "wasp_2040_clay",
            {
                "preset_shape": "parametric",
                "parametric": param_cfg,
                "include_base": False,
                "layer_height_mm": 1.5,
                "weaving": {"enabled": True, "waveform": wf, "mode": "outward", "freq": 12, "h_amp_mm": 2.5, "z_min": 10, "z_max": 100},
            },
        )
        assert "base_parsed" in r_wf, "Parametric process must return base_parsed for live ghost update!"
        assert r_wf["analysis"]["stats"]["extruding_count"] > 5000

    # 3. Procedural Image-Heightmap + Non-Planar Rim Wave
    hm_info = register_procedural_heightmap("voronoi")
    r_hm = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "parametric",
            "parametric": param_cfg,
            "include_base": False,
            "layer_height_mm": 1.5,
            "heightmap": {"enabled": True, "heightmap_id": hm_info["heightmap_id"], "depth_mm": 3.0, "repeat_x": 2.0, "repeat_y": 1.0, "z_min": 10, "z_max": 100},
            "nonplanar": {"enabled": True, "mode": "rim_wave", "freq": 6, "z_amp_mm": 3.0, "z_min": 20, "z_max": 110},
        },
    )
    hm_ext = [s for s in r_hm["parsed"]["segments"] if s["extruding"]]
    top_zs = [s["z1"] for s in hm_ext[-128:]]
    assert (max(top_zs) - min(top_zs)) > 4.0, f"Rim wave should modulate top rim Z by ~6 mm, got {max(top_zs) - min(top_zs):.2f}"

    # 4. Clay shrinkage compensation (12% shrinkage -> 1 / 0.88 = 1.1364x wet scale)
    r_sh = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "parametric",
            "parametric": param_cfg,
            "include_base": False,
            "layer_height_mm": 1.5,
            "shrinkage_pct": 12.0,
            "shrinkage_compensate": True,
        },
    )
    z_wet = r_sh["analysis"]["bounds"]["max_z"]
    assert abs(z_wet - 110.0 / 0.88) < 2.0, f"Expected compensated Z ~125.0 mm, got {z_wet:.2f}"
    print(f"[PASS] test_parametric_waveforms_heightmap_and_rim (5 waveforms + voronoi heightmap + rim_wave dz={max(top_zs)-min(top_zs):.2f} mm + shrinkage Z={z_wet:.1f} mm)")


def test_flow_modulator_and_crisp_brick():
    from gcode_engine import generate_preset_gcode

    base_gc = generate_preset_gcode("tumbler", "wasp_2040_clay", layer_height_mm=1.5, include_base=False)

    # 1. Flow-Modulator: 0.0x (zero extrusion!) to 4.5x extreme peak, zero G4 dwell, all 5 curves
    for curve in ("smooth", "sharp", "plateau", "ramp_up", "ramp_down"):
        res = process_and_generate_gcode(
            base_gc,
            "wasp_2040_clay",
            {
                "preset_shape": "tumbler",
                "include_base": False,
                "layer_height_mm": 1.5,
                "oozing": {
                    "enabled": True,
                    "curve": curve,
                    "flow_min": 0.0,
                    "flow_max": 4.5,
                    "width": 0.65,
                    "speed_min": 0.35,
                    "count_per_turn": 10,
                    "every_n_layers": 2,
                    "push_mm": 2.0,
                    "dwell_ms": 0,
                    "extra_e": 0,
                    "z_min": 10,
                    "z_max": 85,
                },
            },
        )
        assert "G4 " not in res["gcode"], f"Flow-Modulator ({curve}) should not emit G4 dwell when dwell_ms=0!"
        segs = res["parsed"]["segments"]
        # Must contain zero-extrusion segments (E0.0000) in the valleys AND high-flow segments (>3.5x base) at peaks!
        zero_e_wall = [s for s in segs if (not s["extruding"]) and 15.0 < s["z1"] < 80.0 and s["len3d"] > 0.2]
        max_epm = max((s["e_per_mm"] for s in segs if s["extruding"] and 15.0 < s["z1"] < 80.0), default=0.0)
        assert len(zero_e_wall) > 10, f"Expected zero-extrusion valleys for flow_min=0.0 ({curve}), got {len(zero_e_wall)}"
        assert max_epm > 0.65, f"Expected extreme high-flow peaks (>0.65 E/mm) for flow_max=4.5 ({curve}), got {max_epm:.3f}"

    # 2. Crisp 2-point Brick: narrow (25%) vs wide (75%) must have different outer-point proportions & sharp corners!
    r_narrow = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "tumbler",
            "include_base": False,
            "layer_height_mm": 1.5,
            "weaving": {"enabled": True, "waveform": "square", "brick_duty": 0.25, "mode": "outward", "freq": 10, "h_amp_mm": 4.0, "z_min": 10, "z_max": 85},
        },
    )
    r_wide = process_and_generate_gcode(
        base_gc,
        "wasp_2040_clay",
        {
            "preset_shape": "tumbler",
            "include_base": False,
            "layer_height_mm": 1.5,
            "weaving": {"enabled": True, "waveform": "square", "brick_duty": 0.75, "mode": "outward", "freq": 10, "h_amp_mm": 4.0, "z_min": 10, "z_max": 85},
        },
    )
    def outer_len(res_obj):
        return sum(s["xy"] for s in res_obj["parsed"]["segments"] if s["extruding"] and 25.0 < s["z1"] < 70.0 and math.hypot(s["x1"], s["y1"]) > 40.5)
    len_narrow = outer_len(r_narrow)
    len_wide = outer_len(r_wide)
    assert len_wide > len_narrow * 2.2, f"75% Brick width should have >2.2x outer wall length vs 25%, got wide={len_wide:.1f} vs narrow={len_narrow:.1f}"
    print(f"[PASS] test_flow_modulator_and_crisp_brick (0.0x-4.5x flow mod + 5 curves + crisp brick wide={len_wide:.0f}mm vs narrow={len_narrow:.0f}mm)")


if __name__ == "__main__":
    test_real_wasp_puzzle_gcode()
    test_real_ender_header_gcode()
    test_weaving_oozing_and_profile_conversion()
    test_safety_checks_catch_hazards()
    test_nozzle_diameter_scaling()
    test_ooze_exact_angular_precision_and_wasp_layer_reslicing()
    test_vase_mode_without_base()
    test_outward_only_weaving_never_bends_inward()
    test_3dm_and_stl_import()
    test_square_vase_selective_face_mask()
    test_parametric_waveforms_heightmap_and_rim()
    test_flow_modulator_and_crisp_brick()
    test_http_api()
    print("\nALL TESTS PASSED SUCCESSFULLY!")
