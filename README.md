# NASSCAD 4.7.0 — MEDUSA

> Free browser-based parametric 3D CAD & STL viewer — OpenCASCADE WASM · STEP AP242 · Three.js

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Version](https://img.shields.io/badge/version-4.7.0%20MEDUSA-blue.svg)](https://www.nasscad.com/)
[![Live Demo](https://img.shields.io/badge/demo-nasscad.com-brightgreen.svg)](https://www.nasscad.com/)
[![Previous](https://img.shields.io/badge/previous-4.2.7-lightblue.svg)](https://github.com/Nx-Nass/Nasscad_4.2.7)

**NASSCAD** is a fully offline, browser-based 3D CAD modeler and STL viewer. No server, no install, no login, nothing uploaded. Open the HTML file — it works.

Version 4.7.0 takes its name from its companion. It replaces the local WASM pool of the 4.2.x line with a real B-Rep kernel — **OpenCASCADE** in the browser for STEP, fillet and chamfer — and moves every boolean operation into **MEDUSA**, a native engine (C++ / oneTBB) that runs on your own machine.

> **MEDUSA is required for boolean operations.** Manifold no longer runs in the browser at all, and there is no WASM fallback: with MEDUSA stopped, Union / Subtraction / Intersection stop with an explicit error. Everything else — viewing, primitives, fillet, chamfer, STEP and mesh I/O — runs in the browser alone. See [NASSCAD Engine](#-nasscad-engine--medusa).

---

## ⚡ Quick start

The two OpenCASCADE WASM binaries (≈ 154 MB) are **not** in the repository — they are attached to the [latest release](../../releases/latest). Clone, then fetch them:

```powershell
git clone https://github.com/Nx-Nass/Nasscad_4.7.0.git
cd Nasscad_4.7.0
.\scripts\fetch-assets.ps1        # Windows
```

```bash
git clone https://github.com/Nx-Nass/Nasscad_4.7.0.git
cd Nasscad_4.7.0
./scripts/fetch-assets.sh         # Linux / macOS
```

Then build and start **MEDUSA** — booleans do not work without it. The build bundles are in the `DEPLOY_*` folders (`BUILD.md` for Windows/MSVC, `install-linux.sh` for Ubuntu, `deploy.bat` for WSL); see [NASSCAD Engine](#-nasscad-engine--medusa) below.

Then open `NASSCAD_V4_7_0.htm`. The CSG panel shows the engine state: green `· MEDUSA` when it is reachable, red `· MEDUSA OFF` when it is not.

> ⚠️ **Serve it, don't double-click it.** WASM streaming and the OCCT data file need a real HTTP origin. Any static server works:
> ```bash
> python -m http.server 8080     # then open http://localhost:8080/NASSCAD_V4_7_0.htm
> ```
> Chrome launched with `--allow-file-access-from-files`, or the VS Code Live Server extension, also work.

---

## ✨ What's in 4.7.0

| | |
|---|---|
| **18 watertight primitives** | ArcSphere, Cylind, Cubic, Tore, Gear, Screw, Nut, Pipe, RevSolid, Gen… |
| **Real fillet & chamfer** | True B-Rep operations via OpenCASCADE, on picked edges or all edges |
| **STEP AP203 / AP214 / AP242** | Import **and** export, with per-part *and* per-face colours read from the file itself |
| **PMI & GD&T** | Product manufacturing information read from STEP assemblies |
| **Non-destructive CSG tree** | Union / Subtraction / Intersection keep their construction tree — change a source and Re-run |
| **Native CSG engine** | All booleans run in MEDUSA — C++, multithreaded, on your own machine. **Required**, no browser fallback |
| **Sketch.Gen** | 2D sketcher |
| **Generators** | Screw.Gen & Nut.Gen (ISO / ASME), Gear.Gen, Pipe.Gen, CircularText.Gen |
| **NassScript** | Full-access JS console over the scene graph |
| **Undo / Redo** | 200 levels, IndexedDB-persistent |
| **Editing** | Box-select, face handles, 3-axis rotation gizmo, X-Ray mode, magnetic snap down to 0.001 mm |
| **Import** | STL · OBJ · 3MF · GLB · PLY · STEP |
| **Export** | STL · OBJ · 3MF · GLB · PLY · STEP AP242 · SVG · DXF |

Requires a modern browser with WebGL and WebAssembly: Chrome 90+, Firefox 90+, Safari 16+.

---

## 🗂 Repository layout

```
NASSCAD_V4_7_0.htm          Application — the single entry point
three.js                    Renderer
nasscad-fonts.js            Bundled typefaces
nasscad-draco.js            Draco codec (GLB/glTF)
nasscad-gens.js             Generators: Sketch, Screw, Nut, Gear, Pipe, CircularText
nasscad-io.js               Import / export pipeline
nasscad-materials.js        Material library
nasscad_logs.js             Structured logging
nasscad_occt_wasm.js        OCCT glue layer
nassscript.js               NassScript console
occt-import-js.js           occt-import-js bridge
occt-loader-b64.js          OCCT loader
quick-fillet.js             Fillet / chamfer (OCCT)
step-import.js              STEP reader
step-export.js              STEP AP242 writer
step-xcaf.js                XCAF — colours, PMI, assembly structure

scripts/                    fetch-assets.ps1 / .sh — pull the WASM binaries
DEPLOY_WINDOWS_11_MSVC/     MEDUSA engine — MSVC build (source + CMake + vcpkg)
DEPLOY_UBUNTU_LINUX/        MEDUSA engine — native Ubuntu installer
DEPLOY_UBUNTU_WSL/          MEDUSA engine — WSL deployment
```

**Not in git** (fetched from the release): `opencascade.wasm.data.js` (88 MB) and `opencascade.wasm.wasm` (66 MB).

---

## 🐙 NASSCAD Engine — MEDUSA

**Required for boolean operations.** Since 4.7.0, `manifold.js` and `manifold_worker.js` are gone: Manifold no longer runs in the browser at all. Every boolean goes to MEDUSA over local HTTP (`POST /csg` for a flat operation, `POST /csgtree` for a whole tree), and reachability is re-probed before each one. There is **no WASM fallback** — with MEDUSA stopped, the engine badge turns red (`MEDUSA OFF`) and the operation stops with an explicit error rather than silently degrading.

MEDUSA is a small native binary that runs **on your own machine** and listens only to it — nothing is uploaded, no account, no remote server. It links Manifold in native C++ with oneTBB, so booleans run at compiled-native speed across your cores instead of single-threaded WASM, and it also does native STEP reading and tessellation.

**Works without MEDUSA** — viewing, the 18 primitives, selection, gizmos, fillet and chamfer, and import/export of STEP, STL, OBJ, 3MF, GLB and PLY. All of that is OpenCASCADE WASM in the browser and needs nothing installed.

**Needs MEDUSA** — Union, Subtraction and Intersection, Deep Re-run of a CSG tree, and auto-union repair.

**Engine log — on demand, not on disk.** MEDUSA writes no log file. The last 20 000 lines are kept in memory and served as plain text by `GET /log?n=<max>` — the jellyfish button in the NASSCAD Logs panel pulls them into the panel, next to the browser-side log of the same session. Pass `--logfile` to also write a timestamped `medusa-logs-<date>.txt`, as earlier builds did.

Build bundles are in the `DEPLOY_*` folders:

| Target | Contents |
|--------|----------|
| `DEPLOY_WINDOWS_11_MSVC` | `nasscad_medusa.cpp`, `CMakeLists.txt`, `vcpkg.json`, `build_msvc.bat`, `BUILD.md` |
| `DEPLOY_UBUNTU_LINUX` | `install-linux.sh`, `nasscad.sh`, desktop launcher + icons, `README-LINUX.md` |
| `DEPLOY_UBUNTU_WSL` | `deploy.bat` / `deploy.sh`, `Medusa_Engine_3.1.bat`, uninstallers |

---

## 📦 Third-party components — all local, zero CDN

**In the browser**

| Component | Author | License |
|-----------|--------|---------|
| `three.js` | Mr.doob and contributors | MIT |
| OpenCASCADE Technology | Open Cascade SAS | LGPL 2.1 with exception |
| `occt-import-js` | Viktor Kovács | MIT |
| Draco | Google | Apache 2.0 |
| `helvetiker` regular / bold | MAGENTA Ltd — MgOpen Modata | MgOpen License |
| `optimer` regular / bold | MAGENTA Ltd — MgOpen Cosmetica | MgOpen License |
| `gentilis` regular / bold | J. Victor Gaultney / SIL International | SIL OFL 1.1 |
| `nasscad_logs.js` | NassLab | CC BY-NC 4.0 |

**In the NASSCAD Engine companion**

| Component | Author | License |
|-----------|--------|---------|
| OpenCASCADE Technology | Open Cascade SAS | LGPL 2.1 with exception |
| Manifold | Emmett Lalish and contributors | Apache 2.0 |
| oneTBB | Intel / UXL Foundation | Apache 2.0 |
| Clipper2 | Angus Johnson | Boost Software License 1.0 |
| hwloc | Inria and the Open MPI project | BSD 3-Clause |

Each third-party component stays under its own license. See [`THIRD-PARTY.md`](THIRD-PARTY.md).

---

## 👥 Authors

| Role | |
|------|-|
| **Architect & Tester** | **Nasser** — NassLab, Marseille, France. Vision, direction, critical bug identification, quality standards, field testing, technology pivots. |
| **Developer** | **Claude** — Anthropic. Native CSG engine, watertight primitives, STEP colour decoding verified against the file itself, surgical patches, systematic verification before delivery. |

---

## 📄 License

© 2026 NassLab — Nasser, France

NassLab's own code is distributed under the **Creative Commons BY-NC 4.0** license:

- **Personal and non-commercial use** — free, redistribution allowed with attribution
- **Commercial use** — written agreement required from NassLab

[Full license →](https://creativecommons.org/licenses/by-nc/4.0/) · [`LICENSE`](LICENSE)

Third-party components listed above are **not** covered by CC BY-NC 4.0 and remain under their respective licenses.

INPI Soleau filings: DSO2026022493 · DSO2026016593 · DSO2026011841 · DSO2026010838

> No implied warranty. The author cannot be held liable for any damage resulting from the use of this software.

---

*NASSCAD — NassLab · Marseille, 2026*
