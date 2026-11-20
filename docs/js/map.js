import { CORRIENTES_CENTER, MAP_TILES, getLineColor, getDirectionColor } from './config.js';
import { formatDistance } from './api.js';

export class TransitMap {
  constructor(containerId, { onBusSelect, onStopPick } = {}) {
    this.onBusSelect = onBusSelect || (() => {});
    this.onStopPick = onStopPick || (() => {});

    this.map = L.map(containerId, {
      center: [CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng],
      zoom: CORRIENTES_CENTER.zoom,
      zoomControl: false,
      attributionControl: true
    });

    this.tileKey = 'dark';
    this.tileLayer = null;
    this.setTileStyle('dark');

    // Layers
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.routeStopsLayer = L.layerGroup().addTo(this.map);
    this.nearbyLayer = L.layerGroup().addTo(this.map);
    this.vectorLayer = L.layerGroup().addTo(this.map);
    this.stopLayer = L.layerGroup().addTo(this.map);
    this.busLayer = L.layerGroup().addTo(this.map);
    this.userLayer = L.layerGroup().addTo(this.map);

    this.busMarkers = new Map(); // busKey -> { marker, lat, lng, data }
    this.stopMarker = null;
    this.activeStopCoords = null;
    this.selectedBusKey = null;
  }

  _getPadding() {
    const isMobile = window.innerWidth <= 860;
    if (isMobile) {
      const dock = document.getElementById('transit-dock');
      const bottomPad = dock?.classList.contains('sheet-peek')
        ? 180
        : Math.round(window.innerHeight * 0.5);
      return {
        paddingTopLeft: [20, 72],
        paddingBottomRight: [20, bottomPad]
      };
    }
    return {
      paddingTopLeft: [430, 84],
      paddingBottomRight: [68, 52]
    };
  }

  setTileStyle(styleKey) {
    const cfg = MAP_TILES[styleKey] || MAP_TILES.dark;
    const prevUrl = this.tileLayer ? this.tileLayer._url : null;
    this.tileKey = cfg.id;

    if (!this.tileLayer || prevUrl !== cfg.url) {
      if (this.tileLayer) {
        this.map.removeLayer(this.tileLayer);
      }
      this.tileLayer = L.tileLayer(cfg.url, {
        attribution: cfg.attribution,
        maxZoom: cfg.maxZoom
      }).addTo(this.map);
    }

    const tilePane = this.map.getPane('tilePane');
    if (tilePane) {
      tilePane.classList.toggle('osm-dark-filter', Boolean(cfg.darkFilter));
    }
    return cfg;
  }

  cycleTileStyle() {
    const order = ['dark', 'light', 'hot'];
    const next = order[(order.indexOf(this.tileKey) + 1) % order.length];
    return this.setTileStyle(next);
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
  }

  getCenter() {
    const c = this.map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  resetViewToCity() {
    this.map.setView([CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng], CORRIENTES_CENTER.zoom, { animate: true });
  }

  clearActiveStop() {
    this.stopLayer.clearLayers();
    this.busLayer.clearLayers();
    this.vectorLayer.clearLayers();
    this.busMarkers.clear();
    this.stopMarker = null;
    this.activeStopCoords = null;
    this.selectedBusKey = null;
  }

  setActiveStop(stop) {
    this.stopLayer.clearLayers();
    if (!stop || typeof stop.lat !== 'number' || typeof stop.lng !== 'number') {
      this.activeStopCoords = null;
      return;
    }
    this.activeStopCoords = { lat: stop.lat, lng: stop.lng };

    const icon = L.divIcon({
      className: 'stop-beacon-leaflet',
      html: `
        <div class="stop-beacon-wrap">
          <span class="stop-beacon-ring"></span>
          <span class="stop-beacon-ring delay"></span>
          <span class="stop-beacon-core"></span>
        </div>
      `,
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });

    this.stopMarker = L.marker([stop.lat, stop.lng], { icon, zIndexOffset: 700 })
      .addTo(this.stopLayer)
      .bindTooltip(`<strong>${stop.id}</strong> · ${stop.nombre}`, {
        direction: 'top',
        offset: [0, -16]
      });
  }

  focusStop(zoom = 15) {
    if (!this.activeStopCoords) {
      this.resetViewToCity();
      return;
    }
    const { lat, lng } = this.activeStopCoords;
    this.map.fitBounds(
      L.latLngBounds([
        [lat - 0.004, lng - 0.004],
        [lat + 0.004, lng + 0.004]
      ]),
      { ...this._getPadding(), maxZoom: zoom, animate: true }
    );
  }

  _animateMarker(marker, fromLatLng, toLatLng, duration = 1100) {
    const token = (marker._animToken || 0) + 1;
    marker._animToken = token;
    const start = performance.now();
    const dLat = toLatLng[0] - fromLatLng.lat;
    const dLng = toLatLng[1] - fromLatLng.lng;
    if (Math.abs(dLat) < 1e-6 && Math.abs(dLng) < 1e-6) return;

    const step = (now) => {
      if (marker._animToken !== token) return;
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      marker.setLatLng([fromLatLng.lat + dLat * eased, fromLatLng.lng + dLng * eased]);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _buildBusIcon(bus, { selected, dimmed }) {
    const color = getLineColor(bus.descripcionLinea);
    const cls = ['bus-marker-wrap'];
    if (selected) cls.push('is-selected');
    if (dimmed) cls.push('is-dimmed');
    if (bus.isPredicted || bus.gpsLost) cls.push('is-predicted');

    const etaShort = bus.eta.minutes === 0 ? 'YA' : `${bus.eta.display}'`;
    const cocheHtml = bus.identificadorCoche
      ? `<span class="bus-pill-coche">${bus.identificadorCoche}</span>`
      : '';
    const dotHtml =
      bus.desvio && bus.desvio.status !== 'none'
        ? `<span class="bus-desvio-dot ${bus.desvio.status}"></span>`
        : bus.isPredicted || bus.gpsLost
          ? `<span class="bus-desvio-dot pred"></span>`
          : '';

    return L.divIcon({
      className: 'bus-leaflet-icon',
      html: `
        <div class="${cls.join(' ')}" style="--bus-color:${color}">
          <div class="bus-pill-marker">
            ${dotHtml}
            <span>${bus.descripcionLinea}</span>
            ${cocheHtml}
            <span class="bus-pill-eta">${etaShort}</span>
          </div>
          <div class="bus-heading-dot"></div>
        </div>
      `,
      iconSize: [122, 36],
      iconAnchor: [61, 34]
    });
  }

  // Zero-lag 30fps position-only update for smooth simulation (no setIcon / no DOM rebuild!)
  moveBusPositionsFast(buses) {
    for (const bus of buses) {
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      const entry = this.busMarkers.get(bus.key);
      if (!entry) continue;
      entry.marker._animToken = (entry.marker._animToken || 0) + 1;
      entry.marker.setLatLng([bus.lat, bus.lng]);
      entry.data = bus;
    }
  }

  updateBuses(buses, { filterLine = 'ALL', selectedBusKey = null, simulateMode = false } = {}) {
    this.selectedBusKey = selectedBusKey;
    const incomingKeys = new Set();

    // STRICT LINE FILTER: When a single line is selected, completely omit all other lines from Leaflet!
    const visibleBuses =
      filterLine === 'ALL' ? buses : buses.filter((b) => b.descripcionLinea === filterLine);

    const primaryKeys = new Set(visibleBuses.filter((b) => !b.isNextLap).map((b) => b.key));

    for (const bus of visibleBuses) {
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      // Same physical bus on a later lap (`Sig. vuelta`): never plot a duplicate marker on the map!
      if (bus.isNextLap && bus.nextLapOfKey && primaryKeys.has(bus.nextLapOfKey)) continue;
      incomingKeys.add(bus.key);

      const isSelected = bus.key === selectedBusKey;
      const icon = this._buildBusIcon(bus, { selected: isSelected, dimmed: false });

      const existing = this.busMarkers.get(bus.key);
      if (existing) {
        if (simulateMode) {
          // Cancel any live-mode tween; BusSimulator already reconciled position continuously with 0 backjumps!
          existing.marker._animToken = (existing.marker._animToken || 0) + 1;
          existing.marker.setLatLng([bus.lat, bus.lng]);
        } else {
          const curPos = existing.marker.getLatLng();
          this._animateMarker(existing.marker, curPos, [bus.lat, bus.lng], 750);
        }
        existing.marker.setIcon(icon);
        existing.marker.setZIndexOffset(isSelected ? 1000 : 500);
        existing.data = bus;
      } else {
        const marker = L.marker([bus.lat, bus.lng], {
          icon,
          zIndexOffset: isSelected ? 1000 : 500
        }).addTo(this.busLayer);

        marker.on('click', () => {
          this.onBusSelect(bus.key);
        });

        this.busMarkers.set(bus.key, { marker, data: bus });
      }
    }

    // Remove hidden or departed buses completely from the Leaflet layer
    for (const [key, entry] of this.busMarkers.entries()) {
      if (!incomingKeys.has(key)) {
        this.busLayer.removeLayer(entry.marker);
        this.busMarkers.delete(key);
      }
    }

    const focused = selectedBusKey ? this.busMarkers.get(selectedBusKey)?.data : null;
    this.drawFocusVector(focused);
  }

  drawFocusVector(bus) {
    this.vectorLayer.clearLayers();
    if (!bus || !this.activeStopCoords || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') {
      return;
    }

    const fallbackColor = bus.realBanderaColor || getLineColor(bus.descripcionLinea);
    const segments = Array.isArray(bus.trajectory?.segments) && bus.trajectory.segments.length > 0
      ? bus.trajectory.segments
      : null;

    let allPts;
    if (segments) {
      allPts = [];
      segments.forEach((seg, idx) => {
        if (!Array.isArray(seg.pts) || seg.pts.length < 2) return;
        allPts.push(...seg.pts);
        const segColor = seg.color || fallbackColor;
        L.polyline(seg.pts, {
          color: '#0b1017',
          weight: idx === 0 ? 6.5 : 5,
          opacity: 0.45
        }).addTo(this.vectorLayer);

        L.polyline(seg.pts, {
          color: segColor,
          weight: idx === 0 ? 4 : 3,
          opacity: idx === 0 ? 0.94 : 0.72,
          dashArray: idx === 0 ? null : '7, 6'
        }).addTo(this.vectorLayer);
      });
    } else {
      const hasRealPath = bus.trajectory && Array.isArray(bus.trajectory.pathPts) && bus.trajectory.pathPts.length >= 2;
      allPts = hasRealPath
        ? bus.trajectory.pathPts
        : [
            [bus.lat, bus.lng],
            [this.activeStopCoords.lat, this.activeStopCoords.lng]
          ];

      L.polyline(allPts, {
        color: fallbackColor,
        weight: 3.5,
        opacity: 0.88
      }).addTo(this.vectorLayer);
    }

    const displayDist = bus.routeMeters ?? bus.distanceMeters;
    if (displayDist !== null && displayDist !== undefined && allPts.length > 0) {
      const midPt = allPts[Math.floor(allPts.length / 2)];
      L.marker(midPt, {
        interactive: false,
        icon: L.divIcon({
          className: 'dist-mid-icon',
          html: `<div class="distance-label-pill">${formatDistance(displayDist)}</div>`,
          iconSize: [78, 24],
          iconAnchor: [39, 12]
        })
      }).addTo(this.vectorLayer);
    }
  }

  focusBus(bus, zoom = 16) {
    if (!bus || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') return;
    const targetZoom = Math.max(zoom, Math.min(17, this.map.getZoom()));
    const pad = this._getPadding();
    const targetPt = this.map.project([bus.lat, bus.lng], targetZoom);
    const offsetX = (pad.paddingBottomRight[0] - pad.paddingTopLeft[0]) / 2;
    const offsetY = (pad.paddingBottomRight[1] - pad.paddingTopLeft[1]) / 2;
    const shiftedCenter = this.map.unproject(targetPt.add([offsetX, offsetY]), targetZoom);
    this.map.setView(shiftedCenter, targetZoom, { animate: true });
  }

  focusBusAndStop(bus) {
    if (!bus || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') return;
    const pts = [[bus.lat, bus.lng]];
    if (this.activeStopCoords) {
      pts.push([this.activeStopCoords.lat, this.activeStopCoords.lng]);
    }
    const bounds = L.latLngBounds(pts);
    this.map.fitBounds(bounds, {
      ...this._getPadding(),
      maxZoom: 16,
      animate: true
    });
  }

  fitFleet(buses) {
    const pts = [];
    if (this.activeStopCoords) {
      pts.push([this.activeStopCoords.lat, this.activeStopCoords.lng]);
    }
    for (const b of buses) {
      if (typeof b.lat === 'number' && typeof b.lng === 'number') {
        pts.push([b.lat, b.lng]);
      }
    }
    if (pts.length === 0) return;
    if (pts.length === 1) {
      this.focusStop(15);
      return;
    }
    this.map.fitBounds(L.latLngBounds(pts), {
      ...this._getPadding(),
      maxZoom: 16,
      animate: true
    });
  }

  clearRoutes() {
    this.routeLayer.clearLayers();
    this.routeStopsLayer.clearLayers();
  }

  drawRouteCollection(recorridos, lineName, { showStops = true, fit = false } = {}) {
    const allPts = [];

    recorridos.forEach((rec, idx) => {
      const branchColor = getDirectionColor(idx);
      const pts = (rec.puntos || [])
        .map((p) => [parseFloat(p.latitud), parseFloat(p.longitud)])
        .filter(([la, ln]) => !Number.isNaN(la) && !Number.isNaN(ln));

      if (pts.length > 1) {
        allPts.push(...pts);
        // Subtle dark casing + distinct solid color per direction (IDA vs VTA)
        L.polyline(pts, {
          color: '#0b1017',
          weight: 6.5,
          opacity: 0.45
        }).addTo(this.routeLayer);

        L.polyline(pts, {
          color: branchColor,
          weight: 3.8,
          opacity: 0.9
        })
          .bindTooltip(`${lineName} · ${rec.abreviaturaBanderaSMP || 'Recorrido'}`, { sticky: true })
          .addTo(this.routeLayer);
      }

      if (showStops && Array.isArray(rec.paradas)) {
        for (const p of rec.paradas) {
          const la = parseFloat(p.latitudParada);
          const ln = parseFloat(p.longitudParada);
          if (Number.isNaN(la) || Number.isNaN(ln)) continue;

          const dot = L.marker([la, ln], {
            icon: L.divIcon({
              className: 'route-stop-leaflet',
              html: `<div class="route-stop-dot" style="--line-color:${branchColor}"></div>`,
              iconSize: [12, 12],
              iconAnchor: [6, 6]
            }),
            zIndexOffset: 250
          }).addTo(this.routeStopsLayer);

          dot.bindTooltip(`<strong>${p.identificador}</strong> · ${p.descripcion}`, {
            direction: 'top',
            offset: [0, -6]
          });

          dot.on('click', () => {
            this.onStopPick({
              id: p.identificador,
              nombre: p.descripcion,
              lat: la,
              lng: ln
            });
          });
        }
      }
    });

    if (fit && allPts.length > 1) {
      this.map.fitBounds(L.latLngBounds(allPts), {
        ...this._getPadding(),
        maxZoom: 15,
        animate: true
      });
    }
  }

  showNearbyStops(stops, centerLatLng = null) {
    this.nearbyLayer.clearLayers();
    const pts = [];

    for (const s of stops) {
      const la = parseFloat(s.latitud);
      const ln = parseFloat(s.longitud);
      if (Number.isNaN(la) || Number.isNaN(ln)) continue;
      pts.push([la, ln]);

      const marker = L.marker([la, ln], {
        icon: L.divIcon({
          className: 'nearby-leaflet',
          html: `<div class="nearby-pin"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        zIndexOffset: 380
      }).addTo(this.nearbyLayer);

      marker.bindTooltip(`<strong>${s.identificador}</strong> · ${s.descripcion}<br/><small>${s.lineas || ''}</small>`, {
        direction: 'top',
        offset: [0, -8]
      });

      marker.on('click', () => {
        this.onStopPick({
          id: s.identificador,
          nombre: s.descripcion,
          lat: la,
          lng: ln
        });
      });
    }

    if (centerLatLng) {
      pts.push([centerLatLng.lat, centerLatLng.lng]);
    }
    if (pts.length > 0) {
      this.map.fitBounds(L.latLngBounds(pts), {
        ...this._getPadding(),
        maxZoom: 16,
        animate: true
      });
    }
  }

  setUserLocation(lat, lng, accuracy = 80) {
    this.userLayer.clearLayers();
    L.circle([lat, lng], {
      radius: Math.min(accuracy, 250),
      color: '#38bdf8',
      fillColor: '#38bdf8',
      fillOpacity: 0.14,
      weight: 1.5
    }).addTo(this.userLayer);

    L.circleMarker([lat, lng], {
      radius: 7,
      color: '#ffffff',
      weight: 2.5,
      fillColor: '#0284c7',
      fillOpacity: 1
    })
      .bindTooltip('Tu ubicación GPS')
      .addTo(this.userLayer);
  }
}
