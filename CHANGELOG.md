# Changelog

All notable changes to NASSCAD.

This file was reconstructed from the README and the release history. Entries before
4.7.0 are summarised from the 4.2.x line rather than from a per-commit log, so they
describe what changed between versions, not every individual fix.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
NASSCAD does not follow semantic versioning: the version number tracks the
application release, not an API.

---

## [4.7.0] — 2026-09-02 — "MEDUSA"

The release that swaps a mesh pipeline for a real B-Rep kernel.

### Added

- **OpenCASCADE in the browser.** OCCT 7.4.0 via opencascade.js, bundled as
  `opencascade.wasm.wasm` (66 MB) and `opencascade.wasm.data.js` (88 MB), both
  versioned in the repository so a clone runs with no asset-fetching step.
- **Real fillet and chamfer** — true B-Rep operations on picked edges or all edges,
  replacing the mesh-level approximation of the 4.2.x line.
- **STEP AP242 export** with per-face colours and PMI, alongside AP203 / AP214 /
  AP242 import.
- **PMI and GD&T** read from STEP assemblies.
- **IFC read and write** — IFC2X3 / IFC4 / IFC4X3 in, IFC4 out, with the
  Project › Site › Building › Storey structure, via the bundled web-ifc engine.
- **MEDUSA**, an optional native engine (C++ / Manifold / oneTBB) that runs booleans
  multithreaded on the local machine, with native STEP reading and tessellation.
  Shipped as source plus build bundles for Windows/MSVC, Ubuntu and WSL.
- **Build volume** for 28 printers, and a gridded world room sized to the scene.
- **Progressive booleans** — a fast preview first, the full-quality result right after.
- **Engine log over HTTP** — `GET /log?n=<max>`, in memory, no log file on disk.

### Changed

- Boolean operations are routed to MEDUSA when it is reachable, and fall back to the
  browser otherwise.
- Toolbox reorganised to 6 icons per row, with per-button documentation in the
  built-in help.
- Undo / Redo raised to 200 levels, persisted in IndexedDB.

### Fixed

- **2026-09-23 — NotManifold on coplanar spheres.** Mesh welding by proximity now
  probes neighbouring cells by integer index. Spheres centred on the Z = 0 plane kept
  one unwelded seam vertex and failed as *NotManifold*; they now union cleanly. The
  fix is carried by the source in all three `DEPLOY_*` bundles.

---

## [Unreleased]

### Added

- **2026-09-30 — browser boolean fallback restored.** `nasscad-manifold-wasm.js` is
  back in the application and is now the default boolean engine. Union, Subtraction
  and Intersection run in the browser with nothing installed; MEDUSA is used when it
  is running and skipped when it is not. This reverses the 4.7.0 decision to make the
  native engine mandatory.
- Screenshots and an orbit animation in `docs/images/`, used by the README.
- `CHANGELOG.md`, `CONTRIBUTING.md` and GitHub issue templates.

### Changed

- README rewritten: the quick start now leads with the hosted version at
  [nasscad.com](https://www.nasscad.com) instead of a 154 MB clone, the MEDUSA
  sections describe it as an optional accelerator rather than a requirement, and a
  "Status & roadmap" section states plainly what works and what does not.
- Removed the "designed and optimized for 1920×1080 or higher" notice, which read as
  a refusal to support laptops, Chromebooks and tablets. Replaced by a note on
  comfortable panel width.

---

## [4.2.7] — earlier line

The last of the 4.2.x releases, and the end of the mesh-only architecture.

- Booleans ran on a pool of Manifold WebAssembly workers in the browser.
- No B-Rep kernel: fillet and chamfer were mesh-level operations.
- STEP support was import-oriented; AP242 export, PMI and IFC came with 4.7.0.
- Repository: <https://github.com/Nx-Nass/Nasscad_4.2.7>

---

[4.7.0]: https://github.com/Nx-Nass/Nasscad_4.7.0/releases/tag/v4.7.0
[4.2.7]: https://github.com/Nx-Nass/Nasscad_4.2.7
