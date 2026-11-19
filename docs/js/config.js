export const PILOT_STOP_DEFAULT = {
  id: 'CT31498',
  codigo: '20129',
  nombre: 'AV. PEDRO FERRÉ - BRASIL IDA',
  callePrincipal: 'AVENIDA PEDRO FERRÉ',
  calleInterseccion: 'BRASIL',
  lat: -27.476965,
  lng: -58.825184,
  lineas: ['102A', '102B', '102C', '106A', '106B', '106C', '904A'],
  esPiloto: true
};

export const REFRESH_INTERVAL_SEC = 15;

// Distinct, high-contrast civic transit palette by Corrientes line family
const FAMILY_COLORS = {
  '102': '#0284c7', // Corrientes River Blue
  '103': '#0d9488', // Paraná Teal
  '104': '#d97706', // Transit Amber
  '105': '#e11d48', // Civic Crimson
  '106': '#059669', // Signal Emerald
  '108': '#ea580c', // Terracotta Orange
  '109': '#2563eb', // Cobalt Blue
  '904': '#0891b2', // Interprovincial Cyan (Corrientes-Chaco)
  AER: '#ca8a04',   // Airport Gold
  RIA: '#16a34a',   // Riachuelo Green
  SAN: '#dc2626'    // Santa Ana Red
};

// Subtle shade shifts for branch variants (A/B/C/D) so 102A/102B/102C stay visually distinct
const BRANCH_OVERRIDES = {
  '102A': '#0284c7',
  '102B': '#0369a1',
  '102C': '#0ea5e9',
  '103A': '#0d9488',
  '103B': '#0f766e',
  '103C': '#14b8a6',
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

export const MAP_TILES = {
  dark: {
    id: 'dark',
    label: 'Nocturno',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  },
  light: {
    id: 'light',
    label: 'Día',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19
  },
  satellite: {
    id: 'satellite',
    label: 'Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri World Imagery',
    maxZoom: 19
  }
};
