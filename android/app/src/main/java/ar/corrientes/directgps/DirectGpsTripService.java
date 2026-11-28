package ar.corrientes.directgps;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android Foreground Service nativo de DIRECT GPS (v3.0.1).
 * Funciona de forma autónoma con la app minimizada, pantalla apagada o COMPLETAMENTE CERRADA:
 *  - Notificaciones en tiempo real que se ACTUALIZAN EN EL LUGAR (nunca duplican tarjetas)
 *    con barra de progreso recta estilo Uber EXCLUSIVA para arribos (izquierda -> derecha)
 *    impulsada por simulación EN VIVO continua cada 2 s (sin saltos del último GPS).
 *  - Soporta múltiples campanitas de parada simultáneas persistidas en SharedPreferences
 *    (no se apagan ni dejan de leer TTS al salir o cerrar la app).
 *  - Timbre real elegido del celular + vibración + motor nativo TextToSpeech (es-AR) auto-reparador.
 *  - Modo A Bordo (Subir/Bajar) limpio sin barra recta, con LocationManager nativo anunciando
 *    "Arribando, <parada>." en cada próxima parada.
 */
public class DirectGpsTripService extends Service implements TextToSpeech.OnInitListener, LocationListener {

    private static final String TAG = "DirectGpsTripService";
    private static final String PREFS_NAME = "directgps_fg_prefs_v1";
    private static final String KEY_WATCHES_JSON = "watches_json";
    private static final String KEY_PREFS_JSON = "user_prefs_json";
    private static final String KEY_PRIMARY_JSON = "primary_trip_json";
    private static final String KEY_RINGTONE_URI = "custom_ringtone_uri";
    private static final String KEY_RINGTONE_TITLE = "custom_ringtone_title";

    public static final String CHANNEL_LIVE_SILENT = "direct_gps_trip_live_v1";
    public static final String CHANNEL_ALERTS_SOUND = "direct_gps_alerts_sound_v1";

    public static final int NOTIF_ID_LIVE_TRIP = 4101;
    public static final int NOTIF_ID_ALERT_BASE = 4200;
    public static final int NOTIF_ID_WATCH_BASE = 4300;

    public static final String ACTION_START_WAITING = "ar.corrientes.directgps.ACTION_START_WAITING";
    public static final String ACTION_UPDATE_WAITING = "ar.corrientes.directgps.ACTION_UPDATE_WAITING";
    public static final String ACTION_BOARD = "ar.corrientes.directgps.ACTION_BOARD";
    public static final String ACTION_BOARD_NOW = "ar.corrientes.directgps.ACTION_BOARD_NOW";
    public static final String ACTION_ALIGHT = "ar.corrientes.directgps.ACTION_ALIGHT";
    public static final String ACTION_STOP = "ar.corrientes.directgps.ACTION_STOP";
    public static final String ACTION_SYNC_PREFS = "ar.corrientes.directgps.ACTION_SYNC_PREFS";
    public static final String ACTION_SEND_ALERT = "ar.corrientes.directgps.ACTION_SEND_ALERT";
    public static final String ACTION_SPEAK_ONLY = "ar.corrientes.directgps.ACTION_SPEAK_ONLY";
    public static final String ACTION_UPSERT_WATCH = "ar.corrientes.directgps.ACTION_UPSERT_WATCH";
    public static final String ACTION_REMOVE_WATCH = "ar.corrientes.directgps.ACTION_REMOVE_WATCH";
    public static final String ACTION_CLEAR_WATCHES = "ar.corrientes.directgps.ACTION_CLEAR_WATCHES";
    public static final String ACTION_ENSURE_ALIVE = "ar.corrientes.directgps.ACTION_ENSURE_ALIVE";
    public static final String ACTION_RESTORE_WATCHDOG = "ar.corrientes.directgps.ACTION_RESTORE_WATCHDOG";
    public static final String ACTION_HEARTBEAT_POLL = "ar.corrientes.directgps.ACTION_HEARTBEAT_POLL";

    public static final String EXTRA_PAYLOAD = "payload";
    public static final String EXTRA_WATCH_KEY = "watch_key";

    private static final Pattern ETA_MIN_PATTERN = Pattern.compile("(\\d+)");
    private static final Pattern GPS_STAMP_PATTERN = Pattern.compile(
        "^(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s+(\\d{1,2}):(\\d{2}):(\\d{2})$"
    );

    public interface StateListener {
        void onTripStateChanged(JSONObject snapshot);
        void onWatchedAlertsChanged(JSONArray alerts);
    }

    private static volatile StateListener stateListener = null;
    private static volatile JSONObject lastKnownSnapshot = null;
    private static volatile boolean serviceRunning = false;

    public static void setStateListener(@Nullable StateListener listener) {
        stateListener = listener;
    }

    public static boolean isServiceRunning() {
        return serviceRunning;
    }

    @Nullable
    public static JSONObject getLastKnownSnapshot() {
        return lastKnownSnapshot;
    }

    public static void saveCustomRingtone(Context ctx, @Nullable String uriStr, @Nullable String title) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            sp.edit()
                .putString(KEY_RINGTONE_URI, uriStr != null ? uriStr : "")
                .putString(KEY_RINGTONE_TITLE, title != null ? title : "")
                .apply();
        } catch (Exception ignored) {}
    }

    public static String getCustomRingtoneUri(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return sp.getString(KEY_RINGTONE_URI, "");
        } catch (Exception e) {
            return "";
        }
    }

    public static String getCustomRingtoneTitle(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String t = sp.getString(KEY_RINGTONE_TITLE, "");
            if (t != null && !t.isEmpty()) return t;
            Uri defUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            Ringtone r = defUri != null ? RingtoneManager.getRingtone(ctx, defUri) : null;
            String sysTitle = r != null ? r.getTitle(ctx) : "";
            return (sysTitle != null && !sysTitle.isEmpty()) ? sysTitle + " (predeterminado)" : "Timbre predeterminado del teléfono";
        } catch (Exception e) {
            return "Timbre predeterminado del teléfono";
        }
    }

    /**
     * Lee las campanitas activas directamente desde SharedPreferences (útil incluso si el servicio
     * aún no recibió un intent en esta sesión).
     */
    public static JSONArray loadPersistedWatchesArray(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY_WATCHES_JSON, "[]");
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /**
     * Indica si existen campanitas o un viaje activo persistido que deba sobrevivir al minimizar/cerrar.
     */
    public static boolean hasPersistedActiveWork(Context ctx) {
        try {
            if (loadPersistedWatchesArray(ctx).length() > 0) return true;
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONObject primary = new JSONObject(sp.getString(KEY_PRIMARY_JSON, "{}"));
            String p = primary.optString("phase", "idle");
            return !"idle".equals(p) && !p.isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private static final class RouteStop {
        final String id;
        final String nombre;
        final String cleanName;
        final double lat;
        final double lng;
        final double along;

        RouteStop(String id, String nombre, double lat, double lng, double along) {
            this.id = id;
            this.nombre = nombre;
            this.cleanName = SpanishTtsFormatter.formatStopName(nombre);
            this.lat = lat;
            this.lng = lng;
            this.along = along;
        }
    }

    private static final class WatchAlert {
        String key;
        String stopId;
        String stopName;
        double stopLat;
        double stopLng;
        String lineName;
        int codLinea;
        String coche;
        boolean lockCar;
        String choferNombre;
        String scheduledHHMM;
        double distM = -1;
        double initialDistM = 2600;
        int etaMin = -1;
        double simEtaSec = -1;
        double simSpeedMps = 5.5;
        long simLastTickMs = 0;
        long lastRawGpsMs = 0;
        double lastRawDistM = -1;
        long lastJsSimMs = 0;
        double progress01 = 0.08;
        double lastRenderedProgress01 = -1;
        double lastRenderedDistM = -999;
        int lastRenderedEtaMin = -999;
        int leadMin = 3;
        boolean triggered = false;
        Integer lastSpokenEtaMin = null;
        boolean wasClose = false;
        int missingPolls = 0;
        int notifId;

        JSONObject toJson() {
            JSONObject o = new JSONObject();
            try {
                o.put("key", key);
                o.put("stopId", stopId);
                o.put("stopName", stopName);
                o.put("stopLat", stopLat);
                o.put("stopLng", stopLng);
                o.put("lineName", lineName);
                o.put("codLinea", codLinea);
                o.put("coche", coche);
                o.put("lockCar", lockCar);
                o.put("choferNombre", choferNombre);
                o.put("scheduledHHMM", scheduledHHMM);
                o.put("distM", distM);
                o.put("initialDistM", initialDistM);
                o.put("etaMin", etaMin);
                o.put("simEtaSec", simEtaSec);
                o.put("simSpeedMps", simSpeedMps);
                o.put("progress01", progress01);
                o.put("leadMin", leadMin);
                o.put("triggered", triggered);
                o.put("lastSpokenEtaMin", lastSpokenEtaMin != null ? lastSpokenEtaMin : JSONObject.NULL);
                o.put("wasClose", wasClose);
                o.put("notifId", notifId);
            } catch (Exception ignored) {}
            return o;
        }

        static WatchAlert fromJson(JSONObject o) {
            WatchAlert w = new WatchAlert();
            w.key = o.optString("key", "").trim();
            w.stopId = o.optString("stopId", "").trim().toUpperCase(Locale.ROOT);
            w.stopName = o.optString("stopName", w.stopId);
            w.stopLat = o.optDouble("stopLat", 0);
            w.stopLng = o.optDouble("stopLng", 0);
            w.lineName = o.optString("lineName", "").trim();
            w.codLinea = o.optInt("codLinea", 0);
            w.coche = o.optString("coche", "").trim();
            w.lockCar = o.optBoolean("lockCar", false);
            w.choferNombre = o.optString("choferNombre", "").trim();
            w.scheduledHHMM = sanitizeScheduledHHMM(o.optString("scheduledHHMM", ""));
            w.distM = o.optDouble("distM", -1);
            w.initialDistM = Math.max(900, o.optDouble("initialDistM", 2600));
            w.etaMin = o.optInt("etaMin", -1);
            w.simEtaSec = o.optDouble("simEtaSec", w.etaMin >= 0 ? w.etaMin * 60.0 : -1);
            w.simSpeedMps = Math.max(1.5, Math.min(14.0, o.optDouble("simSpeedMps", 5.5)));
            w.simLastTickMs = System.currentTimeMillis();
            w.progress01 = o.optDouble("progress01", 0.08);
            w.leadMin = Math.max(1, o.optInt("leadMin", 3));
            w.triggered = o.optBoolean("triggered", false);
            if (!o.isNull("lastSpokenEtaMin") && o.has("lastSpokenEtaMin")) {
                w.lastSpokenEtaMin = o.optInt("lastSpokenEtaMin");
            }
            w.wasClose = o.optBoolean("wasClose", false);
            w.notifId = o.optInt("notifId", NOTIF_ID_WATCH_BASE + Math.abs(w.key.hashCode() % 600));
            return w;
        }
    }

    private NotificationManager notifManager;
    private LocationManager locationManager;
    private AudioManager audioManager;
    private PowerManager.WakeLock wakeLock;
    private PowerManager.WakeLock ttsWakeLock;
    private AudioFocusRequest audioFocusRequest;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile boolean ttsInitializing = false;
    private final List<String> pendingInitSpeeches = java.util.Collections.synchronizedList(new ArrayList<>());
    private final Map<String, ScheduledFuture<?>> utteranceWatchdogs = new java.util.concurrent.ConcurrentHashMap<>();
    private final Map<String, String> activeUtteranceTexts = new java.util.concurrent.ConcurrentHashMap<>();
    private final Set<String> retriedUtterances = java.util.Collections.synchronizedSet(new HashSet<>());

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<ScheduledFuture<?>> scheduledSpeechFutures = java.util.Collections.synchronizedList(new ArrayList<>());
    private ScheduledExecutorService speechExecutor;
    private long lastChimeMs = 0;
    private volatile long lastPollCompletedMs = 0;

    private ScheduledExecutorService pollExecutor;
    private ScheduledFuture<?> pollFuture;
    private ScheduledFuture<?> simTickerFuture;

    private int activeForegroundNotifId = 0;

    // ── Persisted Stop Bells (campanitas en vivo que se actualizan en el lugar) ──
    private final Map<String, WatchAlert> watchedAlerts = java.util.Collections.synchronizedMap(new LinkedHashMap<>());

    // ── Primary Trip State (selected line tracking / Subir / A Bordo) ─────────
    private String phase = "idle"; // idle | waiting | boarding_armed | onboard
    private String apiBase = "https://direct-gps-proxy.cristiantmassa.workers.dev";
    private String lineName = "";
    private int codLinea = 0;
    private String coche = "";
    private boolean lockCar = false;
    private String choferNombre = "";
    private String choferLegajo = "";
    private String bandera = "";
    private String scheduledHHMM = ""; // Hora programada REAL (nunca estimada)

    private String stopId = "";
    private String stopName = "";
    private double stopLat = 0;
    private double stopLng = 0;

    private double initialDistM = 2600;
    private double distM = -1;
    private int etaMin = -1;
    private double primarySimEtaSec = -1;
    private double primarySimSpeedMps = 5.5;
    private long primarySimLastTickMs = 0;
    private long primaryLastRawGpsMs = 0;
    private double primaryLastRawDistM = -1;
    private long primaryLastJsSimMs = 0;
    private Integer lastSpokenEtaMin = null;
    private boolean wasCloseToStop = false;
    private double progress01 = 0.08;
    private double primaryLastRenderedProgress01 = -1;
    private double primaryLastRenderedDistM = -999;
    private int primaryLastRenderedEtaMin = -999;

    private final List<RouteStop> orderedStops = new ArrayList<>();
    private final Set<String> announcedStopIds = new HashSet<>();
    private int nextStopIdx = 0;
    private double prevStopDistRef = 350;
    private double distToNextM = -1;
    private boolean arrivingNow = false;
    private boolean gpsListening = false;

    private boolean minuteByMinute = false;
    private boolean ttsEnabled = false;
    private boolean soundEnabled = true;
    private int leadMin = 3;
    private float ttsSpeechRate = 1.02f;
    private boolean ttsSpeakInDnd = true;

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        notifManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createNotificationChannels();
        pollExecutor = Executors.newSingleThreadScheduledExecutor();
        speechExecutor = Executors.newSingleThreadScheduledExecutor();
        restorePersistedState();
        initTts();
    }

    private synchronized void ensureWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "directgps:LiveBackgroundWakeLock");
                wakeLock.setReferenceCounted(false);
            }
            // Renovar 15 minutos en cada ciclo de sondeo; se libera apenas queda sin tareas activas
            wakeLock.acquire(15 * 60 * 1000L);
        } catch (Exception e) {
            Log.w(TAG, "WakeLock acquire skipped", e);
        }
    }

    private synchronized void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    private synchronized void acquireTtsWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (ttsWakeLock == null) {
                ttsWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "directgps:TtsSpeechWakeLock");
                ttsWakeLock.setReferenceCounted(false);
            }
            ttsWakeLock.acquire(25_000L);
        } catch (Exception ignored) {}
    }

    private synchronized void releaseTtsWakeLock() {
        try {
            if (ttsWakeLock != null && ttsWakeLock.isHeld()) {
                ttsWakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    private void restorePersistedState() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONObject prefs = new JSONObject(sp.getString(KEY_PREFS_JSON, "{}"));
            if (prefs.has("minuteByMinute")) minuteByMinute = prefs.optBoolean("minuteByMinute", minuteByMinute);
            if (prefs.has("ttsEnabled")) ttsEnabled = prefs.optBoolean("ttsEnabled", ttsEnabled);
            if (prefs.has("soundEnabled")) soundEnabled = prefs.optBoolean("soundEnabled", soundEnabled);
            if (prefs.has("leadMin")) leadMin = Math.max(1, prefs.optInt("leadMin", leadMin));
            if (prefs.has("ttsSpeechRate")) {
                ttsSpeechRate = (float) Math.max(0.75, Math.min(1.35, prefs.optDouble("ttsSpeechRate", 1.02)));
            }
            if (prefs.has("ttsSpeakInDnd")) ttsSpeakInDnd = prefs.optBoolean("ttsSpeakInDnd", true);
            String savedBase = prefs.optString("apiBase", "").trim();
            if (!savedBase.isEmpty()) apiBase = savedBase.replaceAll("/+$", "");

            JSONArray arr = new JSONArray(sp.getString(KEY_WATCHES_JSON, "[]"));
            synchronized (watchedAlerts) {
                watchedAlerts.clear();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    WatchAlert w = WatchAlert.fromJson(o);
                    if (!w.key.isEmpty() && !w.stopId.isEmpty() && !w.lineName.isEmpty()) {
                        watchedAlerts.put(w.key, w);
                    }
                }
            }

            // Restaurar también el viaje principal (waiting / boarding_armed / onboard)
            JSONObject primary = new JSONObject(sp.getString(KEY_PRIMARY_JSON, "{}"));
            String savedPhase = primary.optString("phase", "idle");
            if (!"idle".equals(savedPhase) && !savedPhase.isEmpty()) {
                phase = savedPhase;
                lineName = primary.optString("lineName", "");
                codLinea = primary.optInt("codLinea", 0);
                coche = primary.optString("coche", "");
                lockCar = primary.optBoolean("lockCar", false);
                choferNombre = primary.optString("choferNombre", "");
                choferLegajo = primary.optString("choferLegajo", "");
                bandera = primary.optString("bandera", "");
                scheduledHHMM = sanitizeScheduledHHMM(primary.optString("scheduledHHMM", ""));
                stopId = primary.optString("stopId", "");
                stopName = primary.optString("stopName", "");
                stopLat = primary.optDouble("stopLat", 0);
                stopLng = primary.optDouble("stopLng", 0);
                initialDistM = Math.max(900, primary.optDouble("initialDistM", 2600));
                distM = primary.optDouble("distM", -1);
                etaMin = primary.optInt("etaMin", -1);
                progress01 = primary.optDouble("progress01", 0.08);
                wasCloseToStop = primary.optBoolean("wasCloseToStop", false);
                if (!primary.isNull("lastSpokenEtaMin") && primary.has("lastSpokenEtaMin")) {
                    lastSpokenEtaMin = primary.optInt("lastSpokenEtaMin");
                }
                nextStopIdx = Math.max(0, primary.optInt("nextStopIdx", 0));
                loadOrderedStopsFromJson(primary.optJSONArray("orderedStops"));
                announcedStopIds.clear();
                JSONArray ann = primary.optJSONArray("announcedStopIds");
                if (ann != null) {
                    for (int i = 0; i < ann.length(); i++) {
                        String id = ann.optString(i, "");
                        if (!id.isEmpty()) announcedStopIds.add(id);
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed restoring persisted state", e);
        }
    }

    private void persistState() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONObject prefs = new JSONObject();
            prefs.put("minuteByMinute", minuteByMinute);
            prefs.put("ttsEnabled", ttsEnabled);
            prefs.put("soundEnabled", soundEnabled);
            prefs.put("leadMin", leadMin);
            prefs.put("ttsSpeechRate", ttsSpeechRate);
            prefs.put("ttsSpeakInDnd", ttsSpeakInDnd);
            prefs.put("apiBase", apiBase);

            JSONArray arr = new JSONArray();
            synchronized (watchedAlerts) {
                for (WatchAlert w : watchedAlerts.values()) {
                    arr.put(w.toJson());
                }
            }

            JSONObject primary = new JSONObject();
            primary.put("phase", phase);
            if (!"idle".equals(phase)) {
                primary.put("lineName", lineName);
                primary.put("codLinea", codLinea);
                primary.put("coche", coche);
                primary.put("lockCar", lockCar);
                primary.put("choferNombre", choferNombre);
                primary.put("choferLegajo", choferLegajo);
                primary.put("bandera", bandera);
                primary.put("scheduledHHMM", scheduledHHMM);
                primary.put("stopId", stopId);
                primary.put("stopName", stopName);
                primary.put("stopLat", stopLat);
                primary.put("stopLng", stopLng);
                primary.put("initialDistM", initialDistM);
                primary.put("distM", distM);
                primary.put("etaMin", etaMin);
                primary.put("progress01", progress01);
                primary.put("wasCloseToStop", wasCloseToStop);
                primary.put("lastSpokenEtaMin", lastSpokenEtaMin != null ? lastSpokenEtaMin : JSONObject.NULL);
                primary.put("nextStopIdx", nextStopIdx);
                JSONArray stopsArr = new JSONArray();
                for (RouteStop rs : orderedStops) {
                    JSONObject so = new JSONObject();
                    so.put("id", rs.id);
                    so.put("nombre", rs.nombre);
                    so.put("lat", rs.lat);
                    so.put("lng", rs.lng);
                    so.put("along", rs.along);
                    stopsArr.put(so);
                }
                primary.put("orderedStops", stopsArr);
                JSONArray annArr = new JSONArray();
                for (String aid : announcedStopIds) annArr.put(aid);
                primary.put("announcedStopIds", annArr);
            }

            sp.edit()
                .putString(KEY_PREFS_JSON, prefs.toString())
                .putString(KEY_WATCHES_JSON, arr.toString())
                .putString(KEY_PRIMARY_JSON, primary.toString())
                .apply();

            DirectGpsWidgetProvider.updateAllWidgets(getApplicationContext());
        } catch (Exception e) {
            Log.w(TAG, "Failed persisting state", e);
        }
    }

    private synchronized void initTts() {
        if (ttsInitializing) return;
        ttsInitializing = true;
        ttsReady = false;
        try {
            tts = new TextToSpeech(getApplicationContext(), this);
        } catch (Exception e) {
            ttsInitializing = false;
            Log.w(TAG, "TTS init failed", e);
        }
    }

    private synchronized void reinitTtsEngine() {
        ttsReady = false;
        ttsInitializing = false;
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {}
            tts = null;
        }
        initTts();
    }

    private AudioAttributes buildTtsAudioAttributes() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    }

    @Override
    public void onInit(int status) {
        ttsInitializing = false;
        if (status == TextToSpeech.SUCCESS && tts != null) {
            int res = tts.setLanguage(new Locale("es", "AR"));
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                res = tts.setLanguage(new Locale("es", "ES"));
            }
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(new Locale("es"));
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                try {
                    tts.setAudioAttributes(buildTtsAudioAttributes());
                } catch (Exception ignored) {}
            }
            tts.setSpeechRate(ttsSpeechRate);
            tts.setPitch(1.0f);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    ScheduledFuture<?> wd = utteranceWatchdogs.remove(utteranceId);
                    if (wd != null) wd.cancel(false);
                }

                @Override
                public void onDone(String utteranceId) {
                    ScheduledFuture<?> wd = utteranceWatchdogs.remove(utteranceId);
                    if (wd != null) wd.cancel(false);
                    activeUtteranceTexts.remove(utteranceId);
                    retriedUtterances.remove(utteranceId);
                    if (activeUtteranceTexts.isEmpty()) {
                        abandonAudioFocus();
                        releaseTtsWakeLock();
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    ScheduledFuture<?> wd = utteranceWatchdogs.remove(utteranceId);
                    if (wd != null) wd.cancel(false);
                    String failedText = activeUtteranceTexts.remove(utteranceId);
                    if (failedText != null && retriedUtterances.add(utteranceId)) {
                        // El motor TTS del SO se había dormido/desvinculado: reinicializar y reintentar 1 vez
                        Log.w(TAG, "TTS utterance error -> recreating engine & retrying");
                        pendingInitSpeeches.add(failedText);
                        reinitTtsEngine();
                        return;
                    }
                    retriedUtterances.remove(utteranceId);
                    if (activeUtteranceTexts.isEmpty()) {
                        abandonAudioFocus();
                        releaseTtsWakeLock();
                    }
                }
            });
            ttsReady = true;
            List<String> copy;
            synchronized (pendingInitSpeeches) {
                copy = new ArrayList<>(pendingInitSpeeches);
                pendingInitSpeeches.clear();
            }
            for (String txt : copy) {
                speakNow(txt, true);
            }
        } else {
            ttsReady = false;
            releaseTtsWakeLock();
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notifManager == null) return;

        NotificationChannel liveChannel = new NotificationChannel(
            CHANNEL_LIVE_SILENT,
            "Seguimiento en vivo (actualización en tiempo real)",
            NotificationManager.IMPORTANCE_LOW
        );
        liveChannel.setDescription("Actualiza en el lugar el avance y los minutos de tus colectivos sin duplicar notificaciones.");
        liveChannel.setSound(null, null);
        liveChannel.enableVibration(false);
        liveChannel.setShowBadge(false);
        notifManager.createNotificationChannel(liveChannel);

        NotificationChannel alertChannel = new NotificationChannel(
            CHANNEL_ALERTS_SOUND,
            "Alertas de arribo y paradas (timbre)",
            NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("Suena con el timbre de tu celular al acercarse un colectivo o llegar a una parada.");
        Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        alertChannel.setSound(defaultSound, attrs);
        alertChannel.enableVibration(true);
        alertChannel.setVibrationPattern(new long[]{0, 160, 80, 160});
        notifManager.createNotificationChannel(alertChannel);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private boolean hasAnyActiveWork() {
        return !"idle".equals(phase) || !watchedAlerts.isEmpty();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Mantener el servicio activo aunque el usuario deslice la app desde recientes (Samsung One UI, MIUI, Android)
        if (hasAnyActiveWork()) {
            persistState();
            ensureWakeLock();
            ensurePollingRunning();
            scheduleWatchdogRestart();
        }
        super.onTaskRemoved(rootIntent);
    }

    private void scheduleWatchdogRestart() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent restartIntent = new Intent(getApplicationContext(), DirectGpsTripService.class);
            restartIntent.setAction(ACTION_RESTORE_WATCHDOG);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? PendingIntent.getForegroundService(getApplicationContext(), 901, restartIntent, flags)
                : PendingIntent.getService(getApplicationContext(), 901, restartIntent, flags);
            long triggerAt = SystemClock.elapsedRealtime() + 1200L;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "Watchdog restart schedule skipped", e);
        }
    }

    private void scheduleDozeHeartbeat() {
        try {
            if (!hasAnyActiveWork()) return;
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent hbIntent = new Intent(getApplicationContext(), DirectGpsTripService.class);
            hbIntent.setAction(ACTION_HEARTBEAT_POLL);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? PendingIntent.getForegroundService(getApplicationContext(), 902, hbIntent, flags)
                : PendingIntent.getService(getApplicationContext(), 902, hbIntent, flags);
            long triggerAt = SystemClock.elapsedRealtime() + 30_000L;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (Exception e) {
            Log.d(TAG, "Doze heartbeat schedule skipped: " + e.getMessage());
        }
    }

    private void cancelDozeHeartbeat() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent hbIntent = new Intent(getApplicationContext(), DirectGpsTripService.class);
            hbIntent.setAction(ACTION_HEARTBEAT_POLL);
            int flags = PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? PendingIntent.getForegroundService(getApplicationContext(), 902, hbIntent, flags)
                : PendingIntent.getService(getApplicationContext(), 902, hbIntent, flags);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        } catch (Exception ignored) {}
    }

    private void resumeActiveWorkNow() {
        if (!hasAnyActiveWork()) return;
        ensureWakeLock();
        refreshAllNotificationsAndForeground();
        if ("onboard".equals(phase)) {
            startGpsUpdates();
        }
        ensurePollingRunning();
        scheduleDozeHeartbeat();
        broadcastSnapshot();
        broadcastWatches();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent == null) {
            // Reinicio automático del SO (START_STICKY): reanudar campanitas y/o viaje activo persistidos
            if (hasAnyActiveWork()) {
                resumeActiveWorkNow();
                return START_STICKY;
            }
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        JSONObject payload = parsePayload(intent.getStringExtra(EXTRA_PAYLOAD));

        if (ACTION_HEARTBEAT_POLL.equals(action)) {
            if (!hasAnyActiveWork()) restorePersistedState();
            if (hasAnyActiveWork()) {
                ensureWakeLock();
                ensurePollingRunning();
                scheduleDozeHeartbeat();
                // Si el SO durmió el executor por > 18s, disparar un sondeo inmediato despertado por AlarmManager
                if (System.currentTimeMillis() - lastPollCompletedMs > 18_000L && pollExecutor != null && !pollExecutor.isShutdown()) {
                    pollExecutor.execute(this::pollAllTargetsSafe);
                }
                return START_STICKY;
            }
            stopForegroundAndIdle();
            return START_NOT_STICKY;
        } else if (ACTION_ENSURE_ALIVE.equals(action) || ACTION_RESTORE_WATCHDOG.equals(action)) {
            if (!hasAnyActiveWork()) {
                restorePersistedState();
            }
            if (hasAnyActiveWork()) {
                resumeActiveWorkNow();
                return START_STICKY;
            }
            stopForegroundAndIdle();
            return START_NOT_STICKY;
        } else if (ACTION_UPSERT_WATCH.equals(action)) {
            handleUpsertWatch(payload);
        } else if (ACTION_REMOVE_WATCH.equals(action)) {
            String key = intent.getStringExtra(EXTRA_WATCH_KEY);
            if (key == null || key.isEmpty()) key = payload.optString("key", "");
            handleRemoveWatch(key);
        } else if (ACTION_CLEAR_WATCHES.equals(action)) {
            handleClearWatches();
        } else if (ACTION_START_WAITING.equals(action)) {
            handleStartWaiting(payload);
        } else if (ACTION_UPDATE_WAITING.equals(action)) {
            handleUpdateWaitingFromJs(payload);
        } else if (ACTION_BOARD.equals(action)) {
            handleRequestBoard(payload, false);
        } else if (ACTION_BOARD_NOW.equals(action)) {
            handleRequestBoard(payload, true);
        } else if (ACTION_ALIGHT.equals(action)) {
            handleAlight(false);
        } else if (ACTION_STOP.equals(action)) {
            handleAlight(payload != null && payload.optBoolean("silent", false));
        } else if (ACTION_SYNC_PREFS.equals(action)) {
            applyPrefs(payload);
            persistState();
            if (hasAnyActiveWork()) {
                ensureWakeLock();
                refreshAllNotificationsAndForeground();
                broadcastSnapshot();
            }
        } else if (ACTION_SEND_ALERT.equals(action)) {
            handleStandaloneAlert(payload);
            if (!hasAnyActiveWork()) {
                mainHandler.postDelayed(() -> {
                    if (!hasAnyActiveWork()) stopSelf();
                }, 9000);
                return START_NOT_STICKY;
            }
        } else if (ACTION_SPEAK_ONLY.equals(action)) {
            String txt = payload != null ? payload.optString("text", "") : "";
            long delayMs = payload != null ? payload.optLong("delayMs", 0) : 0;
            if (!txt.isEmpty()) {
                scheduleSpeech(txt, delayMs, false);
            }
            if (!hasAnyActiveWork()) {
                mainHandler.postDelayed(() -> {
                    if (!hasAnyActiveWork()) stopSelf();
                }, delayMs + 9000);
                return START_NOT_STICKY;
            }
        }

        if (!hasAnyActiveWork()) {
            stopForegroundAndIdle();
            return START_NOT_STICKY;
        }
        ensureWakeLock();
        return START_STICKY;
    }

    private JSONObject parsePayload(@Nullable String raw) {
        if (raw == null || raw.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private void applyPrefs(JSONObject p) {
        if (p == null) return;
        if (p.has("minuteByMinute")) minuteByMinute = p.optBoolean("minuteByMinute", minuteByMinute);
        if (p.has("ttsEnabled")) ttsEnabled = p.optBoolean("ttsEnabled", ttsEnabled);
        if (p.has("soundEnabled")) soundEnabled = p.optBoolean("soundEnabled", soundEnabled);
        if (p.has("leadMin")) leadMin = Math.max(1, p.optInt("leadMin", leadMin));
        if (p.has("ttsSpeechRate")) {
            ttsSpeechRate = (float) Math.max(0.75, Math.min(1.35, p.optDouble("ttsSpeechRate", ttsSpeechRate)));
            if (tts != null && ttsReady) {
                try {
                    tts.setSpeechRate(ttsSpeechRate);
                } catch (Exception ignored) {}
            }
        }
        if (p.has("ttsSpeakInDnd")) ttsSpeakInDnd = p.optBoolean("ttsSpeakInDnd", ttsSpeakInDnd);
        String base = p.optString("apiBase", "").trim();
        if (!base.isEmpty()) apiBase = base.replaceAll("/+$", "");
    }

    // ── Multi-Watch Stop Bells (campanitas en vivo sin duplicados) ────────────
    private int allocateWatchNotifId(String key) {
        int base = NOTIF_ID_WATCH_BASE + Math.abs(key.hashCode() % 500);
        while (true) {
            boolean collision = (base == NOTIF_ID_LIVE_TRIP);
            if (!collision) {
                for (WatchAlert existing : watchedAlerts.values()) {
                    if (!existing.key.equals(key) && existing.notifId == base) {
                        collision = true;
                        break;
                    }
                }
            }
            if (!collision) return base;
            base++;
        }
    }

    private void handleUpsertWatch(JSONObject p) {
        if (p == null) return;
        applyPrefs(p);

        String wStopId = p.optString("stopId", "").trim().toUpperCase(Locale.ROOT);
        String wLine = p.optString("lineName", "").trim();
        String wCoche = p.optString("coche", "").trim();
        boolean wLockCar = p.optBoolean("lockCar", false);
        String key = p.optString("key", "").trim();
        if (key.isEmpty()) {
            key = wLockCar && !wCoche.isEmpty()
                ? (wStopId + "::" + wLine + "::" + wCoche)
                : (wStopId + "::" + wLine);
        }
        if (wStopId.isEmpty() || wLine.isEmpty()) return;

        WatchAlert w = watchedAlerts.get(key);
        boolean isNew = (w == null);
        if (isNew) {
            w = new WatchAlert();
            w.key = key;
            w.notifId = allocateWatchNotifId(key);
            watchedAlerts.put(key, w);
        }

        w.stopId = wStopId;
        String sn = p.optString("stopName", "").trim();
        if (!sn.isEmpty()) w.stopName = sn;
        else if (w.stopName == null || w.stopName.isEmpty()) w.stopName = wStopId;

        double sLat = p.optDouble("stopLat", Double.NaN);
        double sLng = p.optDouble("stopLng", Double.NaN);
        if (Double.isFinite(sLat) && sLat != 0) w.stopLat = sLat;
        if (Double.isFinite(sLng) && sLng != 0) w.stopLng = sLng;

        w.lineName = wLine;
        int wCod = p.optInt("codLinea", 0);
        if (wCod > 0) w.codLinea = wCod;
        w.lockCar = wLockCar;
        String prevCoche = w.coche != null ? w.coche : "";
        boolean cocheChanged = (!isNew && !prevCoche.isEmpty() && !wCoche.isEmpty() && !prevCoche.equals(wCoche));
        if (!wCoche.isEmpty()) w.coche = wCoche;
        String wDrv = p.optString("choferNombre", "").trim();
        if (!wDrv.isEmpty()) w.choferNombre = wDrv;
        String wSched = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));
        if (!wSched.isEmpty()) w.scheduledHHMM = wSched;
        w.leadMin = Math.max(1, p.optInt("leadMin", leadMin));
        w.missingPolls = 0;

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        double incomingEtaSec = p.optDouble("etaSec", -1);
        double incomingSpeed = p.optDouble("simSpeedMps", -1);
        boolean fromLiveSim = p.optBoolean("fromLiveSim", false);
        updateWatchMetricsAndMaybeAlert(
            w,
            incomingEta,
            incomingDist,
            incomingEtaSec,
            incomingSpeed,
            0L,
            fromLiveSim,
            isNew || cocheChanged
        );

        if (isNew || cocheChanged || !fromLiveSim) {
            persistState();
        }
        refreshAllNotificationsAndForeground();
        ensurePollingRunning();
        if (isNew || cocheChanged) {
            broadcastWatches();
        }
    }

    private static boolean isDistanceCoherentWithEta(double distMeters, int etaMinutes) {
        if (distMeters < 0) return false;
        if (etaMinutes < 5) return true;
        // Velocidad implícita < 1.3 m/s (< 4.7 km/h) delata un cálculo erróneo en línea recta (parada de enfrente)
        double impliedSpeed = distMeters / (etaMinutes * 60.0);
        return impliedSpeed >= 1.3;
    }

    private static double computeInitialReferenceDist(double currentDist, int etaMinutes) {
        double etaRef = etaMinutes > 0 ? Math.max(1200.0, etaMinutes * 260.0) : 2600.0;
        double base = currentDist > 0 ? Math.max(currentDist * 1.12, etaRef) : etaRef;
        return Math.max(1000.0, Math.min(25000.0, base));
    }

    /**
     * Curva continua C1 basada en simulación EN VIVO (distancia simulada + ETA continuo en segundos).
     * Elimina 100 % los escalones bruscos al cambiar de minuto y garantiza orden intuitivo entre colectivos.
     */
    private static double computeSmoothLiveProgress01(double distMeters, double etaSec, int etaMinutes) {
        double effEtaSec = etaSec >= 0 ? etaSec : (etaMinutes >= 0 ? etaMinutes * 60.0 : -1);
        if ((effEtaSec >= 0 && effEtaSec <= 20.0)
            || etaMinutes == 0
            || (distMeters >= 0 && distMeters <= 35.0 && (etaMinutes < 0 || etaMinutes <= 1))) {
            return 1.0;
        }
        double etaProg = effEtaSec >= 0
            ? 1.0 / (1.0 + Math.pow(Math.max(0.0, effEtaSec / 60.0) / 14.0, 1.10))
            : 0.08;
        boolean distOk = distMeters >= 0 && isDistanceCoherentWithEta(distMeters, etaMinutes);
        double distProg = distOk
            ? 1.0 / (1.0 + Math.pow(Math.max(0.0, distMeters) / 3800.0, 1.05))
            : -1.0;
        double raw = distProg >= 0 ? (0.65 * distProg + 0.35 * etaProg) : etaProg;
        return Math.max(0.05, Math.min(0.99, raw));
    }

    private static double easeProgress01(double current, double target, boolean instant) {
        if (instant || !Double.isFinite(current) || current < 0 || Math.abs(target - current) > 0.28) {
            return target;
        }
        double delta = target - current;
        if (delta >= 0) {
            return Math.min(target, current + 0.016);
        }
        // Evitar retrocesos bruscos si el colectivo se detuvo en un semáforo
        return Math.max(target, current - 0.004);
    }

    private static long parseGpsTimestampMs(@Nullable String raw) {
        if (raw == null || raw.trim().isEmpty()) return 0L;
        Matcher m = GPS_STAMP_PATTERN.matcher(raw.trim());
        if (!m.matches()) return 0L;
        try {
            int dd = Integer.parseInt(m.group(1));
            int mm = Integer.parseInt(m.group(2));
            int yyyy = Integer.parseInt(m.group(3));
            int hh = Integer.parseInt(m.group(4));
            int mi = Integer.parseInt(m.group(5));
            int ss = Integer.parseInt(m.group(6));
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("GMT-03:00"));
            cal.clear();
            cal.set(yyyy, mm - 1, dd, hh, mi, ss);
            return cal.getTimeInMillis();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private double resolveRouteDistanceMeters(
        int lineCod,
        String lineLabel,
        String targetStopId,
        double sLat,
        double sLng,
        double bLat,
        double bLng,
        int parsedEta
    ) {
        RouteDistanceCalculator.RouteResult rr = RouteDistanceCalculator.computeRouteDistance(
            this,
            lineCod,
            lineLabel,
            targetStopId,
            sLat,
            sLng,
            bLat,
            bLng,
            parsedEta
        );
        if (rr != null && Double.isFinite(rr.routeMeters) && rr.routeMeters >= 0) {
            return Math.round(rr.routeMeters);
        }
        if (Double.isFinite(bLat) && Double.isFinite(bLng) && Double.isFinite(sLat) && Double.isFinite(sLng) && sLat != 0) {
            double straight = haversineMeters(bLat, bLng, sLat, sLng);
            if (isDistanceCoherentWithEta(straight, parsedEta)) {
                return Math.round(straight);
            }
        }
        return -1;
    }

    private void updateWatchMetricsAndMaybeAlert(
        WatchAlert w,
        int nextEta,
        double nextDist,
        double incomingEtaSec,
        double incomingSpeedMps,
        long rawGpsMs,
        boolean fromLiveSim,
        boolean isInitialOrUnitChange
    ) {
        long now = System.currentTimeMillis();
        int prevEta = w.etaMin;
        int effEta = nextEta >= 0 ? nextEta : w.etaMin;

        if (isInitialOrUnitChange) {
            w.lastRawGpsMs = 0L;
            w.lastRawDistM = -1;
            w.lastRenderedProgress01 = -1;
        }

        if (fromLiveSim) {
            // La app abierta en modo EN VIVO alimenta la simulación exacta de BusSimulator
            w.lastJsSimMs = now;
            if (incomingSpeedMps >= 0.4 && incomingSpeedMps <= 18.0) {
                w.simSpeedMps = incomingSpeedMps;
            }
            if (incomingEtaSec >= 0) {
                w.simEtaSec = incomingEtaSec;
            } else if (nextEta >= 0) {
                w.simEtaSec = nextEta * 60.0;
            }
            if (nextDist >= 0 && isDistanceCoherentWithEta(nextDist, effEta)) {
                if (isInitialOrUnitChange || w.distM < 0 || Math.abs(nextDist - w.distM) > 650.0) {
                    w.distM = nextDist;
                } else {
                    // Seguimiento suave del valor EN VIVO sin micro-saltos
                    w.distM = w.distM * 0.45 + nextDist * 0.55;
                }
                if (isInitialOrUnitChange || w.initialDistM < w.distM) {
                    w.initialDistM = computeInitialReferenceDist(w.distM, effEta);
                }
            } else if (nextDist >= 0 && !isDistanceCoherentWithEta(nextDist, effEta)) {
                if (w.distM >= 0 && !isDistanceCoherentWithEta(w.distM, effEta)) w.distM = -1;
            }
            w.simLastTickMs = now;
        } else {
            // Sondeo autónomo en 2° plano (app minimizada/cerrada): extrapolación EN VIVO continua
            boolean jsSimDriving = (now - w.lastJsSimMs) < 12_000L && !isInitialOrUnitChange;
            if (!jsSimDriving) {
                boolean coherentDist = nextDist >= 0 && isDistanceCoherentWithEta(nextDist, effEta);
                boolean sameStaleFix = (rawGpsMs > 0 && rawGpsMs == w.lastRawGpsMs && w.distM >= 0 && !isInitialOrUnitChange);
                if (coherentDist && !sameStaleFix) {
                    if (w.lastRawGpsMs > 0 && rawGpsMs > w.lastRawGpsMs && w.lastRawDistM > 0 && !isInitialOrUnitChange) {
                        double dtGps = (rawGpsMs - w.lastRawGpsMs) / 1000.0;
                        if (dtGps >= 8.0 && dtGps <= 220.0) {
                            double measuredSpd = (w.lastRawDistM - nextDist) / dtGps;
                            if (measuredSpd >= 1.2 && measuredSpd <= 15.0) {
                                w.simSpeedMps = w.simSpeedMps * 0.55 + measuredSpd * 0.45;
                            }
                        }
                    } else if (effEta > 0) {
                        double implied = Math.max(2.4, Math.min(10.5, nextDist / (effEta * 60.0)));
                        w.simSpeedMps = isInitialOrUnitChange ? implied : (w.simSpeedMps * 0.65 + implied * 0.35);
                    }
                    double gpsAgeSec = rawGpsMs > 0 ? Math.max(0.0, Math.min(110.0, (now - rawGpsMs) / 1000.0)) : 0.0;
                    double liveDistNow = Math.max(effEta <= 0 ? 0.0 : 35.0, nextDist - gpsAgeSec * w.simSpeedMps);
                    w.lastRawGpsMs = rawGpsMs;
                    w.lastRawDistM = nextDist;

                    if (isInitialOrUnitChange || w.distM < 0 || Math.abs(liveDistNow - w.distM) > 850.0) {
                        w.distM = liveDistNow;
                    } else {
                        // Convergencia suave por velocidad (cero saltos bruscos!)
                        double errM = w.distM - liveDistNow;
                        double steered = Math.max(1.2, Math.min(14.0, w.simSpeedMps + errM / 18.0));
                        w.simSpeedMps = w.simSpeedMps * 0.4 + steered * 0.6;
                        if (errM > 0) {
                            w.distM = Math.max(effEta <= 0 ? 0.0 : 30.0, w.distM - Math.min(errM * 0.16, 55.0));
                        } else if (errM < -280.0) {
                            w.distM = w.distM - errM * 0.12;
                        }
                    }
                    if (isInitialOrUnitChange || w.initialDistM < w.distM) {
                        w.initialDistM = computeInitialReferenceDist(w.distM, effEta);
                    }
                } else if (nextDist >= 0 && !coherentDist) {
                    if (w.distM >= 0 && !isDistanceCoherentWithEta(w.distM, effEta)) {
                        w.distM = -1;
                    }
                }

                if (nextEta >= 0) {
                    double targetEtaSec = nextEta == 0 ? 0.0 : Math.max(30.0, nextEta * 60.0 - 20.0);
                    if (isInitialOrUnitChange || w.simEtaSec < 0 || Math.abs(targetEtaSec - w.simEtaSec) > 180.0) {
                        w.simEtaSec = targetEtaSec;
                    } else {
                        w.simEtaSec = w.simEtaSec * 0.72 + targetEtaSec * 0.28;
                    }
                }
                w.simLastTickMs = now;
            }
        }

        if (nextEta >= 0) {
            w.etaMin = nextEta;
            if (w.etaMin <= 1 || (w.distM >= 0 && w.distM <= 250 && w.etaMin <= 3)) {
                w.wasClose = true;
            }
        }

        double targetProg = computeSmoothLiveProgress01(w.distM, w.simEtaSec, w.etaMin);
        w.progress01 = easeProgress01(w.progress01, targetProg, isInitialOrUnitChange);

        if (w.etaMin < 0) return;

        // Evaluar disparo de timbre + TTS sin crear notificación duplicada
        boolean shouldAlert = false;
        if (!w.triggered && w.etaMin <= w.leadMin) {
            w.triggered = true;
            w.lastSpokenEtaMin = w.etaMin;
            shouldAlert = true;
        } else if (minuteByMinute && w.etaMin <= Math.max(w.leadMin, 15)) {
            boolean isLower = (w.lastSpokenEtaMin == null) || (w.etaMin < w.lastSpokenEtaMin);
            boolean reachedNow = (w.etaMin == 0 && (w.lastSpokenEtaMin == null || w.lastSpokenEtaMin != 0));
            if (isLower || reachedNow) {
                w.triggered = true;
                w.lastSpokenEtaMin = w.etaMin;
                shouldAlert = true;
            }
        } else if (prevEta != 0 && w.etaMin == 0 && (w.lastSpokenEtaMin == null || w.lastSpokenEtaMin != 0)) {
            w.triggered = true;
            w.lastSpokenEtaMin = 0;
            shouldAlert = true;
        }

        if (shouldAlert) {
            String speechText = SpanishTtsFormatter.buildArrivalSpeech(
                w.lineName,
                w.coche,
                w.etaMin,
                (w.etaMin == 0 || !minuteByMinute) ? w.stopName : ""
            );
            triggerChimeAndSpeech(speechText);
        }
    }

    private void handleRemoveWatch(String key) {
        if (key == null || key.isEmpty()) return;
        WatchAlert removed = watchedAlerts.remove(key);
        if (removed != null && notifManager != null) {
            if (removed.notifId == activeForegroundNotifId) {
                activeForegroundNotifId = 0;
            }
            notifManager.cancel(removed.notifId);
        }
        persistState();
        broadcastWatches();
        if (hasAnyActiveWork()) {
            refreshAllNotificationsAndForeground();
        } else {
            stopForegroundAndIdle();
        }
    }

    private void handleClearWatches() {
        for (WatchAlert w : watchedAlerts.values()) {
            if (notifManager != null) notifManager.cancel(w.notifId);
        }
        watchedAlerts.clear();
        if (activeForegroundNotifId >= NOTIF_ID_WATCH_BASE) {
            activeForegroundNotifId = 0;
        }
        persistState();
        broadcastWatches();
        if (hasAnyActiveWork()) {
            refreshAllNotificationsAndForeground();
        } else {
            stopForegroundAndIdle();
        }
    }

    private boolean isDuplicateOfPrimaryWaiting(WatchAlert w) {
        if (!"waiting".equals(phase) && !"boarding_armed".equals(phase)) return false;
        return w.stopId.equals(stopId) && w.lineName.equalsIgnoreCase(lineName);
    }

    // ── Primary Trip Tracking (Selected Line / Subir / A Bordo) ───────────────
    private void loadOrderedStopsFromJson(@Nullable JSONArray arr) {
        if (arr == null || arr.length() == 0) return;
        orderedStops.clear();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "").trim().toUpperCase(Locale.ROOT);
            String nom = o.optString("nombre", o.optString("cleanName", id));
            double la = o.optDouble("lat", Double.NaN);
            double ln = o.optDouble("lng", Double.NaN);
            double al = o.optDouble("along", 0);
            if (!id.isEmpty() && Double.isFinite(la) && Double.isFinite(ln)) {
                orderedStops.add(new RouteStop(id, nom, la, ln, al));
            }
        }
    }

    private void handleStartWaiting(JSONObject p) {
        stopGpsUpdates();
        applyPrefs(p);

        String newStopId = p.optString("stopId", stopId).trim().toUpperCase(Locale.ROOT);
        String newLine = p.optString("lineName", lineName).trim();
        boolean sameTarget = ("waiting".equals(phase) || "boarding_armed".equals(phase))
            && newStopId.equals(stopId)
            && newLine.equals(lineName);

        phase = sameTarget ? phase : "waiting";

        stopId = newStopId;
        stopName = p.optString("stopName", stopId);
        stopLat = p.optDouble("stopLat", stopLat);
        stopLng = p.optDouble("stopLng", stopLng);

        lineName = newLine;
        codLinea = p.optInt("codLinea", codLinea);
        lockCar = p.optBoolean("lockCar", false);
        String prevCoche = coche;
        coche = p.optString("coche", "").trim();
        boolean cocheChanged = sameTarget && !prevCoche.isEmpty() && !coche.isEmpty() && !prevCoche.equals(coche);
        choferNombre = p.optString("choferNombre", "").trim();
        choferLegajo = p.optString("choferLegajo", "").trim();
        bandera = p.optString("bandera", "").trim();
        scheduledHHMM = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));

        loadOrderedStopsFromJson(p.optJSONArray("orderedStops"));

        if (!sameTarget || cocheChanged) {
            lastSpokenEtaMin = null;
            wasCloseToStop = false;
            initialDistM = 2600;
            etaMin = -1;
            distM = -1;
            primarySimEtaSec = -1;
            primarySimSpeedMps = 5.5;
            primaryLastRawGpsMs = 0L;
            primaryLastRawDistM = -1;
            primaryLastRenderedProgress01 = -1;
            progress01 = 0.08;
        }

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        double incomingEtaSec = p.optDouble("etaSec", -1);
        double incomingSpeed = p.optDouble("simSpeedMps", -1);
        boolean fromLiveSim = p.optBoolean("fromLiveSim", false);
        processWaitingUpdate(incomingEta, incomingDist, incomingEtaSec, incomingSpeed, 0L, fromLiveSim, !sameTarget || cocheChanged);

        persistState();
        ensurePollingRunning();
    }

    private void handleUpdateWaitingFromJs(JSONObject p) {
        if (!"waiting".equals(phase) && !"boarding_armed".equals(phase)) return;
        applyPrefs(p);
        String prevCoche = coche;
        String newCoche = p.optString("coche", "").trim();
        boolean cocheChanged = !prevCoche.isEmpty() && !newCoche.isEmpty() && !prevCoche.equals(newCoche);
        if (!newCoche.isEmpty()) coche = newCoche;
        String newChofer = p.optString("choferNombre", "").trim();
        if (!newChofer.isEmpty()) choferNombre = newChofer;
        String newSched = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));
        if (!newSched.isEmpty()) scheduledHHMM = newSched;
        loadOrderedStopsFromJson(p.optJSONArray("orderedStops"));

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        double incomingEtaSec = p.optDouble("etaSec", -1);
        double incomingSpeed = p.optDouble("simSpeedMps", -1);
        boolean fromLiveSim = p.optBoolean("fromLiveSim", false);
        processWaitingUpdate(incomingEta, incomingDist, incomingEtaSec, incomingSpeed, 0L, fromLiveSim, cocheChanged);
    }

    private void processWaitingUpdate(
        int nextEta,
        double nextDist,
        double incomingEtaSec,
        double incomingSpeedMps,
        long rawGpsMs,
        boolean fromLiveSim,
        boolean isInitialOrUnitChange
    ) {
        long now = System.currentTimeMillis();
        int prevEta = etaMin;
        int effEta = nextEta >= 0 ? nextEta : etaMin;

        if (isInitialOrUnitChange) {
            primaryLastRawGpsMs = 0L;
            primaryLastRawDistM = -1;
            primaryLastRenderedProgress01 = -1;
        }

        if (fromLiveSim) {
            primaryLastJsSimMs = now;
            if (incomingSpeedMps >= 0.4 && incomingSpeedMps <= 18.0) {
                primarySimSpeedMps = incomingSpeedMps;
            }
            if (incomingEtaSec >= 0) {
                primarySimEtaSec = incomingEtaSec;
            } else if (nextEta >= 0) {
                primarySimEtaSec = nextEta * 60.0;
            }
            if (nextDist >= 0 && isDistanceCoherentWithEta(nextDist, effEta)) {
                if (isInitialOrUnitChange || distM < 0 || Math.abs(nextDist - distM) > 650.0) {
                    distM = nextDist;
                } else {
                    distM = distM * 0.45 + nextDist * 0.55;
                }
                if (isInitialOrUnitChange || distM > initialDistM) {
                    initialDistM = computeInitialReferenceDist(distM, effEta);
                }
            } else if (nextDist >= 0 && !isDistanceCoherentWithEta(nextDist, effEta)) {
                if (distM >= 0 && !isDistanceCoherentWithEta(distM, effEta)) distM = -1;
            }
            primarySimLastTickMs = now;
        } else {
            boolean jsSimDriving = (now - primaryLastJsSimMs) < 12_000L && !isInitialOrUnitChange;
            if (!jsSimDriving) {
                boolean coherentDist = nextDist >= 0 && isDistanceCoherentWithEta(nextDist, effEta);
                boolean sameStaleFix = (rawGpsMs > 0 && rawGpsMs == primaryLastRawGpsMs && distM >= 0 && !isInitialOrUnitChange);
                if (coherentDist && !sameStaleFix) {
                    if (primaryLastRawGpsMs > 0 && rawGpsMs > primaryLastRawGpsMs && primaryLastRawDistM > 0 && !isInitialOrUnitChange) {
                        double dtGps = (rawGpsMs - primaryLastRawGpsMs) / 1000.0;
                        if (dtGps >= 8.0 && dtGps <= 220.0) {
                            double measuredSpd = (primaryLastRawDistM - nextDist) / dtGps;
                            if (measuredSpd >= 1.2 && measuredSpd <= 15.0) {
                                primarySimSpeedMps = primarySimSpeedMps * 0.55 + measuredSpd * 0.45;
                            }
                        }
                    } else if (effEta > 0) {
                        double implied = Math.max(2.4, Math.min(10.5, nextDist / (effEta * 60.0)));
                        primarySimSpeedMps = isInitialOrUnitChange ? implied : (primarySimSpeedMps * 0.65 + implied * 0.35);
                    }
                    double gpsAgeSec = rawGpsMs > 0 ? Math.max(0.0, Math.min(110.0, (now - rawGpsMs) / 1000.0)) : 0.0;
                    double liveDistNow = Math.max(effEta <= 0 ? 0.0 : 35.0, nextDist - gpsAgeSec * primarySimSpeedMps);
                    primaryLastRawGpsMs = rawGpsMs;
                    primaryLastRawDistM = nextDist;

                    if (isInitialOrUnitChange || distM < 0 || Math.abs(liveDistNow - distM) > 850.0) {
                        distM = liveDistNow;
                    } else {
                        double errM = distM - liveDistNow;
                        double steered = Math.max(1.2, Math.min(14.0, primarySimSpeedMps + errM / 18.0));
                        primarySimSpeedMps = primarySimSpeedMps * 0.4 + steered * 0.6;
                        if (errM > 0) {
                            distM = Math.max(effEta <= 0 ? 0.0 : 30.0, distM - Math.min(errM * 0.16, 55.0));
                        } else if (errM < -280.0) {
                            distM = distM - errM * 0.12;
                        }
                    }
                    if (isInitialOrUnitChange || distM > initialDistM) {
                        initialDistM = computeInitialReferenceDist(distM, effEta);
                    }
                } else if (nextDist >= 0 && !coherentDist) {
                    if (distM >= 0 && !isDistanceCoherentWithEta(distM, effEta)) distM = -1;
                }

                if (nextEta >= 0) {
                    double targetEtaSec = nextEta == 0 ? 0.0 : Math.max(30.0, nextEta * 60.0 - 20.0);
                    if (isInitialOrUnitChange || primarySimEtaSec < 0 || Math.abs(targetEtaSec - primarySimEtaSec) > 180.0) {
                        primarySimEtaSec = targetEtaSec;
                    } else {
                        primarySimEtaSec = primarySimEtaSec * 0.72 + targetEtaSec * 0.28;
                    }
                }
                primarySimLastTickMs = now;
            }
        }

        if (nextEta >= 0) {
            etaMin = nextEta;
            if (etaMin <= 1 || (distM >= 0 && distM <= 250 && etaMin <= 3)) wasCloseToStop = true;
        }
        double targetProg = computeSmoothLiveProgress01(distM, primarySimEtaSec, etaMin);
        progress01 = easeProgress01(progress01, targetProg, isInitialOrUnitChange);

        // Auto-Subir al llegar el colectivo a la parada (nunca por un coche de la mano de enfrente)
        if ("boarding_armed".equals(phase)
            && ((etaMin >= 0 && etaMin <= 0) || (distM >= 0 && distM <= 95 && (etaMin < 0 || etaMin <= 2)))) {
            enterOnboardMode(true);
            return;
        }

        // Alerta minuto a minuto o llegada a 0 min — ACTUALIZANDO LA MISMA NOTIFICACIÓN EN EL LUGAR
        boolean shouldAlert = false;
        String speechText = "";
        if (minuteByMinute && etaMin >= 0 && etaMin <= 20) {
            boolean isLower = (lastSpokenEtaMin == null)
                ? (etaMin <= Math.max(leadMin, 10))
                : (etaMin < lastSpokenEtaMin);
            boolean reachedNow = (etaMin == 0 && (lastSpokenEtaMin == null || lastSpokenEtaMin != 0));
            if (isLower || reachedNow) {
                lastSpokenEtaMin = etaMin;
                shouldAlert = true;
                speechText = SpanishTtsFormatter.buildArrivalSpeech(
                    lineName, coche, etaMin, etaMin == 0 ? stopName : ""
                );
            }
        } else if (prevEta != 0 && etaMin == 0) {
            shouldAlert = true;
            speechText = SpanishTtsFormatter.buildArrivalSpeech(lineName, coche, 0, stopName);
        }

        refreshAllNotificationsAndForeground();
        if (shouldAlert) {
            triggerChimeAndSpeech(speechText);
        }
        broadcastSnapshot();
    }

    private void handleRequestBoard(JSONObject p, boolean immediate) {
        if (p != null) {
            applyPrefs(p);
            String l = p.optString("lineName", "").trim();
            if (!l.isEmpty()) lineName = l;
            if (p.has("codLinea") && p.optInt("codLinea", 0) > 0) codLinea = p.optInt("codLinea", codLinea);
            String c = p.optString("coche", "").trim();
            if (!c.isEmpty()) coche = c;
            String dr = p.optString("choferNombre", "").trim();
            if (!dr.isEmpty()) choferNombre = dr;
            String sc = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));
            if (!sc.isEmpty()) scheduledHHMM = sc;
            String sId = p.optString("stopId", "").trim().toUpperCase(Locale.ROOT);
            if (!sId.isEmpty()) stopId = sId;
            String sNom = p.optString("stopName", "").trim();
            if (!sNom.isEmpty()) stopName = sNom;
            loadOrderedStopsFromJson(p.optJSONArray("orderedStops"));
        }

        boolean arrivingSoon = immediate
            || "idle".equals(phase)
            || "boarding_armed".equals(phase)
            || (etaMin >= 0 && etaMin <= 1)
            || (distM >= 0 && distM <= 160);

        if (arrivingSoon) {
            enterOnboardMode(false);
            return;
        }

        phase = "boarding_armed";
        persistState();
        ensureWakeLock();
        refreshAllNotificationsAndForeground();
        broadcastSnapshot();
        if (ttsEnabled) {
            scheduleSpeech(
                "Subir activado para línea " + SpanishTtsFormatter.formatLinea(lineName)
                    + ". Cuando llegue el colectivo te avisaré cada parada.",
                200,
                false
            );
        }
    }

    private void enterOnboardMode(boolean auto) {
        phase = "onboard";
        announcedStopIds.clear();
        arrivingNow = false;
        distToNextM = -1;
        progress01 = 0;

        nextStopIdx = 0;
        if (!orderedStops.isEmpty()) {
            int foundIdx = -1;
            if (!stopId.isEmpty()) {
                for (int i = 0; i < orderedStops.size(); i++) {
                    if (stopId.equals(orderedStops.get(i).id)) {
                        foundIdx = i;
                        break;
                    }
                }
            }
            if (foundIdx >= 0) {
                announcedStopIds.add(orderedStops.get(foundIdx).id);
                nextStopIdx = Math.min(orderedStops.size() - 1, foundIdx + 1);
                if (nextStopIdx > foundIdx) {
                    prevStopDistRef = Math.max(
                        120,
                        haversineMeters(
                            orderedStops.get(foundIdx).lat, orderedStops.get(foundIdx).lng,
                            orderedStops.get(nextStopIdx).lat, orderedStops.get(nextStopIdx).lng
                        )
                    );
                }
            } else {
                nextStopIdx = Math.min(orderedStops.size() - 1, 1);
            }
        }

        persistState();
        ensureWakeLock();
        refreshAllNotificationsAndForeground();
        startGpsUpdates();
        if (watchedAlerts.isEmpty()) stopWaitingPoller();
        broadcastSnapshot();

        String nextClean = nextStopIdx < orderedStops.size() ? orderedStops.get(nextStopIdx).cleanName : "";
        String speech = auto
            ? "El colectivo llegó. Modo a bordo activado en línea " + SpanishTtsFormatter.formatLinea(lineName)
                + (nextClean.isEmpty() ? "." : ". Próxima parada, " + nextClean + ".")
            : "Modo a bordo activado en línea " + SpanishTtsFormatter.formatLinea(lineName)
                + (coche.isEmpty() ? "" : ", coche " + SpanishTtsFormatter.formatCoche(coche))
                + (nextClean.isEmpty() ? "." : ". Próxima parada, " + nextClean + ".");

        if (auto) {
            triggerChimeAndSpeech(speech);
        } else if (ttsEnabled) {
            scheduleSpeech(speech, 250, false);
        }
    }

    private void handleAlight(boolean silent) {
        boolean wasOnboard = "onboard".equals(phase);
        stopGpsUpdates();
        phase = "idle";
        arrivingNow = false;
        announcedStopIds.clear();
        lastKnownSnapshot = null;

        if (notifManager != null) {
            notifManager.cancel(NOTIF_ID_LIVE_TRIP);
        }
        if (activeForegroundNotifId == NOTIF_ID_LIVE_TRIP) {
            activeForegroundNotifId = 0;
        }
        persistState();
        broadcastSnapshot();

        if (!silent && ttsEnabled) {
            String msg = wasOnboard
                ? "Bajaste del colectivo. Modo viaje finalizado."
                : "Seguimiento detenido.";
            speakNow(msg, false);
        }

        if (hasAnyActiveWork()) {
            ensureWakeLock();
            refreshAllNotificationsAndForeground();
            ensurePollingRunning();
        } else {
            stopForegroundAndIdle();
        }
    }

    private void stopForegroundAndIdle() {
        stopWaitingPoller();
        stopGpsUpdates();
        cancelDozeHeartbeat();
        releaseWakeLock();
        releaseTtsWakeLock();
        activeForegroundNotifId = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        mainHandler.postDelayed(() -> {
            if (!hasAnyActiveWork()) stopSelf();
        }, 4500);
    }

    private void handleStandaloneAlert(JSONObject p) {
        String title = p.optString("title", "DIRECT GPS");
        String body = p.optString("body", "");
        String speech = p.optString("speechText", "");
        boolean playSound = p.optBoolean("playSound", true);
        boolean speakAfter = p.optBoolean("speakAfterChime", ttsEnabled);
        int notifId = NOTIF_ID_ALERT_BASE + 10 + Math.abs(p.optString("tag", "alert").hashCode() % 40);

        if (notifManager != null) {
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
                .setSmallIcon(R.drawable.ic_stat_bus)
                .setContentTitle(title)
                .setContentText(body.split("\n")[0])
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setSilent(true)
                .setContentIntent(buildOpenAppIntent(null));
            notifManager.notify(notifId, b.build());
        }
        if (playSound) {
            playDeviceNotificationChime();
        }
        if (speakAfter && !speech.isEmpty()) {
            scheduleSpeech(speech, playSound ? 950 : 0, true);
        }
    }

    // ── Grouped 10-Second Background Poller + 2-Second EN VIVO Continuous Simulation Ticker ──
    private void ensurePollingRunning() {
        boolean needPolling = !watchedAlerts.isEmpty()
            || "waiting".equals(phase)
            || "boarding_armed".equals(phase);
        if (!needPolling) {
            stopWaitingPoller();
            return;
        }
        ensureWakeLock();
        scheduleDozeHeartbeat();
        if (pollExecutor == null || pollExecutor.isShutdown()) {
            pollExecutor = Executors.newSingleThreadScheduledExecutor();
        }
        if (pollFuture == null || pollFuture.isCancelled() || pollFuture.isDone()) {
            pollFuture = pollExecutor.scheduleWithFixedDelay(this::pollAllTargetsSafe, 2, 10, TimeUnit.SECONDS);
        }
        if (simTickerFuture == null || simTickerFuture.isCancelled() || simTickerFuture.isDone()) {
            simTickerFuture = pollExecutor.scheduleWithFixedDelay(
                () -> mainHandler.post(this::runLiveSimTickOnMain),
                2,
                2,
                TimeUnit.SECONDS
            );
        }
    }

    private void stopWaitingPoller() {
        if (pollFuture != null) {
            pollFuture.cancel(false);
            pollFuture = null;
        }
        if (simTickerFuture != null) {
            simTickerFuture.cancel(false);
            simTickerFuture = null;
        }
    }

    /**
     * Avance continuo cada 2 s en modo Simulación EN VIVO:
     * integra la velocidad sobre el trazado del recorrido y desliza suavemente la cápsula del colectivo
     * sin esperar los saltos de 60-120 s del último GPS.
     */
    private void runLiveSimTickOnMain() {
        try {
            if (notifManager == null) return;
            long now = System.currentTimeMillis();

            // 1) Seguimiento principal (waiting / boarding_armed)
            if ("waiting".equals(phase) || "boarding_armed".equals(phase)) {
                if (primarySimLastTickMs <= 0) primarySimLastTickMs = now;
                double dt = Math.max(0.2, Math.min(5.0, (now - primarySimLastTickMs) / 1000.0));
                primarySimLastTickMs = now;

                if (distM > 0 && etaMin != 0) {
                    distM = Math.max(30.0, distM - primarySimSpeedMps * dt);
                }
                if (primarySimEtaSec > 0 && etaMin != 0) {
                    primarySimEtaSec = Math.max(25.0, primarySimEtaSec - dt);
                }
                double targetP = computeSmoothLiveProgress01(distM, primarySimEtaSec, etaMin);
                progress01 = easeProgress01(progress01, targetP, false);

                if (shouldRepaintNotification(
                    progress01, primaryLastRenderedProgress01,
                    distM, primaryLastRenderedDistM,
                    etaMin, primaryLastRenderedEtaMin
                )) {
                    Notification primaryNotif = buildPrimaryWaitingNotification();
                    if (activeForegroundNotifId != NOTIF_ID_LIVE_TRIP) {
                        startForegroundCompat(NOTIF_ID_LIVE_TRIP, primaryNotif);
                    } else {
                        notifManager.notify(NOTIF_ID_LIVE_TRIP, primaryNotif);
                    }
                    primaryLastRenderedProgress01 = progress01;
                    primaryLastRenderedDistM = distM;
                    primaryLastRenderedEtaMin = etaMin;
                }
            }

            // 2) Campanitas activas (watchedAlerts)
            List<WatchAlert> snapshot;
            synchronized (watchedAlerts) {
                snapshot = new ArrayList<>(watchedAlerts.values());
            }
            for (WatchAlert w : snapshot) {
                if (isDuplicateOfPrimaryWaiting(w)) continue;
                if (w.simLastTickMs <= 0) w.simLastTickMs = now;
                double dt = Math.max(0.2, Math.min(5.0, (now - w.simLastTickMs) / 1000.0));
                w.simLastTickMs = now;

                if (w.distM > 0 && w.etaMin != 0) {
                    w.distM = Math.max(30.0, w.distM - w.simSpeedMps * dt);
                }
                if (w.simEtaSec > 0 && w.etaMin != 0) {
                    w.simEtaSec = Math.max(25.0, w.simEtaSec - dt);
                }
                double targetP = computeSmoothLiveProgress01(w.distM, w.simEtaSec, w.etaMin);
                w.progress01 = easeProgress01(w.progress01, targetP, false);

                if (shouldRepaintNotification(
                    w.progress01, w.lastRenderedProgress01,
                    w.distM, w.lastRenderedDistM,
                    w.etaMin, w.lastRenderedEtaMin
                )) {
                    Notification n = buildWatchNotification(w);
                    notifManager.notify(w.notifId, n);
                    w.lastRenderedProgress01 = w.progress01;
                    w.lastRenderedDistM = w.distM;
                    w.lastRenderedEtaMin = w.etaMin;
                }
            }
        } catch (Throwable t) {
            Log.d(TAG, "Sim tick skipped", t);
        }
    }

    private static boolean shouldRepaintNotification(
        double prog, double lastProg,
        double dist, double lastDist,
        int eta, int lastEta
    ) {
        if (lastProg < 0 || eta != lastEta) return true;
        if (Math.abs(prog - lastProg) >= 0.002) return true;
        if (dist >= 0 && lastDist >= 0) {
            double thresh = dist < 1000.0 ? 20.0 : 50.0;
            if (Math.abs(dist - lastDist) >= thresh) return true;
        }
        return false;
    }

    private void pollAllTargetsSafe() {
        try {
            if (hasAnyActiveWork()) {
                ensureWakeLock();
                scheduleDozeHeartbeat();
            }
            pollAllTargetsOnce();
            lastPollCompletedMs = System.currentTimeMillis();
        } catch (Throwable t) {
            // Nunca dejar que una excepción inesperada mate el ScheduledExecutorService
            Log.e(TAG, "Recovered from background poll error", t);
        }
    }

    private void pollAllTargetsOnce() {
        if (apiBase == null || apiBase.isEmpty()) return;

        // Recopilar todas las paradas únicas a consultar (1 sola llamada HTTP por parada)
        final Set<String> stopsToQuery = new HashSet<>();
        if (("waiting".equals(phase) || "boarding_armed".equals(phase)) && !stopId.isEmpty()) {
            stopsToQuery.add(stopId);
        }
        final List<String> watchKeysSnapshot;
        synchronized (watchedAlerts) {
            watchKeysSnapshot = new ArrayList<>(watchedAlerts.keySet());
            for (WatchAlert w : watchedAlerts.values()) {
                if (w.stopId != null && !w.stopId.isEmpty()) {
                    stopsToQuery.add(w.stopId);
                }
            }
        }
        if (stopsToQuery.isEmpty()) return;

        final Map<String, JSONArray> arribosByStop = new HashMap<>();
        for (String sid : stopsToQuery) {
            JSONArray arr = fetchStopArribos(sid);
            if (arr != null) {
                arribosByStop.put(sid, arr);
            }
        }
        if (arribosByStop.isEmpty()) return;

        mainHandler.post(() -> {
            // 1) Actualizar seguimiento principal (waiting / boarding_armed)
            if (("waiting".equals(phase) || "boarding_armed".equals(phase)) && arribosByStop.containsKey(stopId)) {
                JSONArray list = arribosByStop.get(stopId);
                JSONObject matched = findMatchingBus(list, lineName, codLinea, coche, lockCar);
                if (matched == null) {
                    if ("boarding_armed".equals(phase) && wasCloseToStop) {
                        enterOnboardMode(true);
                    }
                } else {
                    String prevCoche = coche;
                    String bc = matched.optString("identificadorCoche", "").trim();
                    boolean cocheChanged = !prevCoche.isEmpty() && !bc.isEmpty() && !prevCoche.equals(bc);
                    String bDrv = matched.optString("choferNombre", "").trim();
                    int bCod = matched.optInt("codigoLinea", codLinea);
                    if (bCod > 0) codLinea = bCod;
                    double bLat = parseDoubleSafe(matched.opt("latitud"));
                    double bLng = parseDoubleSafe(matched.opt("longitud"));
                    double sLat = stopLat != 0 ? stopLat : parseDoubleSafe(matched.opt("latitudParada"));
                    double sLng = stopLng != 0 ? stopLng : parseDoubleSafe(matched.opt("longitudParada"));
                    int parsedEta = parseEtaMinutes(matched.optString("tiempoRestanteArribo", matched.optString("tiempoRaw", "")));
                    long gpsMs = parseGpsTimestampMs(matched.optString("fechaHoraGps", matched.optString("ultimaActualizacion", "")));
                    double calcDist = resolveRouteDistanceMeters(codLinea, lineName, stopId, sLat, sLng, bLat, bLng, parsedEta);
                    if (!bc.isEmpty()) coche = bc;
                    if (!bDrv.isEmpty()) choferNombre = bDrv;
                    processWaitingUpdate(parsedEta, calcDist, -1, -1, gpsMs, false, cocheChanged);
                }
            }

            // 2) Actualizar todas las campanitas activas en el lugar
            boolean watchesChanged = false;
            List<String> toRemove = new ArrayList<>();
            for (String wk : watchKeysSnapshot) {
                WatchAlert w = watchedAlerts.get(wk);
                if (w == null) continue;
                JSONArray list = arribosByStop.get(w.stopId);
                if (list == null) continue;

                JSONObject matched = findMatchingBus(list, w.lineName, w.codLinea, w.coche, w.lockCar);
                if (matched == null) {
                    w.missingPolls++;
                    if (w.wasClose && w.missingPolls >= 2) {
                        toRemove.add(wk);
                    }
                    continue;
                }
                w.missingPolls = 0;
                String prevCoche = w.coche != null ? w.coche : "";
                String bc = matched.optString("identificadorCoche", "").trim();
                boolean cocheChanged = !prevCoche.isEmpty() && !bc.isEmpty() && !prevCoche.equals(bc);
                String bDrv = matched.optString("choferNombre", "").trim();
                int bCod = matched.optInt("codigoLinea", w.codLinea);
                if (bCod > 0) w.codLinea = bCod;
                if (!bc.isEmpty()) w.coche = bc;
                if (!bDrv.isEmpty()) w.choferNombre = bDrv;

                double bLat = parseDoubleSafe(matched.opt("latitud"));
                double bLng = parseDoubleSafe(matched.opt("longitud"));
                double sLat = w.stopLat != 0 ? w.stopLat : parseDoubleSafe(matched.opt("latitudParada"));
                double sLng = w.stopLng != 0 ? w.stopLng : parseDoubleSafe(matched.opt("longitudParada"));
                int parsedEta = parseEtaMinutes(matched.optString("tiempoRestanteArribo", matched.optString("tiempoRaw", "")));
                long gpsMs = parseGpsTimestampMs(matched.optString("fechaHoraGps", matched.optString("ultimaActualizacion", "")));
                double calcDist = resolveRouteDistanceMeters(w.codLinea, w.lineName, w.stopId, sLat, sLng, bLat, bLng, parsedEta);

                updateWatchMetricsAndMaybeAlert(w, parsedEta, calcDist, -1, -1, gpsMs, false, cocheChanged);
                watchesChanged = true;
            }

            for (String rmKey : toRemove) {
                WatchAlert rem = watchedAlerts.remove(rmKey);
                if (rem != null && notifManager != null) {
                    if (rem.notifId == activeForegroundNotifId) activeForegroundNotifId = 0;
                    notifManager.cancel(rem.notifId);
                    watchesChanged = true;
                }
            }

            if (watchesChanged) {
                persistState();
                broadcastWatches();
            }
            if (hasAnyActiveWork()) {
                refreshAllNotificationsAndForeground();
            } else {
                stopForegroundAndIdle();
            }
        });
    }

    @Nullable
    private JSONArray fetchStopArribos(String sid) {
        HttpURLConnection conn = null;
        try {
            String qStop = URLEncoder.encode(sid, "UTF-8");
            URL url = new URL(apiBase + "/api/arribos?idParada=" + qStop + "&codLinea=000");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(7000);
            conn.setReadTimeout(7000);
            conn.setRequestMethod("GET");
            if (conn.getResponseCode() != 200) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
            JSONObject root = new JSONObject(sb.toString());
            JSONObject data = root.optJSONObject("data");
            if (data != null && data.has("arribos")) return data.optJSONArray("arribos");
            if (root.has("arribos")) return root.optJSONArray("arribos");
            return new JSONArray();
        } catch (Exception e) {
            Log.d(TAG, "Background poll failed for " + sid + ": " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Nullable
    private JSONObject findMatchingBus(JSONArray arribos, String targetLine, int targetCod, String targetCoche, boolean carLocked) {
        if (arribos == null || arribos.length() == 0) return null;
        if (carLocked && targetCoche != null && !targetCoche.isEmpty()) {
            for (int i = 0; i < arribos.length(); i++) {
                JSONObject b = arribos.optJSONObject(i);
                if (b == null || b.optBoolean("esSiguienteVuelta", false)) continue;
                String bc = b.optString("identificadorCoche", "").trim();
                if (targetCoche.equals(bc)) return b;
            }
            return null;
        }
        JSONObject best = null;
        int bestEta = Integer.MAX_VALUE;
        for (int i = 0; i < arribos.length(); i++) {
            JSONObject b = arribos.optJSONObject(i);
            if (b == null || b.optBoolean("esSiguienteVuelta", false)) continue;
            int bCod = b.optInt("codigoLinea", 0);
            String bLine = b.optString("descripcionLinea", "").trim();
            boolean matchLine = (targetCod > 0 && bCod == targetCod)
                || (targetLine != null && !targetLine.isEmpty() && targetLine.equalsIgnoreCase(bLine));
            if (!matchLine) continue;
            int e = parseEtaMinutes(b.optString("tiempoRestanteArribo", b.optString("tiempoRaw", "")));
            int rank = e >= 0 ? e : 999;
            if (best == null || rank < bestEta) {
                best = b;
                bestEta = rank;
            }
        }
        return best;
    }

    private int parseEtaMinutes(String raw) {
        if (raw == null || raw.trim().isEmpty()) return -1;
        String up = raw.toUpperCase(Locale.ROOT);
        if (up.contains("ARRIB") || up.contains("LLEG") || up.contains("AHORA")) return 0;
        Matcher m = ETA_MIN_PATTERN.matcher(up);
        if (m.find()) {
            try {
                return Integer.parseInt(m.group(1));
            } catch (Exception ignored) {
                return -1;
            }
        }
        return -1;
    }

    private static double parseDoubleSafe(@Nullable Object raw) {
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

    // ── Native Android LocationManager for A Bordo Mode (works with app closed!) ──
    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void startGpsUpdates() {
        stopGpsUpdates();
        if (locationManager == null || !hasLocationPermission()) return;
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2500L, 8f, this, Looper.getMainLooper());
                gpsListening = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 15f, this, Looper.getMainLooper());
                gpsListening = true;
            }
        } catch (SecurityException se) {
            Log.w(TAG, "Location permission missing", se);
        }
    }

    private void stopGpsUpdates() {
        if (locationManager != null && gpsListening) {
            try {
                locationManager.removeUpdates(this);
            } catch (Exception ignored) {}
        }
        gpsListening = false;
    }

    @Override
    public void onLocationChanged(@NonNull Location location) {
        if (!"onboard".equals(phase) || orderedStops.isEmpty()) return;
        double lat = location.getLatitude();
        double lng = location.getLongitude();

        int bestFutureIdx = nextStopIdx;
        double bestFutureDist = haversineMeters(lat, lng, orderedStops.get(nextStopIdx).lat, orderedStops.get(nextStopIdx).lng);
        int lookAheadLimit = Math.min(orderedStops.size() - 1, nextStopIdx + 4);
        for (int i = nextStopIdx + 1; i <= lookAheadLimit; i++) {
            double d = haversineMeters(lat, lng, orderedStops.get(i).lat, orderedStops.get(i).lng);
            if (d < bestFutureDist && bestFutureDist > 180) {
                bestFutureDist = d;
                bestFutureIdx = i;
            }
        }
        if (bestFutureIdx > nextStopIdx) {
            nextStopIdx = bestFutureIdx;
            arrivingNow = false;
            prevStopDistRef = Math.max(150, bestFutureDist);
        }

        RouteStop target = orderedStops.get(nextStopIdx);
        double dist = haversineMeters(lat, lng, target.lat, target.lng);
        distToNextM = dist;

        if (announcedStopIds.contains(target.id) && dist > 110 && nextStopIdx < orderedStops.size() - 1) {
            RouteStop prev = target;
            nextStopIdx += 1;
            target = orderedStops.get(nextStopIdx);
            arrivingNow = false;
            prevStopDistRef = Math.max(120, haversineMeters(prev.lat, prev.lng, target.lat, target.lng));
            dist = haversineMeters(lat, lng, target.lat, target.lng);
            distToNextM = dist;
        }

        // Zona de arribo a parada (<= 150 m) — actualiza la MISMA notificación en el lugar + timbre + TTS
        if (dist <= 150.0 && !announcedStopIds.contains(target.id)) {
            announcedStopIds.add(target.id);
            arrivingNow = true;

            boolean isFinal = nextStopIdx >= orderedStops.size() - 1;
            String speech = isFinal
                ? "Arribando, " + target.cleanName + ". Fin del recorrido."
                : "Arribando, " + target.cleanName + ".";

            refreshAllNotificationsAndForeground();
            triggerChimeAndSpeech(speech);
            broadcastSnapshot();
            return;
        }

        refreshAllNotificationsAndForeground();
        broadcastSnapshot();
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(@NonNull String provider) {}

    @Override
    public void onProviderDisabled(@NonNull String provider) {}

    // ── In-Place Notification Rendering (ZERO Duplicates!) ────────────────────
    private void startForegroundCompat(int notifId, Notification notification) {
        activeForegroundNotifId = notifId;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                if (hasLocationPermission()) {
                    fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION | ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                }
                try {
                    startForeground(notifId, notification, fgsType);
                } catch (SecurityException se) {
                    startForeground(notifId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                }
            } else {
                startForeground(notifId, notification);
            }
        } catch (Exception e) {
            // Respaldo seguro en Android 12+ si el SO bloqueó startForeground desde 2° plano
            Log.w(TAG, "startForeground fallback to notify", e);
            if (notifManager != null) {
                try {
                    notifManager.notify(notifId, notification);
                } catch (Exception ignored) {}
            }
        }
    }

    private void refreshAllNotificationsAndForeground() {
        if (notifManager == null) return;

        boolean hasPrimary = !"idle".equals(phase);
        if (hasPrimary) {
            Notification primaryNotif = "onboard".equals(phase)
                ? buildOnboardNotification()
                : buildPrimaryWaitingNotification();
            if (activeForegroundNotifId != NOTIF_ID_LIVE_TRIP) {
                startForegroundCompat(NOTIF_ID_LIVE_TRIP, primaryNotif);
            } else {
                notifManager.notify(NOTIF_ID_LIVE_TRIP, primaryNotif);
            }
            primaryLastRenderedProgress01 = progress01;
            primaryLastRenderedDistM = distM;
            primaryLastRenderedEtaMin = etaMin;
        }

        List<WatchAlert> snapshot;
        synchronized (watchedAlerts) {
            snapshot = new ArrayList<>(watchedAlerts.values());
        }

        boolean promotedWatchToFg = false;
        for (WatchAlert w : snapshot) {
            if (isDuplicateOfPrimaryWaiting(w)) {
                notifManager.cancel(w.notifId);
                continue;
            }
            Notification n = buildWatchNotification(w);
            if (!hasPrimary && !promotedWatchToFg && (activeForegroundNotifId == 0 || activeForegroundNotifId == w.notifId)) {
                if (activeForegroundNotifId != w.notifId) {
                    startForegroundCompat(w.notifId, n);
                } else {
                    notifManager.notify(w.notifId, n);
                }
                promotedWatchToFg = true;
            } else {
                notifManager.notify(w.notifId, n);
            }
            w.lastRenderedProgress01 = w.progress01;
            w.lastRenderedDistM = w.distM;
            w.lastRenderedEtaMin = w.etaMin;
        }
    }

    private PendingIntent buildOpenAppIntent(@Nullable String targetStopId) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int reqCode = 100;
        if (targetStopId != null && !targetStopId.isEmpty()) {
            i.putExtra("dgps_stop_id", targetStopId);
            reqCode = 101 + Math.abs(targetStopId.hashCode() % 400);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, reqCode, i, flags);
    }

    private PendingIntent buildServiceActionIntent(String action, int reqCode, @Nullable String watchKey) {
        Intent i = new Intent(this, DirectGpsTripService.class);
        i.setAction(action);
        if (watchKey != null) i.putExtra(EXTRA_WATCH_KEY, watchKey);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(this, reqCode, i, flags);
        }
        return PendingIntent.getService(this, reqCode, i, flags);
    }

    /**
     * Construye la notificación en vivo estilo Uber con UNA SOLA barra gráfica limpia
     * (sin setProgress redundante) y tarjeta interna limpia sin etiquetas redundantes:
     *   #4150            Prog. real: 23:03
     *   GARCIA J.
     *   2,5 km (25 c.)
     */
    private NotificationCompat.Builder buildUberArrivalBuilder(
        String targetStopId,
        String targetLine,
        String targetCoche,
        String targetDriver,
        String targetSched,
        String targetStopName,
        int targetEtaMin,
        double targetDistM,
        double targetProgress01,
        @Nullable String extraStatusLine
    ) {
        String cocheTxt = (targetCoche == null || targetCoche.isEmpty()) ? "s/d" : "#" + targetCoche;
        String driverTxt = (targetDriver == null || targetDriver.isEmpty()) ? "Sin datos" : targetDriver;
        String schedTxt = (targetSched == null || targetSched.isEmpty()) ? "s/d" : targetSched;
        String stopClean = SpanishTtsFormatter.shortLabel(targetStopName, 34);
        String etaHeadline = targetEtaMin < 0
            ? targetLine + " · En camino"
            : (targetEtaMin <= 0 ? targetLine + " · Arribando ahora" : targetLine + " · Llega en " + targetEtaMin + " min");
        String schedPill = "s/d".equals(schedTxt) ? "" : "Prog. " + schedTxt;

        String distLine;
        if (extraStatusLine != null && !extraStatusLine.isEmpty()) {
            distLine = extraStatusLine;
        } else if (targetDistM > 0 && isDistanceCoherentWithEta(targetDistM, targetEtaMin)) {
            distLine = SpanishTtsFormatter.formatDistance(targetDistM)
                + " (" + SpanishTtsFormatter.formatBlocks(targetDistM) + " c.)"
                + (minuteByMinute ? " · Min a min" : "");
        } else {
            distLine = "En camino" + (minuteByMinute ? " · Min a min" : "");
        }

        int lineColor = UberProgressBitmapRenderer.resolveLineColor(targetLine);
        Bitmap compactTrack = UberProgressBitmapRenderer.renderTrack(this, targetProgress01, lineColor, true);
        Bitmap expandedTrack = UberProgressBitmapRenderer.renderTrack(this, targetProgress01, lineColor, false);
        Bitmap badgeBmp = UberProgressBitmapRenderer.renderLineBadge(this, targetLine, lineColor);

        RemoteViews compactView = new RemoteViews(getPackageName(), R.layout.notif_uber_compact);
        compactView.setTextViewText(R.id.notif_title, etaHeadline);
        compactView.setTextViewText(R.id.notif_sched_pill, schedPill);
        compactView.setTextViewText(
            R.id.notif_subtitle,
            "s/d".equals(cocheTxt) ? stopClean : (stopClean + " · " + cocheTxt)
        );
        compactView.setImageViewBitmap(R.id.notif_progress_track, compactTrack);

        RemoteViews expandedView = new RemoteViews(getPackageName(), R.layout.notif_uber_expanded);
        expandedView.setTextViewText(R.id.notif_title, etaHeadline);
        expandedView.setTextViewText(R.id.notif_subtitle, stopClean);
        expandedView.setImageViewBitmap(R.id.notif_progress_track, expandedTrack);
        expandedView.setImageViewBitmap(R.id.notif_line_badge, badgeBmp);
        expandedView.setTextViewText(R.id.notif_car_primary, cocheTxt);
        expandedView.setTextViewText(R.id.notif_sched_pill, "s/d".equals(schedTxt) ? "" : "Prog. real: " + schedTxt);
        expandedView.setTextViewText(R.id.notif_driver_line, driverTxt);
        expandedView.setTextViewText(R.id.notif_dist_line, distLine);

        return new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(buildOpenAppIntent(targetStopId))
            .setContentTitle(etaHeadline)
            .setContentText(cocheTxt + " · " + distLine + ("s/d".equals(schedTxt) ? "" : " · Prog. real: " + schedTxt))
            .setStyle(new NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(compactView)
            .setCustomBigContentView(expandedView);
    }

    /**
     * Notificación en vivo de ARRIBO (campanita de parada):
     * - Se ACTUALIZA EN EL LUGAR con UNA sola barra estilo Uber (sin barra nativa duplicada).
     */
    private Notification buildWatchNotification(WatchAlert w) {
        return buildUberArrivalBuilder(
            w.stopId,
            w.lineName,
            w.coche,
            w.choferNombre,
            w.scheduledHHMM,
            w.stopName,
            w.etaMin,
            w.distM,
            w.progress01,
            null
        )
            .addAction(0, "✕ Quitar aviso", buildServiceActionIntent(ACTION_REMOVE_WATCH, 300 + (w.notifId % 500), w.key))
            .build();
    }

    /**
     * Notificación en vivo de ARRIBO (línea seleccionada):
     * - UNA sola barra recta estilo Uber (izquierda -> derecha) + acciones Subir / Detener.
     */
    private Notification buildPrimaryWaitingNotification() {
        String extraStatus = "boarding_armed".equals(phase)
            ? "✅ Subir activado · pasa a A Bordo al llegar"
            : null;
        NotificationCompat.Builder builder = buildUberArrivalBuilder(
            stopId,
            lineName,
            coche,
            choferNombre,
            scheduledHHMM,
            stopName.isEmpty() ? stopId : stopName,
            etaMin,
            distM,
            progress01,
            extraStatus
        );

        if ("boarding_armed".equals(phase)) {
            builder.addAction(0, "🚌 Ya subí", buildServiceActionIntent(ACTION_BOARD_NOW, 202, null));
        } else {
            builder.addAction(0, "🚌 Subir", buildServiceActionIntent(ACTION_BOARD, 201, null));
        }
        builder.addAction(0, "✕ Detener", buildServiceActionIntent(ACTION_STOP, 204, null));
        return builder.build();
    }

    /**
     * Notificación de MODO A BORDO (accesible para no videntes):
     * - SIN línea recta de progreso (la barra recta es exclusiva de arribos).
     * - Se actualiza en el lugar con próxima parada, distancia, chofer, coche y botón Bajar.
     */
    private Notification buildOnboardNotification() {
        String cocheTxt = coche.isEmpty() ? "s/d" : "#" + coche;
        String driverTxt = choferNombre.isEmpty() ? "Sin datos" : choferNombre;
        String schedTxt = scheduledHHMM.isEmpty() ? "s/d" : scheduledHHMM;
        RouteStop next = nextStopIdx < orderedStops.size() ? orderedStops.get(nextStopIdx) : null;
        String nextClean = next != null ? next.cleanName : "Fin del recorrido";
        int rem = Math.max(0, orderedStops.size() - nextStopIdx);
        String distPart = distToNextM >= 0 ? " · " + SpanishTtsFormatter.formatDistance(distToNextM) : "";

        String title = arrivingNow
            ? "🔔 ARRIBANDO · " + nextClean
            : "🚌 A bordo " + lineName + (coche.isEmpty() ? "" : " #" + coche);

        String bigBody = "Próxima parada: " + nextClean + distPart
            + "\nChofer: " + driverTxt + " · Coche " + cocheTxt + " · Prog. real: " + schedTxt
            + "\n" + rem + (rem == 1 ? " parada restante" : " paradas restantes");

        return new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(buildOpenAppIntent(stopId))
            .setContentTitle(title)
            .setContentText("Próxima: " + nextClean + distPart)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(bigBody))
            .addAction(0, "🚪 Bajar", buildServiceActionIntent(ACTION_ALIGHT, 203, null))
            .build();
    }

    // ── Custom Phone Notification Ringtone + Vibrate + Immortal Background TTS ──
    private void triggerChimeAndSpeech(String speechText) {
        acquireTtsWakeLock();
        boolean playedSound = false;
        if (soundEnabled) {
            playedSound = playDeviceNotificationChime();
        }
        if (ttsEnabled && speechText != null && !speechText.isEmpty()) {
            int ringerMode = audioManager != null ? audioManager.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
            if (ttsSpeakInDnd || ringerMode == AudioManager.RINGER_MODE_NORMAL) {
                scheduleSpeech(speechText, playedSound ? 950 : 120, true);
            } else {
                releaseTtsWakeLock();
            }
        } else {
            releaseTtsWakeLock();
        }
    }

    private boolean playDeviceNotificationChime() {
        long now = System.currentTimeMillis();
        // Si 2 colectivos disparan en el mismo tick de 10 s, sonar 1 solo timbre y encolar ambas voces
        if (now - lastChimeMs < 1400) return true;
        lastChimeMs = now;

        int ringerMode = audioManager != null ? audioManager.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
        if (ringerMode == AudioManager.RINGER_MODE_SILENT && !ttsSpeakInDnd) return false;

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) {
                    vm.getDefaultVibrator().vibrate(VibrationEffect.createWaveform(new long[]{0, 150, 80, 150}, -1));
                }
            } else {
                Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vib != null && vib.hasVibrator()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vib.vibrate(VibrationEffect.createWaveform(new long[]{0, 150, 80, 150}, -1));
                    } else {
                        vib.vibrate(new long[]{0, 150, 80, 150}, -1);
                    }
                }
            }
        } catch (Exception ignored) {}

        if (ringerMode != AudioManager.RINGER_MODE_NORMAL && !ttsSpeakInDnd) return false;

        try {
            String customUriStr = getCustomRingtoneUri(getApplicationContext());
            Uri uri = (customUriStr != null && !customUriStr.isEmpty())
                ? Uri.parse(customUriStr)
                : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            Ringtone ringtone = uri != null ? RingtoneManager.getRingtone(getApplicationContext(), uri) : null;
            if (ringtone == null) {
                Uri fallback = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                ringtone = fallback != null ? RingtoneManager.getRingtone(getApplicationContext(), fallback) : null;
            }
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    ringtone.setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(ttsSpeakInDnd
                                ? AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
                                : AudioAttributes.USAGE_NOTIFICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    );
                }
                ringtone.play();
                return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "Ringtone play failed", e);
        }
        return false;
    }

    // ── Self-Healing Background TTS (never sleeps after minutes in Doze / One UI!) ──
    private void scheduleSpeech(String text, long delayMs, boolean queueAdd) {
        if (text == null || text.trim().isEmpty()) return;
        acquireTtsWakeLock();
        if (delayMs <= 0) {
            speakNow(text, queueAdd);
            return;
        }
        if (speechExecutor == null || speechExecutor.isShutdown()) {
            speechExecutor = Executors.newSingleThreadScheduledExecutor();
        }
        // Usar ScheduledExecutorService + WakeLock (a diferencia de Handler.postDelayed, no se congela en Doze)
        ScheduledFuture<?> fut = speechExecutor.schedule(() -> {
            speakNow(text, queueAdd);
        }, delayMs, TimeUnit.MILLISECONDS);
        scheduledSpeechFutures.add(fut);
    }

    private void cancelPendingSpeech() {
        synchronized (scheduledSpeechFutures) {
            for (ScheduledFuture<?> f : scheduledSpeechFutures) {
                try {
                    f.cancel(false);
                } catch (Exception ignored) {}
            }
            scheduledSpeechFutures.clear();
        }
        for (ScheduledFuture<?> wd : utteranceWatchdogs.values()) {
            try {
                wd.cancel(false);
            } catch (Exception ignored) {}
        }
        utteranceWatchdogs.clear();
        activeUtteranceTexts.clear();
        if (tts != null && ttsReady) {
            try {
                tts.stop();
            } catch (Exception ignored) {}
        }
        releaseTtsWakeLock();
    }

    private void speakNow(String text, boolean queueAdd) {
        if (text == null || text.trim().isEmpty()) return;
        acquireTtsWakeLock();

        if (!ttsReady || tts == null) {
            pendingInitSpeeches.add(text);
            if (!ttsInitializing) {
                reinitTtsEngine();
            }
            return;
        }

        requestAudioFocus();
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        String uttId = "dgps-" + System.nanoTime();
        activeUtteranceTexts.put(uttId, text);

        try {
            tts.setSpeechRate(ttsSpeechRate);
            int res = tts.speak(
                text,
                queueAdd ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH,
                params,
                uttId
            );
            if (res != TextToSpeech.SUCCESS) {
                // El servicio Binder remoto de Google/Samsung TTS se durmió: recrear motor y reproducir!
                Log.w(TAG, "tts.speak returned ERROR (" + res + ") -> reinitializing TTS engine");
                activeUtteranceTexts.remove(uttId);
                pendingInitSpeeches.add(text);
                reinitTtsEngine();
                return;
            }

            // Watchdog de 2.8 s: si onStart(uttId) no arrancó, el motor TTS remoto quedó zombi -> reiniciar y reintentar
            if (speechExecutor != null && !speechExecutor.isShutdown()) {
                ScheduledFuture<?> wd = speechExecutor.schedule(() -> {
                    utteranceWatchdogs.remove(uttId);
                    String stuckText = activeUtteranceTexts.remove(uttId);
                    if (stuckText != null && retriedUtterances.add(uttId)) {
                        Log.w(TAG, "TTS watchdog triggered (silent binder) -> recreating TTS engine");
                        pendingInitSpeeches.add(stuckText);
                        reinitTtsEngine();
                    }
                }, 2800L, TimeUnit.MILLISECONDS);
                utteranceWatchdogs.put(uttId, wd);
            }
        } catch (Exception e) {
            Log.w(TAG, "TTS speak exception -> recreating engine", e);
            activeUtteranceTexts.remove(uttId);
            pendingInitSpeeches.add(text);
            reinitTtsEngine();
        }
    }

    private void requestAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(buildTtsAudioAttributes())
                    .setAcceptsDelayedFocusGain(false)
                    .build();
                audioManager.requestAudioFocus(audioFocusRequest);
            } else {
                audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            }
        } catch (Exception ignored) {}
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            }
        } catch (Exception ignored) {}
    }

    // ── Snapshot Bridge back to Capacitor WebView ─────────────────────────────
    private void broadcastSnapshot() {
        JSONObject snap = buildSnapshotJson();
        lastKnownSnapshot = "idle".equals(phase) ? null : snap;
        StateListener listener = stateListener;
        if (listener != null) {
            mainHandler.post(() -> listener.onTripStateChanged(snap));
        }
    }

    private void broadcastWatches() {
        JSONArray arr = new JSONArray();
        synchronized (watchedAlerts) {
            for (WatchAlert w : watchedAlerts.values()) {
                arr.put(w.toJson());
            }
        }
        StateListener listener = stateListener;
        if (listener != null) {
            mainHandler.post(() -> listener.onWatchedAlertsChanged(arr));
        }
    }

    private JSONObject buildSnapshotJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("phase", phase);
            o.put("lineName", lineName);
            o.put("codLinea", codLinea);
            o.put("coche", coche);
            o.put("choferNombre", choferNombre);
            o.put("choferLegajo", choferLegajo);
            o.put("bandera", bandera);
            o.put("scheduledHHMM", scheduledHHMM);
            o.put("stopId", stopId);
            o.put("stopName", stopName);
            o.put("distM", distM >= 0 ? Math.round(distM) : JSONObject.NULL);
            o.put("etaMin", etaMin >= 0 ? etaMin : JSONObject.NULL);
            o.put("progress01", progress01);
            o.put("minuteByMinute", minuteByMinute);
            o.put("ttsEnabled", ttsEnabled);
            o.put("arrivingNow", arrivingNow);
            o.put("usingPhoneGps", gpsListening);
            o.put("remainingStops", "onboard".equals(phase) ? Math.max(0, orderedStops.size() - nextStopIdx) : 0);
            if ("onboard".equals(phase) && nextStopIdx < orderedStops.size()) {
                RouteStop ns = orderedStops.get(nextStopIdx);
                JSONObject nsObj = new JSONObject();
                nsObj.put("id", ns.id);
                nsObj.put("nombre", ns.nombre);
                nsObj.put("cleanName", ns.cleanName);
                o.put("nextStop", nsObj);
                o.put("distToNextM", distToNextM >= 0 ? Math.round(distToNextM) : JSONObject.NULL);
            }
            if (!orderedStops.isEmpty()) {
                o.put("finalStopName", orderedStops.get(orderedStops.size() - 1).cleanName);
            }
        } catch (Exception ignored) {}
        return o;
    }

    private static String sanitizeScheduledHHMM(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.matches("^\\d{1,2}:\\d{2}.*$")) {
            return s.length() >= 5 ? s.substring(0, 5) : s;
        }
        return "";
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

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15+ FGS timeout guard: guardar estado y detener ordenadamente sin crashear
        persistState();
        cancelDozeHeartbeat();
        releaseWakeLock();
        releaseTtsWakeLock();
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        stopWaitingPoller();
        stopGpsUpdates();
        cancelDozeHeartbeat();
        cancelPendingSpeech();
        releaseWakeLock();
        releaseTtsWakeLock();
        if (pollExecutor != null) pollExecutor.shutdownNow();
        if (speechExecutor != null) speechExecutor.shutdownNow();
        if (tts != null) {
            try {
                tts.shutdown();
            } catch (Exception ignored) {}
        }
        abandonAudioFocus();
        super.onDestroy();
    }
}
