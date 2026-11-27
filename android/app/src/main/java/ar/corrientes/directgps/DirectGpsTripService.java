package ar.corrientes.directgps;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android Foreground Service nativo de DIRECT GPS (estilo Uber).
 * Funciona de forma autónoma con la app minimizada, pantalla apagada o COMPLETAMENTE CERRADA:
 *  - Notificación fija en barra de estado con barra horizontal nativa izquierda->derecha (setProgress)
 *    mostrando chofer, coche, minutos de arribo y hora programada REAL (nunca estimada).
 *  - Botones nativos Subir / Ya subí / Bajar / Detener procesados directamente por el Servicio.
 *  - Alertas minuto a minuto y avisos de parada con timbre real del celular + TextToSpeech es-AR 950 ms después.
 *  - Modo A Bordo con LocationManager nativo anunciando "Arribando, <parada>" al llegar a cada parada.
 */
public class DirectGpsTripService extends Service implements TextToSpeech.OnInitListener, LocationListener {

    private static final String TAG = "DirectGpsTripService";

    public static final String CHANNEL_LIVE_SILENT = "direct_gps_trip_live_v1";
    public static final String CHANNEL_ALERTS_SOUND = "direct_gps_alerts_sound_v1";

    public static final int NOTIF_ID_LIVE_TRIP = 4101;
    public static final int NOTIF_ID_ALERT_BASE = 4200;

    public static final String ACTION_START_WAITING = "ar.corrientes.directgps.ACTION_START_WAITING";
    public static final String ACTION_UPDATE_WAITING = "ar.corrientes.directgps.ACTION_UPDATE_WAITING";
    public static final String ACTION_BOARD = "ar.corrientes.directgps.ACTION_BOARD";
    public static final String ACTION_BOARD_NOW = "ar.corrientes.directgps.ACTION_BOARD_NOW";
    public static final String ACTION_ALIGHT = "ar.corrientes.directgps.ACTION_ALIGHT";
    public static final String ACTION_STOP = "ar.corrientes.directgps.ACTION_STOP";
    public static final String ACTION_SYNC_PREFS = "ar.corrientes.directgps.ACTION_SYNC_PREFS";
    public static final String ACTION_SEND_ALERT = "ar.corrientes.directgps.ACTION_SEND_ALERT";
    public static final String ACTION_SPEAK_ONLY = "ar.corrientes.directgps.ACTION_SPEAK_ONLY";

    public static final String EXTRA_PAYLOAD = "payload";

    private static final Pattern ETA_MIN_PATTERN = Pattern.compile("(\\d+)");

    public interface StateListener {
        void onTripStateChanged(JSONObject snapshot);
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

    private NotificationManager notifManager;
    private LocationManager locationManager;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private String pendingInitSpeech = null;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingSpeechTask = null;

    private ScheduledExecutorService pollExecutor;
    private ScheduledFuture<?> pollFuture;

    // ── Trip State ────────────────────────────────────────────────────────────
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
        initTts();
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
            if (pendingInitSpeech != null) {
                String txt = pendingInitSpeech;
                pendingInitSpeech = null;
                speakNow(txt);
            }
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notifManager == null) return;

        NotificationChannel liveChannel = new NotificationChannel(
            CHANNEL_LIVE_SILENT,
            "Seguimiento en vivo (barra de progreso)",
            NotificationManager.IMPORTANCE_LOW
        );
        liveChannel.setDescription("Muestra en tiempo real el avance del colectivo estilo Uber en tu barra de estado.");
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

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent == null) {
            return "idle".equals(phase) ? START_NOT_STICKY : START_STICKY;
        }

        String action = intent.getAction();
        JSONObject payload = parsePayload(intent.getStringExtra(EXTRA_PAYLOAD));

        if (ACTION_START_WAITING.equals(action)) {
            handleStartWaiting(payload);
        } else if (ACTION_UPDATE_WAITING.equals(action)) {
            handleUpdateWaitingFromJs(payload);
        } else if (ACTION_BOARD.equals(action)) {
            handleRequestBoard(payload, false);
        } else if (ACTION_BOARD_NOW.equals(action)) {
            handleRequestBoard(payload, true);
        } else if (ACTION_ALIGHT.equals(action)) {
            handleAlight(false);
            return START_NOT_STICKY;
        } else if (ACTION_STOP.equals(action)) {
            handleAlight(payload != null && payload.optBoolean("silent", false));
            return START_NOT_STICKY;
        } else if (ACTION_SYNC_PREFS.equals(action)) {
            applyPrefs(payload);
            if (!"idle".equals(phase)) {
                updateForegroundNotification();
                broadcastSnapshot();
            }
        } else if (ACTION_SEND_ALERT.equals(action)) {
            handleStandaloneAlert(payload);
            if ("idle".equals(phase)) {
                // Keep service alive briefly so TTS finishes speaking, then stop cleanly
                mainHandler.postDelayed(() -> {
                    if ("idle".equals(phase)) stopSelf();
                }, 8000);
                return START_NOT_STICKY;
            }
        } else if (ACTION_SPEAK_ONLY.equals(action)) {
            String txt = payload != null ? payload.optString("text", "") : "";
            long delayMs = payload != null ? payload.optLong("delayMs", 0) : 0;
            if (!txt.isEmpty()) {
                scheduleSpeech(txt, delayMs);
            }
            if ("idle".equals(phase)) {
                mainHandler.postDelayed(() -> {
                    if ("idle".equals(phase)) stopSelf();
                }, delayMs + 8000);
                return START_NOT_STICKY;
            }
        }

        return "idle".equals(phase) ? START_NOT_STICKY : START_STICKY;
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
        if (p.has("leadMin")) leadMin = p.optInt("leadMin", leadMin);
    }

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
        String base = p.optString("apiBase", "").trim();
        if (!base.isEmpty()) apiBase = base.replaceAll("/+$", "");

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

        startForegroundCompat(buildLiveNotification());
        startWaitingPoller();
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

        // Alerta minuto a minuto o llegada a 0 min
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

        updateForegroundNotification();
        if (shouldAlert) {
            String etaTxt = etaMin <= 0 ? "ARRIBANDO AHORA" : (etaMin + " min");
            String title = (etaMin <= 0 ? "🔔 " : "🚌 ") + lineName + " · " + etaTxt
                + (coche.isEmpty() ? "" : " · #" + coche);
            String body = SpanishTtsFormatter.buildUberProgressBar(progress01, 12) + " "
                + SpanishTtsFormatter.shortLabel(stopName, 20)
                + "\nChofer: " + (choferNombre.isEmpty() ? "Sin datos" : choferNombre)
                + " · Coche #" + (coche.isEmpty() ? "—" : coche)
                + "\nArribo: " + etaTxt + " · Prog. real: " + (scheduledHHMM.isEmpty() ? "s/d" : scheduledHHMM);
            fireSoundAlert(title, body, speechText, NOTIF_ID_ALERT_BASE + 1);
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
        startForegroundCompat(buildLiveNotification());
        broadcastSnapshot();
        if (ttsEnabled) {
            scheduleSpeech(
                "Subir activado para línea " + SpanishTtsFormatter.formatLinea(lineName)
                    + ". Cuando llegue el colectivo te avisaré cada parada.",
                200
            );
        }
    }

    private void enterOnboardMode(boolean auto) {
        stopWaitingPoller();
        phase = "onboard";
        announcedStopIds.clear();
        arrivingNow = false;
        distToNextM = -1;
        progress01 = 0.05;

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

        startForegroundCompat(buildLiveNotification());
        startGpsUpdates();
        broadcastSnapshot();

        String nextClean = nextStopIdx < orderedStops.size() ? orderedStops.get(nextStopIdx).cleanName : "";
        String speech = auto
            ? "El colectivo llegó. Modo a bordo activado en línea " + SpanishTtsFormatter.formatLinea(lineName)
                + (nextClean.isEmpty() ? "." : ". Próxima parada, " + nextClean + ".")
            : "Modo a bordo activado en línea " + SpanishTtsFormatter.formatLinea(lineName)
                + (coche.isEmpty() ? "" : ", coche " + SpanishTtsFormatter.formatCoche(coche))
                + (nextClean.isEmpty() ? "." : ". Próxima parada, " + nextClean + ".");

        if (auto) {
            fireSoundAlert(
                "🚌 A bordo · " + lineName + (coche.isEmpty() ? "" : " #" + coche),
                "Modo viaje activado · Te avisaremos cada próxima parada",
                speech,
                NOTIF_ID_ALERT_BASE + 2
            );
        } else if (ttsEnabled) {
            scheduleSpeech(speech, 250);
        }
    }

    private void handleAlight(boolean silent) {
        boolean wasOnboard = "onboard".equals(phase);
        stopWaitingPoller();
        stopGpsUpdates();
        cancelPendingSpeech();
        phase = "idle";
        arrivingNow = false;
        announcedStopIds.clear();
        lastKnownSnapshot = null;

        if (notifManager != null) {
            notifManager.cancel(NOTIF_ID_LIVE_TRIP);
            notifManager.cancel(NOTIF_ID_ALERT_BASE + 1);
            notifManager.cancel(NOTIF_ID_ALERT_BASE + 2);
            notifManager.cancel(NOTIF_ID_ALERT_BASE + 3);
        }
        broadcastSnapshot();

        if (!silent && ttsEnabled) {
            String msg = wasOnboard
                ? "Bajaste del colectivo. Modo viaje finalizado."
                : "Seguimiento detenido.";
            speakNow(msg);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        mainHandler.postDelayed(() -> {
            if ("idle".equals(phase)) stopSelf();
        }, silent ? 100 : 3500);
    }

    private void handleStandaloneAlert(JSONObject p) {
        String title = p.optString("title", "DIRECT GPS");
        String body = p.optString("body", "");
        String speech = p.optString("speechText", "");
        boolean playSound = p.optBoolean("playSound", true);
        boolean speakAfter = p.optBoolean("speakAfterChime", ttsEnabled);
        int notifId = NOTIF_ID_ALERT_BASE + 10 + Math.abs(p.optString("tag", "alert").hashCode() % 40);

        if (playSound) {
            postHighAlertNotification(title, body, notifId);
            if (speakAfter && !speech.isEmpty()) {
                scheduleSpeech(speech, 950);
            }
        } else if (speakAfter && !speech.isEmpty()) {
            scheduleSpeech(speech, 0);
        }
    }

    // ── Background Waiting Poller (works even with Activity closed!) ──────────
    private void startWaitingPoller() {
        stopWaitingPoller();
        if (pollExecutor == null || pollExecutor.isShutdown() || stopId.isEmpty()) return;
        pollFuture = pollExecutor.scheduleWithFixedDelay(this::pollArrivalsOnce, 12, 12, TimeUnit.SECONDS);
    }

    private void stopWaitingPoller() {
        if (pollFuture != null) {
            pollFuture.cancel(false);
            pollFuture = null;
        }
    }

    private void pollArrivalsOnce() {
        if (!"waiting".equals(phase) && !"boarding_armed".equals(phase)) return;
        if (stopId.isEmpty() || apiBase.isEmpty()) return;

        HttpURLConnection conn = null;
        try {
            String qStop = URLEncoder.encode(stopId, "UTF-8");
            String qLine = codLinea > 0 ? String.valueOf(codLinea) : "000";
            URL url = new URL(apiBase + "/api/arribos?idParada=" + qStop + "&codLinea=" + qLine);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(7000);
            conn.setReadTimeout(7000);
            conn.setRequestMethod("GET");
            if (conn.getResponseCode() != 200) return;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }

            JSONObject root = new JSONObject(sb.toString());
            JSONObject data = root.optJSONObject("data");
            JSONArray arribos = data != null ? data.optJSONArray("arribos") : null;
            if (arribos == null || arribos.length() == 0) {
                if ("boarding_armed".equals(phase) && wasCloseToStop) {
                    mainHandler.post(() -> enterOnboardMode(true));
                }
                return;
            }

            JSONObject matched = null;
            if (lockCar && !coche.isEmpty()) {
                for (int i = 0; i < arribos.length(); i++) {
                    JSONObject b = arribos.optJSONObject(i);
                    if (b == null) continue;
                    String bc = b.optString("identificadorCoche", "").trim();
                    if (coche.equals(bc)) {
                        matched = b;
                        break;
                    }
                }
            }
            if (matched == null) {
                for (int i = 0; i < arribos.length(); i++) {
                    JSONObject b = arribos.optJSONObject(i);
                    if (b == null) continue;
                    int bCod = b.optInt("codigoLinea", 0);
                    String bLine = b.optString("descripcionLinea", "").trim();
                    if ((codLinea > 0 && bCod == codLinea) || (!lineName.isEmpty() && lineName.equalsIgnoreCase(bLine))) {
                        matched = b;
                        break;
                    }
                }
            }

            if (matched == null) {
                if ("boarding_armed".equals(phase) && wasCloseToStop) {
                    mainHandler.post(() -> enterOnboardMode(true));
                }
                return;
            }

            String bc = matched.optString("identificadorCoche", "").trim();
            String bDrv = matched.optString("choferNombre", "").trim();
            double bLat = matched.optDouble("latitud", Double.NaN);
            double bLng = matched.optDouble("longitud", Double.NaN);
            int parsedEta = parseEtaMinutes(matched.optString("tiempoRestanteArribo", matched.optString("tiempoRaw", "")));
            double calcDist = (Double.isFinite(bLat) && Double.isFinite(bLng) && stopLat != 0 && stopLng != 0)
                ? haversineMeters(bLat, bLng, stopLat, stopLng)
                : -1;

            mainHandler.post(() -> {
                if (!bc.isEmpty()) coche = bc;
                if (!bDrv.isEmpty()) choferNombre = bDrv;
                processWaitingUpdate(parsedEta, calcDist);
            });
        } catch (Exception e) {
            Log.d(TAG, "Background poll skipped: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
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

        // Buscar si saltamos alguna parada intermedia (solo avanzar hacia adelante, nunca retroceder)
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

        // Si ya anunciamos esta parada y ahora nos estamos alejando (> 110 m), avanzar a la siguiente parada
        if (announcedStopIds.contains(target.id) && dist > 110 && nextStopIdx < orderedStops.size() - 1) {
            RouteStop prev = target;
            nextStopIdx += 1;
            target = orderedStops.get(nextStopIdx);
            arrivingNow = false;
            prevStopDistRef = Math.max(120, haversineMeters(prev.lat, prev.lng, target.lat, target.lng));
            dist = haversineMeters(lat, lng, target.lat, target.lng);
            distToNextM = dist;
        }

        if (dist > prevStopDistRef) prevStopDistRef = Math.min(2500, dist);
        progress01 = Math.max(0.05, Math.min(1.0, 1.0 - dist / Math.max(120.0, prevStopDistRef)));

        // Zona de arribo a parada (<= 150 m)
        if (dist <= 150.0 && !announcedStopIds.contains(target.id)) {
            announcedStopIds.add(target.id);
            arrivingNow = true;
            progress01 = 1.0;

            boolean isFinal = nextStopIdx >= orderedStops.size() - 1;
            String speech = isFinal
                ? "Arribando, " + target.cleanName + ". Fin del recorrido."
                : "Arribando, " + target.cleanName + ".";

            updateForegroundNotification();
            fireSoundAlert(
                "🔔 ARRIBANDO · " + target.cleanName,
                SpanishTtsFormatter.buildUberProgressBar(1.0, 12) + " " + SpanishTtsFormatter.shortLabel(target.cleanName, 20)
                    + "\nLínea " + lineName + (coche.isEmpty() ? "" : " · Coche #" + coche)
                    + (choferNombre.isEmpty() ? "" : " · " + choferNombre),
                speech,
                NOTIF_ID_ALERT_BASE + 3
            );
            broadcastSnapshot();
            return;
        }

        updateForegroundNotification();
        broadcastSnapshot();
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(@NonNull String provider) {}

    @Override
    public void onProviderDisabled(@NonNull String provider) {}

    // ── Notification Builders (Uber-style native progress bar + action buttons) ──
    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (hasLocationPermission()) {
                fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION | ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            }
            try {
                startForeground(NOTIF_ID_LIVE_TRIP, notification, fgsType);
            } catch (SecurityException se) {
                startForeground(NOTIF_ID_LIVE_TRIP, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            }
        } else {
            startForeground(NOTIF_ID_LIVE_TRIP, notification);
        }
    }

    private void updateForegroundNotification() {
        if ("idle".equals(phase) || notifManager == null) return;
        notifManager.notify(NOTIF_ID_LIVE_TRIP, buildLiveNotification());
    }

    private PendingIntent buildOpenAppIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 100, i, flags);
    }

    private PendingIntent buildServiceActionIntent(String action, int reqCode) {
        Intent i = new Intent(this, DirectGpsTripService.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(this, reqCode, i, flags);
        }
        return PendingIntent.getService(this, reqCode, i, flags);
    }

    private Notification buildLiveNotification() {
        String cocheTxt = coche.isEmpty() ? "s/d" : "#" + coche;
        String driverTxt = choferNombre.isEmpty() ? "Sin datos" : choferNombre;
        String schedTxt = scheduledHHMM.isEmpty() ? "s/d" : scheduledHHMM;
        int pct = (int) Math.max(4, Math.min(100, Math.round(progress01 * 100.0)));
        String bar = SpanishTtsFormatter.buildUberProgressBar(progress01, 12);

        String title;
        String bigBody;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_LIVE_SILENT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setContentIntent(buildOpenAppIntent())
            .setProgress(100, pct, false);

        if ("onboard".equals(phase)) {
            RouteStop next = nextStopIdx < orderedStops.size() ? orderedStops.get(nextStopIdx) : null;
            String nextClean = next != null ? next.cleanName : "Fin del recorrido";
            String nextShort = SpanishTtsFormatter.shortLabel(nextClean, 22);
            int rem = Math.max(0, orderedStops.size() - nextStopIdx);
            String distPart = distToNextM >= 0 ? " · " + SpanishTtsFormatter.formatDistance(distToNextM) : "";

            title = arrivingNow
                ? "🔔 ARRIBANDO · " + nextClean
                : "🚌 A bordo " + lineName + (coche.isEmpty() ? "" : " #" + coche) + " → " + nextShort;

            bigBody = bar + " " + nextShort
                + "\nPróxima: " + nextClean + distPart
                + "\nChofer: " + driverTxt + " · Coche " + cocheTxt + " · Prog. real: " + schedTxt
                + "\n" + rem + (rem == 1 ? " parada restante" : " paradas restantes");

            builder.addAction(0, "🚪 Bajar", buildServiceActionIntent(ACTION_ALIGHT, 203));
        } else {
            String stopShort = SpanishTtsFormatter.shortLabel(stopName.isEmpty() ? stopId : stopName, 20);
            String etaTxt = etaMin < 0 ? "En camino" : (etaMin <= 0 ? "ARRIBANDO" : etaMin + " min");
            title = (etaMin == 0 ? "🔔 " : "🚌 ") + lineName + " · " + etaTxt + " · Coche " + cocheTxt;

            String distLine = distM > 0
                ? "A " + SpanishTtsFormatter.formatDistance(distM) + " (" + SpanishTtsFormatter.formatBlocks(distM) + " c.)"
                : "Acercándose a tu parada";
            String statusLine = "boarding_armed".equals(phase)
                ? "✅ Subir activado · pasa a A Bordo al llegar"
                : distLine + (minuteByMinute ? " · Min a min" : "");

            bigBody = bar + " " + stopShort
                + "\nChofer: " + driverTxt + " · Coche " + cocheTxt
                + "\nArribo: " + etaTxt + " · Prog. real: " + schedTxt
                + "\n" + statusLine;

            if ("boarding_armed".equals(phase)) {
                builder.addAction(0, "🚌 Ya subí", buildServiceActionIntent(ACTION_BOARD_NOW, 202));
            } else {
                builder.addAction(0, "🚌 Subir", buildServiceActionIntent(ACTION_BOARD, 201));
            }
            builder.addAction(0, "✕ Detener", buildServiceActionIntent(ACTION_STOP, 204));
        }

        builder.setContentTitle(title);
        builder.setContentText(bigBody.split("\n")[0]);
        builder.setStyle(new NotificationCompat.BigTextStyle().bigText(bigBody));
        return builder.build();
    }

    private void fireSoundAlert(String title, String body, String speechText, int notifId) {
        postHighAlertNotification(title, body, notifId);
        if (ttsEnabled && speechText != null && !speechText.isEmpty()) {
            // Reproducir voz nativa Android 950 ms DESPUÉS del timbre real del celular
            scheduleSpeech(speechText, 950);
        }
    }

    private void postHighAlertNotification(String title, String body, int notifId) {
        if (notifManager == null) return;
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ALERTS_SOUND)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(body.split("\n")[0])
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(buildOpenAppIntent());

        if ("onboard".equals(phase)) {
            b.addAction(0, "🚪 Bajar", buildServiceActionIntent(ACTION_ALIGHT, 213));
        }
        notifManager.notify(notifId, b.build());
    }

    // ── Native Android TextToSpeech with AudioFocus ───────────────────────────
    private void scheduleSpeech(String text, long delayMs) {
        cancelPendingSpeech();
        if (text == null || text.trim().isEmpty()) return;
        if (delayMs <= 0) {
            speakNow(text);
            return;
        }
        pendingSpeechTask = () -> {
            pendingSpeechTask = null;
            speakNow(text);
        };
        mainHandler.postDelayed(pendingSpeechTask, delayMs);
    }

    private void cancelPendingSpeech() {
        if (pendingSpeechTask != null) {
            mainHandler.removeCallbacks(pendingSpeechTask);
            pendingSpeechTask = null;
        }
        if (tts != null && ttsReady) {
            try {
                tts.stop();
            } catch (Exception ignored) {}
        }
    }

    private void speakNow(String text) {
        if (!ttsReady || tts == null) {
            pendingInitSpeech = text;
            return;
        }
        requestAudioFocus();
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f);
        try {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "dgps-" + System.currentTimeMillis());
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
    public void onDestroy() {
        stopWaitingPoller();
        stopGpsUpdates();
        cancelPendingSpeech();
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
