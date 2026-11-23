# KIND Clay Custom G-Code Studio

**Live im Browser (GitHub Pages – 100 % client-seitig, ohne Installation):**
👉 **https://dima1999ukr.github.io/kind-clay-gcode-studio/**

Parametrisches Ton- & FDM-3D-Druck Studio für die **Delta WASP 2040 Clay (LDM)** und **Creality Ender-5 S1 (PLA)** – entwickelt im Rahmen von **KIND Clay** (Hochschule Trier, Campus Gestaltung).

## Features
- **Form-Sculptor (Profil A–E):** Interaktiver 2D-Profil-Editor mit 5 ziehbaren Kontrollpunkten, Höhe (`35–260 mm`), Seitenanzahl (`3–64` + Ecken-Rundung) und Twist (`-240° bis +240°`).
- **3D-Import:** Direkter Upload von `.3dm` (Rhino), `.stl`, `.obj`, `.3mf`, `.ply` und `.gcode`.
- **Selektive Flächen-Auswahl (3D-Klick):** Einzelne Wände (z. B. Vorderwand der viereckigen Vase) im UI oder direkt im 3D-Viewport anklicken – Muster wirken mit weichem $C^1$-Ecken-Übergang und lokalen Wandnormalen nur auf aktiven Wänden.
- **Horizontales Weaving:** 5 Wellenformen (*Weiche Wellen*, *Pleats/Dreieck*, *Exakte 2-Punkt-Bricks* mit einstellbarer Brick-Breite, *Sägezahn*, *Schuppen*).
- **Non-Planar:** Z-Wellen in der Wand, gewellter Rand oben (*Rim-Fade*) und progressive Schicht-Neigung (*Tilt*).
- **Reiner Flow-Modulator:** Steuert ausschließlich Tonfluss (`0.00×–5.00×`) und Peak-Tempo über 5 Kurvenformen – ohne die modellierte XYZ-Bahn zu verändern.
- **Bild als Relief (Image-Heightmap):** `.png`/`.jpg` hochladen oder prozedurale Reliefs (*Voronoi*, *Schach*, *Raute*, *Noppen*) direkt auf die Wand prägen.
- **Ton-Schwund-Rechner:** Nass- vs. Brandmaße (`Irdenware 8%`, `Steinzeug 11%`, `Porzellan 13%`) mit automatischer Maßkompensation ($1 / (1 - s)$).
- **Rhino-Ghosted Druckbahnen & glatte 3D-Ton-Vorschau** + Fine-Scrubbing Simulation.

## Lokal starten
```bash
pip install -r requirements.txt
python server.py
```
Öffne anschließend `http://127.0.0.1:8765` im Browser.

## Kostenlos online deployen
- **Render.com:** Repository verbinden → `render.yaml` wird automatisch erkannt → 1-Klick-Deploy.
- **Hugging Face Spaces:** Neues Docker-Space anlegen → Dateien hochladen (`Dockerfile` startet automatisch auf Port `7860`).
