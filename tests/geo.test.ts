import { describe, expect, it } from 'vitest';
import { estimateTravelTimeMinutes } from '../src/utils/geo';

// Stima del tempo di guida dalla distanza in linea d'aria (smistamento,
// alternative al telefono, motore sul server). Deve restare credibile sia in
// città sia sui trasferimenti lunghi: se è troppo pessimista i giri proposti
// si riempiono di buchi, se è troppo ottimista il tecnico arriva in ritardo.
describe('estimateTravelTimeMinutes', () => {
  it('a distanza zero resta solo il tempo di partenza e parcheggio', () => {
    expect(estimateTravelTimeMinutes(0)).toBe(5);
    expect(estimateTravelTimeMinutes(-3)).toBe(5);
  });

  it('sui tratti brevi di città dà gli stessi tempi di prima', () => {
    // prima: ceil(km × 1,4 / 0,35) + 5
    expect(estimateTravelTimeMinutes(1)).toBe(9);
    expect(estimateTravelTimeMinutes(2)).toBe(13);
  });

  it('sui trasferimenti lunghi non conta più la velocità di città', () => {
    // Milano-Pavia: 32 km in linea d'aria, circa 50 minuti veri (prima: 133)
    const milanoPavia = estimateTravelTimeMinutes(32);
    expect(milanoPavia).toBeGreaterThanOrEqual(45);
    expect(milanoPavia).toBeLessThanOrEqual(65);
    // 37 km: prima 153 minuti, cioè due ore e mezza di buco nel giro
    expect(estimateTravelTimeMinutes(37)).toBeLessThanOrEqual(70);
    // due comuni della stessa provincia a 12 km: 25-35 minuti (prima: 53)
    const provincia = estimateTravelTimeMinutes(12);
    expect(provincia).toBeGreaterThanOrEqual(25);
    expect(provincia).toBeLessThanOrEqual(35);
  });

  it('resta prudente: mai sopra i 60 km/h di media sulla strada', () => {
    for (const km of [5, 10, 20, 40, 80, 150]) {
      const roadKm = km * 1.4;
      const driveMinutes = estimateTravelTimeMinutes(km) - 5;
      expect(roadKm / (driveMinutes / 60)).toBeLessThanOrEqual(60);
    }
  });

  it('più lontano non è mai più veloce', () => {
    let prev = 0;
    for (let km = 0; km <= 200; km += 0.5) {
      const t = estimateTravelTimeMinutes(km);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('non è mai più ottimista della stima di prima oltre il 45% in città (fino a 10 km)', () => {
    // In città la vecchia stima era ragionevole: la nuova può accorciare, ma
    // non dimezzare, i tempi dei tratti urbani.
    for (let km = 0.5; km <= 10; km += 0.5) {
      const before = Math.ceil((km * 1.4) / 0.35) + 5;
      expect(estimateTravelTimeMinutes(km)).toBeGreaterThanOrEqual(before * 0.55);
    }
  });
});
