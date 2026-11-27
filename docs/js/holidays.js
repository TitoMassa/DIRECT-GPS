/**
 * Calendario de feriados nacionales de Argentina y feriados locales de Corrientes Capital
 * para anticipar el diagrama de servicio (Domingo/Feriado) en días futuros (+1 a +7 días)
 * e históricos, complementando la detección en vivo por SOAP.
 */

// Feriados nacionales fijos (MM-DD)
const FIXED_NATIONAL_HOLIDAYS = {
  '01-01': 'Año Nuevo',
  '03-24': 'Día de la Memoria por la Verdad y la Justicia',
  '04-02': 'Día del Veterano y de los Caídos en Malvinas',
  '05-01': 'Día del Trabajador',
  '05-25': 'Día de la Revolución de Mayo',
  '06-20': 'Paso a la Inmortalidad del Gral. Belgrano',
  '07-09': 'Día de la Independencia',
  '12-08': 'Inmaculada Concepción de María',
  '12-25': 'Navidad'
};

// Feriados locales/provinciales fijos en Corrientes Capital (afectan transporte urbano)
const FIXED_CORRIENTES_HOLIDAYS = {
  '04-03': 'Fundación de Corrientes',
  '05-03': 'Día de la Cruz de los Milagros',
  '07-16': 'Coronación Pontificia de la Virgen de Itatí',
  '09-24': 'Nuestra Señora de la Merced (Patrona de Corrientes)'
};

// Feriados trasladables y puentes oficiales conocidos (YYYY-MM-DD)
const SPECIFIC_YEAR_HOLIDAYS = {
  // 2025
  '2025-05-02': 'Día no laborable con fines turísticos',
  '2025-06-16': 'Paso a la Inmortalidad del Gral. Güemes',
  '2025-08-15': 'Día no laborable con fines turísticos',
  '2025-08-17': 'Paso a la Inmortalidad del Gral. San Martín',
  '2025-10-12': 'Día del Respeto a la Diversidad Cultural',
  '2025-11-21': 'Día no laborable con fines turísticos',
  '2025-11-24': 'Día de la Soberanía Nacional',
  // 2026
  '2026-03-23': 'Día no laborable con fines turísticos',
  '2026-06-15': 'Paso a la Inmortalidad del Gral. Güemes',
  '2026-07-10': 'Día no laborable con fines turísticos',
  '2026-08-17': 'Paso a la Inmortalidad del Gral. San Martín',
  '2026-10-12': 'Día del Respeto a la Diversidad Cultural',
  '2026-11-23': 'Día de la Soberanía Nacional',
  '2026-12-07': 'Día no laborable con fines turísticos',
  // 2027
  '2027-06-21': 'Paso a la Inmortalidad del Gral. Güemes',
  '2027-08-16': 'Paso a la Inmortalidad del Gral. San Martín',
  '2027-10-11': 'Día del Respeto a la Diversidad Cultural',
  '2027-11-22': 'Día de la Soberanía Nacional',
  // 2028
  '2028-06-19': 'Paso a la Inmortalidad del Gral. Güemes',
  '2028-08-21': 'Paso a la Inmortalidad del Gral. San Martín',
  '2028-10-16': 'Día del Respeto a la Diversidad Cultural',
  '2028-11-20': 'Día de la Soberanía Nacional'
};

/**
 * Calcula el Domingo de Pascua gregoriano (algoritmo anónimo de Meeus/Jones/Butcher).
 * Permite calcular Carnaval (-48/-47 días) y Viernes Santo (-2 días) para cualquier año.
 */
function computeEasterUtcMs(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

function isoFromUtcMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

const movableCache = new Map();

function getMovableHolidaysForYear(year) {
  if (movableCache.has(year)) return movableCache.get(year);
  const easterMs = computeEasterUtcMs(year);
  const dayMs = 86400 * 1000;
  const map = {
    [isoFromUtcMs(easterMs - 48 * dayMs)]: 'Carnaval (Lunes)',
    [isoFromUtcMs(easterMs - 47 * dayMs)]: 'Carnaval (Martes)',
    [isoFromUtcMs(easterMs - 2 * dayMs)]: 'Viernes Santo'
  };
  movableCache.set(year, map);
  return map;
}

/**
 * Devuelve información de feriado para una fecha `YYYY-MM-DD`, o `null` si es día común.
 * @param {string} dayKey
 * @returns {{ name: string, scope: 'nacional'|'corrientes', suggestedTipo: 'domingo'|'sabado' } | null}
 */
export function getHolidayInfo(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const mmdd = `${m[2]}-${m[3]}`;

  if (FIXED_NATIONAL_HOLIDAYS[mmdd]) {
    return { name: FIXED_NATIONAL_HOLIDAYS[mmdd], scope: 'nacional', suggestedTipo: 'domingo' };
  }
  const movable = getMovableHolidaysForYear(year);
  if (movable[dayKey]) {
    return { name: movable[dayKey], scope: 'nacional', suggestedTipo: 'domingo' };
  }
  if (SPECIFIC_YEAR_HOLIDAYS[dayKey]) {
    const name = SPECIFIC_YEAR_HOLIDAYS[dayKey];
    const isBridge = /turísticos|no laborable/i.test(name);
    return { name, scope: 'nacional', suggestedTipo: isBridge ? 'sabado' : 'domingo' };
  }
  if (FIXED_CORRIENTES_HOLIDAYS[mmdd]) {
    return { name: FIXED_CORRIENTES_HOLIDAYS[mmdd], scope: 'corrientes', suggestedTipo: 'domingo' };
  }
  return null;
}

/**
 * Resuelve el tipo de día calendario (`habil` | `sabado` | `domingo`) contemplando feriados
 * nacionales y locales de Corrientes.
 */
export function getCalendarTipoDiaWithHolidays(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || '').trim());
  if (!m) return { tipo: 'habil', holiday: null };
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  const dow = dt.getUTCDay();
  const holiday = getHolidayInfo(dayKey);
  if (dow === 0) return { tipo: 'domingo', holiday };
  if (holiday) return { tipo: holiday.suggestedTipo, holiday };
  if (dow === 6) return { tipo: 'sabado', holiday: null };
  return { tipo: 'habil', holiday: null };
}
