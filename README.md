# NASSCAD 4.2.7

> Offline single-file 3D CAD modeler — Manifold WASM CSG / Three.js

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Version](https://img.shields.io/badge/version-4.2.7-blue.svg)](https://www.nasscad.com/)
[![Live Demo](https://img.shields.io/badge/demo-nasscad.com-brightgreen.svg)](https://www.nasscad.com/)

**NASSCAD** is a fully offline, browser-based 3D CAD modeler. No server. No install. No internet. Open the HTML file — it works.

---

## ✨ Features

- **100% offline** — zero CDN, zero server, zero dependencies to install
- **17 watertight primitives** — ArcSphere, Cylind, Cubic, Tore, Gear, Screw, Pipe, RevSolid, Gen and more
- **Non-destructive CSG Tree** — boolean operations with full arborescent history (200 undo/redo levels, IDB-persistent)
- **Progressive CSG (2-pass)** — Manifold WASM engine + BSP fallback for maximum robustness
- **BVH Raycaster** — AABB cache + firstHitOnly for sub-millisecond selection
- **GeometryPool** — 512MB–2GB custom binary arena, GC mark-and-sweep, DataView global
- **Box-select** — rectangle NDC multi-selection
- **NassScript** — built-in scripting interface
- **Import / Export** — STL, OBJ, 3MF
- **Threads** — parametric M2 to M20 (UNC + metric)
- **Snap** — 0.1 mm precision
- **X-Ray mode**, **Rotation Gizmo 3-axis**, **Sphere resolution slider**

---

## 🏗 Architecture

| Component | Details |
|-----------|---------|
| Renderer | Three.js r128 |
| CSG Engine | Manifold WASM (Worker Pool ×N async) + BSP fallback |
| Geometry Pool | 512MB–2GB binary arena, GC mark-and-sweep |
| Undo / Redo | 200 levels — TypedArrays structured clone, IDB-persistent |
| CSG History | Arborescent `_csgTree` Map — serialized in IndexedDB |
| Raycaster | BVH (AABB cache per mesh, firstHitOnly) |
| AABB Cache | Box3 world-space per mesh — rebuilt on position/scale change |
| Selection | Box-select rectangle NDC |

---

## 📦 Dependencies (all local — zero CDN)

| Library | Author | License |
|---------|--------|---------|
| `three.js` | Mr.doob & community | MIT |
| `manifold.js` + `manifold_worker.js` | Emmett Lalish et al. | Apache 2.0 |
| `helvetiker_regular/bold.js` | MAGENTA Ltd / MgOpen Modata | MgOpen License |
| `optimer_regular/bold.js` | MAGENTA Ltd / MgOpen Cosmética | MgOpen License |
| `gentilis_regular/bold.js` | J. Victor Gaultney / SIL International | SIL OFL 1.1 |
| `NUTS_AND_BOLTS.js` | NassLab | CC BY-NC 4.0 |
| `nasscad_logs.js` | NassLab | CC BY-NC 4.0 |

---

## 🚀 Usage

No installation required.

```bash
# Clone the repository
git clone https://github.com/Nx-Nass/Nasscad_4.2.7.git

# Open in your browser
open nasscad.html   # macOS
start nasscad.html  # Windows
xdg-open nasscad.html  # Linux
```

Or download the ZIP and open `nasscad.html` directly in Chrome, Firefox, or Edge.

> ⚠️ For full WASM support, open via a local server or a browser that allows local file access (Chrome with `--allow-file-access-from-files`, or VS Code Live Server).

---

## 👥 Authors

| Role | |
|------|-|
| **Architect & Lead Developer** | Nasser — NassLab, Marseille, France |
| **AI Developer** | Claude Sonnet 4.6 — Anthropic |

---

## 📄 License

© 2026 NassLab — Nasser, France

Distributed under the **Creative Commons BY-NC 4.0** license:

- **Personal and non-commercial use** — free, redistribution allowed with attribution
- **Commercial use** — written agreement required from NassLab

[View full license →](https://creativecommons.org/licenses/by-nc/4.0/)

> No implied warranty. The author cannot be held liable for any damage resulting from the use of this software.

---

*NASSCAD — co-developed with Claude Sonnet 4.6 · Marseille, 2026*
