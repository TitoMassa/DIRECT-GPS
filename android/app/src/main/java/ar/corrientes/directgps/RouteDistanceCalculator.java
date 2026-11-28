package ar.corrientes.directgps;

import android.content.Context;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Calculador nativo de distancia REAL sobre el trazado del recorrido (v2.9.1).
 * Lee directamente los recorridos empaquetados en `assets/public/data/recorridos/{codLinea}.json`
 * (100 % offline, cacheados en RAM) y evalúa las 3 hipótesis geométricas:
 *   1) Tramo directo en el ramal de la parada (antes de llegar)
 *   2) Tramo opuesto (ej. pasando por la mano de enfrente IDA) -> cabecera -> vuelta hasta la parada
 *   3) Ciclo completo (ya pasó la parada -> cabecera -> vuelta completa -> parada)
 * Elige la hipótesis físicamente coherente con los minutos de arribo (etaMin), evitando que un
 * colectivo a 26-30 min en la mano contraria figure "a 320 m" con la barra casi llena.
 */
public final class RouteDistanceCalculator {

    private static final String TAG = "RouteDistCalc";

    public static final class RouteResult {
        public final double routeMeters;
        public final boolean isOppositeLeg;
        public final String activeBandera;

        RouteResult(double routeMeters, boolean isOppositeLeg, String activeBandera) {
            this.routeMeters = routeMeters;
            this.isOppositeLeg = isOppositeLeg;
            this.activeBandera = activeBandera;
        }
    }

    public static final class StopItem {
        public final String id;
        public final String nombre;
        public final double lat;
        public final double lng;
        public final double along;

        StopItem(String id, String nombre, double lat, double lng, double along) {
            this.id = id;
            this.nombre = nombre;
            this.lat = lat;
            this.lng = lng;
            this.along = along;
        }
    }

    private static final class RouteBranch {
        final String bandera;
        final double[] lats;
        final double[] lngs;
        final double[] cum;
        final double totalLen;
        final Set<String> stopIds;
        final List<StopItem> orderedStops;

        RouteBranch(String bandera, double[] lats, double[] lngs, double[] cum, Set<String> stopIds, List<StopItem> orderedStops) {
            this.bandera = bandera;
            this.lats = lats;
            this.lngs = lngs;
            this.cum = cum;
            this.totalLen = cum.length > 0 ? cum[cum.length - 1] : 0;
            this.stopIds = stopIds;
            this.orderedStops = orderedStops;
        }
    }

    private static final class Projection {
        final double along;
        final double distToLine;

        Projection(double along, double distToLine) {
            this.along = along;
            this.distToLine = distToLine;
        }
    }

    private static final Map<Integer, List<RouteBranch>> BRANCH_CACHE = new ConcurrentHashMap<>();
    private static volatile Map<String, Integer> LINE_CODE_MAP = null;

    private RouteDistanceCalculator() {}

    /**
     * Resuelve el codLinea a partir del nombre de línea (ej. "102C" -> 96) usando catalogo.json local.
     */
    public static int resolveCodLinea(Context ctx, int codLinea, @Nullable String lineName) {
        if (codLinea > 0) return codLinea;
        if (lineName == null || lineName.trim().isEmpty()) return 0;
        Map<String, Integer> map = getLineCodeMap(ctx);
        Integer found = map.get(lineName.trim().toUpperCase(Locale.ROOT));
        return found != null ? found : 0;
    }

    private static synchronized Map<String, Integer> getLineCodeMap(Context ctx) {
        if (LINE_CODE_MAP != null) return LINE_CODE_MAP;
        Map<String, Integer> map = new HashMap<>();
        try {
            String raw = readAssetText(ctx, "public/data/catalogo.json");
            if (raw != null && !raw.isEmpty()) {
                JSONObject root = new JSONObject(raw);
                JSONArray lineas = root.optJSONArray("lineas");
                if (lineas != null) {
                    for (int i = 0; i < lineas.length(); i++) {
                        JSONObject l = lineas.optJSONObject(i);
                        if (l == null) continue;
                        int cod = l.optInt("codigo", 0);
                        String desc = l.optString("descripcion", "").trim().toUpperCase(Locale.ROOT);
                        if (cod > 0 && !desc.isEmpty()) {
                            map.put(desc, cod);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "catalogo.json read skipped: " + e.getMessage());
        }
        LINE_CODE_MAP = map;
        return map;
    }

    @Nullable
    private static List<RouteBranch> loadBranches(Context ctx, int codLinea) {
        if (codLinea <= 0) return null;
        List<RouteBranch> cached = BRANCH_CACHE.get(codLinea);
        if (cached != null) return cached;

        try {
            String raw = readAssetText(ctx, "public/data/recorridos/" + codLinea + ".json");
            if (raw == null || raw.isEmpty()) return null;
            JSONArray arr = new JSONArray(raw);
            List<RouteBranch> list = new ArrayList<>();

            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.optJSONObject(i);
                if (obj == null) continue;
                JSONArray ptsArr = obj.optJSONArray("puntos");
                if (ptsArr == null || ptsArr.length() < 2) continue;

                double[] tmpLat = new double[ptsArr.length()];
                double[] tmpLng = new double[ptsArr.length()];
                int validCount = 0;
                for (int j = 0; j < ptsArr.length(); j++) {
                    JSONObject pt = ptsArr.optJSONObject(j);
                    if (pt == null) continue;
                    double la = parseDouble(pt.opt("latitud"));
                    double ln = parseDouble(pt.opt("longitud"));
                    if (Double.isFinite(la) && Double.isFinite(ln) && la != 0 && ln != 0) {
                        tmpLat[validCount] = la;
                        tmpLng[validCount] = ln;
                        validCount++;
                    }
                }
                if (validCount < 2) continue;

                double[] lats = new double[validCount];
                double[] lngs = new double[validCount];
                double[] cum = new double[validCount];
                lats[0] = tmpLat[0];
                lngs[0] = tmpLng[0];
                cum[0] = 0.0;
                for (int j = 1; j < validCount; j++) {
                    lats[j] = tmpLat[j];
                    lngs[j] = tmpLng[j];
                    cum[j] = cum[j - 1] + haversineMeters(lats[j - 1], lngs[j - 1], lats[j], lngs[j]);
                }

                Set<String> stopIds = new HashSet<>();
                List<StopItem> orderedStops = new ArrayList<>();
                RouteBranch tempBranch = new RouteBranch("", lats, lngs, cum, stopIds, orderedStops);
                JSONArray stopsArr = obj.optJSONArray("paradas");
                if (stopsArr != null) {
                    for (int j = 0; j < stopsArr.length(); j++) {
                        JSONObject st = stopsArr.optJSONObject(j);
                        if (st == null) continue;
                        String id = st.optString("identificador", "").trim().toUpperCase(Locale.ROOT);
                        if (id.isEmpty() || stopIds.contains(id)) continue;
                        stopIds.add(id);
                        double sLa = parseDouble(st.opt("latitud"));
                        double sLn = parseDouble(st.opt("longitud"));
                        String sNom = st.optString("descripcion", st.optString("nombre", id)).trim();
                        if (Double.isFinite(sLa) && Double.isFinite(sLn) && sLa != 0 && sLn != 0) {
                            Projection pr = projectOnBranch(tempBranch, sLa, sLn);
                            orderedStops.add(new StopItem(id, sNom.isEmpty() ? id : sNom, sLa, sLn, pr.along));
                        }
                    }
                }
                orderedStops.sort((a, b) -> Double.compare(a.along, b.along));

                String bandera = obj.optString("abreviaturaBanderaSMP", obj.optString("descripcion", "")).trim();
                list.add(new RouteBranch(bandera, lats, lngs, cum, stopIds, orderedStops));
            }

            if (!list.isEmpty()) {
                // Garantizar que el inicio de la bandera siguiente complete el hueco desde el final de la bandera anterior (0 m)
                if (list.size() >= 2) {
                    List<RouteBranch> connected = new ArrayList<>(list.size());
                    for (int j = 0; j < list.size(); j++) {
                        RouteBranch b = list.get(j);
                        double bestDist = Double.MAX_VALUE;
                        RouteBranch bestPrev = null;
                        for (int i = 0; i < list.size(); i++) {
                            if (i == j) continue;
                            RouteBranch a = list.get(i);
                            int aLast = a.lats.length - 1;
                            double d = haversineMeters(a.lats[aLast], a.lngs[aLast], b.lats[0], b.lngs[0]);
                            if (d < bestDist) {
                                bestDist = d;
                                bestPrev = a;
                            }
                        }
                        if (bestPrev != null && bestDist > 0.5 && bestDist <= 430.0) {
                            int pLast = bestPrev.lats.length - 1;
                            int n = b.lats.length;
                            double[] nLats = new double[n + 1];
                            double[] nLngs = new double[n + 1];
                            double[] nCum = new double[n + 1];
                            nLats[0] = bestPrev.lats[pLast];
                            nLngs[0] = bestPrev.lngs[pLast];
                            nCum[0] = 0.0;
                            System.arraycopy(b.lats, 0, nLats, 1, n);
                            System.arraycopy(b.lngs, 0, nLngs, 1, n);
                            for (int k = 0; k < n; k++) {
                                nCum[k + 1] = b.cum[k] + bestDist;
                            }
                            List<StopItem> shiftedStops = new ArrayList<>(b.orderedStops.size());
                            for (StopItem s : b.orderedStops) {
                                shiftedStops.add(new StopItem(s.id, s.nombre, s.lat, s.lng, s.along + bestDist));
                            }
                            connected.add(new RouteBranch(b.bandera, nLats, nLngs, nCum, b.stopIds, shiftedStops));
                        } else {
                            connected.add(b);
                        }
                    }
                    list = connected;
                }
                BRANCH_CACHE.put(codLinea, list);
                return list;
            }
        } catch (Exception e) {
            Log.d(TAG, "Failed loading route " + codLinea + ": " + e.getMessage());
        }
        return null;
    }

    /**
     * Devuelve la lista ordenada de paradas del ramal que contiene la parada indicada (100 % offline).
     * Permite activar Modo A Bordo ("Subir") directamente desde cualquier notificación push aunque la app esté cerrada.
     */
    public static List<StopItem> loadOrderedStopsForStop(
        Context ctx,
        int codLinea,
        @Nullable String lineName,
        @Nullable String stopId,
        double stopLat,
        double stopLng
    ) {
        int resolvedCod = resolveCodLinea(ctx, codLinea, lineName);
        List<RouteBranch> branches = loadBranches(ctx, resolvedCod);
        if (branches == null || branches.isEmpty()) return new ArrayList<>();
        String normStopId = stopId != null ? stopId.trim().toUpperCase(Locale.ROOT) : "";
        RouteBranch chosen = null;
        if (!normStopId.isEmpty()) {
            for (RouteBranch b : branches) {
                if (b.stopIds.contains(normStopId)) {
                    chosen = b;
                    break;
                }
            }
        }
        if (chosen == null && Double.isFinite(stopLat) && Double.isFinite(stopLng) && stopLat != 0 && stopLng != 0) {
            double bestDist = Double.MAX_VALUE;
            for (RouteBranch b : branches) {
                Projection p = projectOnBranch(b, stopLat, stopLng);
                if (p.distToLine < bestDist) {
                    bestDist = p.distToLine;
                    chosen = b;
                }
            }
        }
        if (chosen == null) chosen = branches.get(0);
        return new ArrayList<>(chosen.orderedStops);
    }

    /**
     * Calcula la distancia REAL siguiendo el trazado de calles del colectivo hasta la parada.
     */
    @Nullable
    public static RouteResult computeRouteDistance(
        Context ctx,
        int codLinea,
        @Nullable String lineName,
        @Nullable String stopId,
        double stopLat,
        double stopLng,
        double busLat,
        double busLng,
        int etaMin
    ) {
        if (!Double.isFinite(busLat) || !Double.isFinite(busLng) || busLat == 0 || busLng == 0) {
            return null;
        }
        if (!Double.isFinite(stopLat) || !Double.isFinite(stopLng) || stopLat == 0 || stopLng == 0) {
            return null;
        }

        int resolvedCod = resolveCodLinea(ctx, codLinea, lineName);
        List<RouteBranch> branches = loadBranches(ctx, resolvedCod);
        if (branches == null || branches.isEmpty()) {
            return null;
        }

        String normStopId = stopId != null ? stopId.trim().toUpperCase(Locale.ROOT) : "";

        // 1) Elegir el ramal exacto al que pertenece la parada (ej. CT31942 pertenece SOLO a VUELTA)
        RouteBranch stopBranch = null;
        if (!normStopId.isEmpty()) {
            for (RouteBranch b : branches) {
                if (b.stopIds.contains(normStopId)) {
                    stopBranch = b;
                    break;
                }
            }
        }
        if (stopBranch == null) {
            double bestDist = Double.MAX_VALUE;
            for (RouteBranch b : branches) {
                Projection p = projectOnBranch(b, stopLat, stopLng);
                if (p.distToLine < bestDist) {
                    bestDist = p.distToLine;
                    stopBranch = b;
                }
            }
        }
        if (stopBranch == null) return null;

        Projection stopProj = projectOnBranch(stopBranch, stopLat, stopLng);
        Projection busOnStop = projectOnBranch(stopBranch, busLat, busLng);

        // 2) Elegir el mejor ramal opuesto (el más cercano al GPS actual del colectivo)
        RouteBranch oppBranch = null;
        Projection busOnOpp = null;
        for (RouteBranch b : branches) {
            if (b == stopBranch) continue;
            Projection p = projectOnBranch(b, busLat, busLng);
            if (busOnOpp == null || p.distToLine < busOnOpp.distToLine) {
                oppBranch = b;
                busOnOpp = p;
            }
        }

        // 3) Evaluar las 3 hipótesis geométricas sobre el recorrido real
        // Hipótesis A: tramo directo en stopBranch antes de la parada
        double directDist = (busOnStop.along <= stopProj.along + 45.0)
            ? Math.max(0.0, stopProj.along - busOnStop.along)
            : Double.POSITIVE_INFINITY;

        // Hipótesis B: está en el tramo opuesto (ej. pasando Av. Ferré y Brasil IDA -> Puerto -> VUELTA)
        double loopDist = Double.POSITIVE_INFINITY;
        if (oppBranch != null && busOnOpp != null) {
            int lastOpp = oppBranch.lats.length - 1;
            double gapOppToStop = haversineMeters(
                oppBranch.lats[lastOpp], oppBranch.lngs[lastOpp],
                stopBranch.lats[0], stopBranch.lngs[0]
            );
            loopDist = Math.max(0.0, oppBranch.totalLen - busOnOpp.along) + gapOppToStop + stopProj.along;
        }

        // Hipótesis C: ciclo completo (ya pasó la parada -> cabecera -> vuelta -> parada)
        double fullCycleDist = Double.POSITIVE_INFINITY;
        if (oppBranch != null) {
            int lastStop = stopBranch.lats.length - 1;
            int lastOpp = oppBranch.lats.length - 1;
            double gap1 = haversineMeters(
                stopBranch.lats[lastStop], stopBranch.lngs[lastStop],
                oppBranch.lats[0], oppBranch.lngs[0]
            );
            double gap2 = haversineMeters(
                oppBranch.lats[lastOpp], oppBranch.lngs[lastOpp],
                stopBranch.lats[0], stopBranch.lngs[0]
            );
            fullCycleDist = Math.max(0.0, stopBranch.totalLen - busOnStop.along)
                + gap1 + oppBranch.totalLen + gap2 + stopProj.along;
        }

        // 4) Si no tenemos etaMin válido, preferir directo solo si está sobre stopBranch; si está más cerca de oppBranch, usar loop
        if (etaMin < 0) {
            if (oppBranch != null && busOnOpp != null && busOnOpp.distToLine + 25.0 < busOnStop.distToLine && Double.isFinite(loopDist)) {
                return new RouteResult(loopDist, true, oppBranch.bandera);
            }
            if (Double.isFinite(directDist)) {
                return new RouteResult(directDist, false, stopBranch.bandera);
            }
            if (Double.isFinite(loopDist)) {
                return new RouteResult(loopDist, true, oppBranch.bandera);
            }
            return null;
        }

        // Si está arribando ahora (<= 1 min) y directo es corto y sobre el ramal de la parada
        if (etaMin <= 1 && Double.isFinite(directDist) && directDist <= 750.0 && busOnStop.distToLine <= 150.0) {
            return new RouteResult(directDist, false, stopBranch.bandera);
        }

        double etaSec = etaMin <= 0 ? 45.0 : etaMin * 60.0;

        double bestScore = Double.POSITIVE_INFINITY;
        RouteResult bestResult = null;

        if (Double.isFinite(directDist)) {
            double score = scoreCandidate(directDist, etaSec, busOnStop.distToLine, false);
            if (score < bestScore) {
                bestScore = score;
                bestResult = new RouteResult(directDist, false, stopBranch.bandera);
            }
        }
        if (Double.isFinite(loopDist) && oppBranch != null && busOnOpp != null) {
            double score = scoreCandidate(loopDist, etaSec, busOnOpp.distToLine, true);
            if (score < bestScore) {
                bestScore = score;
                bestResult = new RouteResult(loopDist, true, oppBranch.bandera);
            }
        }
        if (Double.isFinite(fullCycleDist)) {
            double score = scoreCandidate(fullCycleDist, etaSec, busOnStop.distToLine, true) + 0.35;
            if (score < bestScore) {
                bestScore = score;
                bestResult = new RouteResult(fullCycleDist, true, stopBranch.bandera);
            }
        }

        return bestResult;
    }

    /**
     * Puntuación de coherencia física: compara la velocidad implícita (dist / etaSec) con la
     * velocidad urbana real de colectivos en Corrientes (~4.8-5.5 m/s = 17-20 km/h).
     * Un colectivo a 320 m en línea recta con ETA 30 min tiene velocidad implícita de 0.17 m/s
     * (0.6 km/h -> penalización masiva), mientras que el tramo real por el centro (~6 km) da
     * 3.3 m/s (12 km/h -> altamente coherente).
     */
    private static double scoreCandidate(double distMeters, double etaSec, double distToLineM, boolean isOpposite) {
        double speed = distMeters / Math.max(30.0, etaSec);
        double idealSpeed = 5.0; // ~18 km/h promedio urbano con paradas y semáforos
        double speedCost = Math.abs(speed - idealSpeed) / idealSpeed;

        if (speed < 1.6) {
            // Imposiblemente lento (típico caso de parada de enfrente en línea recta)
            speedCost += 6.0 + (1.6 - speed) * 8.0;
        } else if (speed > 13.5) {
            // Imposiblemente rápido para colectivo urbano
            speedCost += 5.0 + (speed - 13.5) * 1.5;
        }

        // Proximidad al trazado del ramal candidato
        double linePenalty = Math.min(2.0, distToLineM / 180.0);
        double oppBias = isOpposite ? 0.08 : 0.0;
        return speedCost + linePenalty * 0.45 + oppBias;
    }

    private static Projection projectOnBranch(RouteBranch b, double lat, double lng) {
        double cosLat = Math.cos(Math.toRadians(lat));
        double mPerDegLat = 111320.0;
        double mPerDegLng = 111320.0 * cosLat;

        double bestDistSq = Double.POSITIVE_INFINITY;
        double bestAlong = 0.0;

        for (int i = 0; i < b.lats.length - 1; i++) {
            double ax = (b.lngs[i] - lng) * mPerDegLng;
            double ay = (b.lats[i] - lat) * mPerDegLat;
            double bx = (b.lngs[i + 1] - lng) * mPerDegLng;
            double by = (b.lats[i + 1] - lat) * mPerDegLat;

            double dx = bx - ax;
            double dy = by - ay;
            double segLenSq = dx * dx + dy * dy;
            double t = segLenSq > 1e-6 ? Math.max(0.0, Math.min(1.0, -(ax * dx + ay * dy) / segLenSq)) : 0.0;

            double px = ax + t * dx;
            double py = ay + t * dy;
            double distSq = px * px + py * py;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                double segLen = b.cum[i + 1] - b.cum[i];
                bestAlong = b.cum[i] + t * segLen;
            }
        }

        return new Projection(bestAlong, Math.sqrt(bestDistSq));
    }

    private static String readAssetText(Context ctx, String assetPath) {
        try (InputStream is = ctx.getAssets().open(assetPath);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder(8192);
            char[] buf = new char[4096];
            int n;
            while ((n = br.read(buf)) != -1) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static double parseDouble(@Nullable Object raw) {
        if (raw == null) return Double.NaN;
        if (raw instanceof Number) return ((Number) raw).doubleValue();
        try {
            String s = String.valueOf(raw).trim().replace(',', '.');
            if (s.isEmpty() || "null".equalsIgnoreCase(s)) return Double.NaN;
            return Double.parseDouble(s);
        } catch (Exception e) {
            return Double.NaN;
        }
    }

    private static double haversineMeters(double lat1, double lng1, double lat2, double lng2) {
        double R = 6371000.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
            * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
    }
}
