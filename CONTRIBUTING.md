# Contributing to NASSCAD

NASSCAD is written and maintained by one person, in his own time. That shapes what
help is useful: a precise bug report with the file that triggers it is worth more
than almost anything else you could send.

Thank you for being here.

---

## Before anything: the license

NASSCAD is distributed under **CC BY-NC 4.0** — free for personal, educational and
non-commercial use, commercial use by written agreement with NassLab. It is a
non-commercial licence, not an open-source one in the OSI sense.

By opening a pull request you agree that your contribution is distributed under that
same licence. If that does not work for you, open an issue instead and describe the
fix in words — that is genuinely useful too, and costs you nothing.

---

## Reporting a bug

Open an issue with the **Bug report** template. The report is useful when it answers
four questions:

1. **What did you do?** The steps, in order, from a freshly loaded page.
2. **What did you expect?**
3. **What happened instead?** Exact error text, not a paraphrase.
4. **Where?** Browser and version, operating system, and whether MEDUSA was running.

Two things make a report dramatically easier to act on:

- **The Logs panel.** Open `Logs` in the top bar and copy the contents. If MEDUSA was
  running, press the jellyfish button first so the engine log is pulled in next to
  the browser log.
- **The browser console.** `F12` → Console, and copy anything in red.

### Attaching a STEP or IFC file

For anything involving import or export — wrong geometry, missing colours, a part that
does not appear, a file that will not open — **attach the file**. A description of a
STEP problem without the STEP file is almost never actionable.

- Attach it directly to the issue. GitHub accepts up to 25 MB; zip it if needed, and
  rename to `.zip` if GitHub refuses the extension.
- **Only send files you are allowed to share.** CAD files carry real design work.
  Never attach something covered by an NDA or belonging to a client or employer.
- If the file is confidential, reproduce the problem on a file you can share. Trimming
  the assembly down to the single offending part usually keeps the bug and removes the
  confidential content.
- Say which program wrote the file (SolidWorks, Fusion, CATIA, FreeCAD, Pro/ENGINEER…)
  and which schema if you know it — AP203, AP214, AP242, IFC2X3, IFC4.
- Say what the file should look like. A screenshot from the program it came out of
  settles the question faster than any description.

If you need a file to test against that you can share freely, the STEP assemblies in
[pythonocc-demos](https://github.com/tpaviot/pythonocc-demos/tree/master/assets/models)
are public reference models.

---

## Suggesting a feature

Use the **Feature request** template. Describe the problem you are trying to solve
before the solution you have in mind — the underlying need often has a cheaper answer
than the feature first imagined.

Be aware that NASSCAD is one person's project with a long list already. A clear "not
planned" is a real answer here, and it is not a rejection of the idea.

---

## Proposing a fix

Small, focused fixes are the ones most likely to be merged.

1. **Open an issue first** for anything beyond a typo or a one-line fix. It saves you
   writing a patch that will not be taken.
2. **Branch from `main`**, one subject per branch.
3. **Keep the diff small.** A patch that fixes one thing is reviewable in an evening.
   A patch that reorganises four files to fix one thing is not.
4. **Match the surrounding style.** No reformatting of untouched lines, no change of
   quoting or indentation conventions, no new build step or dependency. NASSCAD ships
   as plain files served over HTTP and loads no CDN — a contribution must not change
   that.
5. **Do not touch vendored libraries** — `three.js`, `nasscad-draco.js`,
   `nasscad-fonts.js`, `occt-*`, `opencascade.*`, `web-ifc-*`,
   `nasscad-ifc-wasm.js`, `nasscad-manifold-wasm.js`. They are third-party builds
   under their own licences and are replaced wholesale, never patched in place.

### Checks before you open the pull request

```bash
# every JavaScript file you touched must parse
node --check path/to/file.js
```

Then exercise the change by hand in the application, served over HTTP:

```bash
python -m http.server 8080    # then open http://localhost:8080/NASSCAD_V4_7_0.htm
```

`file://` will not do: WASM streaming and the OCCT data file need a real HTTP origin.

Say in the pull request **what you tested and on what** — browser, operating system,
whether MEDUSA was running, and which files you imported or exported. Booleans should
be checked on the browser's Manifold WebAssembly path at minimum, since that is the
default for everyone who has not built MEDUSA.

---

## Building MEDUSA

Only needed if your change touches the native engine. Each `DEPLOY_*` folder holds a
zip with its own build instructions — `BUILD.md` for Windows/MSVC, `install-linux.sh`
for Ubuntu, `deploy.bat` for WSL. The C++ source is in
[`MEDUSA_SOURCE/`](MEDUSA_SOURCE/).

---

## Security

If you find something with security consequences, do not open a public issue. NASSCAD
runs entirely in the browser and uploads nothing, so the surface is small, but STEP and
IFC parsers handle untrusted input by nature. Report it privately through GitHub's
**Security → Report a vulnerability**.

---

## Code of conduct

Be decent. Assume the person on the other side is doing their best with the time they
have. Technical disagreement is welcome; contempt is not.

---

*NASSCAD — NassLab · Marseille, 2026*
