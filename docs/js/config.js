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
