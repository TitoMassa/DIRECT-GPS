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
  '10002': 'AGUILAR BERNARDINO',
  '10007': 'CARDOZO OSVALDO LUIS',
  '10043': 'SOSA CHRISTIAN HUGO',
  '10128': 'ESTIGARRIBIA RAMON TOMAS',
  '10131': 'LOPEZ JUAN DOMINGO',
  '10132': 'MEDINA RAMON ALBERTO',
  '10139': 'RIOS LEONARDO RAMON',
  '10150': 'SANCHEZ FLORENCIO NICOLAS',
  '10162': 'LENCINA RAUL EDUARDO',
  '10164': 'MACIEL JUAN MANUEL',
  '10177': 'BAZANTI RICARDO DANIEL',
  '10181': 'ARAUJO CARLOS DANIEL',
  '10231': 'CANTERO TERENCIO DE JESUS',
  '10232': 'CARDOZO DIEGO',
  '10241': 'GAUNA OSCAR ENRIQUE',
  '10242': 'GIMENEZ MARIO JOSE',
  '10246': 'MAIDANA JORGE OSVALDO',
  '10248': 'PALOMO RAMON DE JESUS',
  '10304': 'DABRIO JUAN',
  '10340': 'MARINILLI JULIO CESAR',
  '10354': 'GONZALEZ CLAUDIO MARIA',
  '10400': 'FIGUEROA ALFREDO AGUSTIN',
  '10405': 'CARDOZO MARIO ROBERTO',
  '10413': 'PARRAS EDGARDO JUAN',
  '10463': 'DUARTE ANTONIO REGINO',
  '10469': 'FLORES ENZO RENE',
  '10477': 'ENRIQUEZ CLAUDIO SEBASTIAN',
  '10495': 'ROMERO ABEL',
  '10803': 'LENCINAS DIEGO WALTER',
  '10830': 'ARCE ROBERTO CARLOS',
  '10838': 'AQUINO MIGUEL ANGEL',
  '10853': 'GOMEZ ROBERTO WALDEMAR',
  '10880': 'ESCALANTE ADOLFO GUSTAVO',
  '10903': 'ACEVEDO NESTOR DAMIAN',
  '10907': 'ESCOBAR JESUS EMANUEL',
  '12040': 'NOVACK ADELAIDA AGNES',
  '12109': 'BARRIOS CLAUDIO ANDRES',
  '12114': 'BARRIOS JOSE ANTONIO',
  '12117': 'CABRAL RAFAEL FRANCISCO',
  '12119': 'BILLORDO EDUARDO MIGUEL',
  '12127': 'OLIVERA VICTOR RAFAEL',
  '12156': 'ESTIGARRIBIA MARTIN CIRIACO',
  '12163': 'GOMEZ RAMON ANIBAL',
  '12196': 'LEZCANO PABLO LISANDRO',
  '12218': 'TORREZ NESTOR JAVIER',
  '12222': 'VILLALBA DAMIAN EMANUEL',
  '12270': 'ALARCON DIEGO ESTEBAN',
  '12293': 'ORTIZ JULIAN ABEL',
  '12297': 'ESTIGARRIBIA WILLIAM MARTIN',
  '12311': 'SAUCEDO MATIAS SEBASTIAN',
  '12313': 'ENCINAS VICTOR SERGIO',
  '12314': 'LENCINA JOSE ROLANDO',
  '12318': 'VALDEZ GASTON NERY',
  '12333': 'CABRAL JONATHAN OMAR',
  '12338': 'GUTIERREZ RAMON ALFREDO',
  '12351': 'SOTO GERONIMO DE JESUS',
  '12353': 'AGUIRRE PEDRO OMAR',
  '12359': 'PORTO LISANDRO LUCAS',
  '12360': 'PUCHETA NELSON HERNAN',
  '13012': 'FRETE JOSE RICARDO',
  '13037': 'SOTO JOSE GUSTAVO',
  '13053': 'ACEVEDO HECTOR GERARDO',
  '13058': 'GAMBOA HECTOR LUIS',
  '13075': 'ROBLEDO WALTER AMILCAR',
  '13078': 'GAUNA CARLOS ADRIAN',
  '13082': 'SOTO HECTOR JOSE',
  '13110': 'QUIROGA ANTONIO OCTAVIO',
  '13111': 'MORALES VICENTE JAVIER',
  '13121': 'TONIANES MANUEL ALEJANDRO',
  '13145': 'GONZALEZ JUAN ANTONIO',
  '13155': 'RODRIGUEZ MAURO GABRIEL',
  '13177': 'ACEVEDO GUSTAVO ADOLFO',
  '13181': 'SANCHEZ PABLO MARTIN',
  '13182': 'SOTO DIEGO RAMON',
  '13336': 'GOMEZ JUAN ALBERTO',
  '13337': 'VILLAR MATIAS DANIEL',
  '13347': 'GALVEZ ALAN GASTON',
  '14009': 'BRAUVANO OSVALDO LUIS',
  '14034': 'PINTOS DANIEL ALEJANDRO',
  '14103': 'LENCINA LEON JESUS',
  '14104': 'BAZET RODRIGO SEBASTIAN',
  '14128': 'LANNUZZI HECTOR MIGUEL',
  '14141': 'CARDOZO GERARDO DAVID',
  '14164': 'BAEZ JOSE ANTONIO',
  '14172': 'BARRIOS CARLOS SEBASTIAN',
  '14183': 'BERNAL PEDRO ARMANDO',
  '19020': 'CANTEROS JUAN RAMON',
  '19034': 'ESPINOSA JORGE EULICES',
  '19059': 'AGUILAR JOSE CARLOS',
  '19060': 'TRIPIER JUAN LUIS',
  '19083': 'GOMES RAMON SERGIO',
  '19084': 'ESCOBAR ESTEBAN SIXTO',
  '19093': 'ROCH LUCAS MATIAS',
  '19105': 'MOLINA RODRIGO BELEN',
  '19125': 'LENCINAS CLAUDIO DANIEL',
  '19144': 'ERMOSI GONZALO ADRIAN',
  '19146': 'LEZCANO LUIS ALBERTO',
  '98508': 'GONZALEZ RUBEN OSCAR',
  '98510': 'BUIATTI PABLO ANTONIO',
  '98512': 'ORTIZ ANIBAL OSCAR',
  '98513': 'BENITEZ JOSE LUIS',
  '98514': 'GIMENEZ ARNALDO JAVIER',
  '98518': 'SANCHEZ RODRIGO ANTONIO',
  '98534': 'MIRANDA MARCOS CESAR',
  '98535': 'GIMENEZ MARCOS ANTONIO',
  '98540': 'IBARRA MAXIMILIANO ARIEL'
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

// Mapas 100% libres sin API key (comparten la misma caché offline de mosaicos OSM)
export const MAP_TILES = {
  osm: {
    id: 'osm',
    label: 'Claro',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    darkFilter: false
  },
  dark: {
    id: 'dark',
    label: 'Nocturno',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    darkFilter: true
  }
};
