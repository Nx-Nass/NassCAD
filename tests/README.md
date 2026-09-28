# STEP import test bench (MEDUSA)

Headless check of the MEDUSA STEP import against the manifold check NASSCAD
itself runs.

- `medusa_step_harness.js` posts every STEP file of a folder to the engine
  (`POST /step`, 127.0.0.1) and decodes the NSTP v1 answer. For each body it runs
  NASSCAD's own `_weldAndCheckManifold` and `_edgeManifoldCheck`. Both functions
  are extracted verbatim from `NASSCAD_V4_7_0.htm` at run time and executed with
  the repo's `three.js` r128, so the check can't drift from the app.
  - `raw` reads the NSTP mesh as received (Z-up → Y-up only).
  - `client` replays the whole lean import of `step-import.js`: Z-up → Y-up,
    global centring, native `/smooth` (30°), then `nasEnsureManifold`
    (`_weldAndCheckManifold(copy, 3)`). This is what the "non manifold" badge
    shows.

  It then compares with what the file declares (`step-declare.js`, whole file)
  and with the per-body B-rep declaration (NSTP field `brep`: `closed` / `open` /
  `nonmanifold`).
- `fetch_step_files.js` downloads the test sets. Each one is pinned to a commit
  and checked by SHA-256. The STEP files themselves are not versioned.
- `results/` holds the reference runs (Ubuntu 24.04, OCCT 7.6.3 from apt), from
  before and after the fix. `main` and `extended` come from the manifests. The
  other sets are not versioned; each JSON names its input in its `input` field.
  Put the files of one set into a folder of its own and pass that with `--dir`.

  | Set | Files | Source |
  |---|---|---|
  | `rocky-house` | `Rocky_House.stp` | supplied by the user |
  | `stealthburner` | `Stealthburner_CW2_Assembly.step` | supplied by the user |
  | `voron24` | `Voron_2.4r2_Assembly.step` (241 MB, 1715 bodies, ~6 min) | `CAD/Voron_2.4r2_Assembly_STEP.zip` of [VoronDesign/Voron-2](https://github.com/VoronDesign/Voron-2/tree/Voron2.4/CAD), branch `Voron2.4` @ `a192410` (zip SHA-256 `36c6c58e…c1c6`) |
  | `voron02-parts` | the 25 `.step` files under `CAD/` (sub-folders flattened) | [VoronDesign/Voron-0](https://github.com/VoronDesign/Voron-0/tree/Voron0.2/CAD), branch `Voron0.2` @ `a4d02db` |
  | `voron02-master` | `V0.2 Master Assembly RC2.step` (168 MB, 3065 bodies, ~4.5 min) | `CAD/V0.2 Master Assembly RC2.zip` of the same repository (zip SHA-256 `694d0de2…a09c`) |
  | `nist` | 33 STEP files of the NIST MBE PMI test models (CTC, FTC, STC; AP203 and AP242), flattened | supplied by the user (`NIST-PMI-STEP-Files.zip`) |

## Run

```sh
node tests/fetch_step_files.js                                          # 18 files -> tests/step/
node tests/fetch_step_files.js --manifest tests/step/manifest-extended.json   # 65 files -> tests/step/extended/

# engine started by the bench (port 8766), or one already running (--url)
node tests/medusa_step_harness.js --engine ~/nasscad-medusa/engine/nasscad_medusa --strict \
     --baseline tests/results/linux-occt763-main-after.json --no-regress --md out.md --out out.json
node tests/medusa_step_harness.js --engine <binary> --dir tests/step/extended --strict
```

Windows (MSVC build): `--engine path\to\nasscad_medusa.exe`, same commands.

Options:

| Option | Effect |
|---|---|
| `--only <text>` | Only test files whose name contains `<text>` |
| `--no-client` | Skip the `/smooth` replay |
| `--verbose` | List the failing bodies and the engine `[WELD]` log lines |
| `--strict` | Exit code 1 if a body declared closed by its B-rep is flagged by NASSCAD, or a file fails to import |
| `--no-regress` | With `--baseline`: exit code 1 if any file gets worse than the reference (more broken bodies, naked or over-shared edges, raw or client; a different body count; a failed import) |

Any other `.stp` or `.step` dropped into `tests/step/` is picked up too.

The `www.steptools.com/docs/stpfiles/bigassy/` samples were not reachable from
the environment the reference runs came from. Drop them into `tests/step/` to
include them.

## Rule for engine changes

A change to the weld is kept only if, on every set above, `--no-regress`
passes against the committed `*-after.json` and `--selftest-weld` passes. Each
new defect gets a generic rule (never a file-specific one) and, when it can be
built from primitives, a `--selftest-weld` case that fails without the rule.
