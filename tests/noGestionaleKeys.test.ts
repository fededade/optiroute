import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guardia: l'invio al gestionale è stato tolto (novembre 2026). Nessuna chiave
// Google né il progetto del gestionale devono rientrare nel codice dell'app,
// del server, delle funzioni o degli script: un eventuale nuovo invio passerà
// dal server, con la configurazione nelle variabili d'ambiente.

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'server', 'api', 'scripts'];
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{20,}/;
const GESTIONALE_PROJECT = 'gestionale-effetre';

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
};

describe('nessuna chiave né progetto del gestionale nel codice', () => {
  it(`in ${DIRS.join(', ')}: niente chiavi Google e niente "${GESTIONALE_PROJECT}"`, async () => {
    const files = (await Promise.all(DIRS.map(d => listFiles(path.join(ROOT, d))))).flat();
    expect(files.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      const rel = path.relative(ROOT, file);
      if (GOOGLE_KEY.test(text)) found.push(`${rel}: chiave API Google`);
      if (text.includes(GESTIONALE_PROJECT)) found.push(`${rel}: progetto del gestionale`);
    }
    expect(found).toEqual([]);
  });
});
