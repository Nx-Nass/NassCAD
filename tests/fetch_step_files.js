#!/usr/bin/env node
// Downloads the STEP test set listed in a manifest into tests/step/ (or into the
// sub-folder the manifest names in its "dir" field).
//
//   node tests/fetch_step_files.js                        main set (tests/step/manifest.json)
//   node tests/fetch_step_files.js --manifest tests/step/manifest-extended.json
//   node tests/fetch_step_files.js --update-sha           record the SHA-256 of what was downloaded
//
// Behind an HTTPS proxy, Node's fetch() only honours HTTPS_PROXY when
// NODE_USE_ENV_PROXY=1 is set (Node >= 22.21). Plain Windows/Linux machines
// need nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const mi = argv.indexOf('--manifest');
const MANIFEST = path.resolve(mi >= 0 ? argv[mi + 1] : path.join(__dirname, 'step', 'manifest.json'));
const updateSha = argv.includes('--update-sha');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY)
    console.warn('note: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not; fetch() may bypass the proxy.');
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const DIR = path.join(path.dirname(MANIFEST), man.dir || '');
  fs.mkdirSync(DIR, { recursive: true });
  let failed = 0, changed = false;
  for (const f of man.files) {
    const dst = path.join(DIR, f.name);
    if (fs.existsSync(dst)) {
      const h = sha256(fs.readFileSync(dst));
      if (!f.sha256 || f.sha256 === h) {
        if (!f.sha256 && updateSha) { f.sha256 = h; changed = true; }
        console.log(`ok       ${f.name}`);
        continue;
      }
      console.log(`mismatch ${f.name} (re-downloading)`);
    }
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const h = sha256(buf);
      if (f.sha256 && f.sha256 !== h) throw new Error(`SHA-256 ${h} does not match the manifest`);
      if (!f.sha256 && updateSha) { f.sha256 = h; changed = true; }
      fs.writeFileSync(dst, buf);
      console.log(`fetched  ${f.name} (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      failed++;
      console.log(`FAILED   ${f.name}: ${e.message} — ${f.url}`);
    }
  }
  if (changed) fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2) + '\n');
  if (failed) { console.log(`${failed} file(s) could not be fetched`); process.exitCode = 1; }
}
main();
