# MEDUSA engine — C++ source

`nasscad_medusa.cpp` is the whole NASSCAD native engine in a single file. It runs on your own machine and listens only on 127.0.0.1:

- **Boolean CSG** with Manifold: union, subtraction, intersection, whole CSG trees
- **STEP and IFC reading and tessellation** with OpenCASCADE
- **Multithreading** with oneTBB
- Mesh welding and repair, on-demand engine log (`GET /log`)

It is the same file as in the three build bundles. To build it, extract the bundle for your platform:

| Platform | Bundle | Start with |
|----------|--------|------------|
| Windows 11 (MSVC) | `DEPLOY_WINDOWS_11_MSVC/Medusa_Engine_MSVC.zip` | `BUILD.md` |
| Ubuntu | `DEPLOY_UBUNTU_LINUX/DEPLOY_UBUNTU.zip` | `install-linux.sh` |
| Windows through WSL | `DEPLOY_UBUNTU_WSL/DEPLOY_UBUNTU_WSL.zip` | `deploy.bat` |
