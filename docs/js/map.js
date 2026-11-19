import { MAP_TILES, getLineColor } from './config.js';
import { formatDistance } from './api.js';

export class TransitMap {
  constructor(containerId, { onBusSelect, onStopPick } = {}) {
    this.onBusSelect = onBusSelect || (() => {});
    this.onStopPick = onStopPick || (() => {});

    this.map = L.map(containerId, {
      center: [-27.476965, -58.825184],
      zoom: 15,
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
    const isMobile = window.innerWidth <= 820;
    if (isMobile) {
      return {
        paddingTopLeft: [24, 90],
        paddingBottomRight: [24, Math.round(window.innerHeight * 0.52)]
      };
    }
    return {
      paddingTopLeft: [450, 96],
      paddingBottomRight: [74, 60]
    };
  }

  setTileStyle(styleKey) {
    const cfg = MAP_TILES[styleKey] || MAP_TILES.dark;
    this.tileKey = cfg.id;
    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
    }
    this.tileLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: cfg.maxZoom
    }).addTo(this.map);
    return cfg;
  }

  cycleTileStyle() {
    const order = ['dark', 'light', 'satellite'];
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
    if (!this.activeStopCoords) return;
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
    const start = performance.now();
    const dLat = toLatLng[0] - fromLatLng.lat;
    const dLng = toLatLng[1] - fromLatLng.lng;
    if (Math.abs(dLat) < 1e-6 && Math.abs(dLng) < 1e-6) return;

    const step = (now) => {
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

    const etaShort = bus.eta.minutes === 0 ? 'YA' : `${bus.eta.display}'`;

    return L.divIcon({
      className: 'bus-leaflet-icon',
      html: `
        <div class="${cls.join(' ')}" style="--bus-color:${color}">
          <div class="bus-pill-marker">
            <span>${bus.descripcionLinea}</span>
            <span class="bus-pill-eta">${etaShort}</span>
          </div>
          <div class="bus-heading-dot"></div>
        </div>
      `,
      iconSize: [86, 36],
      iconAnchor: [43, 34]
    });
  }

  updateBuses(buses, { filterLine = 'ALL', selectedBusKey = null } = {}) {
    this.selectedBusKey = selectedBusKey;
    const incomingKeys = new Set();

    for (const bus of buses) {
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      incomingKeys.add(bus.key);

      const isSelected = bus.key === selectedBusKey;
      const isDimmed = filterLine !== 'ALL' && bus.descripcionLinea !== filterLine;
      const icon = this._buildBusIcon(bus, { selected: isSelected, dimmed: isDimmed });

      const existing = this.busMarkers.get(bus.key);
      if (existing) {
        const curPos = existing.marker.getLatLng();
        this._animateMarker(existing.marker, curPos, [bus.lat, bus.lng]);
        existing.marker.setIcon(icon);
        existing.marker.setZIndexOffset(isSelected ? 1000 : isDimmed ? 100 : 500);
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

    // Remove departed buses
    for (const [key, entry] of this.busMarkers.entries()) {
      if (!incomingKeys.has(key)) {
        this.busLayer.removeLayer(entry.marker);
        this.busMarkers.delete(key);
      }
    }

    // Update focus vector if a bus is selected
    const focused = selectedBusKey ? this.busMarkers.get(selectedBusKey)?.data : null;
    this.drawFocusVector(focused);
  }

  drawFocusVector(bus) {
    this.vectorLayer.clearLayers();
    if (!bus || !this.activeStopCoords || typeof bus.lat !== 'number' || typeof bus.lng !== 'number') {
      return;
    }

    const color = getLineColor(bus.descripcionLinea);
    const pts = [
      [bus.lat, bus.lng],
      [this.activeStopCoords.lat, this.activeStopCoords.lng]
    ];

    L.polyline(pts, {
      color,
      weight: 3,
      opacity: 0.85,
      dashArray: '7, 8'
    }).addTo(this.vectorLayer);

    if (bus.distanceMeters !== null) {
      const midLat = (bus.lat + this.activeStopCoords.lat) / 2;
      const midLng = (bus.lng + this.activeStopCoords.lng) / 2;
      L.marker([midLat, midLng], {
        interactive: false,
        icon: L.divIcon({
          className: 'dist-mid-icon',
          html: `<div class="distance-label-pill">${formatDistance(bus.distanceMeters)}</div>`,
          iconSize: [74, 24],
          iconAnchor: [37, 12]
        })
      }).addTo(this.vectorLayer);
    }
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
    const color = getLineColor(lineName);
    const allPts = [];

    recorridos.forEach((rec, idx) => {
      const pts = (rec.puntos || [])
        .map((p) => [parseFloat(p.latitud), parseFloat(p.longitud)])
        .filter(([la, ln]) => !Number.isNaN(la) && !Number.isNaN(ln));

      if (pts.length > 1) {
        allPts.push(...pts);
        // Subtle outer glow casing + crisp core stroke
        L.polyline(pts, {
          color: '#0b1017',
          weight: idx === 0 ? 7 : 5,
          opacity: 0.45
        }).addTo(this.routeLayer);

        L.polyline(pts, {
          color,
          weight: idx === 0 ? 4 : 3,
          opacity: idx === 0 ? 0.92 : 0.65,
          dashArray: idx === 0 ? null : '6, 6'
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
              html: `<div class="route-stop-dot" style="--line-color:${color}"></div>`,
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
