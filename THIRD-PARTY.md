# Third-party components

NASSCAD 4.7.0 bundles the components below. **All of them are local — zero CDN, no network call at runtime.** Each stays under its own license; the CC BY-NC 4.0 license of NassLab's own code does not apply to them.

## In the browser

| Component | Author | License | Used for |
|-----------|--------|---------|----------|
| **three.js** | Mr.doob and contributors | MIT | 3D WebGL rendering |
| **OpenCASCADE Technology** | Open Cascade SAS | LGPL 2.1 with exception | B-Rep CAD kernel — fillet/chamfer, STEP assembly, colour and PMI reading |
| **occt-import-js** | Viktor Kovács | MIT | Browser bridge to OpenCASCADE for STEP import |
| **Draco** | Google | Apache 2.0 | Mesh compression, glTF/GLB import and export |
| **helvetiker** regular / bold | MAGENTA Ltd — MgOpen Modata | MgOpen License | Text geometry |
| **optimer** regular / bold | MAGENTA Ltd — MgOpen Cosmetica | MgOpen License | Text geometry |
| **gentilis** regular / bold | J. Victor Gaultney / SIL International | SIL OFL 1.1 | Text geometry |
| **nasscad_logs.js** | NassLab | CC BY-NC 4.0 | Structured logging module |

## In the NASSCAD Engine (MEDUSA) — required for booleans, runs on your own machine

| Component | Author | License | Used for |
|-----------|--------|---------|----------|
| **OpenCASCADE Technology** | Open Cascade SAS | LGPL 2.1 with exception | Native STEP reading and tessellation |
| **Manifold** | Emmett Lalish and contributors | Apache 2.0 | Boolean CSG engine |
| **oneTBB** | Intel / UXL Foundation | Apache 2.0 | Multithreading |
| **Clipper2** | Angus Johnson | Boost Software License 1.0 | 2D polygon clipping, used by Manifold |
| **hwloc** | Inria and the Open MPI project | BSD 3-Clause | CPU topology detection, used by oneTBB |

## Release assets

`opencascade.wasm.data.js` and `opencascade.wasm.wasm` are builds of **OpenCASCADE Technology** (Open Cascade SAS, LGPL 2.1 with exception) compiled to WebAssembly. They are distributed as GitHub release assets rather than committed to the repository, and remain under the OCCT license.

## License texts

- MIT — https://opensource.org/licenses/MIT
- Apache 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- LGPL 2.1 with OCCT exception — https://dev.opencascade.org/resources/licensing
- Boost Software License 1.0 — https://www.boost.org/LICENSE_1_0.txt
- BSD 3-Clause — https://opensource.org/licenses/BSD-3-Clause
- SIL OFL 1.1 — https://openfontlicense.org/
- MgOpen — https://www.ellak.gr/fonts/mgopen/license.html
- CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
