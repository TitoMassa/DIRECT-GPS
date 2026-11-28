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
import java.util.Calendar;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Buscador nativo 100 % offline de horarios programados REALES (v3.1.3).
 * Lee `assets/public/data/horarios/{codLinea}.json` para resolver el horario oficial exacto (HH:MM)
 * del colectivo actual cuando el servicio en 2° plano cambia a la unidad siguiente (p. ej. tras
 * arribar el coche anterior), evitando heredar el horario vencido del coche anterior y sin inventar
 * nunca horas estimadas.
 */
public final class NativeScheduleLookup {

    private static final String TAG = "NativeScheduleLookup";
    private static final int SERVICE_DAY_CUTOFF_SEC = 3 * 3600; // 00:00–02:59 pertenece al día de servicio anterior
    private static final int MAX_MATCH_DIFF_SEC = 18 * 60;
    private static final int MAX_PLAUSIBLE_DIFF_SEC = 22 * 60;
    private static final Pattern DESVIO_PATTERN = Pattern.compile("^([+-])(\\d{1,4}):(\\d{2})$");

    private static final Map<Integer, JSONObject> HORARIOS_CACHE = new ConcurrentHashMap<>();

    private NativeScheduleLookup() {}

    /**
     * Parsea el desvío horario oficial de SmartMovePro (ej. "+01:30" = adelantado, "-04:15" = atrasado)
     * devolviendo segundos con signo, o 0 si no está disponible o es corrupto (> 120 min).
     */
    public static int parseDesvioSec(@Nullable String raw) {
        if (raw == null) return 0;
        String norm = raw.replaceAll("\\s+", "");
        if (norm.isEmpty() || "0".equals(norm) || "00:00".equals(norm) || "+00:00".equals(norm) || "-00:00".equals(norm)) {
            return 0;
        }
        Matcher m = DESVIO_PATTERN.matcher(norm);
        if (!m.matches()) return 0;
        try {
            int mins = Integer.parseInt(m.group(2));
            int secs = Integer.parseInt(m.group(3));
            int total = mins * 60 + secs;
            if (total > 120 * 60) return 0; // Descartar desvíos corruptos de SmartMovePro
            int signed = "+".equals(m.group(1)) ? total : -total;
            return Math.max(-90 * 60, Math.min(45 * 60, signed));
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Devuelve el tipo de día de servicio en Corrientes (UTC-3 con corte a las 03:00 AM ART).
     */
    public static String getCurrentArgentinaServiceTipo(long nowMs) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        cal.setTimeInMillis(nowMs - (6L * 3600L * 1000L)); // UTC-3 - 3h corte = -6h
        int dow = cal.get(Calendar.DAY_OF_WEEK);
        if (dow == Calendar.SUNDAY) return "domingo";
        if (dow == Calendar.SATURDAY) return "sabado";
        return "habil";
    }

    /**
     * Devuelve el segundo del día de servicio en Argentina (00:00–02:59 -> 86400..97199).
     */
    public static int getCurrentArgentinaServiceSec(long nowMs) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("GMT-03:00"));
        cal.setTimeInMillis(nowMs);
        int sec = cal.get(Calendar.HOUR_OF_DAY) * 3600 + cal.get(Calendar.MINUTE) * 60 + cal.get(Calendar.SECOND);
        return sec < SERVICE_DAY_CUTOFF_SEC ? (sec + 86400) : sec;
    }

    private static int parseHHMMToServiceSec(@Nullable String raw) {
        if (raw == null) return -1;
        String s = raw.trim();
        int pipe = s.indexOf('|');
        if (pipe >= 0) s = s.substring(0, pipe).trim();
        String[] parts = s.split(":");
        if (parts.length < 2) return -1;
        try {
            int hh = Integer.parseInt(parts[0]);
            int mm = Integer.parseInt(parts[1]);
            int ss = parts.length >= 3 ? Integer.parseInt(parts[2]) : 0;
            if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return -1;
            int sec = hh * 3600 + mm * 60 + ss;
            return sec < SERVICE_DAY_CUTOFF_SEC ? (sec + 86400) : sec;
        } catch (Exception e) {
            return -1;
        }
    }

    /**
     * Verifica si un horario programado guardado (HH:MM) sigue siendo coherente con el arribo actual
     * (fórmula oficial: ExpectedScheduledPass = Now + ETA + Desvio).
     * Detecta de inmediato horarios vencidos heredados de un colectivo anterior (ej. 00:43 en un coche a 33 min).
     */
    public static boolean isScheduledHHMMPlausible(
        @Nullable String hhmm,
        int etaMin,
        @Nullable String desvioRaw
    ) {
        return isScheduledHHMMPlausibleAt(hhmm, etaMin, desvioRaw, System.currentTimeMillis());
    }

    public static boolean isScheduledHHMMPlausibleAt(
        @Nullable String hhmm,
        int etaMin,
        @Nullable String desvioRaw,
        long nowMs
    ) {
        if (hhmm == null || hhmm.trim().isEmpty()) return false;
        if (etaMin < 0) return true;
        int slotSec = parseHHMMToServiceSec(hhmm);
        if (slotSec < 0) return false;
        int nowSec = getCurrentArgentinaServiceSec(nowMs);
        int desvioSec = parseDesvioSec(desvioRaw);
        int expectedSec = nowSec + etaMin * 60 + desvioSec;
        int diff = Math.abs(slotSec - expectedSec);
        if (diff > 43200) diff = 86400 - diff;
        return diff <= MAX_PLAUSIBLE_DIFF_SEC;
    }

    /**
     * Calcula los segundos restantes estimados hasta la parada según el horario programado oficial:
     *  - `strictPunctual = true` (>= 5 min sin GPS): desvío 00:00 (100 % puntual).
     *  - `strictPunctual = false` (3–5 min sin GPS): aplica el último desvío horario visto.
     * Devuelve -1 si no hay horario programado válido o está fuera de ventana razonable.
     */
    public static double computeScheduleRemainingSec(
        @Nullable String hhmm,
        @Nullable String desvioRaw,
        boolean strictPunctual,
        long nowMs
    ) {
        if (hhmm == null || hhmm.trim().isEmpty()) return -1.0;
        int slotSec = parseHHMMToServiceSec(hhmm);
        if (slotSec < 0) return -1.0;
        int nowSec = getCurrentArgentinaServiceSec(nowMs);
        int effDesvio = strictPunctual ? 0 : parseDesvioSec(desvioRaw);
        int rem = slotSec - (nowSec + effDesvio);
        if (rem < -43200) rem += 86400;
        if (rem > 43200) rem -= 86400;
        if (rem < -45 || rem > 7200) return -1.0;
        return Math.max(0.0, (double) rem);
    }

    /**
     * Resuelve el horario programado REAL (HH:MM) exacto desde `assets/public/data/horarios/{codLinea}.json`.
     * Devuelve "" si no existe coincidencia real dentro de la tolerancia (nunca devuelve hora estimada).
     */
    public static String resolveRealScheduledHHMM(
        Context ctx,
        int codLinea,
        @Nullable String lineName,
        @Nullable String stopId,
        @Nullable String banderaHint,
        int etaMin,
        @Nullable String desvioRaw
    ) {
        return resolveRealScheduledHHMMAt(
            ctx, codLinea, lineName, stopId, banderaHint, etaMin, desvioRaw, System.currentTimeMillis()
        );
    }

    public static String resolveRealScheduledHHMMAt(
        Context ctx,
        int codLinea,
        @Nullable String lineName,
        @Nullable String stopId,
        @Nullable String banderaHint,
        int etaMin,
        @Nullable String desvioRaw,
        long nowMs
    ) {
        if (stopId == null || stopId.trim().isEmpty() || etaMin < 0) return "";
        int resolvedCod = RouteDistanceCalculator.resolveCodLinea(ctx, codLinea, lineName);
        if (resolvedCod <= 0) return "";

        JSONObject horFile = loadHorariosFile(ctx, resolvedCod);
        if (horFile == null) return "";

        JSONObject paradas = horFile.optJSONObject("paradas");
        if (paradas == null) return "";

        String normStop = stopId.trim().toUpperCase(Locale.ROOT);
        JSONObject stopObj = paradas.optJSONObject(normStop);
        if (stopObj == null) return "";

        String tipo = getCurrentArgentinaServiceTipo(nowMs);
        JSONArray slots = stopObj.optJSONArray(tipo);
        if (slots == null || slots.length() == 0) {
            slots = stopObj.optJSONArray("habil");
        }
        if (slots == null || slots.length() == 0) return "";

        JSONArray banderas = horFile.optJSONArray("banderas");
        String normHint = banderaHint != null ? banderaHint.trim().toUpperCase(Locale.ROOT) : "";

        int nowSec = getCurrentArgentinaServiceSec(nowMs);
        int desvioSec = parseDesvioSec(desvioRaw);
        int expectedSec = nowSec + etaMin * 60 + desvioSec;

        String bestHHMM = "";
        int bestScore = Integer.MAX_VALUE;
        int bestRawDiff = Integer.MAX_VALUE;

        for (int i = 0; i < slots.length(); i++) {
            String raw = slots.optString(i, "").trim();
            if (raw.isEmpty()) continue;

            int slotSec = parseHHMMToServiceSec(raw);
            if (slotSec < 0) continue;

            int diff = Math.abs(slotSec - expectedSec);
            if (diff > 43200) diff = 86400 - diff;

            int score = diff;
            if (!normHint.isEmpty() && banderas != null) {
                int pipe = raw.indexOf('|');
                if (pipe >= 0 && pipe + 1 < raw.length()) {
                    try {
                        int bIdx = Integer.parseInt(raw.substring(pipe + 1).trim());
                        if (bIdx >= 0 && bIdx < banderas.length()) {
                            String bName = banderas.optString(bIdx, "").trim().toUpperCase(Locale.ROOT);
                            if (!bName.isEmpty() && (bName.contains(normHint) || normHint.contains(bName))) {
                                score = Math.max(0, score - 90);
                            }
                        }
                    } catch (Exception ignored) {}
                }
            }

            if (score < bestScore) {
                bestScore = score;
                bestRawDiff = diff;
                String hhmm = raw.length() >= 5 ? raw.substring(0, 5) : "";
                if (hhmm.matches("^\\d{2}:\\d{2}$")) {
                    bestHHMM = hhmm;
                }
            }
        }

        return (bestRawDiff <= MAX_MATCH_DIFF_SEC) ? bestHHMM : "";
    }

    @Nullable
    private static JSONObject loadHorariosFile(Context ctx, int codLinea) {
        JSONObject cached = HORARIOS_CACHE.get(codLinea);
        if (cached != null) return cached;
        try {
            String raw = readAssetText(ctx, "public/data/horarios/" + codLinea + ".json");
            if (raw == null || raw.isEmpty()) return null;
            JSONObject obj = new JSONObject(raw);
            HORARIOS_CACHE.put(codLinea, obj);
            return obj;
        } catch (Exception e) {
            Log.d(TAG, "Failed loading horarios/" + codLinea + ".json: " + e.getMessage());
            return null;
        }
    }

    @Nullable
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
}
