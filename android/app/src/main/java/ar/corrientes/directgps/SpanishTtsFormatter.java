package ar.corrientes.directgps;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Formateador de voz natural en español rioplatense (es-AR) para el Foreground Service nativo.
 * Garantiza la misma pronunciación natural incluso con la app completamente cerrada:
 *  - "2976" -> "veintinueve setenta y seis"
 *  - "3035" -> "treinta treinta y cinco"
 *  - "4100" -> "cuarenta y uno cero cero"
 *  - "4122" -> "cuarenta y uno veintidós"
 */
public final class SpanishTtsFormatter {

    private static final String[] UNITS = {
        "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
        "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
        "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco",
        "veintiséis", "veintisiete", "veintiocho", "veintinueve"
    };

    private static final String[] TENS = {
        "", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"
    };

    private static final String[] HUNDREDS = {
        "", "ciento", "doscientos", "trescientos", "cuatrocientos",
        "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"
    };

    private static final Pattern COCHE_PATTERN = Pattern.compile("^(\\d+)([A-Za-z]*)$");
    private static final Pattern LINEA_PATTERN = Pattern.compile("^(\\d{1,3})\\s*([A-Za-z]*)$");
    private static final Set<String> LOWER_WORDS = new HashSet<>(Arrays.asList(
        "de", "del", "la", "las", "los", "el", "y", "e", "en", "a", "por", "con", "al"
    ));

    private static final Locale ES_AR = new Locale("es", "AR");

    private static final String[][] STOP_ABBREVS = {
        {"(?i)\\bAVDA\\.?(?=\\s|$)", "Avenida"},
        {"(?i)\\bAV\\.?(?=\\s|$)", "Avenida"},
        {"(?i)\\bB[º°]\\.?(?=\\s|$)", "Barrio"},
        {"(?i)\\bBO\\.?(?=\\s|$)", "Barrio"},
        {"(?i)\\bPTE\\.?(?=\\s|$)", "Presidente"},
        {"(?i)\\bPRES\\.?(?=\\s|$)", "Presidente"},
        {"(?i)\\bGRAL\\.?(?=\\s|$)", "General"},
        {"(?i)\\bDR\\.?(?=\\s|$)", "Doctor"},
        {"(?i)\\bDRA\\.?(?=\\s|$)", "Doctora"},
        {"(?i)\\bSTA\\.?(?=\\s|$)", "Santa"},
        {"(?i)\\bSTO\\.?(?=\\s|$)", "Santo"},
        {"(?i)\\bSGTO\\.?(?=\\s|$)", "Sargento"},
        {"(?i)\\bTTE\\.?(?=\\s|$)", "Teniente"},
        {"(?i)\\bCNEL\\.?(?=\\s|$)", "Coronel"},
        {"(?i)\\bGDOR\\.?(?=\\s|$)", "Gobernador"},
        {"(?i)\\bGOB\\.?(?=\\s|$)", "Gobernador"},
        {"(?i)\\bPROF\\.?(?=\\s|$)", "Profesor"},
        {"(?i)\\bING\\.?(?=\\s|$)", "Ingeniero"},
        {"(?i)\\bPJE\\.?(?=\\s|$)", "Pasaje"},
        {"(?i)\\bPZA\\.?(?=\\s|$)", "Plaza"},
        {"(?i)\\bPLZA\\.?(?=\\s|$)", "Plaza"},
        {"(?i)\\bHOSP\\.?(?=\\s|$)", "Hospital"},
        {"(?i)\\bESC\\.?(?=\\s|$)", "Escuela"},
        {"(?i)\\bFAC\\.?(?=\\s|$)", "Facultad"},
        {"(?i)\\bBV\\.?(?=\\s|$)", "Bulevar"},
        {"(?i)\\bUNNE\\b", "Unne"}
    };

    private SpanishTtsFormatter() {}

    public static String number0to99(int n) {
        int clamped = Math.max(0, Math.min(99, n));
        if (clamped < 30) return UNITS[clamped];
        int t = clamped / 10;
        int u = clamped % 10;
        return u == 0 ? TENS[t] : TENS[t] + " y " + UNITS[u];
    }

    public static String number0to999(int n) {
        int clamped = Math.max(0, Math.min(999, n));
        if (clamped < 100) return number0to99(clamped);
        if (clamped == 100) return "cien";
        int h = clamped / 100;
        int rem = clamped % 100;
        return rem == 0 ? HUNDREDS[h] : HUNDREDS[h] + " " + number0to99(rem);
    }

    private static String speakTwoDigitPair(String pair) {
        if ("00".equals(pair)) return "cero cero";
        if (pair.charAt(0) == '0') return "cero " + UNITS[pair.charAt(1) - '0'];
        return number0to99(Integer.parseInt(pair));
    }

    public static String formatCoche(String rawCoche) {
        if (rawCoche == null) return "";
        String clean = rawCoche.replaceFirst("^#", "").trim();
        if (clean.isEmpty()) return "";
        Matcher m = COCHE_PATTERN.matcher(clean);
        if (!m.matches()) return clean;

        String digits = m.group(1);
        String suffix = m.group(2) != null && !m.group(2).isEmpty()
            ? " " + m.group(2).toUpperCase(ES_AR)
            : "";

        int len = digits.length();
        if (len == 4) {
            return speakTwoDigitPair(digits.substring(0, 2)) + " " + speakTwoDigitPair(digits.substring(2, 4)) + suffix;
        }
        if (len == 3) {
            return UNITS[digits.charAt(0) - '0'] + " " + speakTwoDigitPair(digits.substring(1)) + suffix;
        }
        if (len == 2) {
            return speakTwoDigitPair(digits) + suffix;
        }
        if (len == 1) {
            return UNITS[digits.charAt(0) - '0'] + suffix;
        }

        StringBuilder sb = new StringBuilder();
        int idx = 0;
        if (len % 2 == 1) {
            sb.append(UNITS[digits.charAt(0) - '0']);
            idx = 1;
        }
        while (idx < len) {
            if (sb.length() > 0) sb.append(' ');
            sb.append(speakTwoDigitPair(digits.substring(idx, idx + 2)));
            idx += 2;
        }
        sb.append(suffix);
        return sb.toString();
    }

    public static String formatLinea(String rawLinea) {
        if (rawLinea == null) return "";
        String clean = rawLinea.trim();
        if (clean.isEmpty()) return "";
        Matcher m = LINEA_PATTERN.matcher(clean);
        if (!m.matches()) return clean;
        String numWord = number0to999(Integer.parseInt(m.group(1)));
        String letter = m.group(2) != null && !m.group(2).isEmpty()
            ? " " + m.group(2).toUpperCase(ES_AR)
            : "";
        return numWord + letter;
    }

    public static String formatStopName(String rawName) {
        if (rawName == null || rawName.trim().isEmpty()) return "próxima parada";
        String s = rawName.trim();
        s = s.replaceAll("(?i)\\s*\\((?:IDA|VTA|VUELTA|REG|REGRESO)\\)\\s*$", "");
        s = s.replaceAll("(?i)\\s+(?:IDA|VTA|VUELTA|REG|REGRESO)\\s*$", "");
        s = s.replaceAll("\\s*[-–—/]\\s*", " y ");
        for (String[] pair : STOP_ABBREVS) {
            s = s.replaceAll(pair[0], pair[1]);
        }
        s = s.replaceAll("\\s+", " ").trim();

        String[] words = s.split("\\s+");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < words.length; i++) {
            String w = words[i];
            if (w.isEmpty()) continue;
            if (out.length() > 0) out.append(' ');
            if (Character.isDigit(w.charAt(0))) {
                out.append(w);
            } else {
                String lower = w.toLowerCase(ES_AR);
                if (i > 0 && LOWER_WORDS.contains(lower)) {
                    out.append(lower);
                } else {
                    out.append(lower.substring(0, 1).toUpperCase(ES_AR)).append(lower.substring(1));
                }
            }
        }
        return out.toString();
    }

    public static String buildArrivalSpeech(String lineName, String coche, int etaMin, String stopName) {
        StringBuilder sb = new StringBuilder();
        if (lineName != null && !lineName.trim().isEmpty()) {
            sb.append("Línea ").append(formatLinea(lineName));
        } else {
            sb.append("Colectivo");
        }
        if (coche != null && !coche.trim().isEmpty()) {
            sb.append(", coche ").append(formatCoche(coche));
        }
        if (etaMin <= 0) {
            sb.append(", arribando ahora");
        } else if (etaMin == 1) {
            sb.append(", a un minuto");
        } else {
            sb.append(", a ").append(etaMin).append(" minutos");
        }
        if (stopName != null && !stopName.trim().isEmpty()) {
            sb.append(" en ").append(formatStopName(stopName));
        }
        sb.append(".");
        return sb.toString();
    }

    public static String buildUberProgressBar(double progress01, int segments) {
        double p = Math.max(0.0, Math.min(1.0, Double.isFinite(progress01) ? progress01 : 0.0));
        int segs = Math.max(6, Math.min(20, segments));
        int pos = (int) Math.round(p * segs);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < pos; i++) sb.append('━');
        sb.append("🚌");
        for (int i = pos; i < segs; i++) sb.append('─');
        sb.append('◉');
        return sb.toString();
    }

    public static String shortLabel(String text, int maxLen) {
        String clean = formatStopName(text);
        if (clean.length() <= maxLen) return clean;
        return clean.substring(0, Math.max(1, maxLen - 1)).trim() + "…";
    }

    public static String formatDistance(double meters) {
        int m = (int) Math.max(0, Math.round(meters));
        if (m < 1000) return m + " m";
        return String.format(ES_AR, "%.1f km", m / 1000.0);
    }

    public static int formatBlocks(double meters) {
        return Math.max(1, (int) Math.round(Math.max(0, meters) / 100.0));
    }
}
