// FILE GENERATO da scripts/build-api.mjs: non modificare a mano.
// Sorgenti in server/ (più src/services/, api/retell-call.ts, api/call-status.ts).
// Rigenera con: node scripts/build-api.mjs (lo fa anche npm run build).

// server/tz.ts
process.env.TZ = process.env.OPTIROUTE_TZ || "Europe/Rome";
var intlOffset = (d, zone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }).formatToParts(d);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((d.getTime() - asUtc) / 6e4);
};
var timezoneStatus = () => {
  const zone = process.env.TZ || "";
  try {
    const year = (/* @__PURE__ */ new Date()).getFullYear();
    const jan = new Date(year, 0, 15, 12, 0, 0);
    const jul = new Date(year, 6, 15, 12, 0, 0);
    if (zone === "Europe/Rome") {
      return { zone, ok: jan.getTimezoneOffset() === -60 && jul.getTimezoneOffset() === -120 };
    }
    if (!zone) return { zone, ok: false };
    const ok = jan.getTimezoneOffset() === intlOffset(jan, zone) && jul.getTimezoneOffset() === intlOffset(jul, zone);
    return { zone, ok };
  } catch {
    return { zone, ok: false };
  }
};

// src/services/gestionaleSync.ts
var isSyncable = (a) => {
  if (a.status !== "confirmed" || !a.date || !a.startTime) return false;
  if (a.callOutcome?.result === "confermato") return true;
  if (!a.phone) return true;
  return false;
};
var getSyncableAppointments = (appointments) => appointments.filter(isSyncable);
var fsString = (v) => ({ stringValue: v });
var fsInt = (v) => ({ integerValue: String(Math.round(v)) });
var fsDouble = (v) => ({ doubleValue: v });
var fsBool = (v) => ({ booleanValue: v });
var toFirestoreFields = (a) => {
  const giornoIt = a.date ? (/* @__PURE__ */ new Date(`${a.date}T00:00:00`)).toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "2-digit" }) : "";
  return {
    codice: fsString(a.periziaCode || ""),
    cliente: fsString(a.title),
    telefono: fsString(a.phone || ""),
    referente: fsString(a.contactPerson || ""),
    indirizzo: fsString(a.shortAddress || a.address),
    indirizzo_completo: fsString(a.address),
    comune: fsString(a.comune || ""),
    data: fsString(a.date || ""),
    giorno: fsString(giornoIt),
    ora_inizio: fsString(a.startTime || ""),
    ora_fine: fsString(a.endTime || ""),
    ordine: fsInt(a.sequenceOrder || 0),
    progetto: fsString(a.project || ""),
    note: fsString(a.notes || ""),
    esito: fsString(a.callOutcome?.result || (a.phone ? "" : "senza_telefono")),
    lat: fsDouble(a.coords.lat),
    lng: fsDouble(a.coords.lng),
    origine: fsString("optiroute"),
    importato: fsBool(false),
    aggiornato_il: fsString((/* @__PURE__ */ new Date()).toISOString())
  };
};
var pushConfirmedToFirestore = async (appointments, target, envName) => {
  const syncable = getSyncableAppointments(appointments);
  const result = { sent: 0, failed: 0, errors: [], envName };
  for (const appt of syncable) {
    const docId = (appt.periziaCode || `app_${appt.id}`).replace(/[^\w-]/g, "_");
    const url = `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/documents/optiroute_sync/${docId}?key=${target.apiKey}`;
    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields(appt) })
      });
      if (response.ok) {
        result.sent++;
      } else {
        const text = await response.text().catch(() => "");
        result.failed++;
        result.errors.push(`${appt.title}: HTTP ${response.status} ${text.slice(0, 120)}`);
      }
    } catch (error) {
      result.failed++;
      result.errors.push(`${appt.title}: ${error?.message || "errore di rete"}`);
    }
  }
  return result;
};

// api/retell-call.ts
var COMPANY_NAME = process.env.RETELL_COMPANY_NAME || "Effetre Properties";
var AGENT_NAME = process.env.RETELL_AGENT_NAME || "Misi";
var MANDANTE = process.env.RETELL_MANDANTE || "Prelios - Banca Intesa";
var retellEnv = () => ({
  apiKey: process.env.RETELL_API_KEY || "",
  fromNumber: process.env.RETELL_FROM_NUMBER || "",
  agentId: process.env.RETELL_AGENT_ID || "",
  apiBase: (process.env.RETELL_API_BASE || "https://api.retellai.com").replace(/\/+$/, "")
});
var normalizePhone = (raw) => {
  let phone = raw.replace(/[\s\-().]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (!phone.startsWith("+")) {
    if (!/^\d{6,15}$/.test(phone)) return null;
    phone = `+39${phone}`;
  }
  return /^\+\d{6,15}$/.test(phone) ? phone : null;
};
var GIORNI_IT = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
var MESI_IT = [
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre"
];
var parseIsoDateParts = (isoDate) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) return void 0;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return void 0;
  return date;
};
var formatDateItalian = (isoDate) => {
  if (!isoDate) return "";
  const date = parseIsoDateParts(isoDate);
  if (!date) return isoDate;
  return `${GIORNI_IT[date.getDay()]} ${date.getDate()} ${MESI_IT[date.getMonth()]}`;
};
var REGIONI_IT = [
  "abruzzo",
  "basilicata",
  "calabria",
  "campania",
  "emilia-romagna",
  "friuli-venezia giulia",
  "lazio",
  "liguria",
  "lombardia",
  "marche",
  "molise",
  "piemonte",
  "puglia",
  "sardegna",
  "sicilia",
  "toscana",
  "trentino-alto adige",
  "umbria",
  "valle d'aosta",
  "veneto"
];
var cleanDisplayName = (full) => {
  const parts = full.split(",").map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((p) => {
    const pl = p.toLowerCase();
    if (/^\d{4,5}$/.test(p)) return false;
    if (pl === "italia") return false;
    if (/^municipio\b/i.test(p)) return false;
    if (REGIONI_IT.includes(pl)) return false;
    return true;
  });
  if (kept.length > 3) {
    return [kept[0], kept[1], kept[kept.length - 1]].filter(Boolean).join(", ");
  }
  return kept.join(", ");
};
var oraParlata = (hhmm) => {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || "0", 10);
  if (isNaN(h)) return hhmm;
  if (!m) return `${h}`;
  if (m === 30) return `${h} e mezza`;
  return `${h} e ${m}`;
};
var MAX_ALTERNATIVES = 3;
var isHHMM = (v) => {
  if (typeof v !== "string") return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return false;
  return parseInt(m[1], 10) <= 23 && parseInt(m[2], 10) <= 59;
};
var parseAlternatives = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    if (out.length >= MAX_ALTERNATIVES) break;
    if (!item || typeof item !== "object") continue;
    const { label, date, startTime, endTime } = item;
    const lbl = typeof label === "string" ? label.trim().toUpperCase() : "";
    if (lbl !== "A" && lbl !== "B" && lbl !== "C") continue;
    if (seen.has(lbl)) continue;
    if (typeof date !== "string" || !parseIsoDateParts(date)) continue;
    if (!isHHMM(startTime) || !isHHMM(endTime)) continue;
    seen.add(lbl);
    out.push({ label: lbl, date: date.trim(), startTime: startTime.trim(), endTime: endTime.trim() });
  }
  return out;
};
var formatAlternativeSpoken = (slot) => `${formatDateItalian(slot.date)} alle ${oraParlata(slot.startTime)}`;
var formatAlternativeKey = (slot) => `${slot.label} = ${slot.date} ${slot.startTime}`;
var buildAlternativesSection = (alternatives) => {
  if (alternatives.length === 0) return [];
  const spoken = alternatives.map(formatAlternativeSpoken);
  return [
    `## SLOT ALTERNATIVI — usali SOLO se il cliente non può o non vuole il giorno e l'orario proposti:`,
    `Sono disponibilità REALI, già verificate sull'agenda del tecnico: sono le UNICHE che puoi offrire o fissare.`,
    `- Offrile UNA ALLA VOLTA, in quest'ordine, aspettando la risposta prima di passare alla successiva:`,
    ...spoken.map((s, i) => `  ${i + 1}) ${s}`),
    `- Di' al cliente SOLO giorno e ora (es. "Potrebbe andarle bene ${spoken[0]}?"): NON leggere MAI lettere, numeri o etichette delle alternative.`,
    `- Se ne ACCETTA una → confermala esplicitamente ripetendo giorno e ora: "Perfetto, allora le confermo il sopralluogo per <giorno> alle <ora>." Spiega al cliente che è un appuntamento FISSATO: da quel momento l'appuntamento valido è quello (non più quello proposto all'inizio). Ringrazia e saluta.`,
    `- Se chiede un giorno o un orario DIVERSO da questi → non confermarlo e non dire che "dovrebbe essere possibile": proponi le alternative rimaste.`,
    `- Se NESSUNA va bene → NON inventare altre disponibilità e NON promettere orari: chiedi quando preferirebbe (giorno e fascia oraria), prendine nota e di' che verrà ricontattato con una nuova proposta.`,
    ``
  ];
};
var buildAnalysisNote = (alternatives) => {
  if (alternatives.length === 0) return [];
  return [
    `## NOTA PER L'ANALISI POST-CHIAMATA (NON pronunciarla, NON leggerla al cliente):`,
    `- Corrispondenza alternative: ${alternatives.map(formatAlternativeKey).join("; ")}.`,
    `- Se il cliente ha accettato una delle alternative: alternativa_scelta = la sua lettera, esito_appuntamento = confermato, nuova_data_richiesta = data (AAAA-MM-GG) e nuovo_orario_richiesto = ora (HH:MM) dello slot accettato. Altrimenti alternativa_scelta = nessuna.`,
    ``
  ];
};
var buildCallData = (input) => {
  const {
    clientName,
    date,
    startTime,
    endTime,
    address,
    shortAddress,
    comune,
    notes,
    urgent,
    technicianName,
    periziaCode,
    project,
    contactPerson,
    referredBy,
    daySchedule
  } = input;
  const alternatives = parseAlternatives(input.alternatives);
  const hasAlternatives = alternatives.length > 0;
  const dateSpoken = formatDateItalian(date);
  const timeSpoken = startTime ? `alle ${oraParlata(startTime)}` : "in orario da definire";
  const isReferral = !!contactPerson;
  const isUrgent = urgent === true || urgent === "true";
  const luogoBreve = shortAddress || comune ? [shortAddress, comune].filter(Boolean).join(", ") : address ? cleanDisplayName(address) : "indirizzo da comunicare";
  const luogoImmobile = comune && shortAddress ? `di ${comune} in ${shortAddress}` : `in ${luogoBreve}`;
  const interlocutore = isReferral ? contactPerson : clientName || "";
  const presentazione = `Buongiorno, sono ${AGENT_NAME} di ${COMPANY_NAME}, società incaricata per conto di ${MANDANTE} per la perizia relativa all'immobile ${luogoImmobile}.` + (interlocutore ? ` Parlo con ${interlocutore}?` : ` Parlo con l'intestatario della pratica?`);
  const proposta = dateSpoken && startTime ? `La chiamavo per proporle la data del sopralluogo del perito: avremmo disponibilità per ${dateSpoken} alle ${oraParlata(startTime)}. Può andarle bene?` : `La chiamavo per concordare la data del sopralluogo del perito: prendo nota delle sue disponibilità e verrà ricontattato con la proposta di giorno e orario.`;
  const gestioneSpostamento = hasAlternatives ? [
    `  * passa agli SLOT ALTERNATIVI (sezione qui sotto): offrili uno alla volta e, se ne accetta uno, fissalo.`,
    `  * NON dare per possibile nessun altro giorno o orario: oltre a quello proposto, le uniche disponibilità sono gli slot alternativi.`,
    `  * se nessuno va bene, prendi SEMPRE nota di giorno e fascia preferiti.`
  ] : [
    `  * consulta l'AGENDA DEL GIORNO qui sotto: se l'orario richiesto CADE in una fascia già impegnata, dillo con garbo (es. "a quell'ora abbiamo già un sopralluogo fissato") e comunica che verrà ricontattato con una proposta alternativa;`,
    `  * se l'orario richiesto NON risulta impegnato: di' che dovrebbe essere possibile, ma che riceverà una conferma definitiva a breve. NON dare MAI il nuovo orario per già fissato: la conferma spetta all'ufficio.`,
    `  * se chiede un ALTRO GIORNO: prendi nota e comunica che verrà ricontattato con la proposta.`,
    `  * in ogni caso prendi SEMPRE nota di giorno e fascia richiesti.`
  ];
  const agendaFallback = hasAlternatives ? "Nessuna informazione sull'agenda: in caso di richieste di spostamento usa SOLO gli slot alternativi." : "Nessuna informazione sull'agenda: in caso di richieste di spostamento prendi nota e basta.";
  const callScript = [
    `Sei ${AGENT_NAME}, assistente telefonica di ${COMPANY_NAME}.`,
    ``,
    `## SEQUENZA DELLA CHIAMATA — rispetta questo ORDINE, senza anticipare domande:`,
    ``,
    `1. APERTURA — appena rispondono, pronuncia ESATTAMENTE questa frase:`,
    `"${presentazione}"`,
    `   NON chiedere "con chi ho il piacere di parlare?" a freddo: prima ti presenti e spieghi chi sei e perché chiami, POI verifichi l'interlocutore.`,
    ``,
    isReferral ? `2. CONTESTO REFERENTE — NON stai chiamando l'intestatario: stai chiamando ${contactPerson}, indicato da ${referredBy || "l'intestatario della pratica"} come persona di riferimento per il sopralluogo. Dopo l'apertura, spiega che l'appuntamento riguarda l'immobile dell'intestatario${clientName ? ` (${clientName})` : ""} e che sei stata indirizzata a lui/lei.` : null,
    `${isReferral ? "3" : "2"}. PROPOSTA — quando l'interlocutore ha confermato di essere la persona giusta, PROPONI l'appuntamento. Non darlo MAI per già confermato: l'operatrice propone, il cliente conferma. Usa questa frase:`,
    `"${proposta}"`,
    ``,
    `${isReferral ? "4" : "3"}. GESTIONE DELLA RISPOSTA:`,
    `- ACCETTA giorno e orario → ripeti chiaramente data e ora, ringrazia e saluta.`,
    `- È TITUBANTE o chiede di spostare → l'obiettivo è CONSERVARE l'appuntamento proposto: fai UN SOLO tentativo, gentile ma deciso, es.: "Guardi, le dico la verità: ci verrebbe difficile riprogrammare, l'agenda è pressoché piena e spostare il sopralluogo potrebbe allungare i tempi della sua pratica. È sicuro di non riuscire a esserci? In alternativa può anche delegare qualcuno: un familiare, l'agente immobiliare, il geometra...". Se delega qualcuno, raccogli NOME, TELEFONO e RUOLO del delegato (e ripeti il numero per conferma). Se invece insiste per spostare, NON forzare oltre — accondiscendi con garbo e procedi:`,
    ...gestioneSpostamento,
    `- RIFIUTA / la perizia non serve più → prendi atto cortesemente e chiudi.`,
    `- NON è lui la persona da contattare (geometra di cantiere, agente immobiliare, familiare con le chiavi...) → fatti dare NOME, NUMERO DI TELEFONO e RUOLO della persona corretta; RIPETI il numero per conferma; comunica che quella persona verrà contattata a breve.`,
    ``,
    ...buildAlternativesSection(alternatives),
    `## AGENDA DEL GIORNO (solo per tua consultazione — NON elencarla al cliente, non citare altri clienti):`,
    `${daySchedule || agendaFallback}`,
    ``,
    `## DATI APPUNTAMENTO:`,
    `- Immobile (pronuncia SOLO questo: via, civico e città): ${luogoBreve}`,
    address ? `- Indirizzo esteso (solo riferimento interno, NON leggerlo al cliente): ${address}` : null,
    dateSpoken ? `- Giorno proposto: ${dateSpoken}` : `- Giorno: da definire`,
    startTime ? `- Orario proposto: ${startTime}${endTime ? ` (indicativamente fino alle ${endTime})` : ""}` : `- Orario: da definire`,
    technicianName ? `- Il sopralluogo sarà effettuato da ${technicianName}: puoi citarlo al cliente (es. "verrà il nostro tecnico ${technicianName}").` : null,
    isUrgent ? `- Priorità: URGENTE — dillo esplicitamente al cliente: il sopralluogo va effettuato il prima possibile.` : null,
    isReferral && clientName ? `- Intestatario della pratica: ${clientName}` : null,
    periziaCode ? `- Pratica: ${periziaCode}` : null,
    notes ? `- Note interne (NON leggerle al cliente, servono a te): ${notes}` : null,
    ``,
    ...buildAnalysisNote(alternatives),
    `## REGOLE:`,
    `- Inizia a parlare direttamente con l'APERTURA: non leggere MAI ad alta voce titoli, etichette o nomi di sezione dello script o del flusso di conversazione (es. "presentazione", "apertura", "step 1").`,
    `- Tono cortese e professionale; non fornire MAI l'importo del finanziamento o altri dati sensibili.`,
    isUrgent ? `- URGENZA: questa pratica è URGENTE — comunicalo chiaramente al cliente e, se chiede di spostare, ricorda con garbo che sarebbe preferibile anticipare, non posticipare.` : null,
    hasAlternatives ? `- DISPONIBILITÀ: oltre all'appuntamento proposto, puoi offrire o fissare SOLO gli slot alternativi indicati. Non inventare MAI altre date o orari.` : null,
    `- ORARI: pronunciali in italiano colloquiale — "alle nove", "alle nove e mezza", "alle quindici". MAI leggere le cifre una a una ("zero nove e zero zero" è VIETATO).`,
    `- INDIRIZZO: quando citi il luogo dell'immobile di' SOLO via, numero civico e città (es. "Via Roma 10, Milano"). NON pronunciare MAI CAP, provincia, quartiere, frazione, regione o la parola "Italia".`,
    `- Ringrazia e saluta prima di chiudere la chiamata.`
  ].filter((line) => line !== null).join("\n");
  const altSpoken = (label) => {
    const slot = alternatives.find((a) => a.label === label);
    return slot ? formatAlternativeSpoken(slot) : "";
  };
  const dynamicVariables = {
    company_name: COMPANY_NAME,
    agent_name: AGENT_NAME,
    mandante: MANDANTE,
    presentazione,
    proposta,
    agenda_giorno: daySchedule || "",
    immobile: luogoBreve,
    client_name: clientName || "cliente",
    appointment_date: dateSpoken || "da definire",
    appointment_time: startTime || "da definire",
    appointment_time_spoken: timeSpoken,
    appointment_end_time: endTime || "",
    appointment_address: address || "",
    appointment_notes: notes || "",
    appointment_urgent: isUrgent ? "URGENTE" : "normale",
    urgency_notice: isUrgent ? "Questo sopralluogo è URGENTE: dillo esplicitamente al cliente e spiega che va effettuato il prima possibile." : "",
    technician_name: technicianName || "",
    pratica_codice: periziaCode || "",
    progetto: project || "",
    contact_person: contactPerson || "",
    referred_by: referredBy || "",
    alternative_disponibili: alternatives.map(formatAlternativeSpoken).join("\n"),
    alternativa_a: altSpoken("A"),
    alternativa_b: altSpoken("B"),
    alternativa_c: altSpoken("C"),
    ha_alternative: hasAlternatives ? "si" : "no",
    call_script: callScript
  };
  const stringVariables = {};
  for (const [k, v] of Object.entries(dynamicVariables)) {
    stringVariables[k] = typeof v === "string" ? v : String(v ?? "");
  }
  return { callScript, dynamicVariables: stringVariables };
};
var NOT_CONFIGURED = "Chiamate AI non configurate: impostare RETELL_API_KEY e RETELL_FROM_NUMBER nelle variabili d'ambiente.";
var buildRetellCallPayload = (body, env = retellEnv()) => {
  const { phone, date, periziaCode, urgent } = body;
  if (!phone) {
    return { ok: false, status: 400, error: "Numero di telefono mancante." };
  }
  const toNumber = normalizePhone(String(phone));
  if (!toNumber) {
    return { ok: false, status: 400, error: `Numero di telefono non valido: ${phone}` };
  }
  const { dynamicVariables } = buildCallData(body);
  const isUrgent = urgent === true || urgent === "true";
  const payload = {
    from_number: env.fromNumber,
    to_number: toNumber,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata: {
      source: "optiroute",
      appointment_date: date || "",
      perizia_code: periziaCode || "",
      urgent: isUrgent
    }
  };
  if (env.agentId) {
    payload.override_agent_id = env.agentId;
  }
  return { ok: true, payload, toNumber };
};
var createRetellCall = async (body, opts = {}) => {
  const env = opts.env || retellEnv();
  if (!env.apiKey || !env.fromNumber) {
    return { ok: false, status: 500, error: NOT_CONFIGURED };
  }
  const built = buildRetellCallPayload(body, env);
  if (!built.ok) return built;
  const controller = opts.timeoutMs ? new AbortController() : void 0;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : void 0;
  try {
    const response = await fetch(`${env.apiBase}/v2/create-phone-call`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(built.payload),
      signal: controller?.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Retell API error:", response.status);
      return {
        ok: false,
        status: response.status,
        error: data?.message || data?.error || `Errore Retell (${response.status})`
      };
    }
    return { ok: true, callId: data.call_id, callStatus: data.call_status, toNumber: built.toNumber };
  } catch (error) {
    console.error("Retell call error:", controller?.signal.aborted ? "timeout" : "errore di rete");
    return { ok: false, status: 500, error: "Impossibile avviare la chiamata. Riprova." };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// server/auth.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
var safeEqual = (a, b) => {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
};
var headerValue = (headers, name) => {
  if (!headers) return "";
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] || "" : v || "";
};
var bearerToken = (headers) => {
  const m = /^Bearer\s+(.+)$/i.exec(headerValue(headers, "authorization").trim());
  return m ? m[1].trim() : "";
};
var isAuthorized = (headers, secret) => {
  const token = bearerToken(headers);
  return !!secret && !!token && safeEqual(token, secret);
};

// server/store.ts
import { gunzipSync, gzipSync } from "node:zlib";
var StoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
};
var ConflictError = class extends Error {
  constructor() {
    super("conflict");
    this.name = "ConflictError";
  }
};
var CAS_SCRIPT = [
  "local cur = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "if cur ~= tonumber(ARGV[1]) then return -1 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return redis.call('INCR', KEYS[2])"
].join("\n");
var REPLACE_SCRIPT = [
  "redis.call('SET', KEYS[1], ARGV[1])",
  "return redis.call('INCR', KEYS[2])"
].join("\n");
var UNLOCK_SCRIPT = [
  "if redis.call('GET', KEYS[1]) == ARGV[1] then",
  "  return redis.call('DEL', KEYS[1])",
  "end",
  "return 0"
].join("\n");
var LEASE_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  "if cur then",
  "  local sep = string.find(cur, '|', 1, true)",
  "  if sep then",
  "    local holder = string.sub(cur, 1, sep - 1)",
  "    local untilMs = tonumber(string.sub(cur, sep + 1)) or 0",
  "    if holder ~= ARGV[1] and untilMs > tonumber(ARGV[2]) then return cur end",
  "  end",
  "end",
  "local v = ARGV[1] .. '|' .. ARGV[3]",
  "redis.call('SET', KEYS[1], v, 'PX', ARGV[4])",
  "return v"
].join("\n");
var UpstashRestClient = class {
  url;
  token;
  timeoutMs;
  fetchImpl;
  constructor(opts) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 8e3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  async post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) throw new StoreError("timeout", "Database: tempo scaduto");
      throw new StoreError("network", "Database: errore di rete");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new StoreError("auth", "Database: credenziali non valide");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (data && typeof data.error === "string") throw new StoreError("redis", `Database: ${data.error}`);
      throw new StoreError("http", `Database: HTTP ${response.status}`);
    }
    if (data === null) throw new StoreError("http", "Database: risposta non valida");
    return data;
  }
  async command(args) {
    const data = await this.post("", args.map(String));
    if (data && typeof data.error === "string") throw new StoreError("redis", `Database: ${data.error}`);
    return data?.result ?? null;
  }
  async pipeline(commands) {
    const data = await this.post("/pipeline", commands.map((c) => c.map(String)));
    if (!Array.isArray(data)) throw new StoreError("http", "Database: risposta non valida");
    return data.map((item) => {
      if (item && typeof item.error === "string") throw new StoreError("redis", `Database: ${item.error}`);
      return item?.result ?? null;
    });
  }
};
var MemoryRedis = class {
  data = /* @__PURE__ */ new Map();
  entry(key) {
    const e = this.data.get(key);
    if (e && e.expiresAt !== void 0 && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return void 0;
    }
    return e;
  }
  getString(key) {
    const e = this.entry(key);
    if (!e) return null;
    if (typeof e.value !== "string") throw new StoreError("redis", "WRONGTYPE");
    return e.value;
  }
  set(key, value, opts = {}) {
    if (opts.nx && this.entry(key)) return null;
    this.data.set(key, { value, expiresAt: opts.px !== void 0 ? Date.now() + opts.px : void 0 });
    return "OK";
  }
  incr(key) {
    const cur = this.getString(key);
    const n = (cur === null ? 0 : parseInt(cur, 10)) + 1;
    if (!Number.isFinite(n)) throw new StoreError("redis", "ERR value is not an integer");
    const e = this.entry(key);
    this.data.set(key, { value: String(n), expiresAt: e?.expiresAt });
    return n;
  }
  // Esegue i comandi in modo sincrono: ogni comando (e ogni script) è
  // atomico come in Redis.
  exec(raw) {
    const args = raw.map(String);
    const name = (args[0] || "").toUpperCase();
    switch (name) {
      case "GET":
        return this.getString(args[1]);
      case "MGET":
        return args.slice(1).map((k) => this.getString(k));
      case "SET": {
        const opts = {};
        for (let i = 3; i < args.length; i++) {
          const o = args[i].toUpperCase();
          if (o === "NX") opts.nx = true;
          else if (o === "PX") opts.px = parseInt(args[++i], 10);
          else throw new StoreError("redis", `ERR opzione SET non supportata: ${o}`);
        }
        return this.set(args[1], args[2], opts);
      }
      case "DEL": {
        let n = 0;
        for (const k of args.slice(1)) if (this.entry(k) && this.data.delete(k)) n++;
        return n;
      }
      case "INCR":
        return this.incr(args[1]);
      case "PTTL": {
        const e = this.entry(args[1]);
        if (!e) return -2;
        return e.expiresAt === void 0 ? -1 : Math.max(0, e.expiresAt - Date.now());
      }
      case "HSET": {
        let e = this.entry(args[1]);
        if (!e) {
          e = { value: /* @__PURE__ */ new Map() };
          this.data.set(args[1], e);
        }
        if (typeof e.value === "string") throw new StoreError("redis", "WRONGTYPE");
        let added = 0;
        for (let i = 2; i + 1 < args.length; i += 2) {
          if (!e.value.has(args[i])) added++;
          e.value.set(args[i], args[i + 1]);
        }
        return added;
      }
      case "HGETALL": {
        const e = this.entry(args[1]);
        if (!e) return [];
        if (typeof e.value === "string") throw new StoreError("redis", "WRONGTYPE");
        return [...e.value.entries()].flat();
      }
      case "FLUSHALL":
        this.data.clear();
        return "OK";
      case "EVAL":
        return this.evalScript(args);
      default:
        throw new StoreError("redis", `ERR comando sconosciuto '${name}'`);
    }
  }
  evalScript(args) {
    const script = args[1];
    const numKeys = parseInt(args[2], 10);
    const keys = args.slice(3, 3 + numKeys);
    const argv = args.slice(3 + numKeys);
    if (script === CAS_SCRIPT) {
      const cur = parseInt(this.getString(keys[1]) ?? "0", 10);
      if (cur !== Number(argv[0])) return -1;
      this.set(keys[0], argv[1]);
      return this.incr(keys[1]);
    }
    if (script === REPLACE_SCRIPT) {
      this.set(keys[0], argv[0]);
      return this.incr(keys[1]);
    }
    if (script === UNLOCK_SCRIPT) {
      if (this.getString(keys[0]) === argv[0]) return this.exec(["DEL", keys[0]]);
      return 0;
    }
    if (script === LEASE_SCRIPT) {
      const cur = this.getString(keys[0]);
      if (cur) {
        const sep = cur.indexOf("|");
        if (sep >= 0) {
          const holder = cur.slice(0, sep);
          const untilMs = Number(cur.slice(sep + 1)) || 0;
          if (holder !== argv[0] && untilMs > Number(argv[1])) return cur;
        }
      }
      const v = `${argv[0]}|${argv[2]}`;
      this.set(keys[0], v, { px: parseInt(argv[3], 10) });
      return v;
    }
    throw new StoreError("redis", "NOSCRIPT script non riconosciuto dall'emulatore");
  }
  async command(args) {
    return this.exec(args);
  }
  async pipeline(commands) {
    return commands.map((c) => this.exec(c));
  }
  clear() {
    this.data.clear();
  }
};
var encodeAppointments = (appointments) => gzipSync(Buffer.from(JSON.stringify(appointments), "utf8")).toString("base64");
var decodeAppointments = (raw) => {
  try {
    const parsed = JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("non è un elenco");
    return parsed;
  } catch {
    throw new StoreError("data", "Database: elenco pratiche illeggibile");
  }
};
var toInt = (v) => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
};
var parseJson = (raw) => {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
var parseLease = (raw) => {
  if (typeof raw !== "string") return null;
  const sep = raw.indexOf("|");
  if (sep < 0) return null;
  const until = Number(raw.slice(sep + 1));
  return Number.isFinite(until) ? { deviceId: raw.slice(0, sep), until } : null;
};
var META_FIELDS = ["lastTick", "schedulerSeenAt", "webhookSeenAt", "lastSync", "lastTickWallMs"];
var keyPrefix = (vercelEnv) => `optiroute:${vercelEnv || "development"}:`;
var RedisStore = class {
  kind;
  prefix;
  redis;
  constructor(redis, kind, prefix) {
    this.redis = redis;
    this.kind = kind;
    this.prefix = prefix;
  }
  k(name) {
    return `${this.prefix}${name}`;
  }
  async revs() {
    const [rev, configRev] = await this.redis.command(["MGET", this.k("rev"), this.k("configRev")]);
    return { rev: toInt(rev), configRev: toInt(configRev) };
  }
  async readAppointments() {
    const [raw, rev] = await this.redis.command(["MGET", this.k("appointments"), this.k("rev")]);
    return {
      appointments: typeof raw === "string" && raw ? decodeAppointments(raw) : null,
      rev: toInt(rev)
    };
  }
  async writeAppointments(expectedRev, appointments) {
    const r = toInt(
      await this.redis.command([
        "EVAL",
        CAS_SCRIPT,
        2,
        this.k("appointments"),
        this.k("rev"),
        expectedRev,
        encodeAppointments(appointments)
      ])
    );
    return r < 0 ? null : r;
  }
  async replaceAppointments(appointments) {
    return toInt(
      await this.redis.command(["EVAL", REPLACE_SCRIPT, 2, this.k("appointments"), this.k("rev"), encodeAppointments(appointments)])
    );
  }
  async readConfig() {
    const [raw, rev] = await this.redis.command(["MGET", this.k("config"), this.k("configRev")]);
    return { config: parseJson(raw), configRev: toInt(rev) };
  }
  async writeConfig(config) {
    return toInt(
      await this.redis.command(["EVAL", REPLACE_SCRIPT, 2, this.k("config"), this.k("configRev"), JSON.stringify(config)])
    );
  }
  async readMeta() {
    const flat = await this.redis.command(["HGETALL", this.k("meta")]);
    const map = /* @__PURE__ */ new Map();
    if (Array.isArray(flat)) {
      for (let i = 0; i + 1 < flat.length; i += 2) map.set(String(flat[i]), String(flat[i + 1]));
    } else if (flat && typeof flat === "object") {
      for (const [k, v] of Object.entries(flat)) map.set(k, String(v));
    }
    return {
      lastTick: parseJson(map.get("lastTick")),
      schedulerSeenAt: map.get("schedulerSeenAt") || null,
      webhookSeenAt: map.get("webhookSeenAt") || null,
      lastSync: parseJson(map.get("lastSync")),
      lastTickWallMs: map.get("lastTickWallMs") ? toInt(map.get("lastTickWallMs")) : null
    };
  }
  async updateMeta(patch) {
    const args = ["HSET", this.k("meta")];
    for (const field of META_FIELDS) {
      if (!(field in patch)) continue;
      const v = patch[field];
      args.push(
        field,
        v === null || v === void 0 ? "" : typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)
      );
    }
    if (args.length > 2) await this.redis.command(args);
  }
  async acquireLock(owner, ttlMs) {
    const r = await this.redis.command(["SET", this.k("lock"), owner, "NX", "PX", ttlMs]);
    return r === "OK";
  }
  async releaseLock(owner) {
    await this.redis.command(["EVAL", UNLOCK_SCRIPT, 1, this.k("lock"), owner]);
  }
  async claimLease(deviceId, nowMs, ttlMs) {
    const r = await this.redis.command(["EVAL", LEASE_SCRIPT, 1, this.k("lease"), deviceId, nowMs, nowMs + ttlMs, ttlMs]);
    const lease = parseLease(r);
    if (!lease) throw new StoreError("data", "Database: turno illeggibile");
    return lease;
  }
  async readLease() {
    return parseLease(await this.redis.command(["GET", this.k("lease")]));
  }
};
var UpstashStore = class extends RedisStore {
  constructor(opts, prefix) {
    super(new UpstashRestClient(opts), "upstash", prefix);
  }
};
var MemoryStore = class extends RedisStore {
  constructor(prefix, redis = new MemoryRedis()) {
    super(redis, "memory", prefix);
  }
};
var sharedMemoryRedis = () => {
  const g = globalThis;
  if (!g.__optirouteMemoryRedis) g.__optirouteMemoryRedis = new MemoryRedis();
  return g.__optirouteMemoryRedis;
};
var storeFromEnv = (env = process.env) => {
  const prefix = keyPrefix(env.VERCEL_ENV);
  if (env.OPTIROUTE_STORE === "memory" && !env.VERCEL_ENV) {
    return new MemoryStore(prefix, sharedMemoryRedis());
  }
  const url = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN } : env.KV_REST_API_URL && env.KV_REST_API_TOKEN ? { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN } : null;
  return url ? new UpstashStore(url, prefix) : null;
};
var COMMIT_MAX_ATTEMPTS = 5;
var commit = async (store, fn, maxAttempts = COMMIT_MAX_ATTEMPTS) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { appointments, rev } = await store.readAppointments();
    const current = appointments || [];
    const next = fn(current);
    if (next === current) return { appointments: current, rev, changed: false };
    const newRev = await store.writeAppointments(rev, next);
    if (newRev !== null) return { appointments: next, rev: newRev, changed: true };
  }
  throw new ConflictError();
};

// server/engine.ts
import { randomUUID } from "node:crypto";

// src/utils/geo.ts
var calculateDistance = (coord1, coord2) => {
  const R = 6371;
  const dLat = deg2rad(coord2.lat - coord1.lat);
  const dLon = deg2rad(coord2.lng - coord1.lng);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(coord1.lat)) * Math.cos(deg2rad(coord2.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return d;
};
var deg2rad = (deg) => {
  return deg * (Math.PI / 180);
};
var TORTUOSITY = 1.4;
var URBAN_KMH = 20;
var OPEN_ROAD_KMH = 60;
var SPEED_RAMP_KM = 30;
var BASE_PENALTY_MINUTES = 5;
var estimateTravelTimeMinutes = (distanceKm) => {
  const roadKm = Math.max(0, distanceKm) * TORTUOSITY;
  const kmh = URBAN_KMH + (OPEN_ROAD_KMH - URBAN_KMH) * (1 - Math.exp(-roadKm / SPEED_RAMP_KM));
  return Math.ceil(roadKm / kmh * 60) + BASE_PENALTY_MINUTES;
};

// src/utils/provinces.ts
var PROVINCE_NAME_BY_CODE = {
  AG: "Agrigento",
  AL: "Alessandria",
  AN: "Ancona",
  AO: "Aosta",
  AR: "Arezzo",
  AP: "Ascoli Piceno",
  AT: "Asti",
  AV: "Avellino",
  BA: "Bari",
  BT: "Barletta-Andria-Trani",
  BL: "Belluno",
  BN: "Benevento",
  BG: "Bergamo",
  BI: "Biella",
  BO: "Bologna",
  BZ: "Bolzano",
  BS: "Brescia",
  BR: "Brindisi",
  CA: "Cagliari",
  CL: "Caltanissetta",
  CB: "Campobasso",
  CE: "Caserta",
  CT: "Catania",
  CZ: "Catanzaro",
  CH: "Chieti",
  CO: "Como",
  CS: "Cosenza",
  CR: "Cremona",
  KR: "Crotone",
  CN: "Cuneo",
  EN: "Enna",
  FM: "Fermo",
  FE: "Ferrara",
  FI: "Firenze",
  FG: "Foggia",
  FC: "Forlì-Cesena",
  FR: "Frosinone",
  GE: "Genova",
  GO: "Gorizia",
  GR: "Grosseto",
  IM: "Imperia",
  IS: "Isernia",
  SP: "La Spezia",
  AQ: "L'Aquila",
  LT: "Latina",
  LE: "Lecce",
  LC: "Lecco",
  LI: "Livorno",
  LO: "Lodi",
  LU: "Lucca",
  MC: "Macerata",
  MN: "Mantova",
  MS: "Massa-Carrara",
  MT: "Matera",
  ME: "Messina",
  MI: "Milano",
  MO: "Modena",
  MB: "Monza e della Brianza",
  NA: "Napoli",
  NO: "Novara",
  NU: "Nuoro",
  OR: "Oristano",
  PD: "Padova",
  PA: "Palermo",
  PR: "Parma",
  PV: "Pavia",
  PG: "Perugia",
  PU: "Pesaro e Urbino",
  PE: "Pescara",
  PC: "Piacenza",
  PI: "Pisa",
  PT: "Pistoia",
  PN: "Pordenone",
  PZ: "Potenza",
  PO: "Prato",
  RG: "Ragusa",
  RA: "Ravenna",
  RC: "Reggio Calabria",
  RE: "Reggio Emilia",
  RI: "Rieti",
  RN: "Rimini",
  RM: "Roma",
  RO: "Rovigo",
  SA: "Salerno",
  SS: "Sassari",
  SV: "Savona",
  SI: "Siena",
  SR: "Siracusa",
  SO: "Sondrio",
  SU: "Sud Sardegna",
  TA: "Taranto",
  TE: "Teramo",
  TR: "Terni",
  TO: "Torino",
  TP: "Trapani",
  TN: "Trento",
  TV: "Treviso",
  TS: "Trieste",
  UD: "Udine",
  VA: "Varese",
  VE: "Venezia",
  VB: "Verbano-Cusio-Ossola",
  VC: "Vercelli",
  VR: "Verona",
  VV: "Vibo Valentia",
  VI: "Vicenza",
  VT: "Viterbo"
};
var stripAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
var cleanName = (s) => stripAccents(s).toUpperCase().replace(/[^A-Z]/g, "");
var CODE_BY_CLEAN_NAME = Object.fromEntries(
  Object.entries(PROVINCE_NAME_BY_CODE).map(([code, name]) => [cleanName(name), code])
);
CODE_BY_CLEAN_NAME[cleanName("Monza e Brianza")] = "MB";
CODE_BY_CLEAN_NAME[cleanName("Reggio nell'Emilia")] = "RE";
CODE_BY_CLEAN_NAME[cleanName("Reggio di Calabria")] = "RC";
CODE_BY_CLEAN_NAME[cleanName("Massa e Carrara")] = "MS";
CODE_BY_CLEAN_NAME[cleanName("Aoste")] = "AO";
CODE_BY_CLEAN_NAME[cleanName("Bolzano - Bozen")] = "BZ";

// src/services/technicianService.ts
var dateInRange = (date, from, to) => {
  const end = to && to >= from ? to : from;
  return date >= from && date <= end;
};
var unavailabilityOn = (tech, date) => tech.unavailability.filter((u) => u.from && dateInRange(date, u.from, u.to));
var isFullyUnavailable = (tech, date) => unavailabilityOn(tech, date).some((u) => u.allDay || !u.startTime && !u.endTime);
var workWindowOn = (tech, date) => {
  if (isFullyUnavailable(tech, date)) return null;
  let start = tech.workStart || "08:30";
  let end = tech.workEnd || "18:00";
  const toMin2 = (t) => {
    const [h, m] = t.split(":").map((n) => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  };
  const toStr = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  let winStart = toMin2(start);
  let winEnd = toMin2(end);
  for (const u of unavailabilityOn(tech, date)) {
    if (u.allDay || !u.startTime || !u.endTime) continue;
    const uStart = toMin2(u.startTime);
    const uEnd = toMin2(u.endTime);
    if (uEnd <= winStart || uStart >= winEnd) continue;
    const before = Math.max(0, uStart - winStart);
    const after = Math.max(0, winEnd - uEnd);
    if (before >= after) {
      winEnd = Math.min(winEnd, uStart);
    } else {
      winStart = Math.max(winStart, uEnd);
    }
  }
  if (winEnd - winStart < 30) return null;
  return { start: toStr(winStart), end: toStr(winEnd) };
};

// src/services/slotService.ts
var DEFAULT_DURATION_MIN = 20;
var LUNCH_MINUTES = 45;
var LUNCH_THRESHOLD_MIN = 12 * 60;
var toMin = (hhmm) => {
  const [h, m] = (hhmm || "").split(":").map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
};
var toHHMM = (min) => {
  const total = Math.max(0, Math.round(min));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
var localDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
var addDaysStr = (date, n) => {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
};
var dateAtMinutes = (date, minutes) => {
  const [y, m, d] = date.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1, 0, minutes, 0, 0);
};
var durationOf = (a) => a.durationMinutes && a.durationMinutes > 0 ? a.durationMinutes : DEFAULT_DURATION_MIN;
var legKm = (from, to) => parseFloat(calculateDistance(from, to).toFixed(2));
var travelMinutes = (from, to) => estimateTravelTimeMinutes(legKm(from, to));
var ceil5 = (min) => Math.ceil(min / 5) * 5;
var isInRoute = (a) => (a.status === "confirmed" || a.status === "proposed") && !!a.date && !!a.startTime;
var sameTech = (a, b) => (a || void 0) === (b || void 0);
var toRouteStop = (a) => {
  const start = toMin(a.startTime || "00:00");
  return {
    id: a.id,
    coords: a.coords,
    start,
    end: a.endTime ? toMin(a.endTime) : start + durationOf(a),
    lunchBefore: !!a.hasLunchBreakBefore,
    appt: a
  };
};
var byStart = (x, y) => x.start - y.start || (x.appt.sequenceOrder ?? 0) - (y.appt.sequenceOrder ?? 0) || x.id.localeCompare(y.id);
var getDayRoute = (all, technicianId, date, excludeId) => all.filter((a) => isInRoute(a) && a.date === date && sameTech(a.technicianId, technicianId) && a.id !== excludeId).map(toRouteStop).sort(byStart);
var dayContextFor = (technician, date, fallback) => {
  if (!technician) {
    return { windowStart: toMin(fallback.start), windowEnd: toMin(fallback.end), base: fallback.base };
  }
  const window = workWindowOn(technician, date);
  if (!window) return null;
  return {
    windowStart: toMin(window.start),
    windowEnd: toMin(window.end),
    base: technician.baseCoords || fallback.base
  };
};
var findFeasibleSlots = (route, ctx, coords, durationMin, opts = {}) => {
  const hasLunch = route.some((s) => s.lunchBefore);
  const options = [];
  let busyUntil = -Infinity;
  for (let p = 0; p <= route.length; p++) {
    const prev = p > 0 ? route[p - 1] : void 0;
    const next = p < route.length ? route[p] : void 0;
    if (prev) busyUntil = Math.max(busyUntil, prev.end);
    let start = prev ? Math.max(prev.end + travelMinutes(prev.coords, coords), busyUntil) : ctx.windowStart + (ctx.base ? travelMinutes(ctx.base, coords) : 0);
    start = Math.max(start, ctx.windowStart);
    if (opts.notBefore !== void 0) start = Math.max(start, opts.notBefore);
    start = ceil5(start);
    let lunchBefore = false;
    if (!hasLunch && start >= LUNCH_THRESHOLD_MIN) {
      start += LUNCH_MINUTES;
      lunchBefore = true;
    }
    const end = start + durationMin;
    if (end > ctx.windowEnd) continue;
    if (opts.notAfter !== void 0 && start > opts.notAfter) continue;
    if (next) {
      const lunchAfter = next.lunchBefore || !hasLunch && !lunchBefore && next.start >= LUNCH_THRESHOLD_MIN;
      const lunchGap = lunchAfter ? LUNCH_MINUTES : 0;
      if (end + travelMinutes(coords, next.coords) + lunchGap > next.start) continue;
    }
    const from = prev ? prev.coords : ctx.base;
    const d1 = from ? calculateDistance(from, coords) : 0;
    const d2 = next ? calculateDistance(coords, next.coords) : 0;
    const d3 = from && next ? calculateDistance(from, next.coords) : 0;
    const detourKm = Math.max(0, d1 + d2 - d3);
    options.push({ start, end, position: p, detourKm, lunchBefore });
  }
  return options.sort((x, y) => x.start - y.start || x.position - y.position);
};
var bestSlot = (options) => {
  let best = null;
  for (const o of options) {
    if (!best || o.detourKm < best.detourKm - 1e-9 || Math.abs(o.detourKm - best.detourKm) <= 1e-9 && o.start < best.start) {
      best = o;
    }
  }
  return best;
};
var applyPatches = (all, patches) => {
  if (patches.length === 0) return all;
  const byId = /* @__PURE__ */ new Map();
  for (const p of patches) byId.set(p.id, { ...byId.get(p.id) || {}, ...p.changes });
  return all.map((a) => {
    const changes = byId.get(a.id);
    return changes ? { ...a, ...changes } : a;
  });
};
var sequenceStops = (stops, base) => stops.map((s, i) => {
  const from = i > 0 ? stops[i - 1].coords : base;
  if (!from) return { sequenceOrder: i + 1, travelTimeFromPrev: 0, distanceFromPrev: 0 };
  const distance = legKm(from, s.coords);
  return { sequenceOrder: i + 1, travelTimeFromPrev: estimateTravelTimeMinutes(distance), distanceFromPrev: distance };
});
var resequenceDay = (all, technicianId, date, ctx) => {
  const route = getDayRoute(all, technicianId, date);
  if (route.length === 0) return all;
  const seq = sequenceStops(route, ctx?.base ?? null);
  const patches = [];
  route.forEach((s, i) => {
    const v = seq[i];
    if (s.appt.sequenceOrder !== v.sequenceOrder || s.appt.travelTimeFromPrev !== v.travelTimeFromPrev || s.appt.distanceFromPrev !== v.distanceFromPrev) {
      patches.push({ id: s.id, changes: v });
    }
  });
  return applyPatches(all, patches);
};
var placeAppointment = (all, id, target, extra = {}) => {
  const a = all.find((x) => x.id === id);
  if (!a) return all;
  const wasInRoute = isInRoute(a);
  const oldDate = a.date;
  const oldTech = a.technicianId;
  const technicianId = target.technicianId ?? a.technicianId;
  const updated = {
    ...a,
    status: "proposed",
    date: target.date,
    technicianId,
    startTime: toHHMM(target.option.start),
    endTime: toHHMM(target.option.end),
    hasLunchBreakBefore: target.option.lunchBefore,
    ...extra
  };
  let result = all.map((x) => x.id === id ? updated : x);
  result = resequenceDay(result, technicianId, target.date, target.ctx);
  if (wasInRoute && oldDate && (oldDate !== target.date || !sameTech(oldTech, technicianId))) {
    result = resequenceDay(result, oldTech, oldDate, target.fromCtx ?? target.ctx);
  }
  return result;
};
var removeFromRoute = (all, id, changes, ctx) => {
  const a = all.find((x) => x.id === id);
  if (!a) return all;
  const wasInRoute = isInRoute(a);
  const updated = {
    ...a,
    date: void 0,
    sequenceOrder: void 0,
    startTime: void 0,
    endTime: void 0,
    hasLunchBreakBefore: void 0,
    travelTimeFromPrev: void 0,
    distanceFromPrev: void 0,
    // fuori dal giro non c'è uno slot da chiamare: la coda si svuota, altrimenti
    // al rientro nel giro partirebbe una chiamata mai approvata
    autoCall: void 0,
    autoCallNotBefore: void 0,
    ...changes
  };
  const result = all.map((x) => x.id === id ? updated : x);
  return wasInRoute && a.date ? resequenceDay(result, a.technicianId, a.date, ctx) : result;
};

// src/services/callService.ts
var pad = (n) => String(n).padStart(2, "0");
var parseFollowUpDate = (raw) => {
  if (!raw) return void 0;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    const y2 = parseInt(iso[1], 10);
    const m2 = parseInt(iso[2], 10);
    const d2 = parseInt(iso[3], 10);
    const date2 = new Date(y2, m2 - 1, d2);
    if (date2.getMonth() === m2 - 1 && date2.getDate() === d2) return `${y2}-${pad(m2)}-${pad(d2)}`;
    return void 0;
  }
  const dmy = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(raw);
  if (!dmy) return void 0;
  const d = parseInt(dmy[1], 10);
  const m = parseInt(dmy[2], 10);
  if (d < 1 || d > 31 || m < 1 || m > 12) return void 0;
  const today = /* @__PURE__ */ new Date();
  let y;
  if (dmy[3]) {
    y = parseInt(dmy[3], 10);
    if (y < 100) y += 2e3;
  } else {
    y = today.getFullYear();
    const candidate = new Date(y, m - 1, d);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (candidate < startOfToday) y += 1;
  }
  const date = new Date(y, m - 1, d);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return void 0;
  return `${y}-${pad(m)}-${pad(d)}`;
};
var toCallOutcome = (o, now = /* @__PURE__ */ new Date()) => {
  const followUpDate = parseFollowUpDate(`${o.followUpRaw || ""}`) || (o.result === "da_richiamare" || o.result === "lavori_non_ultimati" || o.result === "riprogrammare" ? parseFollowUpDate(`${o.requestedDate || ""}`) : void 0);
  const chosenAlternative = o.chosenAlternative === "A" || o.chosenAlternative === "B" || o.chosenAlternative === "C" ? o.chosenAlternative : void 0;
  return {
    result: o.result || "sconosciuto",
    requestedDate: o.requestedDate || void 0,
    requestedTime: o.requestedTime || void 0,
    chosenAlternative,
    followUpDate,
    clientNotes: o.clientNotes || void 0,
    newContactName: o.newContactName || void 0,
    newContactPhone: o.newContactPhone || void 0,
    newContactRole: o.newContactRole || void 0,
    summary: o.summary || void 0,
    sentiment: o.sentiment || void 0,
    receivedAt: now.toISOString()
  };
};

// src/services/alternativesService.ts
var LABELS = ["A", "B", "C"];
var SAME_DAY_MIN_GAP = 120;
var DAY_DISTANCE_WEIGHT = 0.5;
var EMPTY_DAY_PENALTY = 15;
var RESOLVE_TOLERANCE = 5;
var isWeekend = (date) => {
  const day = (/* @__PURE__ */ new Date(`${date}T00:00:00`)).getDay();
  return day === 0 || day === 6;
};
var daysBetween = (from, to) => Math.round(((/* @__PURE__ */ new Date(`${to}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${from}T00:00:00`)).getTime()) / 864e5);
var minStartOn = (date, now, leadMinutes) => {
  const limit = new Date(now.getTime() + leadMinutes * 6e4);
  const limitDate = localDateStr(limit);
  if (limitDate < date) return 0;
  if (limitDate > date) return 24 * 60;
  const partial = limit.getSeconds() > 0 || limit.getMilliseconds() > 0 ? 1 : 0;
  return limit.getHours() * 60 + limit.getMinutes() + partial;
};
var computeAlternativeSlots = (appt, all, technicians, opts) => {
  const horizonDays = opts.horizonDays ?? 10;
  const includeWeekends = opts.includeWeekends ?? false;
  const minLead = opts.minLeadMinutes ?? 180;
  const max = Math.min(opts.max ?? 3, LABELS.length);
  if (max <= 0) return [];
  const tech = appt.technicianId ? technicians.find((t) => t.id === appt.technicianId) : void 0;
  const today = localDateStr(opts.now);
  const refDate = appt.date || today;
  const currentStart = appt.date && appt.startTime ? toMin(appt.startTime) : null;
  const duration = durationOf(appt);
  const candidates = [];
  for (let i = opts.skipToday ? 1 : 0; i <= horizonDays; i++) {
    const date = addDaysStr(today, i);
    if (!includeWeekends && isWeekend(date)) continue;
    if (appt.declinedDates?.includes(date)) continue;
    if (appt.followUpDate && date < appt.followUpDate) continue;
    const ctx = dayContextFor(tech, date, opts.fallback);
    if (!ctx) continue;
    const route = getDayRoute(all, appt.technicianId, date, appt.id);
    const notBefore = minStartOn(date, opts.now, minLead);
    const options = findFeasibleSlots(route, ctx, appt.coords, duration, notBefore > 0 ? { notBefore } : {}).filter((o) => o.start >= notBefore).filter((o) => !(date === appt.date && currentStart !== null && Math.abs(o.start - currentStart) < SAME_DAY_MIN_GAP));
    const best = bestSlot(options);
    if (!best) continue;
    const score = best.detourKm + DAY_DISTANCE_WEIGHT * Math.abs(daysBetween(refDate, date)) + (route.length === 0 ? EMPTY_DAY_PENALTY : 0);
    candidates.push({ date, option: best, score });
  }
  return candidates.sort((x, y) => x.score - y.score || x.date.localeCompare(y.date)).slice(0, max).sort((x, y) => x.date.localeCompare(y.date)).map((c, i) => ({
    label: LABELS[i],
    date: c.date,
    startTime: toHHMM(c.option.start),
    endTime: toHHMM(c.option.end)
  }));
};
var resolveAlternative = (appt, label, all, technicians, fallback, now) => {
  const offered = appt.offeredAlternatives?.find((o) => o.label === label);
  if (!offered) return null;
  const tech = appt.technicianId ? technicians.find((t) => t.id === appt.technicianId) : void 0;
  const ctx = dayContextFor(tech, offered.date, fallback);
  if (!ctx) return null;
  const offeredStart = toMin(offered.startTime);
  if (dateAtMinutes(offered.date, offeredStart).getTime() <= now.getTime()) return null;
  const route = getDayRoute(all, appt.technicianId, offered.date, appt.id);
  const duration = durationOf(appt);
  const searches = [{}, { notBefore: offeredStart }, { notBefore: offeredStart - LUNCH_MINUTES }];
  const options = searches.flatMap((s) => findFeasibleSlots(route, ctx, appt.coords, duration, s)).filter((o) => Math.abs(o.start - offeredStart) <= RESOLVE_TOLERANCE);
  if (options.length === 0) return null;
  const option = options.sort(
    (x, y) => Math.abs(x.start - offeredStart) - Math.abs(y.start - offeredStart) || x.detourKm - y.detourKm
  )[0];
  return { date: offered.date, option };
};
var parseTimeText = (text) => {
  if (!text) return null;
  const t = text.toLowerCase();
  const hm = t.match(/\b([01]?\d|2[0-3])\s*(?:[:.,]|\s+e\s+)\s*([0-5]\d)\b/);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const h = t.match(/\b(?:ore|alle|all[e']?)\s*([01]?\d|2[0-3])\b/) || t.match(/^\s*([01]?\d|2[0-3])\s*$/);
  if (h) return parseInt(h[1], 10) * 60;
  return null;
};
var INFER_TOLERANCE = 45;
var inferChosenAlternative = (outcome, offered, current) => {
  if (!offered || offered.length === 0) return void 0;
  if (outcome.chosenAlternative) {
    return offered.some((o) => o.label === outcome.chosenAlternative) ? outcome.chosenAlternative : void 0;
  }
  if (outcome.result !== "confermato" && outcome.result !== "riprogrammare") return void 0;
  const date = outcome.followUpDate || (outcome.requestedDate ? parseFollowUpDate(outcome.requestedDate) : void 0);
  if (!date) return void 0;
  const sameDate = offered.filter((o) => o.date === date);
  if (sameDate.length !== 1) return void 0;
  const slot = sameDate[0];
  const requested = parseTimeText(outcome.requestedTime);
  if (current?.date === date && current.startTime) {
    if (requested === null) return void 0;
    const currentStart = toMin(current.startTime);
    if (Math.abs(requested - currentStart) <= Math.abs(requested - toMin(slot.startTime))) return void 0;
  }
  if (requested === null) return outcome.result === "confermato" ? slot.label : void 0;
  return Math.abs(requested - toMin(slot.startTime)) <= INFER_TOLERANCE ? slot.label : void 0;
};

// src/services/autopilotService.ts
var DEFAULT_AUTOPILOT_SETTINGS = {
  enabled: false,
  callWindowStart: "09:00",
  callWindowEnd: "19:30",
  callSaturday: false,
  maxAttempts: 3,
  retryMinutes: 120,
  offerAlternatives: true,
  backfill: true,
  minLeadHours: 3,
  sameDayChanges: false,
  autoDispatch: true,
  dispatchHorizonDays: 14,
  autoApprove: false
};
var CALL_OUTCOME_MAX_AGE_MS = 45 * 60 * 1e3;
var outcomeOverdue = (a, now) => a.callStatus === "called" && !!a.callId && !a.callOutcome && !!a.calledAt && now.getTime() - new Date(a.calledAt).getTime() >= CALL_OUTCOME_MAX_AGE_MS;
var isCallInFlight = (a, now) => {
  if (a.callStatus === "calling") return true;
  if (a.callStatus !== "called" || !a.callId || a.callOutcome) return false;
  return !(now && outcomeOverdue(a, now));
};
var reservedOfferStops = (all, now, excludeId) => all.flatMap(
  (a) => a.id !== excludeId && a.offeredAlternatives && isCallInFlight(a, now) ? a.offeredAlternatives.map((o) => ({
    ...a,
    id: `${a.id}#${o.label}`,
    status: "proposed",
    date: o.date,
    startTime: o.startTime,
    endTime: o.endTime,
    hasLunchBreakBefore: false,
    sequenceOrder: void 0
  })) : []
);
var slotStartOf = (a) => a.date && a.startTime ? dateAtMinutes(a.date, toMin(a.startTime)) : null;
var slotPassed = (a, now) => {
  const start = slotStartOf(a);
  return !!start && start.getTime() <= now.getTime();
};
var addNote = (notes, nota) => notes ? `${notes} · ${nota}` : nota;
var addDeclined = (dates, date) => {
  if (!date) return dates;
  if (dates?.includes(date)) return dates;
  return [...dates || [], date];
};
var formatDate = (date) => {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
};
var replaceById = (all, updated) => all.map((a) => a.id === updated.id ? updated : a);
var techById = (technicians, id) => id ? technicians.find((t) => t.id === id) : void 0;
var baseFor = (ctx, technicianId, date) => {
  const tech = techById(ctx.technicians, technicianId);
  const day = dayContextFor(tech, date, ctx.fallback);
  return { base: day ? day.base : tech?.baseCoords || ctx.fallback.base };
};
var dayAllowed = (d, s) => {
  const day = d.getDay();
  if (day === 0) return false;
  if (day === 6) return s.callSaturday;
  return true;
};
var isWithinCallWindow = (now, s) => {
  if (!dayAllowed(now, s)) return false;
  const min = now.getHours() * 60 + now.getMinutes();
  return min >= toMin(s.callWindowStart) && min < toMin(s.callWindowEnd);
};
var nextCallWindowStart = (now, s) => {
  if (isWithinCallWindow(now, s)) return new Date(now.getTime());
  const startMin = toMin(s.callWindowStart);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 0, startMin, 0, 0);
    if (d.getTime() > now.getTime() && dayAllowed(d, s)) return d;
  }
  return new Date(now.getTime());
};
var PRIORITY = { backfill: 0, route: 1, retry: 2 };
var isDue = (a, now) => !!a.autoCall && !!a.phone && isInRoute(a) && !isCallInFlight(a, now) && (!a.autoCallNotBefore || new Date(a.autoCallNotBefore).getTime() <= now.getTime()) && !slotPassed(a, now);
var byPriority = (x, y) => (PRIORITY[x.autoCall || ""] ?? 9) - (PRIORITY[y.autoCall || ""] ?? 9) || (x.date || "").localeCompare(y.date || "") || (x.startTime || "").localeCompare(y.startTime || "");
var phoneKey = (phone) => {
  let digits = (phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith("39")) digits = digits.slice(2);
  return digits;
};
var nextDueCall = (all, ctx, maxInFlight = 4) => {
  if (!ctx.settings.enabled) return null;
  if (!isWithinCallWindow(ctx.now, ctx.settings)) return null;
  const inFlight = all.filter((a) => isCallInFlight(a, ctx.now));
  if (inFlight.length >= maxInFlight) return null;
  const busy = new Set(inFlight.map((a) => phoneKey(a.phone)).filter(Boolean));
  const due = all.filter((a) => isDue(a, ctx.now) && !busy.has(phoneKey(a.phone))).sort(byPriority);
  return due[0] || null;
};
var expireStaleAutoCalls = (all, now) => all.map(
  (a) => a.autoCall && slotPassed(a, now) ? { ...a, autoCall: void 0, autoCallNotBefore: void 0 } : a
);
var alternativesForCall = (appt, all, ctx) => {
  if (!ctx.settings.offerAlternatives || !isInRoute(appt)) return [];
  return computeAlternativeSlots(appt, [...all, ...reservedOfferStops(all, ctx.now, appt.id)], ctx.technicians, {
    now: ctx.now,
    fallback: ctx.fallback,
    minLeadMinutes: ctx.settings.minLeadHours * 60,
    skipToday: !ctx.settings.sameDayChanges
  });
};
var reduceCallStarted = (all, id, alternatives, now) => all.map(
  (a) => a.id === id ? {
    ...a,
    callStatus: "calling",
    callStartedAt: now ? now.toISOString() : void 0,
    // via i riferimenti alla chiamata precedente: il suo esito non deve
    // essere scambiato per quello della chiamata che sta partendo
    callId: void 0,
    calledAt: void 0,
    autoCall: void 0,
    autoCallNotBefore: void 0,
    callOutcome: void 0,
    callSummary: void 0,
    offeredAlternatives: alternatives.length > 0 ? alternatives : void 0
  } : a
);
var reduceCallLaunchResult = (all, id, result, now) => all.map((a) => {
  if (a.id !== id) return a;
  if (result.ok) {
    return { ...a, callStatus: "called", callId: result.callId, calledAt: now.toISOString() };
  }
  return {
    ...a,
    callStatus: "failed",
    calledAt: now.toISOString(),
    callSummary: result.error || "Chiamata non avviata"
  };
});
var ALTERNATIVE_RESULTS = ["confermato", "riprogrammare", "da_richiamare", "sconosciuto"];
var reduceCallOutcome = (all, id, outcome, expectedCallId, ctx) => {
  const a = all.find((x) => x.id === id);
  if (!a || a.callOutcome) return all;
  if (expectedCallId && a.callId !== expectedCallId) return all;
  const s = ctx.settings;
  const pilot = s.enabled;
  const eraNelGiro = isInRoute(a);
  const freed = eraNelGiro ? {
    technicianId: a.technicianId,
    date: a.date,
    start: toMin(a.startTime),
    end: a.endTime ? toMin(a.endTime) : toMin(a.startTime) + durationOf(a),
    coords: a.coords,
    title: a.title
  } : null;
  const oldDayBase = freed ? baseFor(ctx, freed.technicianId, freed.date) : void 0;
  const base = {
    ...a,
    callOutcome: outcome,
    callSummary: outcome.summary || a.callSummary,
    callStatus: outcome.result === "non_risposto" ? "failed" : "called"
  };
  let list = replaceById(all, base);
  let liberato = false;
  const leaveRoute = (changes) => {
    list = removeFromRoute(list, id, changes, oldDayBase);
    liberato = eraNelGiro;
  };
  const reschedule = (followUpDate, nota, savedOutcome) => {
    leaveRoute({
      status: "pending",
      followUpDate,
      declinedDates: addDeclined(a.declinedDates, a.date),
      notes: addNote(a.notes, nota),
      callOutcome: savedOutcome
    });
  };
  const chosen = inferChosenAlternative(outcome, a.offeredAlternatives, eraNelGiro ? a : void 0);
  const offered = chosen ? a.offeredAlternatives?.find((o) => o.label === chosen) : void 0;
  if (offered && ALTERNATIVE_RESULTS.includes(outcome.result)) {
    const occupied = [...list, ...reservedOfferStops(list, ctx.now, id)];
    const resolved = resolveAlternative(a, offered.label, occupied, ctx.technicians, ctx.fallback, ctx.now);
    const quando = `${formatDate(offered.date)} ${offered.startTime}`;
    if (resolved) {
      list = placeAppointment(
        list,
        id,
        {
          date: resolved.date,
          option: resolved.option,
          ctx: baseFor(ctx, a.technicianId, resolved.date),
          fromCtx: oldDayBase
        },
        {
          status: "confirmed",
          callOutcome: { ...outcome, result: "confermato", chosenAlternative: offered.label },
          declinedDates: a.date && a.date !== resolved.date ? addDeclined(a.declinedDates, a.date) : a.declinedDates,
          callAttempts: 0,
          autoCall: void 0,
          autoCallNotBefore: void 0,
          notes: addNote(a.notes, `Spostato su richiesta del cliente: ${quando}`)
        }
      );
      liberato = eraNelGiro;
    } else {
      reschedule(
        offered.date,
        `Da riprogrammare — l'alternativa scelta dal cliente (${quando}) non è più libera`,
        { ...outcome, result: "riprogrammare", followUpDate: offered.date }
      );
    }
  } else {
    switch (outcome.result) {
      case "confermato":
        list = replaceById(list, {
          ...base,
          status: a.status === "proposed" ? "confirmed" : base.status,
          callAttempts: 0
        });
        break;
      case "riprogrammare": {
        const quando = [outcome.requestedDate, outcome.requestedTime].filter(Boolean).join(" ");
        reschedule(
          outcome.followUpDate || a.followUpDate,
          quando ? `Da riprogrammare — richiesta cliente: ${quando}` : "Da riprogrammare (nessuna preferenza indicata)",
          outcome
        );
        break;
      }
      case "da_richiamare":
        leaveRoute({ status: "issue", issueType: "callback", followUpDate: outcome.followUpDate || a.followUpDate });
        break;
      case "numero_errato":
        leaveRoute({ status: "issue", issueType: "wrong_phone" });
        break;
      case "lavori_non_ultimati":
        leaveRoute({ status: "issue", issueType: "works_pending", followUpDate: outcome.followUpDate || a.followUpDate });
        break;
      case "annullato":
        leaveRoute({ status: "cancelled", issueType: void 0 });
        break;
      case "rifiutato":
        leaveRoute({
          status: "standby",
          notes: addNote(a.notes, "Rifiutato dal cliente"),
          declinedDates: addDeclined(a.declinedDates, a.date)
        });
        break;
      case "altro_referente":
        if (outcome.newContactPhone && !(pilot && a.referredBy)) {
          list = replaceById(list, {
            ...base,
            phone: outcome.newContactPhone,
            contactPerson: [outcome.newContactName, outcome.newContactRole].filter(Boolean).join(" — ") || "Referente indicato dal cliente",
            referredBy: a.referredBy || a.title,
            callStatus: void 0,
            callId: void 0,
            calledAt: void 0,
            callOutcome: void 0,
            callAttempts: 0,
            notes: addNote(
              a.notes,
              `Nuovo referente: ${[outcome.newContactName, outcome.newContactRole, outcome.newContactPhone].filter(Boolean).join(" · ")}`
            ),
            // Pilota: richiama da solo il referente per lo stesso slot
            ...pilot && eraNelGiro ? { autoCall: "route", autoCallNotBefore: void 0 } : {}
          });
        }
        break;
      case "non_risposto": {
        const attempts = (a.callAttempts || 0) + 1;
        if (!pilot || !eraNelGiro || a.status !== "proposed") {
          list = replaceById(list, { ...base, callAttempts: attempts });
          break;
        }
        const retryAt = nextCallWindowStart(new Date(ctx.now.getTime() + s.retryMinutes * 6e4), s);
        const slotStart = slotStartOf(a);
        const deadline = slotStart.getTime() - s.minLeadHours * 36e5;
        if (attempts < s.maxAttempts && retryAt.getTime() < deadline) {
          list = replaceById(list, {
            ...base,
            callAttempts: attempts,
            autoCall: "retry",
            autoCallNotBefore: retryAt.toISOString()
          });
        } else {
          leaveRoute({
            status: "issue",
            issueType: "callback",
            callAttempts: attempts,
            autoCall: void 0,
            autoCallNotBefore: void 0,
            notes: addNote(a.notes, `Non raggiungibile dopo ${attempts} ${attempts === 1 ? "tentativo" : "tentativi"}`)
          });
        }
        break;
      }
      default:
        break;
    }
  }
  if (pilot && s.backfill && liberato && freed) {
    const leadOk = dateAtMinutes(freed.date, freed.start).getTime() - ctx.now.getTime() >= s.minLeadHours * 36e5;
    if (leadOk) list = backfillSlot(list, freed, id, ctx);
  }
  return list;
};
var backfillSlot = (all, freed, leftId, ctx) => {
  if (!freed.technicianId) return all;
  if (!ctx.settings.sameDayChanges && freed.date === localDateStr(ctx.now)) return all;
  const tech = techById(ctx.technicians, freed.technicianId);
  const day = dayContextFor(tech, freed.date, ctx.fallback);
  if (!day) return all;
  const minStartAbs = ctx.now.getTime() + ctx.settings.minLeadHours * 36e5;
  const occupied = [...all, ...reservedOfferStops(all, ctx.now, leftId)];
  let best = null;
  for (const cand2 of all) {
    if (cand2.id === leftId || cand2.technicianId !== freed.technicianId || !cand2.phone) continue;
    if (cand2.declinedDates?.includes(freed.date)) continue;
    if (cand2.followUpDate && cand2.followUpDate > freed.date) continue;
    if (isCallInFlight(cand2, ctx.now)) continue;
    const waiting = cand2.status === "pending";
    const advance = cand2.status === "proposed" && isInRoute(cand2) && cand2.date > freed.date && cand2.callOutcome?.result !== "confermato";
    if (!waiting && !advance) continue;
    const route = getDayRoute(occupied, freed.technicianId, freed.date, cand2.id);
    const options = findFeasibleSlots(route, day, cand2.coords, durationOf(cand2), {
      notBefore: freed.start - 30,
      notAfter: freed.start + 120
    }).filter((o) => dateAtMinutes(freed.date, o.start).getTime() >= minStartAbs);
    for (const option2 of options) {
      const score = option2.detourKm + Math.abs(option2.start - freed.start) / 60 + (advance ? 3 : 0) - (cand2.urgent ? 1e3 : 0);
      if (!best || score < best.score) best = { cand: cand2, option: option2, score };
    }
  }
  if (!best) return all;
  const { cand, option } = best;
  return placeAppointment(
    all,
    cand.id,
    {
      date: freed.date,
      option,
      technicianId: freed.technicianId,
      ctx: { base: day.base },
      fromCtx: cand.date ? baseFor(ctx, cand.technicianId, cand.date) : void 0
    },
    {
      status: "proposed",
      autoCall: "backfill",
      backfillOf: freed.title,
      callAttempts: 0,
      callStatus: void 0,
      callId: void 0,
      calledAt: void 0,
      callOutcome: void 0,
      callSummary: void 0,
      offeredAlternatives: void 0,
      autoCallNotBefore: void 0
    }
  );
};
var autopilotStats = (all, ctx) => {
  const queuedList = all.filter((a) => !!a.autoCall);
  const dueNow = all.filter((a) => isDue(a, ctx.now)).length;
  let nextCallAt = null;
  if (ctx.settings.enabled) {
    let earliest = null;
    for (const a of queuedList) {
      if (!a.phone || !isInRoute(a) || isCallInFlight(a, ctx.now) || slotPassed(a, ctx.now)) continue;
      const t = a.autoCallNotBefore ? Math.max(ctx.now.getTime(), new Date(a.autoCallNotBefore).getTime()) : ctx.now.getTime();
      if (earliest === null || t < earliest) earliest = t;
    }
    if (earliest !== null) nextCallAt = nextCallWindowStart(new Date(earliest), ctx.settings);
  }
  return {
    queued: queuedList.length,
    inFlight: all.filter((a) => isCallInFlight(a, ctx.now)).length,
    dueNow,
    nextCallAt,
    windowOpen: isWithinCallWindow(ctx.now, ctx.settings)
  };
};

// src/services/dayScheduleService.ts
var buildDaySchedule = (appt, all, technicians, fallback, defaultDay) => {
  const day = appt.date || defaultDay;
  const tech = appt.technicianId ? technicians.find((t) => t.id === appt.technicianId) : void 0;
  let windowStart = fallback.start;
  let windowEnd = fallback.end;
  if (tech) {
    const window = workWindowOn(tech, day);
    if (window) {
      windowStart = window.start;
      windowEnd = window.end;
    }
  }
  const impegni = all.filter((a) => (a.status === "confirmed" || a.status === "proposed") && a.date === day && a.id !== appt.id && !!a.startTime && a.technicianId === appt.technicianId).sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0)).map((a) => `${a.startTime}-${a.endTime || "?"}${a.comune ? ` (zona ${a.comune})` : ""}`);
  return `Giornata lavorativa ${windowStart}-${windowEnd}. ` + (impegni.length ? `Fasce già impegnate: ${impegni.join("; ")}.` : "Nessun altro appuntamento fissato.");
};

// server/engine.ts
var LOCK_TTL_MS = 55e3;
var LAUNCH_GAP_MS = 1500;
var STALE_LAUNCH_MS = 3 * 6e4;
var SYNC_INTERVAL_MS = 60 * 6e4;
var RECENT_TICK_MS = 3e3;
var DEFAULT_BUDGET_MS = { scheduler: 4e4, browser: 4e4, webhook: 8e3 };
var OUTCOME_CONCURRENCY = 4;
var CREATE_TIMEOUT_MS = 15e3;
var WEBHOOK_MIN_LAUNCH_MS = 3500;
var SYNC_MIN_REMAINING_MS = 1e4;
var INTERRUPTED_LAUNCH_SUMMARY = "Avvio della chiamata interrotto";
var OUTCOME_TIMEOUT_SUMMARY = "Esito non ricevuto nei tempi: controlla la dashboard Retell.";
var realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var planningFrom = (config, now) => ({
  technicians: Array.isArray(config.technicians) ? config.technicians : [],
  fallback: config.fallback,
  settings: { ...DEFAULT_AUTOPILOT_SETTINGS, ...config.autopilot || {} },
  now
});
var pad2 = (n) => String(n).padStart(2, "0");
var localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
var keepIfSame = (before, after) => after.length === before.length && after.every((a, i) => a === before[i]) ? before : after;
var recoverInterruptedLaunches = (all, now) => keepIfSame(
  all,
  all.map((a) => {
    if (a.callStatus !== "calling" || a.callId) return a;
    const started = a.callStartedAt ? new Date(a.callStartedAt).getTime() : NaN;
    if (Number.isFinite(started) && now.getTime() - started < STALE_LAUNCH_MS) return a;
    return {
      ...a,
      callStatus: "failed",
      callSummary: INTERRUPTED_LAUNCH_SUMMARY,
      calledAt: now.toISOString(),
      autoCall: void 0,
      autoCallNotBefore: void 0
    };
  })
);
var countChanged = (before, after) => {
  if (before === after) return 0;
  const byId = new Map(before.map((a) => [a.id, a]));
  return after.filter((a) => byId.get(a.id) !== a).length;
};
var awaitingOutcome = (a) => !!a.callId && !a.callOutcome && (a.callStatus === "called" || a.callStatus === "calling");
var callBodyFor = (appt, all, config, now, alternatives) => {
  const technicians = Array.isArray(config.technicians) ? config.technicians : [];
  const tech = technicians.find((t) => t.id === appt.technicianId);
  return {
    phone: appt.phone,
    clientName: appt.title,
    date: appt.date,
    startTime: appt.startTime,
    endTime: appt.endTime,
    address: appt.address,
    shortAddress: appt.shortAddress,
    comune: appt.comune,
    notes: appt.notes,
    urgent: appt.urgent === true,
    technicianName: tech?.name || void 0,
    periziaCode: appt.periziaCode,
    project: appt.project,
    contactPerson: appt.contactPerson,
    referredBy: appt.referredBy,
    daySchedule: buildDaySchedule(appt, all, technicians, config.fallback, localDay(now)) || void 0,
    alternatives: alternatives.length > 0 ? alternatives : void 0
  };
};
var emptySummary = () => ({
  outcomesApplied: 0,
  callsLaunched: 0,
  callsFailed: 0,
  recovered: 0,
  expired: 0,
  synced: 0,
  inFlight: 0,
  queued: 0,
  windowOpen: false,
  pilotEnabled: false,
  durationMs: 0
});
var errorText = (err) => {
  if (err instanceof ConflictError) return "Troppe modifiche concorrenti: riprova al prossimo passaggio";
  if (err instanceof StoreError) return "Errore del database";
  return "Errore interno del motore";
};
var logError = (where, err) => {
  const code = err instanceof StoreError ? err.code : err instanceof Error ? err.name : "sconosciuto";
  console.error(`pilota cloud: errore (${where}): ${code}`);
};
var forEachLimited = async (items, limit, fn) => {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
};
var runTick = async (deps, source, opts = {}) => {
  const clock = deps.clock || Date.now;
  const sleep = deps.sleep || realSleep;
  const started = clock();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS[source];
  const remaining = () => budgetMs - (clock() - started);
  const summary = emptySummary();
  const store = deps.store;
  let record = true;
  const finish = async () => {
    summary.durationMs = Math.max(0, clock() - started);
    if (record) {
      try {
        await store.updateMeta({
          lastTick: { at: deps.now().toISOString(), source, summary },
          lastTickWallMs: clock()
        });
      } catch (err) {
        logError("metadati", err);
      }
    }
    return summary;
  };
  let config = null;
  try {
    const cfg2 = await store.readConfig();
    config = cfg2.config;
    if (config) {
      const ctx0 = planningFrom(config, deps.now());
      summary.pilotEnabled = ctx0.settings.enabled;
      summary.windowOpen = isWithinCallWindow(ctx0.now, ctx0.settings);
    }
    if (!(deps.timezone || timezoneStatus)().ok) {
      summary.skipped = "timezone";
      return await finish();
    }
    if (!config) {
      summary.skipped = "no_state";
      return await finish();
    }
    if (source === "webhook") {
      const meta = await store.readMeta();
      if (meta.lastTickWallMs !== null && clock() - meta.lastTickWallMs < RECENT_TICK_MS) {
        summary.skipped = "recent";
        record = false;
        return await finish();
      }
    }
    const initial = await store.readAppointments();
    if (!initial.appointments) {
      summary.skipped = "no_state";
      return await finish();
    }
  } catch (err) {
    logError("avvio", err);
    summary.error = errorText(err);
    return await finish();
  }
  const owner = `${source}-${randomUUID()}`;
  try {
    if (!await store.acquireLock(owner, LOCK_TTL_MS)) {
      summary.skipped = "locked";
      record = false;
      return await finish();
    }
  } catch (err) {
    logError("lock", err);
    summary.error = errorText(err);
    return await finish();
  }
  const cfg = config;
  try {
    {
      const now = deps.now();
      let recovered = 0;
      let expired = 0;
      await commit(store, (all) => {
        const rec = recoverInterruptedLaunches(all, now);
        const exp = keepIfSame(rec, expireStaleAutoCalls(rec, now));
        recovered = countChanged(all, rec);
        expired = countChanged(rec, exp);
        return exp;
      });
      summary.recovered = recovered;
      summary.expired = expired;
    }
    if (deps.retell.configured()) {
      const { appointments } = await store.readAppointments();
      const targets = (appointments || []).filter(awaitingOutcome);
      const found = [];
      await forEachLimited(targets, OUTCOME_CONCURRENCY, async (appt) => {
        if (remaining() <= 0) return;
        const callId = appt.callId;
        const lookup = await deps.retell.getCall(callId, Math.max(1e3, Math.min(8e3, remaining())));
        const now = deps.now();
        if (lookup.kind === "done") {
          found.push({ id: appt.id, callId, outcome: toCallOutcome(lookup.outcome, now) });
          return;
        }
        if (lookup.kind === "error" && lookup.transient) return;
        const since = appt.calledAt || appt.callStartedAt;
        const age = since ? now.getTime() - new Date(since).getTime() : Infinity;
        if (age >= CALL_OUTCOME_MAX_AGE_MS) {
          found.push({
            id: appt.id,
            callId,
            outcome: { result: "sconosciuto", summary: OUTCOME_TIMEOUT_SUMMARY, receivedAt: now.toISOString() }
          });
        }
      });
      if (found.length > 0) {
        let applied = 0;
        await commit(store, (all) => {
          applied = 0;
          const ctx = planningFrom(cfg, deps.now());
          let list = all;
          for (const f of found) {
            const next = reduceCallOutcome(list, f.id, f.outcome, f.callId, ctx);
            if (next !== list) applied++;
            list = next;
          }
          return list;
        });
        summary.outcomesApplied = applied;
      }
    }
    const settings = planningFrom(cfg, deps.now()).settings;
    if (settings.enabled) {
      if (!deps.retell.configured()) {
        const { appointments } = await store.readAppointments();
        if (nextDueCall(appointments || [], planningFrom(cfg, deps.now()))) {
          summary.error = "Chiamate AI non configurate sul server (RETELL_API_KEY, RETELL_FROM_NUMBER)";
        }
      } else {
        const minRemaining = source === "webhook" ? WEBHOOK_MIN_LAUNCH_MS : 0;
        let launchedBefore = false;
        while (remaining() > minRemaining) {
          if (launchedBefore) {
            await sleep(LAUNCH_GAP_MS);
            if (remaining() <= minRemaining) break;
          }
          const ts = deps.now();
          let picked = null;
          let alternatives = [];
          const marked = await commit(store, (all) => {
            picked = null;
            alternatives = [];
            const ctx = planningFrom(cfg, ts);
            const next = nextDueCall(all, ctx);
            if (!next) return all;
            picked = next;
            alternatives = alternativesForCall(next, all, ctx);
            return reduceCallStarted(all, next.id, alternatives, ts);
          });
          const chosen = picked;
          if (!chosen) break;
          const current = marked.appointments.find((a) => a.id === chosen.id) || chosen;
          const body = callBodyFor(current, marked.appointments, cfg, ts, alternatives);
          const timeoutMs = source === "webhook" ? Math.max(3e3, Math.min(6e3, remaining() - 500)) : CREATE_TIMEOUT_MS;
          const launch = await deps.retell.createCall(body, timeoutMs).catch(
            () => ({ ok: false, error: "Impossibile avviare la chiamata. Riprova." })
          );
          launchedBefore = true;
          const result = launch.ok ? { ok: true, callId: launch.callId } : { ok: false, error: launch.error };
          let saved = false;
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            try {
              const doneAt = deps.now();
              await commit(store, (all) => reduceCallLaunchResult(all, chosen.id, result, doneAt));
              saved = true;
            } catch (err) {
              if (attempt === 2) throw err;
              await sleep(300);
            }
          }
          if (launch.ok) summary.callsLaunched++;
          else summary.callsFailed++;
        }
      }
    }
    if (deps.sync && source !== "webhook" && remaining() > SYNC_MIN_REMAINING_MS) {
      const meta = await store.readMeta();
      const now = deps.now();
      const last = meta.lastSync ? new Date(meta.lastSync.at).getTime() : NaN;
      if (!Number.isFinite(last) || now.getTime() - last >= SYNC_INTERVAL_MS) {
        const { appointments } = await store.readAppointments();
        const list = appointments || [];
        const syncable = getSyncableAppointments(list).length;
        if (syncable > 0) {
          let sent = 0;
          let failed = 0;
          try {
            const r = await deps.sync(list);
            sent = r.sent;
            failed = r.failed;
          } catch (err) {
            logError("sync", err);
            failed = syncable;
          }
          summary.synced = sent;
          await store.updateMeta({ lastSync: { at: now.toISOString(), sent, failed } });
          if (failed > 0 && !summary.error) {
            summary.error = `Sincronizzazione col gestionale: ${failed} invii non riusciti`;
          }
        }
      }
    }
  } catch (err) {
    logError("passaggio", err);
    summary.error = errorText(err);
  } finally {
    try {
      await store.releaseLock(owner);
    } catch (err) {
      logError("rilascio lock", err);
    }
  }
  try {
    const { appointments } = await store.readAppointments();
    const stats = autopilotStats(appointments || [], planningFrom(cfg, deps.now()));
    summary.inFlight = stats.inFlight;
    summary.queued = stats.queued;
    summary.windowOpen = stats.windowOpen;
  } catch (err) {
    logError("riepilogo", err);
    if (!summary.error) summary.error = errorText(err);
  }
  return await finish();
};

// api/call-status.ts
var retellApiKey = () => process.env.RETELL_API_KEY || "";
var retellApiBase = () => (process.env.RETELL_API_BASE || "https://api.retellai.com").replace(/\/+$/, "");
var pickString = (obj, keys) => {
  if (!obj) return void 0;
  const normalized = {};
  for (const k of Object.keys(obj)) {
    normalized[k.toLowerCase().replace(/[\s-]+/g, "_")] = obj[k];
  }
  for (const key of keys) {
    const v = normalized[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
};
var normalizeChosenAlternative = (raw) => {
  if (typeof raw !== "string") return void 0;
  const v = raw.trim().toLowerCase();
  if (!v) return void 0;
  const tokens = v.split(/[^a-z0-9àèéìòù]+/).filter(Boolean);
  const ALLOWED = /* @__PURE__ */ new Set(["alternativa", "alternative", "opzione", "slot", "scelta", "lettera", "la", "l", "proposta"]);
  const letters = [];
  for (const t of tokens) {
    if (t === "a" || t === "b" || t === "c") letters.push(t);
    else if (!ALLOWED.has(t)) return void 0;
  }
  if (letters.length !== 1) return void 0;
  return letters[0].toUpperCase();
};
var classifyOutcome = (raw, inVoicemail, disconnectionReason, hasNewContact) => {
  if (raw) {
    const v = raw.toLowerCase();
    if (v.includes("altro_referente") || v.includes("contattare_altro") || v.includes("altro referente") || v.includes("altra persona") || v.includes("deleg")) return "altro_referente";
    if (v.includes("riprogramm") || v.includes("sposta") || v.includes("cambi") || v.includes("altro orario") || v.includes("altra data") || v.includes("nuova data") || v.includes("nuovo orario") || v.includes("reschedul")) return "riprogrammare";
    if (v.includes("richiam") || v.includes("ricontatt") || v.includes("callback")) return "da_richiamare";
    if (v.includes("numero_errato") || v.includes("wrong") || v.includes("numero") && (v.includes("errat") || v.includes("sbagliat"))) return "numero_errato";
    if (v.includes("lavori_non_ultimati") || v.includes("lavor") || v.includes("ultimat") || v.includes("non pronto") || v.includes("cantiere")) return "lavori_non_ultimati";
    if (v.includes("annull") || v.includes("disdet") || v.includes("non serve") || v.includes("vendita salt")) return "annullato";
    if (v.includes("rifiut") || v.includes("declin") || v.includes("non vuole") || v.includes("non interessat")) return "rifiutato";
    if (v.includes("non risp") || v.includes("no_answer") || v.includes("nessuna_risposta") || v.includes("non_raggiunto") || v.includes("segreteria") || v.includes("voicemail") || v.includes("irraggiungibile") || v.includes("occupato")) return "non_risposto";
    if (/non\s+(ha\s+|è\s+stato\s+|e'\s+stato\s+)?conferm/.test(v)) return "sconosciuto";
    if (v.includes("conferm")) return "confermato";
  }
  if (hasNewContact) return "altro_referente";
  if (inVoicemail || disconnectionReason === "voicemail_reached" || disconnectionReason === "machine_detected") return "non_risposto";
  if (disconnectionReason === "dial_no_answer" || disconnectionReason === "dial_busy" || disconnectionReason === "dial_failed") return "non_risposto";
  return "sconosciuto";
};
var interpretRetellCall = (raw) => {
  const data = raw && typeof raw === "object" ? raw : {};
  const callStatus = data.call_status || "unknown";
  if (callStatus === "registered" || callStatus === "ongoing") {
    return { pending: true, callStatus };
  }
  const analysis = data.call_analysis || {};
  const custom = analysis.custom_analysis_data;
  const disconnectionReason = data.disconnection_reason || "";
  const inVoicemail = !!data.in_voicemail || analysis.in_voicemail === true;
  if (callStatus === "error") {
    const result2 = /invalid_destination|invalid_number/.test(disconnectionReason) ? "numero_errato" : "non_risposto";
    return {
      pending: false,
      callStatus,
      disconnectionReason,
      outcome: { result: result2, summary: "Chiamata non riuscita (errore telefonico)." }
    };
  }
  if (callStatus === "ended" && !analysis.call_summary && !custom) {
    return { pending: true, callStatus, analysisPending: true };
  }
  const rawEsito = pickString(custom, ["esito_appuntamento", "esito_chiamata", "esito", "appointment_outcome", "outcome"]);
  const newContactName = pickString(custom, ["nuovo_referente_nome", "referente_nome", "new_contact_name"]);
  const newContactPhone = pickString(custom, ["nuovo_referente_telefono", "referente_telefono", "new_contact_phone"]);
  const newContactRole = pickString(custom, ["nuovo_referente_ruolo", "referente_ruolo", "new_contact_role"]);
  const result = classifyOutcome(rawEsito, inVoicemail, disconnectionReason, !!newContactPhone);
  return {
    pending: false,
    callStatus,
    disconnectionReason,
    outcome: {
      result,
      requestedDate: pickString(custom, ["nuova_data_richiesta", "data_richiesta", "data_preferita", "nuova_data", "requested_date"]),
      requestedTime: pickString(custom, ["nuovo_orario_richiesto", "orario_richiesto", "orario_preferito", "requested_time"]),
      chosenAlternative: normalizeChosenAlternative(
        pickString(custom, ["alternativa_scelta", "alternativa_accettata", "alternativa", "slot_scelto", "chosen_alternative"])
      ),
      followUpRaw: pickString(custom, ["data_rientro", "data_richiamo", "follow_up_date"]),
      clientNotes: pickString(custom, ["note_cliente", "note", "client_notes"]),
      newContactName,
      newContactPhone,
      newContactRole,
      summary: typeof analysis.call_summary === "string" ? analysis.call_summary : void 0,
      sentiment: typeof analysis.user_sentiment === "string" ? analysis.user_sentiment : void 0
    }
  };
};
var isValidCallId = (callId) => !!callId && /^[\w-]+$/.test(callId);
var fetchRetellCall = async (callId, opts = {}) => {
  const controller = opts.timeoutMs ? new AbortController() : void 0;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : void 0;
  try {
    const response = await fetch(`${retellApiBase()}/v2/get-call/${encodeURIComponent(callId)}`, {
      headers: { "Authorization": `Bearer ${retellApiKey()}` },
      signal: controller?.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: data?.message || data?.error || `Errore Retell (${response.status})`,
        transient: response.status === 429 || response.status >= 500
      };
    }
    return { ok: true, view: interpretRetellCall(data) };
  } catch (error) {
    console.error("call-status error:", controller?.signal.aborted ? "timeout" : "errore di rete");
    return { ok: false, status: 500, error: "Impossibile recuperare lo stato della chiamata.", transient: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// server/retell.ts
var httpRetellClient = {
  configured: () => {
    const env = retellEnv();
    return !!env.apiKey && !!env.fromNumber;
  },
  async createCall(body, timeoutMs) {
    const r = await createRetellCall(body, { timeoutMs });
    if (!r.ok) return { ok: false, error: r.error };
    if (typeof r.callId !== "string" || !isValidCallId(r.callId)) {
      return { ok: false, error: "Risposta di Retell senza identificativo della chiamata." };
    }
    return { ok: true, callId: r.callId };
  },
  async getCall(callId, timeoutMs) {
    if (!isValidCallId(callId)) return { kind: "error", transient: false };
    const r = await fetchRetellCall(callId, { timeoutMs });
    if (!r.ok) return { kind: "error", transient: r.transient };
    if (r.view.pending || !r.view.outcome) return { kind: "pending" };
    return { kind: "done", outcome: r.view.outcome };
  }
};

// server/http.ts
var syncTargetFromEnv = (env) => {
  const projectId = (env.GESTIONALE_PROJECT_ID || "").trim();
  const apiKey = (env.GESTIONALE_API_KEY || "").trim();
  return projectId && apiKey ? { projectId, apiKey } : null;
};
var syncEnabled = (env, store) => {
  if (env.OPTIROUTE_SYNC === "off") return false;
  if (!syncTargetFromEnv(env)) return false;
  if (store?.kind === "memory") return env.OPTIROUTE_SYNC === "on";
  return true;
};
var defaultNow = (env) => () => {
  const hook = globalThis.__optirouteNow;
  if (typeof hook === "function" && env.OPTIROUTE_STORE === "memory" && !env.VERCEL_ENV) return hook();
  return /* @__PURE__ */ new Date();
};
var defaultDeps = (overrides = {}) => {
  const env = overrides.env || process.env;
  const store = "store" in overrides ? overrides.store : storeFromEnv(env);
  return {
    env,
    store,
    now: overrides.now || defaultNow(env),
    clock: overrides.clock || Date.now,
    retell: overrides.retell || httpRetellClient,
    sync: "sync" in overrides ? overrides.sync ?? null : syncEnabled(env, store) ? (appointments) => pushConfirmedToFirestore(appointments, syncTargetFromEnv(env), "server") : null,
    sleep: overrides.sleep,
    timezone: overrides.timezone || timezoneStatus
  };
};
var engineDeps = (d, store) => ({
  store,
  now: d.now,
  retell: d.retell,
  sync: d.sync || void 0,
  clock: d.clock,
  sleep: d.sleep,
  timezone: d.timezone
});
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var send = (res, status, body) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
};
var fail = (res, err, where) => {
  if (err instanceof HttpError) {
    send(res, err.status, err.message !== err.code ? { error: err.code, message: err.message } : { error: err.code });
    return;
  }
  if (err instanceof ConflictError) {
    send(res, 409, { error: "conflict" });
    return;
  }
  const code = err instanceof StoreError ? `database/${err.code}` : err instanceof Error ? err.name : "sconosciuto";
  console.error(`cloud: errore interno (${where}): ${code}`);
  send(res, 500, { error: "server" });
};
var requireSecret = (d) => {
  const secret = d.env.CRON_SECRET || "";
  if (!secret) throw new HttpError(503, "secret_not_configured");
  return secret;
};
var requireStore = (d) => {
  if (!d.store) throw new HttpError(503, "store_not_configured");
  return d.store;
};
var authenticate = (req, d) => {
  const secret = requireSecret(d);
  if (!isAuthorized(req.headers, secret)) throw new HttpError(401, "auth");
  return requireStore(d);
};
var runAndSummarize = async (d, store, source) => runTick(engineDeps(d, store), source);
var createTickHandler = (overrides = {}) => async function cloudTickHandler(req, res) {
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new HttpError(405, "bad_request", "Metodo non ammesso");
    const d = defaultDeps(overrides);
    const store = authenticate(req, d);
    if (/vercel-cron/i.test(headerValue(req.headers, "user-agent"))) {
      await store.updateMeta({ schedulerSeenAt: d.now().toISOString() });
    }
    const summary = await runAndSummarize(d, store, "scheduler");
    send(res, 200, { summary });
  } catch (err) {
    fail(res, err, "cloud-tick");
  }
};

// server/cloud-tick-entry.ts
var cloud_tick_entry_default = createTickHandler();
export {
  cloud_tick_entry_default as default
};
