# Third-party components

NASSCAD 4.7.0 bundles the components below. **All of them are local — zero CDN.** Opened from your own disk, NASSCAD makes no network call at runtime. Each component stays under its own license; the CC BY-NC 4.0 license of NassLab's own code does not apply to them.

## In the browser

| Component | Version | Author | License | Used for |
|-----------|---------|--------|---------|----------|
| **three.js** | r128 | three.js authors | MIT | 3D WebGL rendering |
| **OpenCASCADE Technology** | 7.4.0 via opencascade.js 1.1.1 | Open Cascade SAS / Sebastian Alff | LGPL 2.1 with exception | B-Rep CAD kernel — fillet/chamfer, STEP assembly, colour and PMI reading (`opencascade.wasm.wasm`, `opencascade.wasm.data.js`) |
| **occt-import-js** | — | Viktor Kovács | LGPL 2.1 | STEP import, embeds OpenCASCADE Technology |
| **web-ifc** | 0.0.77 | That Open Company | MPL 2.0 | IFC import — IFC2X3 / IFC4 / IFC4X3 (`web-ifc-api-iife.js`, `nasscad-ifc-wasm.js`) — license text in [`web-ifc-LICENSE.md`](web-ifc-LICENSE.md) |
| **Draco** | 1.5.7 | Google | Apache 2.0 | Mesh compression, glTF/GLB import and export |
| **helvetiker** regular / bold | — | MAGENTA Ltd — MgOpen Modata | MgOpen License | Text geometry |
| **optimer** regular / bold | — | MAGENTA Ltd — MgOpen Cosmetica | MgOpen License | Text geometry |
| **gentilis** regular / bold | — | J. Victor Gaultney / SIL International | SIL OFL 1.1 | Text geometry |
| **nasscad_logs.js** | — | NassLab | CC BY-NC 4.0 | Structured logging module |

## In the NASSCAD Engine (MEDUSA) — required for booleans, runs on your own machine

| Component | Version | Author | License | Used for |
|-----------|---------|--------|---------|----------|
| **OpenCASCADE Technology** | 8.0.1 | Open Cascade SAS | LGPL 2.1 with exception | Native STEP reading and tessellation — unmodified DLLs |
| **Manifold** | 3.5.3 | Emmett Lalish and contributors | Apache 2.0 | Boolean CSG engine |
| **oneTBB** | 2022.2.0 | Intel / UXL Foundation | Apache 2.0 | Multithreading |
| **Clipper2** | 1.5.4 | Angus Johnson | Boost Software License 1.0 | 2D polygon clipping, used by Manifold |
| **hwloc** | 2.11.2 | Inria and the Open MPI project | BSD 3-Clause | CPU topology detection, shipped with oneTBB |

## Web version only (nasscad.com)

| Component | Author | Used for |
|-----------|--------|----------|
| **Google Analytics 4** | Google | Audience measurement — loaded only when NASSCAD is opened from nasscad.com, never when the file is opened locally |

## Source code of the LGPL / MPL components

- OpenCASCADE Technology — https://github.com/Open-Cascade-SAS/OCCT (tag `V8_0_1`)
- opencascade.js — https://github.com/donalffons/opencascade.js (v1.1.1)
- occt-import-js — https://github.com/kovacsv/occt-import-js
- web-ifc — https://github.com/ThatOpen/engine_web-ifc (0.0.77)

## License texts

- MIT — https://opensource.org/licenses/MIT
- Apache 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- LGPL 2.1 with OCCT exception — https://dev.opencascade.org/resources/licensing
- MPL 2.0 — [`web-ifc-LICENSE.md`](web-ifc-LICENSE.md) · https://www.mozilla.org/MPL/2.0/
- Boost Software License 1.0 — https://www.boost.org/LICENSE_1_0.txt
- BSD 3-Clause — https://opensource.org/licenses/BSD-3-Clause
- SIL OFL 1.1 — https://openfontlicense.org/
- MgOpen — https://www.ellak.gr/fonts/mgopen/license.html
- CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
