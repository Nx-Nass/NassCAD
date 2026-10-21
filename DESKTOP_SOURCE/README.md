# NASSCAD Windows desktop — AGPL release

This directory contains the Electron shell, installer customization and native
MEDUSA source used for the 20 October 2026 AGPL release. The browser assets
are in the repository root, so keep this directory inside the full source tree.

## Requirements

- Windows x64, Node.js 24, npm and Visual Studio 2022 C++ build tools.
- Electron 44.6.0 and electron-builder 26.15.3, pinned by package-lock.json.
- OpenCASCADE Technology 8.0.1, Manifold 3.5.3, oneTBB 2022.2.0 and hwloc 2.11.2
  built for MSVC x64 with their runtime dependencies. See ../THIRD-PARTY.md
  for upstream source links and licenses.

## Build

1. In this directory, run `npm ci`.
2. Set `OCCT_ROOT` and `MANIFOLD_ROOT` to the matching dependency install
   directories. Set `VSDEVCMD` if Visual Studio is installed elsewhere.
3. Run `npm run build:medusa`. The script compiles native/nasscad_medusa.cpp
   and copies OCCT and Manifold DLLs into runtime/medusa. Add the matching
   oneTBB, hwloc and redistributable MSVC runtime DLLs there, too.
4. Run `npm run pack` for an unpacked app, or `npm run dist` for Setup and Portable.
   Without a code-signing certificate, set `CSC_IDENTITY_AUTO_DISCOVERY=false`.

The native engine uses an internal pipe in the desktop edition. It differs
from the standalone HTTP companion in ../MEDUSA_SOURCE. The desktop shell
starts and stops its native process automatically.

The application identity and user-data location are preserved from the
previous desktop release. The packaging includes the full AGPL license,
local license.html, third-party notices and the corresponding-source link.

Native DLLs and compiled executables are not source files and are not checked
into Git. Build them with the versions above. Electron and its dependencies
are obtained through npm; their licenses remain in force.

## License

Copyright (C) 2026 NassLab — Nasser, France. SPDX-License-Identifier: AGPL-3.0-only.
Third-party components retain their own licenses. See ../LICENSE and ../LICENSING.md.

## Development

After building the native engine, run `npm start` from this directory.
The browser resources are loaded from the repository root, and the native
engine and DLLs from `runtime/medusa`. Generated files remain local and ignored
by Git. Packaged apps retain their existing resource paths.

Run `npm run test:ui` after installing dependencies and building the native
engine. It uses an isolated profile under `work`, checks the Start menu,
STEP cache clearing and safe MEDUSA progress rendering, and closes the app.
