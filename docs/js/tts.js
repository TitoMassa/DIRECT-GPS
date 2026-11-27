// ============================================================================
// DIRECT GPS · Motor de Voz Natural en Español Rioplatense (es-AR)
// ----------------------------------------------------------------------------
// Formatea números de coche en pares naturales ("2976" -> "veintinueve setenta
// y seis", "4100" -> "cuarenta y uno cero cero"), limpia nombres de paradas
// para personas no videntes y coordina la locución DESPUÉS del timbre nativo.
// ============================================================================

const UNITS = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve'
];

const TENS = [
  '',
  '',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa'
];

const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos'
];

/**
 * Convierte un entero 0..99 a palabras en español natural.
 */
export function numberToSpanish0to99(n) {
  const num = Math.max(0, Math.min(99, Math.floor(Number(n) || 0)));
  if (num < 30) return UNITS[num];
  const t = Math.floor(num / 10);
  const u = num % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} y ${UNITS[u]}`;
}

/**
 * Convierte un entero 0..999 a palabras en español natural (útil para números de línea como 106, 904).
 */
export function numberToSpanish0to999(n) {
  const num = Math.max(0, Math.min(999, Math.floor(Number(n) || 0)));
  if (num < 100) return numberToSpanish0to99(num);
  if (num === 100) return 'cien';
  const h = Math.floor(num / 100);
  const rem = num % 100;
  return rem === 0 ? HUNDREDS[h] : `${HUNDREDS[h]} ${numberToSpanish0to99(rem)}`;
}

/**
 * Convierte un par de 2 dígitos ("00".."99") en lectura hablada de internos de colectivo:
 *  - "00" -> "cero cero"
 *  - "05" -> "cero cinco"
 *  - "29" -> "veintinueve"
 *  - "76" -> "setenta y seis"
 */
function speakTwoDigitPair(pairStr) {
  const s = String(pairStr).padStart(2, '0');
  if (s === '00') return 'cero cero';
  if (s[0] === '0') return `cero ${UNITS[Number(s[1])]}`;
  return numberToSpanish0to99(Number(s));
}

/**
 * Formatea un número de coche / interno para TTS natural en pares de dos dígitos:
 *  - "2976" -> "veintinueve setenta y seis"
 *  - "3035" -> "treinta treinta y cinco"
 *  - "4100" -> "cuarenta y uno cero cero"
 *  - "4122" -> "cuarenta y uno veintidós"
 *  - "2905" -> "veintinueve cero cinco"
 *  - "845"  -> "ocho cuarenta y cinco"
 */
export function formatCocheForTts(rawCoche) {
  const clean = String(rawCoche || '').replace(/^#/, '').trim();
  if (!clean) return '';

  const m = clean.match(/^(\d+)([A-Za-z]*)$/);
  if (!m) return clean;

  const digits = m[1];
  const suffix = m[2] ? ` ${m[2].toUpperCase()}` : '';

  if (digits.length === 4) {
    return `${speakTwoDigitPair(digits.slice(0, 2))} ${speakTwoDigitPair(digits.slice(2, 4))}${suffix}`;
  }
  if (digits.length === 3) {
    return `${UNITS[Number(digits[0])]} ${speakTwoDigitPair(digits.slice(1))}${suffix}`;
  }
  if (digits.length === 2) {
    return `${speakTwoDigitPair(digits)}${suffix}`;
  }
  if (digits.length === 1) {
    return `${UNITS[Number(digits)]}${suffix}`;
  }

  // 5+ dígitos: agrupar en pares desde la derecha (ej: 12976 -> "uno veintinueve setenta y seis")
  const parts = [];
  let rem = digits;
  if (rem.length % 2 === 1) {
    parts.push(UNITS[Number(rem[0])]);
    rem = rem.slice(1);
  }
  for (let i = 0; i < rem.length; i += 2) {
    parts.push(speakTwoDigitPair(rem.slice(i, i + 2)));
  }
  return `${parts.join(' ')}${suffix}`;
}

/**
 * Formatea el nombre de una línea ("106B", "904B", "902") para pronunciación natural en español.
 */
export function formatLineaForTts(rawLinea) {
  const clean = String(rawLinea || '').trim();
  if (!clean) return '';
  const m = clean.match(/^(\d{1,3})\s*([A-Za-z]*)$/);
  if (!m) return clean;
  const numWord = numberToSpanish0to999(Number(m[1]));
  const letter = m[2] ? ` ${m[2].toUpperCase()}` : '';
  return `${numWord}${letter}`;
}

const STOP_ABBREVS = [
  [/\bAVDA\.?(?=\s|$)/gi, 'Avenida'],
  [/\bAV\.?(?=\s|$)/gi, 'Avenida'],
  [/\bB[º°]\.?(?=\s|$)/gi, 'Barrio'],
  [/\bBO\.?(?=\s|$)/gi, 'Barrio'],
  [/\bPTE\.?(?=\s|$)/gi, 'Presidente'],
  [/\bPRES\.?(?=\s|$)/gi, 'Presidente'],
  [/\bGRAL\.?(?=\s|$)/gi, 'General'],
  [/\bDR\.?(?=\s|$)/gi, 'Doctor'],
  [/\bDRA\.?(?=\s|$)/gi, 'Doctora'],
  [/\bSTA\.?(?=\s|$)/gi, 'Santa'],
  [/\bSTO\.?(?=\s|$)/gi, 'Santo'],
  [/\bSGTO\.?(?=\s|$)/gi, 'Sargento'],
  [/\bTTE\.?(?=\s|$)/gi, 'Teniente'],
  [/\bCNEL\.?(?=\s|$)/gi, 'Coronel'],
  [/\bGDOR\.?(?=\s|$)/gi, 'Gobernador'],
  [/\bGOB\.?(?=\s|$)/gi, 'Gobernador'],
  [/\bPROF\.?(?=\s|$)/gi, 'Profesor'],
  [/\bING\.?(?=\s|$)/gi, 'Ingeniero'],
  [/\bPJE\.?(?=\s|$)/gi, 'Pasaje'],
  [/\bPZA\.?(?=\s|$)/gi, 'Plaza'],
  [/\bPLZA\.?(?=\s|$)/gi, 'Plaza'],
  [/\bHOSP\.?(?=\s|$)/gi, 'Hospital'],
  [/\bESC\.?(?=\s|$)/gi, 'Escuela'],
  [/\bFAC\.?(?=\s|$)/gi, 'Facultad'],
  [/\bBV\.?(?=\s|$)/gi, 'Bulevar'],
  [/\bRUTA\s+NAC\.?(?=\s|$)/gi, 'Ruta Nacional'],
  [/\bRUTA\s+PROV\.?(?=\s|$)/gi, 'Ruta Provincial'],
  [/\bUNNE\b/gi, 'Unne']
];

const LOWERCASE_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en', 'a', 'por', 'con', 'al']);

function toNaturalSpanishCase(str) {
  return String(str || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word, idx) => {
      // Preservar siglas cortas conocidas o números ordinales como 3ro, 25
      if (/^\d/.test(word)) return word;
      const lower = word.toLocaleLowerCase('es-AR');
      if (idx > 0 && LOWERCASE_CONNECTORS.has(lower)) return lower;
      return lower.charAt(0).toLocaleUpperCase('es-AR') + lower.slice(1);
    })
    .join(' ');
}

/**
 * Limpia y humaniza el nombre de una parada para TTS (pensado para personas no videntes):
 *  - "AV. PEDRO FERRÉ - BRASIL IDA" -> "Avenida Pedro Ferré y Brasil"
 *  - "Bº QUINTANA / GRAL. PAZ VTA"  -> "Barrio Quintana y General Paz"
 */
export function formatStopNameForTts(rawName) {
  let s = String(rawName || '').trim();
  if (!s) return 'próxima parada';

  // Quitar sufijos direccionales técnicos al final
  s = s.replace(/\s*\((?:IDA|VTA|VUELTA|REG|REGRESO)\)\s*$/i, '');
  s = s.replace(/\s+(?:IDA|VTA|VUELTA|REG|REGRESO)\s*$/i, '');

  // Separadores de esquina (" - ", " / ") -> " y "
  s = s.replace(/\s*[-–—/]\s*/g, ' y ');

  // Expandir abreviaturas viales frecuentes de Corrientes
  for (const [rx, rep] of STOP_ABBREVS) {
    s = s.replace(rx, rep);
  }

  s = s.replace(/\s+/g, ' ').trim();
  return toNaturalSpanishCase(s);
}

/**
 * Formatea un nombre de chofer en mayúsculas para que TTS lo lea de corrido y no deletreado.
 */
export function formatDriverForTts(rawName) {
  const s = String(rawName || '').trim();
  if (!s) return '';
  return toNaturalSpanishCase(s);
}

// ── Motor de síntesis de voz con espera posterior al timbre de notificación ──

let cachedVoices = [];
let pendingTimerId = null;

function refreshVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  try {
    const list = window.speechSynthesis.getVoices?.() || [];
    if (list.length > 0) cachedVoices = list;
  } catch {
    // ignore
  }
  return cachedVoices;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  refreshVoices();
  try {
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
  } catch {
    // ignore
  }
}

export function isSpeechSupported() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  );
}

export function cancelPendingSpeech() {
  if (pendingTimerId !== null) {
    clearTimeout(pendingTimerId);
    pendingTimerId = null;
  }
  if (isSpeechSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function speakText(text, { interrupt = true, rate = 1.02 } = {}) {
  if (!isSpeechSupported() || !text) return false;
  try {
    if (interrupt) {
      window.speechSynthesis.cancel();
    }
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'es-AR';
    u.rate = rate;
    u.pitch = 1.0;
    u.volume = 1.0;

    const voices = refreshVoices();
    const esVoice =
      voices.find((v) => /^es-AR/i.test(v.lang)) ||
      voices.find((v) => /^es-(UY|CL|419|MX|US|ES)/i.test(v.lang)) ||
      voices.find((v) => /^es/i.test(v.lang));
    if (esVoice) u.voice = esVoice;

    try {
      window.speechSynthesis.resume?.();
    } catch {
      // ignore
    }
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reproduce la locución TTS DESPUÉS del timbre de notificación del celular (o campanita),
 * evitando que el sonido de notificación tape el comienzo de la frase.
 */
export function speakAfterNotification(text, { delayMs = 950, interrupt = true, rate = 1.02 } = {}) {
  if (!isSpeechSupported() || !text) return false;
  if (pendingTimerId !== null) {
    clearTimeout(pendingTimerId);
    pendingTimerId = null;
  }
  const wait = Math.max(0, Number(delayMs) || 0);
  if (wait === 0) {
    return speakText(text, { interrupt, rate });
  }
  pendingTimerId = setTimeout(() => {
    pendingTimerId = null;
    speakText(text, { interrupt, rate });
  }, wait);
  return true;
}
