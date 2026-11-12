// Impacchetta le funzioni del pilota in cloud in bundle autosufficienti:
//   server/cloud-entry.ts      -> api/cloud.js
//   server/cloud-tick-entry.ts -> api/cloud-tick.js
// Su Vercel, con "type": "module", gli import relativi senza estensione fra
// file TypeScript falliscono a runtime: per questo le due funzioni sono
// bundle unici (esterni solo i moduli node:), COMMITTATI nel repo.
// Uso: node scripts/build-api.mjs   (lo esegue anche `npm run build`)
// Un test (tests/serverBundle.test.ts) ricostruisce in memoria e fallisce se
// i file committati non corrispondono ai sorgenti.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLES = [
  { entry: 'server/cloud-entry.ts', out: 'api/cloud.js' },
  { entry: 'server/cloud-tick-entry.ts', out: 'api/cloud-tick.js' },
];

export const HEADER =
  '// FILE GENERATO da scripts/build-api.mjs: non modificare a mano.\n' +
  '// Sorgenti in server/ (più src/services/, api/retell-call.ts, api/call-status.ts).\n' +
  '// Rigenera con: node scripts/build-api.mjs (lo fa anche npm run build).';

// Restituisce [{ out, text }] con il contenuto di ogni bundle, senza scrivere
export const buildApiBundles = async () => {
  const results = [];
  for (const { entry, out } of BUNDLES) {
    const r = await build({
      absWorkingDir: ROOT,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      write: false,
      charset: 'utf8',
      legalComments: 'none',
      banner: { js: HEADER },
      outfile: out,
      logLevel: 'silent',
    });
    results.push({ out, text: r.outputFiles[0].text });
  }
  return results;
};

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bundles = await buildApiBundles();
  for (const { out, text } of bundles) {
    await writeFile(path.join(ROOT, out), text);
    console.log(`build-api: ${out} (${Math.round(text.length / 1024)} KB)`);
  }
}
