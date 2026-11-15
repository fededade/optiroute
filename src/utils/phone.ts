// Normalizzazione dei numeri in formato E.164 (senza prefisso: italiano, +39).
// È la STESSA regola di normalizePhone in api/retell-call.ts (copiata: quel
// file usa moduli di Node e non può finire nel browser); un test controlla
// che diano gli stessi risultati.
export const normalizePhone = (raw: string): string | null => {
  let phone = raw.replace(/[\s\-().]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith('+')) {
    if (!/^\d{6,15}$/.test(phone)) return null;
    phone = `+39${phone}`;
  }
  return /^\+\d{6,15}$/.test(phone) ? phone : null;
};
