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
  before and after the fix. `rocky-house` is a user-supplied file (not
  versioned): drop `Rocky_House.stp` into a folder and pass it with `--dir`.

## Run

```sh
node tests/fetch_step_files.js                                          # 18 files -> tests/step/
node tests/fetch_step_files.js --manifest tests/step/manifest-extended.json   # 65 files -> tests/step/extended/

# engine started by the bench (port 8766), or one already running (--url)
node tests/medusa_step_harness.js --engine ~/nasscad-medusa/engine/nasscad_medusa --strict \
     --baseline tests/results/linux-occt763-main-after.json --md out.md --out out.json
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

Any other `.stp` or `.step` dropped into `tests/step/` is picked up too.

The `www.steptools.com/docs/stpfiles/bigassy/` samples were not reachable from
the environment the reference runs came from. Drop them into `tests/step/` to
include them.
