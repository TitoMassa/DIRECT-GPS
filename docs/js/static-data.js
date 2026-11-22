// Client-side Corrientes Capital transit catalog & moving GPS telemetry engine
// Powers GitHub Pages static deployments seamlessly when no Node.js SmartMovePro proxy is attached.

export const STATIC_PILOT_STOP = {
  id: 'CT31498',
  codigo: '20129',
  nombre: 'AV. PEDRO FERRÉ - BRASIL IDA',
  nombreCorto: 'Av. Ferré y Brasil (Ida)',
  callePrincipal: 'AVENIDA PEDRO FERRÉ',
  calleInterseccion: 'BRASIL',
  lat: -27.476965,
  lng: -58.825184,
  lineas: ['102A', '102B', '102C', '106A', '106B', '106C', '904A'],
  esPiloto: true
};

export const STATIC_QUICK_STOPS = [
  STATIC_PILOT_STOP,
  {
    id: 'CT31942',
    codigo: '21770',
    nombre: 'AV. PEDRO FERRÉ - BRASIL VTA',
    nombreCorto: 'Av. Ferré y Brasil (Vuelta)',
    callePrincipal: 'AVENIDA PEDRO FERRÉ',
    calleInterseccion: 'BRASIL',
    lat: -27.477427,
    lng: -58.824951,
    lineas: ['102B', '102C', '106A', '106B', '106C']
  },
  {
    id: 'CT31941',
    codigo: '21769',
    nombre: 'AV. PEDRO FERRÉ - PARAGUAY VTA',
    nombreCorto: 'Av. Ferré y Paraguay (Vuelta)',
    callePrincipal: 'AVENIDA PEDRO FERRÉ',
    calleInterseccion: 'PARAGUAY',
    lat: -27.477142,
    lng: -58.827352,
    lineas: ['102B', '102C', '106A', '106B', '106C']
  },
  {
    id: 'CT31442',
    codigo: '20119',
    nombre: 'AV. INDEPENDENCIA - MEDRANO IDA',
    nombreCorto: 'Av. Independencia y Medrano (Ida)',
    callePrincipal: 'AV. INDEPENDENCIA',
    calleInterseccion: 'MEDRANO',
    lat: -27.481335,
    lng: -58.798447,
    lineas: ['102A', '102B', '102C', '106A', '106C']
  },
  {
    id: 'CT31581',
    codigo: '20145',
    nombre: '9 DE JULIO - CÓRDOBA',
    nombreCorto: '9 de Julio y Córdoba (Centro)',
    callePrincipal: '9 DE JULIO',
    calleInterseccion: 'CÓRDOBA',
    lat: -27.46858,
    lng: -58.83424,
    lineas: ['102B', '103A', '104A', '105A']
  }
];

export const STATIC_HUBS = [
  { name: 'Av. Ferré y Brasil (Piloto)', lat: -27.476965, lng: -58.825184, stopId: 'CT31498' },
  { name: 'Plaza 25 de Mayo / Centro', lat: -27.46485, lng: -58.83962 },
  { name: 'Puerto de Corrientes', lat: -27.46221, lng: -58.84274 },
  { name: 'Terminal de Ómnibus', lat: -27.48881, lng: -58.81722 },
  { name: 'Campus Deodoro Roca (UNNE)', lat: -27.46664, lng: -58.78241 },
  { name: 'Hospital Escuela', lat: -27.47582, lng: -58.83461 }
];

export const STATIC_LINEAS = [
  { codigo: 94, descripcion: '102A' },
  { codigo: 97, descripcion: '102B' },
  { codigo: 96, descripcion: '102C' },
  { codigo: 132, descripcion: '103A' },
  { codigo: 133, descripcion: '103B' },
  { codigo: 134, descripcion: '103C' },
  { codigo: 433, descripcion: '103D' },
  { codigo: 113, descripcion: '104A' },
  { codigo: 115, descripcion: '104B' },
  { codigo: 114, descripcion: '104C' },
  { codigo: 118, descripcion: '104D' },
  { codigo: 346, descripcion: '105A' },
  { codigo: 347, descripcion: '105B' },
  { codigo: 348, descripcion: '105C' },
  { codigo: 350, descripcion: '106A' },
  { codigo: 351, descripcion: '106B' },
  { codigo: 352, descripcion: '106C' },
  { codigo: 356, descripcion: '108A' },
  { codigo: 357, descripcion: '108C' },
  { codigo: 342, descripcion: '109A' },
  { codigo: 353, descripcion: '109B' },
  { codigo: 852, descripcion: '902' },
  { codigo: 1037, descripcion: '904A' },
  { codigo: 1038, descripcion: '904B' },
  { codigo: 1039, descripcion: '904C' },
  { codigo: 705, descripcion: 'SANTA ANA-INGENIO' }
];

const STATIC_CALLES = [
  { codigo: 7191, descripcion: 'AV. PEDRO FERRÉ - CORRIENTES' },
  { codigo: 7190, descripcion: 'AV. 3 DE ABRIL - CORRIENTES' },
  { codigo: 7195, descripcion: 'AV. INDEPENDENCIA - CORRIENTES' },
  { codigo: 7213, descripcion: '9 DE JULIO - CORRIENTES' },
  { codigo: 10052, descripcion: 'AV. CAZADORES CORRENTINOS - CORRIENTES' }
];

const STATIC_INTERSECCIONES = {
  '7191': [
    { codigo: 8101, descripcion: 'BRASIL - CORRIENTES' },
    { codigo: 8102, descripcion: 'PARAGUAY - CORRIENTES' },
    { codigo: 8103, descripcion: 'PERÚ - CORRIENTES' }
  ],
  '7213': [
    { codigo: 7214, descripcion: 'CÓRDOBA - CORRIENTES' },
    { codigo: 7189, descripcion: 'CATAMARCA - CORRIENTES' },
    { codigo: 7212, descripcion: 'SALTA - CORRIENTES' }
  ],
  default: [
    { codigo: 8101, descripcion: 'BRASIL - CORRIENTES' },
    { codigo: 8104, descripcion: 'MEDRANO - CORRIENTES' }
  ]
};

const CORRIDOR_POINTS = [
  { latitud: -27.489722, longitud: -58.781096 },
  { latitud: -27.48462, longitud: -58.79185 },
  { latitud: -27.481335, longitud: -58.798447 },
  { latitud: -27.47992, longitud: -58.80652 },
  { latitud: -27.47875, longitud: -58.81421 },
  { latitud: -27.47768, longitud: -58.82065 },
  { latitud: -27.476965, longitud: -58.825184 },
  { latitud: -27.47664, longitud: -58.82942 },
  { latitud: -27.47582, longitud: -58.83461 },
  { latitud: -27.47124, longitud: -58.83692 },
  { latitud: -27.46858, longitud: -58.83424 },
  { latitud: -27.46485, longitud: -58.83962 },
  { latitud: -27.46221, longitud: -58.84274 }
];

const APPROACH_PATH = [
  [-27.48412, -58.79215],
  [-27.48289, -58.79844],
  [-27.48134, -58.80512],
  [-27.47992, -58.81185],
  [-27.47875, -58.81762],
  [-27.47768, -58.82195],
  [-27.476965, -58.825184]
];

function interpolatePath(path, progress) {
  const clamped = Math.max(0, Math.min(1, progress));
  const scaled = clamped * (path.length - 1);
  const idx = Math.min(Math.floor(scaled), path.length - 2);
  const frac = scaled - idx;
  const [lat1, lng1] = path[idx];
  const [lat2, lng2] = path[idx + 1];
  return [
    +(lat1 + (lat2 - lat1) * frac).toFixed(6),
    +(lng1 + (lng2 - lng1) * frac).toFixed(6)
  ];
}

export function staticBootstrap() {
  return {
    pilotStop: STATIC_PILOT_STOP,
    quickStops: STATIC_QUICK_STOPS,
    hubs: STATIC_HUBS,
    lineas: STATIC_LINEAS,
    source: 'simulation'
  };
}

export function staticCalles() {
  return { data: STATIC_CALLES, source: 'simulation' };
}

export function staticIntersecciones(codCalle) {
  return {
    data: STATIC_INTERSECCIONES[String(codCalle)] || STATIC_INTERSECCIONES.default,
    source: 'simulation'
  };
}

export function staticParadas(codCalle, codInterseccion) {
  let list;
  if (String(codInterseccion) === '8101') {
    list = [
      {
        codigo: '20129',
        identificador: 'CT31498',
        descripcion: 'AV. PEDRO FERRÉ - BRASIL IDA',
        latitud: '-27.476965',
        longitud: '-58.825184'
      },
      {
        codigo: '21770',
        identificador: 'CT31942',
        descripcion: 'AV. PEDRO FERRÉ - BRASIL VTA',
        latitud: '-27.477427',
        longitud: '-58.824951'
      }
    ];
  } else if (String(codInterseccion) === '8102') {
    list = [
      {
        codigo: '21769',
        identificador: 'CT31941',
        descripcion: 'AV. PEDRO FERRÉ - PARAGUAY VTA',
        latitud: '-27.477142',
        longitud: '-58.827352'
      }
    ];
  } else if (String(codCalle) === '7213') {
    list = [
      {
        codigo: '20145',
        identificador: 'CT31581',
        descripcion: '9 DE JULIO - CÓRDOBA',
        latitud: '-27.46858',
        longitud: '-58.83424'
      }
    ];
  } else {
    list = [
      {
        codigo: '20129',
        identificador: 'CT31498',
        descripcion: 'AV. PEDRO FERRÉ - BRASIL IDA',
        latitud: '-27.476965',
        longitud: '-58.825184'
      }
    ];
  }
  return { data: list, source: 'simulation' };
}

export function staticParadasCercanas() {
  return {
    data: STATIC_QUICK_STOPS.map((s) => ({
      codigo: s.codigo,
      identificador: s.id,
      descripcion: s.nombre,
      callePrincipal: s.callePrincipal,
      calleInterseccion: s.calleInterseccion,
      latitud: String(s.lat),
      longitud: String(s.lng),
      lineas: `Líneas: ${s.lineas.join(', ')}`
    })),
    source: 'simulation'
  };
}

export function staticRecorridos(codLinea) {
  const linea = STATIC_LINEAS.find((l) => String(l.codigo) === String(codLinea));
  const desc = linea ? linea.descripcion : `Línea ${codLinea}`;
  return {
    data: [
      {
        abreviaturaBanderaSMP: `${desc} · CORREDOR AV. FERRÉ - PUERTO`,
        descripcion: `${desc} Corredor Av. Independencia - Av. Ferré - Centro`,
        puntos: CORRIDOR_POINTS,
        paradas: STATIC_QUICK_STOPS.map((s) => ({
          codigo: s.codigo,
          identificador: s.id,
          descripcion: s.nombre,
          latitudParada: String(s.lat),
          longitudParada: String(s.lng)
        }))
      }
    ],
    source: 'simulation'
  };
}

export function staticArribos(idParada = 'CT31498', codLinea = '000') {
  const stop = STATIC_QUICK_STOPS.find((s) => s.id === idParada) || STATIC_PILOT_STOP;
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const gpsStamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const fleet = [
    { codigoLinea: 351, descripcionLinea: '106B', descripcionBandera: 'BARRIO NUEVO-PUERTO', cartel: 'B. NUEVO AL PUERTO', coche: '2967', chofer: 'TOLEDO L.', legajo: '10465', desvio: '-01:20', cycleSec: 360, offsetSec: 305, esAdaptado: false },
    { codigoLinea: 350, descripcionLinea: '106A', descripcionBandera: 'PIRAYUI - PUERTO', cartel: 'PIRAYUI - PUERTO', coche: '3163', chofer: 'FIGUEROA A.', legajo: '10400', desvio: '-02:20', cycleSec: 420, offsetSec: 270, esAdaptado: true },
    { codigoLinea: 352, descripcionLinea: '106C', descripcionBandera: '500 VIVIENDAS SUR HACIA PUERTO', cartel: '500VIV SUR - PUERTO', coche: '3035', chofer: 'LOPEZ J.', legajo: '10131', desvio: '+02:00', cycleSec: 480, offsetSec: 225, esAdaptado: false },
    { codigoLinea: 97, descripcionLinea: '102B', descripcionBandera: 'LAGUNA SECA - PUERTO', cartel: 'LAGUNA SECA - PUERTO', coche: '4040', chofer: 'COCOMAROLA E.', legajo: '10008', desvio: '-03:33', cycleSec: 540, offsetSec: 175, esAdaptado: true },
    { codigoLinea: 1037, descripcionLinea: '904A', descripcionBandera: 'CAMPUS - TERMINAL RCI', cartel: 'CAMPUS - CHACO', coche: '2814', chofer: 'GOMEZ R.', legajo: '10294', desvio: '+00:45', cycleSec: 600, offsetSec: 120, esAdaptado: true },
    { codigoLinea: 96, descripcionLinea: '102C', descripcionBandera: 'B° LAGUNA BRAVA - CENTRO', cartel: 'LAGUNA BRAVA - CENTRO', coche: '3912', chofer: 'SANCHEZ M.', legajo: '10512', desvio: '00:00', cycleSec: 660, offsetSec: 80, esAdaptado: false }
  ];

  const isAll = !codLinea || codLinea === '0' || codLinea === '000';
  const offsetLat = stop.lat - STATIC_PILOT_STOP.lat;
  const offsetLng = stop.lng - STATIC_PILOT_STOP.lng;

  const arribos = fleet
    .filter((bus) => isAll || String(bus.codigoLinea) === String(codLinea))
    .map((bus) => {
      const elapsed = (nowSec + bus.offsetSec) % bus.cycleSec;
      const progress = elapsed / bus.cycleSec;
      const remainingMin = Math.max(1, Math.round(((1 - progress) * bus.cycleSec) / 60));
      const [baseLat, baseLng] = interpolatePath(APPROACH_PATH, progress);
      return {
        codigoLinea: bus.codigoLinea,
        tiempoRestanteArribo: remainingMin <= 1 ? 'Llegando' : `${remainingMin} min. aprox.`,
        descripcionLinea: bus.descripcionLinea,
        descripcionBandera: bus.descripcionBandera,
        descripcionCortaBandera: bus.descripcionBandera,
        descripcionCartelBandera: bus.cartel,
        esAdaptado: bus.esAdaptado,
        latitud: String(+(baseLat + offsetLat).toFixed(6)),
        longitud: String(+(baseLng + offsetLng).toFixed(6)),
        latitudParada: String(stop.lat),
        longitudParada: String(stop.lng),
        esLleno: false,
        identificadorCoche: bus.coche,
        identificadorChofer: `${bus.chofer} (${bus.legajo})`,
        choferNombre: bus.chofer,
        choferLegajo: bus.legajo,
        desvioHorario: bus.desvio,
        ultimaFechaHoraGPS: gpsStamp,
        mensajeError: ''
      };
    });

  arribos.sort((a, b) => {
    const ma = a.tiempoRestanteArribo === 'Llegando' ? 0 : parseInt(a.tiempoRestanteArribo, 10) || 99;
    const mb = b.tiempoRestanteArribo === 'Llegando' ? 0 : parseInt(b.tiempoRestanteArribo, 10) || 99;
    return ma - mb;
  });

  return {
    data: {
      arribos,
      idParada: stop.id,
      codLinea: isAll ? '000' : String(codLinea),
      stopCoords: { lat: stop.lat, lng: stop.lng },
      simulated: true,
      parada: stop
    },
    source: 'simulation'
  };
}
