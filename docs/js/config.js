export const CORRIENTES_CENTER = {
  lat: -27.4712,
  lng: -58.8322,
  zoom: 13
};

export const REFRESH_INTERVAL_SEC = 10;

// Backend proxy SOAP gratuito desplegado en Cloudflare Workers
export const DEFAULT_API_BASE = 'https://direct-gps-proxy.tecladotropical.workers.dev';

// Líneas inactivas eliminadas permanentemente del sistema
export const REMOVED_LINE_CODES = new Set([517, 607, 608, 744, 851, 853, 854]);

// Nombres públicos definitivos por código interno SmartMovePro
export const LINE_NAME_OVERRIDES = {
  433: '103D',
  705: '109C',
  852: '902'
};

export function normalizePublicLineName(codLinea, fallback = '') {
  const n = Number(codLinea);
  if (LINE_NAME_OVERRIDES[n]) return LINE_NAME_OVERRIDES[n];
  return String(fallback || '').trim();
}

// Nombres visibles definitivos de choferes por legajo
export const DRIVER_NAME_OVERRIDES = {
  '14172': 'BARRIOS CARLOS SEBASTIAN',
  '12360': 'PUCHETA NELSON HERNAN',
  '10304': 'DABRIO JUAN',
  '98535': 'GIMENEZ MARCOS ANTONIO',
  '98514': 'GIMENEZ ARNALDO JAVIER',
  '10242': 'GIMENEZ MARIO JOSE',
  '10880': 'ESCALANTE ADOLFO GUSTAVO',
  '13347': 'GALVEZ ALAN GASTON',
  '10413': 'PARRAS EDGARDO JUAN',
  '12222': 'VILLALBA DAMIAN EMANUEL',
  '10903': 'ACEVEDO NESTOR DAMIAN',
  '98534': 'MIRANDA MARCOS CESAR',
  '98513': 'BENITEZ JOSE LUIS',
  '10830': 'ARCE ROBERTO CARLOS',
  '12359': 'PORTO LISANDRO LUCAS',
  '98540': 'IBARRA MAXIMILIANO ARIEL',
  '13337': 'VILLAR MATIAS DANIEL',
  '13177': 'ACEVEDO GUSTAVO ADOLFO',
  '98512': 'ORTIZ ANIBAL OSCAR',
  '10853': 'GOMEZ ROBERTO WALDEMAR',
  '14128': 'LANNUZZI HECTOR MIGUEL',
  '12109': 'BARRIOS CLAUDIO ANDRES',
  '10231': 'CANTERO TERENCIO DE JESUS',
  '19060': 'TRIPIER JUAN LUIS',
  '10164': 'MACIEL JUAN MANUEL',
  '10128': 'ESTIGARRIBIA RAMON TOMAS',
  '10246': 'MAIDANA JORGE OSVALDO',
  '10340': 'MARINILLI JULIO CESAR',
  '14034': 'PINTOS DANIEL ALEJANDRO',
  '10463': 'DUARTE ANTONIO REGINO',
  '10043': 'SOSA CHRISTIAN HUGO',
  '19020': 'CANTEROS JUAN RAMON'
};

export function resolveDriverDisplayInfo(choferLegajo = '', choferNombre = '', choferRaw = '') {
  let leg = String(choferLegajo || '').trim();
  const nom = String(choferNombre || '').trim();
  const raw = String(choferRaw || '').trim();

  if (!leg && raw) {
    const rm = raw.match(/\(\s*([^)]+)\s*\)\s*$/);
    if (rm) leg = rm[1].trim();
  }

  const lookupOverride = (candidate) => {
    const clean = String(candidate || '').trim();
    if (!clean) return null;
    if (DRIVER_NAME_OVERRIDES[clean]) return { leg: clean, nombre: DRIVER_NAME_OVERRIDES[clean] };
    const noZero = clean.replace(/^0+/, '');
    if (noZero && DRIVER_NAME_OVERRIDES[noZero]) return { leg: noZero, nombre: DRIVER_NAME_OVERRIDES[noZero] };
    return null;
  };

  const byLeg = lookupOverride(leg);
  if (byLeg) return { nombre: byLeg.nombre, legajo: leg || byLeg.leg };

  if (nom) {
    const m = nom.match(/^(?:Legajo\s+)?0*(\d+)$/i) || nom.match(/\(\s*0*(\d+)\s*\)\s*$/);
    if (m) {
      const byNameId = lookupOverride(m[1]);
      if (byNameId) return { nombre: byNameId.nombre, legajo: leg || byNameId.leg };
    }
  }

  if (raw && !nom) {
    const m = raw.match(/^(?:Legajo\s+)?0*(\d+)$/i) || raw.match(/\(\s*0*(\d+)\s*\)\s*$/);
    if (m) {
      const byRawId = lookupOverride(m[1]);
      if (byRawId) return { nombre: byRawId.nombre, legajo: leg || byRawId.leg };
    }
  }

  return { nombre: nom, legajo: leg };
}

export function resolveDriverDisplayName(choferLegajo = '', choferNombre = '', choferRaw = '') {
  return resolveDriverDisplayInfo(choferLegajo, choferNombre, choferRaw).nombre;
}

// Distinct, high-contrast civic transit palette by Corrientes line family
const FAMILY_COLORS = {
  '102': '#0284c7', // Corrientes River Blue
  '103': '#0d9488', // Paraná Teal
  '104': '#d97706', // Transit Amber
  '105': '#e11d48', // Civic Crimson
  '106': '#059669', // Signal Emerald
  '108': '#ea580c', // Terracotta Orange
  '109': '#2563eb', // Cobalt Blue
  '902': '#0284c7', // Interprovincial Chaco-Corrientes Blue
  '904': '#0891b2'  // Interprovincial Cyan (Corrientes-Chaco)
};

const BRANCH_OVERRIDES = {
  '102A': '#0284c7',
  '102B': '#0369a1',
  '102C': '#0ea5e9',
  '103A': '#0d9488',
  '103B': '#0f766e',
  '103C': '#14b8a6',
  '103D': '#16a34a',
  '104A': '#d97706',
  '104B': '#b45309',
  '104C': '#f59e0b',
  '104D': '#ca8a04',
  '105A': '#e11d48',
  '105B': '#be123c',
  '105C': '#f43f5e',
  '106A': '#059669',
  '106B': '#047857',
  '106C': '#10b981',
  '108A': '#ea580c',
  '108C': '#c2410c',
  '109A': '#2563eb',
  '109B': '#1d4ed8',
  '109C': '#dc2626',
  '902': '#0284c7',
  '904A': '#0891b2',
  '904B': '#0e7490',
  '904C': '#06b6d4'
};

export function getLineColor(lineName = '') {
  const clean = String(lineName).trim().toUpperCase();
  if (BRANCH_OVERRIDES[clean]) return BRANCH_OVERRIDES[clean];
  const prefix = clean.slice(0, 3);
  if (FAMILY_COLORS[prefix]) return FAMILY_COLORS[prefix];
  return '#0284c7';
}

// Distinct high-contrast colors per route direction (IDA vs VTA / multi-branch)
export const DIRECTION_COLORS = ['#0ea5e9', '#f59e0b', '#a855f7', '#10b981', '#ec4899', '#ef4444'];

export function getDirectionColor(branchIndex = 0) {
  const idx = Math.abs(Number(branchIndex) || 0);
  return DIRECTION_COLORS[idx % DIRECTION_COLORS.length];
}

// Mapa único: OpenStreetMap detalle (100% libre, sin API key)
export const MAP_TILES = {
  osm: {
    id: 'osm',
    label: 'OSM Detalle',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    darkFilter: false
  }
};
