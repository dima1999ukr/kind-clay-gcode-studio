"""Printer profiles for KIND Custom G-Code Studio.

Calibrated directly from the user's real-world G-code files:
- WASP 2040 Clay (Delta bed, origin centered at 0,0, M83 relative extrusion)
- Creality Ender-5 S1 (220x220x280 cartesian bed, center 110,110, M83 relative extrusion)
"""

from __future__ import annotations
import copy
import math
from typing import Any, Dict

PRINTER_PROFILES: Dict[str, Dict[str, Any]] = {
    "wasp_2040_clay": {
        "id": "wasp_2040_clay",
        "name": "Delta WASP 2040 Clay (LDM)",
        "short_name": "WASP 2040 Clay",
        "material": "Clay / Keramik (LDM)",
        "kinematics": "delta",
        "bed_shape": "circle",
        "bed_diameter_mm": 200.0,
        "bed_width_mm": 200.0,
        "bed_depth_mm": 200.0,
        "bed_height_mm": 400.0,
        "origin_center": [0.0, 0.0],
        "extrusion_mode": "M83",
        "heated": False,
        "default_nozzle_mm": 2.0,
        "nozzle_presets_mm": [1.5, 2.0, 3.0, 4.0],
        "default_layer_height_mm": 1.2,
        "default_line_width_mm": 2.2,
        "default_speed_f": 900.0,       # 15 mm/s (F900)
        "travel_speed_f": 1800.0,       # 30 mm/s
        "ooze_speed_f": 300.0,
        "max_nozzle_angle_deg": 42.0,
        "max_safe_temp_c": 0.0,
        "filament_diameter_mm": None,
        # Calibrated from Puzzle_1_Slavynskyy.gcode: 80mm path -> E20.0 => 0.25 E/mm at ~1.5mm layer
        "clay_e_per_mm_ref": 0.25,
        "clay_ref_layer_mm": 1.5,
        "clay_ref_nozzle_mm": 2.0,
        "start_gcode": (
            "; ===================================================\n"
            "; KIND Clay Custom G-Code Studio - WASP 2040 Clay (LDM)\n"
            "; Delta-Druckbett: Ursprung (0,0) mittig, Ø200x400 mm\n"
            "; ===================================================\n"
            "G21                 ; Millimeter\n"
            "G90                 ; Absolute XYZ-Koordinaten\n"
            "M83                 ; Relative Extrusion\n"
            "M107                ; Luefter aus (Ton)\n"
            "G28                 ; Homing aller Delta-Achsen\n"
            "G92 E0              ; Extruder nullen\n"
            "G1 Z15.0 F1200      ; Sichere Anfahrthoehe\n"
            "G1 E2.0 F200        ; Schnecke leicht vorfuellen (Prime)\n"
        ),
        "end_gcode": (
            "; --- Abschluss / Freifahrt WASP 2040 Clay ---\n"
            "G91                 ; Relativ fuer sicheres Abheben\n"
            "G1 E-1.5 F240       ; Druck sanft entlasten\n"
            "G1 Z15.0 F1200      ; Senkrecht vom nassen Ton abheben\n"
            "G90                 ; Zurueck auf absolut\n"
            "G1 X0 Y0 F1500      ; Parkposition ueber Zentrum\n"
            "M107                ; Luefter/Relais aus\n"
            "M84                 ; Motoren aus\n"
        ),
    },
    "ender_5_s1": {
        "id": "ender_5_s1",
        "name": "Creality Ender-5 S1 (Sonic Pad / Klipper)",
        "short_name": "Ender-5 S1 (Sonic Pad)",
        "material": "PLA / PETG (1.75 mm)",
        "kinematics": "cartesian",
        "bed_shape": "rect",
        "bed_diameter_mm": 220.0,
        "bed_width_mm": 220.0,
        "bed_depth_mm": 220.0,
        "bed_height_mm": 280.0,
        "origin_center": [110.0, 110.0],
        "extrusion_mode": "M83",
        "heated": True,
        "default_nozzle_mm": 0.4,
        "nozzle_presets_mm": [0.4, 0.6, 0.8],
        "default_layer_height_mm": 0.24,
        "default_line_width_mm": 0.45,
        "default_speed_f": 1800.0,      # 30 mm/s (safe for custom non-planar)
        "travel_speed_f": 6000.0,       # 100 mm/s
        "ooze_speed_f": 240.0,
        "default_nozzle_temp_c": 205,
        "default_bed_temp_c": 60,
        "default_fan_pct": 80,
        "max_nozzle_angle_deg": 28.0,   # ~28 deg with fan shroud; ~42 deg without shroud
        "max_safe_temp_c": 265.0,
        "filament_diameter_mm": 1.75,
        "clay_e_per_mm_ref": None,
        "start_gcode": (
            "; ===================================================\n"
            "; KIND Custom G-Code Studio - Ender-5 S1 (Sonic Pad / Klipper)\n"
            "; Bauraum: 220x220x280 mm, Mitte (110,110), M83\n"
            "; ===================================================\n"
            "G21                 ; Millimeter\n"
            "G90                 ; Absolute XYZ-Koordinaten\n"
            "M83                 ; Relative Extrusion\n"
            "M104 S150           ; Vorheizen gegen Oozing beim Homing\n"
            "M140 S{bed_temp}    ; Heizbett-Zieltemperatur\n"
            "G28                 ; Homing aller Achsen\n"
            "; BED_MESH_PROFILE LOAD=default ; Optional bei Bedarf einkommentieren\n"
            "G1 Z30 F600         ; Sicherheitsabstand\n"
            "G1 X2.0 Y10 F3000   ; Start Prime-Linie\n"
            "M104 S{nozzle_temp} ; Duesen-Zieltemperatur\n"
            "M190 S{bed_temp}    ; Auf Heizbett warten\n"
            "M109 S{nozzle_temp} ; Auf Duese warten\n"
            "G1 Z0.28 F300       ; Auf Prime-Hoehe fahren\n"
            "G92 E0              ; Extruder nullen\n"
            "G1 X2.0 Y140 E10 F1500 ; Prime-Linie 1\n"
            "G1 X2.4 Y140 F5000\n"
            "G1 X2.4 Y10 E10 F1200  ; Prime-Linie 2\n"
            "G92 E0\n"
            "G1 Z2.0 F1200       ; Anheben vor Start\n"
            "M106 S{fan_pwm}     ; Bauteil-Luefter\n"
        ),
        "end_gcode": (
            "; --- Abschluss / Parken Ender-5 S1 ---\n"
            "G91                 ; Relativ\n"
            "G1 E-1.0 F1800      ; Kleiner Retract\n"
            "G1 Z10.0 F600       ; Druckkopf anheben\n"
            "G90                 ; Absolut\n"
            "G1 X5 Y176 F6000    ; Druck praesentieren\n"
            "M140 S0             ; Heizbett aus\n"
            "M104 S0             ; Duese aus\n"
            "M107                ; Luefter aus\n"
            "M84 X Y E           ; Motoren aus\n"
        ),
    },
}


def get_profile(profile_id: str) -> Dict[str, Any]:
    if profile_id not in PRINTER_PROFILES:
        raise ValueError(f"Unknown printer profile: {profile_id}")
    return copy.deepcopy(PRINTER_PROFILES[profile_id])


def compute_e_per_mm(
    profile: Dict[str, Any],
    layer_height_mm: float,
    line_width_mm: float,
    flow_multiplier: float = 1.0,
) -> float:
    """Calculate linear extrusion E per 1 mm of 3D toolpath travel."""
    if profile["id"] == "wasp_2040_clay" or not profile.get("filament_diameter_mm"):
        ref_e = float(profile.get("clay_e_per_mm_ref", 0.25))
        ref_h = float(profile.get("clay_ref_layer_mm", 1.5))
        ref_w = float(profile.get("clay_ref_nozzle_mm", 2.0)) * 1.1
        scale = (layer_height_mm / ref_h) * (line_width_mm / ref_w)
        return max(0.001, ref_e * scale * flow_multiplier)
    fil_d = float(profile["filament_diameter_mm"])
    fil_area = math.pi * (fil_d * 0.5) ** 2
    bead_area = layer_height_mm * line_width_mm
    return max(0.0001, (bead_area / fil_area) * flow_multiplier)


def render_start_gcode(
    profile: Dict[str, Any],
    nozzle_temp: int | None = None,
    bed_temp: int | None = None,
    fan_pct: int | None = None,
) -> str:
    tpl = profile["start_gcode"]
    if not profile.get("heated", False):
        return tpl
    nt = int(nozzle_temp if nozzle_temp is not None else profile.get("default_nozzle_temp_c", 205))
    bt = int(bed_temp if bed_temp is not None else profile.get("default_bed_temp_c", 60))
    fp = int(fan_pct if fan_pct is not None else profile.get("default_fan_pct", 80))
    fan_pwm = max(0, min(255, round(fp * 2.55)))
    return tpl.format(nozzle_temp=nt, bed_temp=bt, fan_pwm=fan_pwm)
