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
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android Foreground Service nativo de DIRECT GPS (v2.8.0).
 * Funciona de forma autónoma con la app minimizada, pantalla apagada o COMPLETAMENTE CERRADA:
 *  - Notificaciones en tiempo real que se ACTUALIZAN EN EL LUGAR (nunca duplican tarjetas)
 *    con barra de progreso recta estilo Uber EXCLUSIVA para arribos (izquierda -> derecha).
 *  - Soporta múltiples campanitas de parada simultáneas persistidas en SharedPreferences
 *    (no se apagan ni dejan de leer TTS al salir o cerrar la app).
 *  - Timbre real del celular + vibración + motor nativo TextToSpeech (es-AR) 950 ms después.
 *  - Modo A Bordo (Subir/Bajar) limpio sin barra recta, con LocationManager nativo anunciando
 *    "Arribando, <parada>." en cada próxima parada.
 */
public class DirectGpsTripService extends Service implements TextToSpeech.OnInitListener, LocationListener {

    private static final String TAG = "DirectGpsTripService";
    private static final String PREFS_NAME = "directgps_fg_prefs_v1";
    private static final String KEY_WATCHES_JSON = "watches_json";
    private static final String KEY_PREFS_JSON = "user_prefs_json";
    private static final String KEY_PRIMARY_JSON = "primary_trip_json";

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

    public static final String EXTRA_PAYLOAD = "payload";
    public static final String EXTRA_WATCH_KEY = "watch_key";

    private static final Pattern ETA_MIN_PATTERN = Pattern.compile("(\\d+)");

    public interface StateListener {
        void onTripStateChanged(JSONObject snapshot);
        void onWatchedAlertsChanged(JSONArray alerts);
    }

    private static volatile StateListener stateListener = null;
    private static volatile JSONObject lastKnownSnapshot = null;

    public static void setStateListener(@Nullable StateListener listener) {
        stateListener = listener;
    }

    @Nullable
    public static JSONObject getLastKnownSnapshot() {
        return lastKnownSnapshot;
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
        double progress01 = 0.08;
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
    private AudioFocusRequest audioFocusRequest;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private final List<String> pendingInitSpeeches = new ArrayList<>();

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final List<Runnable> scheduledSpeechTasks = new ArrayList<>();
    private long lastChimeMs = 0;

    private ScheduledExecutorService pollExecutor;
    private ScheduledFuture<?> pollFuture;

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
    private Integer lastSpokenEtaMin = null;
    private boolean wasCloseToStop = false;
    private double progress01 = 0.08;

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

    @Override
    public void onCreate() {
        super.onCreate();
        notifManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createNotificationChannels();
        pollExecutor = Executors.newSingleThreadScheduledExecutor();
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

    private void restorePersistedState() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONObject prefs = new JSONObject(sp.getString(KEY_PREFS_JSON, "{}"));
            if (prefs.has("minuteByMinute")) minuteByMinute = prefs.optBoolean("minuteByMinute", minuteByMinute);
            if (prefs.has("ttsEnabled")) ttsEnabled = prefs.optBoolean("ttsEnabled", ttsEnabled);
            if (prefs.has("soundEnabled")) soundEnabled = prefs.optBoolean("soundEnabled", soundEnabled);
            if (prefs.has("leadMin")) leadMin = Math.max(1, prefs.optInt("leadMin", leadMin));
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
        } catch (Exception e) {
            Log.w(TAG, "Failed persisting state", e);
        }
    }

    private void initTts() {
        try {
            tts = new TextToSpeech(this, this);
        } catch (Exception e) {
            Log.w(TAG, "TTS init failed", e);
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS && tts != null) {
            int res = tts.setLanguage(new Locale("es", "AR"));
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                res = tts.setLanguage(new Locale("es", "ES"));
            }
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(new Locale("es"));
            }
            tts.setSpeechRate(1.02f);
            tts.setPitch(1.0f);
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    abandonAudioFocus();
                }

                @Override
                public void onError(String utteranceId) {
                    abandonAudioFocus();
                }
            });
            ttsReady = true;
            if (!pendingInitSpeeches.isEmpty()) {
                List<String> copy = new ArrayList<>(pendingInitSpeeches);
                pendingInitSpeeches.clear();
                for (String txt : copy) {
                    speakNow(txt, true);
                }
            }
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

    private void resumeActiveWorkNow() {
        if (!hasAnyActiveWork()) return;
        ensureWakeLock();
        refreshAllNotificationsAndForeground();
        if ("onboard".equals(phase)) {
            startGpsUpdates();
        }
        ensurePollingRunning();
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

        if (ACTION_ENSURE_ALIVE.equals(action) || ACTION_RESTORE_WATCHDOG.equals(action)) {
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
        if (!wCoche.isEmpty()) w.coche = wCoche;
        String wDrv = p.optString("choferNombre", "").trim();
        if (!wDrv.isEmpty()) w.choferNombre = wDrv;
        String wSched = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));
        if (!wSched.isEmpty()) w.scheduledHHMM = wSched;
        w.leadMin = Math.max(1, p.optInt("leadMin", leadMin));
        w.missingPolls = 0;

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        updateWatchMetricsAndMaybeAlert(w, incomingEta, incomingDist, isNew);

        persistState();
        refreshAllNotificationsAndForeground();
        ensurePollingRunning();
        broadcastWatches();
    }

    private void updateWatchMetricsAndMaybeAlert(WatchAlert w, int nextEta, double nextDist, boolean isInitial) {
        int prevEta = w.etaMin;
        if (nextDist >= 0) {
            w.distM = nextDist;
            if (isInitial || w.distM > w.initialDistM) {
                w.initialDistM = Math.max(900, Math.min(12000, w.distM));
            }
            w.progress01 = Math.max(0.05, Math.min(1.0, 1.0 - w.distM / Math.max(400.0, w.initialDistM)));
        } else if (nextEta >= 0) {
            // Respaldo de barra cuando no vino distancia exacta
            double estMax = Math.max(12.0, Math.max(w.leadMin + 6.0, prevEta > 0 ? prevEta : 12.0));
            w.progress01 = Math.max(0.06, Math.min(1.0, 1.0 - (nextEta / estMax)));
        }

        if (nextEta >= 0) {
            w.etaMin = nextEta;
            if (w.etaMin == 0) w.progress01 = 1.0;
            if (w.etaMin <= 1 || (w.distM >= 0 && w.distM <= 250)) {
                w.wasClose = true;
            }
        }

        if (w.etaMin < 0) return;

        // Evaluar disparo de timbre + TTS sin crear notificación duplicada
        boolean shouldAlert = false;
        if (!w.triggered && w.etaMin <= w.leadMin) {
            w.triggered = true;
            w.lastSpokenEtaMin = w.etaMin;
            shouldAlert = true;
        } else if (minuteByMinute && w.etaMin <= Math.max(w.leadMin, 10)) {
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
        coche = p.optString("coche", "").trim();
        choferNombre = p.optString("choferNombre", "").trim();
        choferLegajo = p.optString("choferLegajo", "").trim();
        bandera = p.optString("bandera", "").trim();
        scheduledHHMM = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));

        loadOrderedStopsFromJson(p.optJSONArray("orderedStops"));

        if (!sameTarget) {
            lastSpokenEtaMin = null;
            wasCloseToStop = false;
            initialDistM = 2600;
            etaMin = -1;
            distM = -1;
            progress01 = 0.08;
        }

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        if (incomingDist >= 0) {
            distM = incomingDist;
            if (!sameTarget || distM > initialDistM) {
                initialDistM = Math.max(900, Math.min(12000, distM));
            }
            progress01 = Math.max(0.05, Math.min(1.0, 1.0 - distM / Math.max(400.0, initialDistM)));
        }
        if (incomingEta >= 0) {
            etaMin = incomingEta;
            if (etaMin == 0) progress01 = 1.0;
            if (etaMin <= 1 || (distM >= 0 && distM <= 250)) wasCloseToStop = true;
        }

        persistState();
        refreshAllNotificationsAndForeground();
        ensurePollingRunning();
        broadcastSnapshot();
    }

    private void handleUpdateWaitingFromJs(JSONObject p) {
        if (!"waiting".equals(phase) && !"boarding_armed".equals(phase)) return;
        applyPrefs(p);
        String newCoche = p.optString("coche", "").trim();
        if (!newCoche.isEmpty()) coche = newCoche;
        String newChofer = p.optString("choferNombre", "").trim();
        if (!newChofer.isEmpty()) choferNombre = newChofer;
        String newSched = sanitizeScheduledHHMM(p.optString("scheduledHHMM", ""));
        if (!newSched.isEmpty()) scheduledHHMM = newSched;
        loadOrderedStopsFromJson(p.optJSONArray("orderedStops"));

        double incomingDist = p.optDouble("distM", -1);
        int incomingEta = p.optInt("etaMin", -1);
        processWaitingUpdate(incomingEta, incomingDist);
    }

    private void processWaitingUpdate(int nextEta, double nextDist) {
        int prevEta = etaMin;
        if (nextDist >= 0) {
            distM = nextDist;
            if (distM > initialDistM) {
                initialDistM = Math.max(900, Math.min(12000, distM));
            }
            progress01 = Math.max(0.05, Math.min(1.0, 1.0 - distM / Math.max(400.0, initialDistM)));
        }
        if (nextEta >= 0) {
            etaMin = nextEta;
            if (etaMin == 0) progress01 = 1.0;
            if (etaMin <= 1 || (distM >= 0 && distM <= 250)) wasCloseToStop = true;
        }

        // Auto-Subir al llegar el colectivo a la parada
        if ("boarding_armed".equals(phase)
            && ((etaMin >= 0 && etaMin <= 0) || (distM >= 0 && distM <= 95))) {
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
        releaseWakeLock();
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
                .setContentIntent(buildOpenAppIntent());
            notifManager.notify(notifId, b.build());
        }
        if (playSound) {
            playDeviceNotificationChime();
        }
        if (speakAfter && !speech.isEmpty()) {
            scheduleSpeech(speech, playSound ? 950 : 0, true);
        }
    }

    // ── Grouped 10-Second Background Poller (works with app closed & screen off!) ──
    private void ensurePollingRunning() {
        boolean needPolling = !watchedAlerts.isEmpty()
            || "waiting".equals(phase)
            || "boarding_armed".equals(phase);
        if (!needPolling) {
            stopWaitingPoller();
            return;
        }
        ensureWakeLock();
        if (pollFuture != null && !pollFuture.isCancelled() && !pollFuture.isDone()) return;
        if (pollExecutor == null || pollExecutor.isShutdown()) {
            pollExecutor = Executors.newSingleThreadScheduledExecutor();
        }
        pollFuture = pollExecutor.scheduleWithFixedDelay(this::pollAllTargetsSafe, 2, 10, TimeUnit.SECONDS);
    }

    private void stopWaitingPoller() {
        if (pollFuture != null) {
            pollFuture.cancel(false);
            pollFuture = null;
        }
    }

    private void pollAllTargetsSafe() {
        try {
            if (hasAnyActiveWork()) {
                ensureWakeLock();
            }
            pollAllTargetsOnce();
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
                    String bc = matched.optString("identificadorCoche", "").trim();
                    String bDrv = matched.optString("choferNombre", "").trim();
                    double bLat = parseDoubleSafe(matched.opt("latitud"));
                    double bLng = parseDoubleSafe(matched.opt("longitud"));
                    double sLat = stopLat != 0 ? stopLat : parseDoubleSafe(matched.opt("latitudParada"));
                    double sLng = stopLng != 0 ? stopLng : parseDoubleSafe(matched.opt("longitudParada"));
                    int parsedEta = parseEtaMinutes(matched.optString("tiempoRestanteArribo", matched.optString("tiempoRaw", "")));
                    double calcDist = (Double.isFinite(bLat) && Double.isFinite(bLng) && Double.isFinite(sLat) && Double.isFinite(sLng) && sLat != 0)
                        ? haversineMeters(bLat, bLng, sLat, sLng)
                        : -1;
                    if (!bc.isEmpty()) coche = bc;
                    if (!bDrv.isEmpty()) choferNombre = bDrv;
                    processWaitingUpdate(parsedEta, calcDist);
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
                String bc = matched.optString("identificadorCoche", "").trim();
                String bDrv = matched.optString("choferNombre", "").trim();
                if (!bc.isEmpty()) w.coche = bc;
                if (!bDrv.isEmpty()) w.choferNombre = bDrv;

                double bLat = parseDoubleSafe(matched.opt("latitud"));
                double bLng = parseDoubleSafe(matched.opt("longitud"));
                double sLat = w.stopLat != 0 ? w.stopLat : parseDoubleSafe(matched.opt("latitudParada"));
                double sLng = w.stopLng != 0 ? w.stopLng : parseDoubleSafe(matched.opt("longitudParada"));
                int parsedEta = parseEtaMinutes(matched.optString("tiempoRestanteArribo", matched.optString("tiempoRaw", "")));
                double calcDist = (Double.isFinite(bLat) && Double.isFinite(bLng) && Double.isFinite(sLat) && Double.isFinite(sLng) && sLat != 0)
                    ? haversineMeters(bLat, bLng, sLat, sLng)
                    : -1;

                updateWatchMetricsAndMaybeAlert(w, parsedEta, calcDist, false);
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
        }
    }

    private PendingIntent buildOpenAppIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 100, i, flags);
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
     * Notificación de ARRIBO (campanita de parada):
     * - Se ACTUALIZA EN EL LUGAR con barra recta estilo Uber (izquierda -> derecha) + setProgress nativo.
     * - Muestra chofer, coche, minutos reales en vivo, distancia y hora programada REAL (nunca estimada).
     */
    private Notification buildWatchNotification(WatchAlert w) {
        String cocheTxt = (w.coche == null || w.coche.isEmpty()) ? "s/d" : "#" + w.coche;
        String driverTxt = (w.choferNombre == null || w.choferNombre.isEmpty()) ? "Sin datos" : w.choferNombre;
        String schedTxt = (w.scheduledHHMM == null || w.scheduledHHMM.isEmpty()) ? "s/d" : w.scheduledHHMM;
        int pct = (int) Math.max(4, Math.min(100, Math.round(w.progress01 * 100.0)));
        String bar = SpanishTtsFormatter.buildUberProgressBar(w.progress01, 12);
        String stopShort = SpanishTtsFormatter.shortLabel(w.stopName, 20);
        String etaTxt = w.etaMin < 0 ? "En camino" : (w.etaMin <= 0 ? "ARRIBANDO" : w.etaMin + " min");

        String title = (w.etaMin == 0 ? "🔔 " : "🚌 ") + w.lineName + " · " + etaTxt + " · Coche " + cocheTxt;
        String distLine = w.distM > 0
            ? "A " + SpanishTtsFormatter.formatDistance(w.distM) + " (" + SpanishTtsFormatter.formatBlocks(w.distM) + " c.)"
            : "Actualizando en tiempo real";
        String bigBody = bar + " " + stopShort
            + "\nChofer: " + driverTxt + " · Coche " + cocheTxt
            + "\nArribo: " + etaTxt + " · Prog. real: " + schedTxt
            + "\n" + distLine + (minuteByMinute ? " · Min a min" : "");

        return new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(buildOpenAppIntent())
            .setProgress(100, pct, false)
            .setContentTitle(title)
            .setContentText(bar + " " + stopShort)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(bigBody))
            .addAction(0, "✕ Quitar aviso", buildServiceActionIntent(ACTION_REMOVE_WATCH, 300 + (w.notifId % 500), w.key))
            .build();
    }

    /**
     * Notificación de ARRIBO (línea seleccionada):
     * - Barra recta estilo Uber (izquierda -> derecha) + setProgress nativo.
     */
    private Notification buildPrimaryWaitingNotification() {
        String cocheTxt = coche.isEmpty() ? "s/d" : "#" + coche;
        String driverTxt = choferNombre.isEmpty() ? "Sin datos" : choferNombre;
        String schedTxt = scheduledHHMM.isEmpty() ? "s/d" : scheduledHHMM;
        int pct = (int) Math.max(4, Math.min(100, Math.round(progress01 * 100.0)));
        String bar = SpanishTtsFormatter.buildUberProgressBar(progress01, 12);
        String stopShort = SpanishTtsFormatter.shortLabel(stopName.isEmpty() ? stopId : stopName, 20);
        String etaTxt = etaMin < 0 ? "En camino" : (etaMin <= 0 ? "ARRIBANDO" : etaMin + " min");

        String title = (etaMin == 0 ? "🔔 " : "🚌 ") + lineName + " · " + etaTxt + " · Coche " + cocheTxt;
        String distLine = distM > 0
            ? "A " + SpanishTtsFormatter.formatDistance(distM) + " (" + SpanishTtsFormatter.formatBlocks(distM) + " c.)"
            : "Acercándose a tu parada";
        String statusLine = "boarding_armed".equals(phase)
            ? "✅ Subir activado · pasa a A Bordo al llegar"
            : distLine + (minuteByMinute ? " · Min a min" : "");

        String bigBody = bar + " " + stopShort
            + "\nChofer: " + driverTxt + " · Coche " + cocheTxt
            + "\nArribo: " + etaTxt + " · Prog. real: " + schedTxt
            + "\n" + statusLine;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(buildOpenAppIntent())
            .setProgress(100, pct, false)
            .setContentTitle(title)
            .setContentText(bar + " " + stopShort)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(bigBody));

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
            .setContentIntent(buildOpenAppIntent())
            .setContentTitle(title)
            .setContentText("Próxima: " + nextClean + distPart)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(bigBody))
            .addAction(0, "🚪 Bajar", buildServiceActionIntent(ACTION_ALIGHT, 203, null))
            .build();
    }

    // ── Real Phone Notification Ringtone + Vibrate + Post-Chime Native TTS ────
    private void triggerChimeAndSpeech(String speechText) {
        boolean playedSound = false;
        if (soundEnabled) {
            playedSound = playDeviceNotificationChime();
        }
        if (ttsEnabled && speechText != null && !speechText.isEmpty()) {
            scheduleSpeech(speechText, playedSound ? 950 : 120, true);
        }
    }

    private boolean playDeviceNotificationChime() {
        long now = System.currentTimeMillis();
        // Si 2 colectivos disparan en el mismo tick de 10 s, sonar 1 solo timbre y encolar ambas voces
        if (now - lastChimeMs < 1400) return true;
        lastChimeMs = now;

        int ringerMode = audioManager != null ? audioManager.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
        if (ringerMode == AudioManager.RINGER_MODE_SILENT) return false;

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

        if (ringerMode != AudioManager.RINGER_MODE_NORMAL) return false;

        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            Ringtone ringtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    ringtone.setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
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

    // ── Native Android TextToSpeech with AudioFocus (queued so simultaneous alerts never clip) ──
    private void scheduleSpeech(String text, long delayMs, boolean queueAdd) {
        if (text == null || text.trim().isEmpty()) return;
        if (delayMs <= 0) {
            speakNow(text, queueAdd);
            return;
        }
        final Runnable task = new Runnable() {
            @Override
            public void run() {
                scheduledSpeechTasks.remove(this);
                speakNow(text, queueAdd);
            }
        };
        scheduledSpeechTasks.add(task);
        mainHandler.postDelayed(task, delayMs);
    }

    private void cancelPendingSpeech() {
        for (Runnable r : scheduledSpeechTasks) {
            mainHandler.removeCallbacks(r);
        }
        scheduledSpeechTasks.clear();
        if (tts != null && ttsReady) {
            try {
                tts.stop();
            } catch (Exception ignored) {}
        }
    }

    private void speakNow(String text, boolean queueAdd) {
        if (!ttsReady || tts == null) {
            pendingInitSpeeches.add(text);
            return;
        }
        requestAudioFocus();
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        try {
            tts.speak(
                text,
                queueAdd ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH,
                params,
                "dgps-" + System.currentTimeMillis()
            );
        } catch (Exception e) {
            abandonAudioFocus();
        }
    }

    private void requestAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(attrs)
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
        for (WatchAlert w : watchedAlerts.values()) {
            arr.put(w.toJson());
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
        releaseWakeLock();
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        stopWaitingPoller();
        stopGpsUpdates();
        cancelPendingSpeech();
        releaseWakeLock();
        if (pollExecutor != null) pollExecutor.shutdownNow();
        if (tts != null) {
            try {
                tts.shutdown();
            } catch (Exception ignored) {}
        }
        abandonAudioFocus();
        super.onDestroy();
    }
}
