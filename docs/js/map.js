import { CORRIENTES_CENTER, MAP_TILES, getLineColor, getDirectionColor } from './config.js';
import { formatDistance } from './api.js';

export class TransitMap {
  constructor(containerId, { onBusSelect, onStopPick } = {}) {
    this.onBusSelect = onBusSelect || (() => {});
    this.onStopPick = onStopPick || (() => {});

    this.canvasRenderer = L.canvas({ padding: 0.35 });

    this.map = L.map(containerId, {
      center: [CORRIENTES_CENTER.lat, CORRIENTES_CENTER.lng],
      zoom: CORRIENTES_CENTER.zoom,
      zoomControl: false,
      attributionControl: true,
      keyboard: false,
      preferCanvas: true,
      renderer: this.canvasRenderer,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      inertia: true,
      inertiaDeceleration: 3000,
      fadeAnimation: false,
      bounceAtZoomLimits: false
    });

    this.isInteracting = false;
    this.map.on('movestart zoomstart', () => {
      this.isInteracting = true;
    });
    this.map.on('moveend zoomend', () => {
      this.isInteracting = false;
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

    this.busMarkers = new Map(); // busKey -> { marker, lat, lng, data, iconSig }
    this.stopMarker = null;
    this.activeStopSig = '';
    this.activeStopCoords = null;
    this.selectedBusKey = null;

    // Keep tiles & projection aligned on rotation, Android split-screen, or soft keyboard
    const container = this.map.getContainer();
    if (container) {
      container.setAttribute('tabindex', '-1');
      container.querySelectorAll('.leaflet-control-attribution a').forEach((a) => a.setAttribute('tabindex', '-1'));
    }
    if (typeof ResizeObserver !== 'undefined' && container) {
      let resizeRaf = 0;
      this._resizeObserver = new ResizeObserver(() => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => this.map.invalidateSize({ animate: false }));
      });
      this._resizeObserver.observe(container);
    }
  }

  invalidateSize() {
    this.map.invalidateSize({ animate: false });
  }

  _getPadding() {
    const header = document.querySelector('.top-bar');
    const dock = document.getElementById('transit-dock');
    const topPad = header ? Math.max(60, Math.round(header.getBoundingClientRect().bottom + 14)) : 68;
    const isLandscapeRail = window.matchMedia('(max-height: 540px) and (min-width: 560px)').matches;
    const isBottomSheet = window.innerWidth <= 860 && !isLandscapeRail;

    if (isBottomSheet) {
      const dockH = dock ? Math.round(dock.getBoundingClientRect().height) : Math.round(window.innerHeight * 0.45);
      const bottomPad = Math.min(dockH + 18, Math.round(window.innerHeight * 0.65));
      return {
        paddingTopLeft: [18, topPad],
        paddingBottomRight: [56, bottomPad]
      };
    }

    const leftPad = dock ? Math.round(dock.getBoundingClientRect().right + 18) : 400;
    return {
      paddingTopLeft: [Math.min(leftPad, Math.round(window.innerWidth * 0.55)), topPad],
      paddingBottomRight: [66, 44]
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
        subdomains: cfg.subdomains || 'abc',
        attribution: cfg.attribution,
        maxZoom: cfg.maxZoom,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 2
      }).addTo(this.map);
    }

    const tilePane = this.map.getPane('tilePane');
    if (tilePane) {
      tilePane.classList.toggle('osm-dark-filter', Boolean(cfg.darkFilter));
    }
    return cfg;
  }

  cycleTileStyle() {
    const order = ['dark', 'light', 'osm'];
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
    this.activeStopSig = '';
    this.activeStopCoords = null;
    this.selectedBusKey = null;
  }

  setActiveStop(stop) {
    if (!stop || typeof stop.lat !== 'number' || typeof stop.lng !== 'number') {
      this.stopLayer.clearLayers();
      this.stopMarker = null;
      this.activeStopSig = '';
      this.activeStopCoords = null;
      return;
    }

    const nextSig = `${stop.id}|${stop.lat.toFixed(6)}|${stop.lng.toFixed(6)}|${stop.nombre || ''}`;
    if (this.activeStopSig === nextSig && this.stopMarker) {
      return; // Avoid tearing down the stop pin on every 10s poll
    }

    this.stopLayer.clearLayers();
    this.activeStopSig = nextSig;
    this.activeStopCoords = { lat: stop.lat, lng: stop.lng };

    const icon = L.divIcon({
      className: 'stop-beacon-leaflet',
      html: `
        <div class="stop-beacon-wrap">
          <span class="stop-beacon-halo"></span>
          <span class="stop-beacon-core"></span>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });

    this.stopMarker = L.marker([stop.lat, stop.lng], { icon, zIndexOffset: 700, keyboard: false })
      .addTo(this.stopLayer)
      .bindTooltip(`<strong>${stop.id}</strong> · ${stop.nombre || ''}`, {
        direction: 'top',
        offset: [0, -14]
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

  _animateMarker(marker, fromLatLng, toLatLng, duration = 700) {
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
    if ((bus.isPredicted && !bus.nextLapSourceLive) || bus.gpsLost) cls.push('is-predicted');

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
            <span class="bus-pill-line">${bus.descripcionLinea}</span>
            ${cocheHtml}
            <span class="bus-pill-eta">${etaShort}</span>
          </div>
          <div class="bus-heading-dot"></div>
        </div>
      `,
      iconSize: [116, 32],
      iconAnchor: [58, 30]
    });
  }

  // Zero-waste position update: skips stationary buses and yields during active map pan/zoom!
  moveBusPositionsFast(buses) {
    if (this.isInteracting) return;
    for (let i = 0; i < buses.length; i++) {
      const bus = buses[i];
      if (!bus._posChanged) continue;
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      const entry = this.busMarkers.get(bus.key);
      if (!entry) continue;
      if (Math.abs(bus.lat - entry.lat) < 2e-6 && Math.abs(bus.lng - entry.lng) < 2e-6) {
        bus._posChanged = false;
        continue;
      }
      entry.marker._animToken = (entry.marker._animToken || 0) + 1;
      entry.marker.setLatLng([bus.lat, bus.lng]);
      entry.lat = bus.lat;
      entry.lng = bus.lng;
      entry.data = bus;
      bus._posChanged = false;
    }
  }

  updateBuses(buses, { filterLine = 'ALL', selectedBusKey = null, simulateMode = false } = {}) {
    this.selectedBusKey = selectedBusKey;
    const incomingKeys = new Set();

    const visibleBuses =
      filterLine === 'ALL' ? buses : buses.filter((b) => b.descripcionLinea === filterLine);

    const primaryKeys = new Set(visibleBuses.filter((b) => !b.isNextLap).map((b) => b.key));

    for (const bus of visibleBuses) {
      if (typeof bus.lat !== 'number' || typeof bus.lng !== 'number') continue;
      // Same physical bus on a later lap (`Sig. vuelta`): never plot a duplicate marker on the map!
      if (bus.isNextLap && bus.nextLapOfKey && primaryKeys.has(bus.nextLapOfKey)) continue;
      incomingKeys.add(bus.key);

      const isSelected = bus.key === selectedBusKey;
      const etaShort = bus.eta.minutes === 0 ? 'YA' : `${bus.eta.display}'`;
      const isPredStyle = (bus.isPredicted && !bus.nextLapSourceLive) || bus.gpsLost ? 1 : 0;
      const iconSig = `${bus.descripcionLinea}|${bus.identificadorCoche || ''}|${etaShort}|${bus.desvio?.status || ''}|${isPredStyle}|${isSelected ? 1 : 0}`;

      const existing = this.busMarkers.get(bus.key);
      if (existing) {
        if (simulateMode) {
          existing.marker._animToken = (existing.marker._animToken || 0) + 1;
          if (Math.abs(bus.lat - existing.lat) >= 1e-6 || Math.abs(bus.lng - existing.lng) >= 1e-6) {
            existing.marker.setLatLng([bus.lat, bus.lng]);
            existing.lat = bus.lat;
            existing.lng = bus.lng;
          }
        } else {
          const curPos = existing.marker.getLatLng();
          this._animateMarker(existing.marker, curPos, [bus.lat, bus.lng], 650);
          existing.lat = bus.lat;
          existing.lng = bus.lng;
        }
        if (existing.iconSig !== iconSig) {
          existing.marker.setIcon(this._buildBusIcon(bus, { selected: isSelected, dimmed: false }));
          existing.iconSig = iconSig;
        }
        existing.marker.setZIndexOffset(isSelected ? 1000 : 500);
        existing.data = bus;
      } else {
        const icon = this._buildBusIcon(bus, { selected: isSelected, dimmed: false });
        const marker = L.marker([bus.lat, bus.lng], {
          icon,
          zIndexOffset: isSelected ? 1000 : 500,
          keyboard: false
        }).addTo(this.busLayer);

        marker.on('click', () => {
          this.onBusSelect(bus.key);
        });

        this.busMarkers.set(bus.key, { marker, lat: bus.lat, lng: bus.lng, data: bus, iconSig });
      }
    }

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
    const segments =
      Array.isArray(bus.trajectory?.segments) && bus.trajectory.segments.length > 0
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
          renderer: this.canvasRenderer,
          color: '#0b0d10',
          weight: idx === 0 ? 6 : 4.5,
          opacity: 0.42,
          interactive: false
        }).addTo(this.vectorLayer);

        L.polyline(seg.pts, {
          renderer: this.canvasRenderer,
          color: segColor,
          weight: idx === 0 ? 3.5 : 2.8,
          opacity: idx === 0 ? 0.92 : 0.7,
          dashArray: idx === 0 ? null : '6, 6',
          interactive: false
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
        renderer: this.canvasRenderer,
        color: fallbackColor,
        weight: 3.5,
        opacity: 0.88,
        interactive: false
      }).addTo(this.vectorLayer);
    }

    const displayDist = bus.routeMeters ?? bus.distanceMeters;
    if (displayDist !== null && displayDist !== undefined && allPts.length > 0) {
      const midPt = allPts[Math.floor(allPts.length / 2)];
      L.marker(midPt, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: 'dist-mid-icon',
          html: `<div class="distance-label-pill">${formatDistance(displayDist)}</div>`,
          iconSize: [74, 22],
          iconAnchor: [37, 11]
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
    this.map.fitBounds(L.latLngBounds(pts), {
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
        L.polyline(pts, {
          renderer: this.canvasRenderer,
          color: '#0b0d10',
          weight: 6,
          opacity: 0.4,
          interactive: false
        }).addTo(this.routeLayer);

        L.polyline(pts, {
          renderer: this.canvasRenderer,
          color: branchColor,
          weight: 3.5,
          opacity: 0.88
        })
          .bindTooltip(`${lineName} · ${rec.abreviaturaBanderaSMP || 'Recorrido'}`, { sticky: true })
          .addTo(this.routeLayer);
      }

      // Render route stops on Canvas via circleMarker (zero DOM bloat -> silky 60fps panning!)
      if (showStops && Array.isArray(rec.paradas)) {
        for (const p of rec.paradas) {
          const la = parseFloat(p.latitudParada);
          const ln = parseFloat(p.longitudParada);
          if (Number.isNaN(la) || Number.isNaN(ln)) continue;

          const dot = L.circleMarker([la, ln], {
            renderer: this.canvasRenderer,
            radius: 4.5,
            color: branchColor,
            weight: 2,
            fillColor: '#ffffff',
            fillOpacity: 1
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

      const marker = L.circleMarker([la, ln], {
        renderer: this.canvasRenderer,
        radius: 6.5,
        color: '#ffffff',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 0.96
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
      renderer: this.canvasRenderer,
      radius: Math.min(accuracy, 250),
      color: '#38bdf8',
      fillColor: '#38bdf8',
      fillOpacity: 0.12,
      weight: 1.5,
      interactive: false
    }).addTo(this.userLayer);

    L.circleMarker([lat, lng], {
      renderer: this.canvasRenderer,
      radius: 6.5,
      color: '#ffffff',
      weight: 2.5,
      fillColor: '#0284c7',
      fillOpacity: 1
    })
      .bindTooltip('Tu ubicación GPS')
      .addTo(this.userLayer);
  }
}
