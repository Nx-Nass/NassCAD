# Website source

Copy these public static files to the same hosting directory as the browser
application assets from the repository root. Rebuilt installers and the source
archive are release assets. The existing feedback endpoint is managed separately.

The homepage uses the original NassLab four-cylinder engine from
`nass-demo-engine.js`, with its slider-crank and cam timing. Deploy these five
files together when replacing the former B-Rep illustration:

- `index.html`
- `nasscad-home-engine.css`
- `nasscad-home-engine.js`
- `nasscad-home-engine.bin`
- `nasscad-home-engine.png`

The existing root `three.js` is also required. The model `.bin` is a gzip payload
decoded locally using `DecompressionStream`; serve it as an ordinary binary file,
without a `Content-Encoding: gzip` header. The PNG remains visible while loading,
when JavaScript or WebGL is unavailable, or when the model cannot be loaded.
The animation respects reduced-motion preferences and sleeps outside the viewport.
Drag to orbit (including horizontal touch gestures); keyboard arrows, Space and
Home also work. The combustion effect is an illustration, not a physics solver.

To rebuild the compressed model from the source demonstration, run
`node scripts/build-home-engine-model.cjs` from the repository root. Homepage
rendering and controls are maintained in `nasscad-home-engine.js`; the full
interactive CAD demonstration remains in `nass-demo-engine.js`.
