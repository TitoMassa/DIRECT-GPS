package ar.corrientes.directgps;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Plugin nativo Capacitor para DIRECT GPS Android (v3.0.0 — Edición Nativa Integral).
 * Expone `window.Capacitor.Plugins.DirectGpsNative`:
 *  - Selector nativo de timbre de notificación del teléfono (RingtoneManager.ACTION_RINGTONE_PICKER)
 *  - Campanitas persistentes en tiempo real + TTS inmortal auto-reparable en segundo plano
 *  - Modo Subir / A Bordo / Bajar autónomo incluso con la app cerrada
 *  - Compartir imágenes PNG/JPG por WhatsApp/Android Share Sheet (FileProvider)
 *  - Háptica nativa flagship (VibrationEffect predefined) + Deep-links de Widget/Atajos/Notificaciones
 *  - Auto-actualizador nativo in-app (descarga APK con progreso e instala con FileProvider)
 */
@CapacitorPlugin(
    name = "DirectGpsNative",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        ),
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        ),
        @Permission(
            alias = "backgroundLocation",
            strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
        )
    }
)
public class DirectGpsNativePlugin extends Plugin {

    private static volatile DirectGpsNativePlugin activeInstance = null;
    private static volatile JSObject pendingLaunchDeepLink = null;
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();

    public static boolean dispatchHardwareBack() {
        DirectGpsNativePlugin inst = activeInstance;
        if (inst == null || !inst.hasListeners("hardwareBack")) return false;
        inst.notifyListeners("hardwareBack", new JSObject(), false);
        return true;
    }

    public static void dispatchAppState(boolean isActive) {
        DirectGpsNativePlugin inst = activeInstance;
        if (inst == null) return;
        JSObject data = new JSObject();
        data.put("isActive", isActive);
        inst.notifyListeners("appStateChanged", data, false);
    }

    public static void dispatchDeepLink(String stopId, String tab, String action) {
        JSObject link = new JSObject();
        if (stopId != null && !stopId.isEmpty()) link.put("stopId", stopId);
        if (tab != null && !tab.isEmpty()) link.put("tab", tab);
        if (action != null && !action.isEmpty()) link.put("action", action);
        pendingLaunchDeepLink = link;
        DirectGpsNativePlugin inst = activeInstance;
        if (inst != null && inst.hasListeners("deepLink")) {
            pendingLaunchDeepLink = null;
            inst.notifyListeners("deepLink", link, false);
        }
    }

    @Override
    public void load() {
        super.load();
        activeInstance = this;
        DirectGpsTripService.setStateListener(new DirectGpsTripService.StateListener() {
            @Override
            public void onTripStateChanged(JSONObject snapshot) {
                try {
                    JSObject data = JSObject.fromJSONObject(snapshot);
                    notifyListeners("tripStateChanged", data, true);
                } catch (Exception ignored) {}
            }

            @Override
            public void onWatchedAlertsChanged(JSONArray alerts) {
                try {
                    JSObject data = new JSObject();
                    data.put("alerts", alerts);
                    notifyListeners("watchedAlertsChanged", data, true);
                } catch (Exception ignored) {}
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) activeInstance = null;
        DirectGpsTripService.setStateListener(null);
        downloadExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private void dispatchServiceIntent(String action, JSONObject payload, boolean asForeground) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, DirectGpsTripService.class);
        intent.setAction(action);
        if (payload != null) {
            intent.putExtra(DirectGpsTripService.EXTRA_PAYLOAD, payload.toString());
        }
        try {
            if (asForeground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void consumeLaunchDeepLink(PluginCall call) {
        JSObject link = pendingLaunchDeepLink;
        pendingLaunchDeepLink = null;
        call.resolve(link != null ? link : new JSObject());
    }

    @PluginMethod
    public void setSystemBarsColor(PluginCall call) {
        String color = call.getString("color");
        if (color == null || !color.trim().startsWith("#")) color = "#12161a";
        boolean lightIcons = Boolean.TRUE.equals(call.getBoolean("lightIcons", false));
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).applySystemBars(color.trim(), lightIcons);
        }
        call.resolve();
    }

    @PluginMethod
    public void minimizeApp(PluginCall call) {
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).minimizeWithoutClosing();
        }
        call.resolve();
    }

    @PluginMethod
    public void ensureBackgroundAlive(PluginCall call) {
        if (DirectGpsTripService.hasPersistedActiveWork(getContext())) {
            dispatchServiceIntent(DirectGpsTripService.ACTION_ENSURE_ALIVE, null, true);
        }
        call.resolve();
    }

    @PluginMethod
    public void hapticFeedback(PluginCall call) {
        String kind = call.getString("kind", "light");
        try {
            Context ctx = getContext();
            Vibrator vib = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) vib = vm.getDefaultVibrator();
            } else {
                vib = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vib != null && vib.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    int effectId = VibrationEffect.EFFECT_TICK;
                    if ("success".equals(kind)) effectId = VibrationEffect.EFFECT_DOUBLE_CLICK;
                    else if ("medium".equals(kind)) effectId = VibrationEffect.EFFECT_CLICK;
                    vib.vibrate(VibrationEffect.createPredefined(effectId));
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    long ms = "success".equals(kind) ? 35 : ("medium".equals(kind) ? 18 : 10);
                    vib.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vib.vibrate("medium".equals(kind) ? 18 : 10);
                }
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    // ── Selector nativo de timbre de notificación del teléfono ────────────────
    @PluginMethod
    public void getNotificationRingtone(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("uri", DirectGpsTripService.getCustomRingtoneUri(ctx));
        ret.put("title", DirectGpsTripService.getCustomRingtoneTitle(ctx));
        call.resolve(ret);
    }

    @PluginMethod
    public void resetNotificationRingtone(PluginCall call) {
        Context ctx = getContext();
        DirectGpsTripService.saveCustomRingtone(ctx, "", "");
        JSObject ret = new JSObject();
        ret.put("uri", "");
        ret.put("title", DirectGpsTripService.getCustomRingtoneTitle(ctx));
        call.resolve(ret);
    }

    @PluginMethod
    public void pickNotificationRingtone(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(RingtoneManager.ACTION_RINGTONE_PICKER);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Elegí el timbre de DIRECT GPS");
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false);

            String currentUriStr = DirectGpsTripService.getCustomRingtoneUri(ctx);
            Uri existingUri = (currentUriStr != null && !currentUriStr.isEmpty())
                ? Uri.parse(currentUriStr)
                : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, existingUri);
            intent.putExtra(RingtoneManager.EXTRA_RINGTONE_DEFAULT_URI, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));

            startActivityForResult(call, intent, "ringtonePickerCallback");
        } catch (Exception e) {
            call.reject("No se pudo abrir el selector de timbres: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void ringtonePickerCallback(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Context ctx = getContext();
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Uri pickedUri = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pickedUri = result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri.class);
            } else {
                pickedUri = result.getData().getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI);
            }
            if (pickedUri != null) {
                String title = "Timbre personalizado";
                try {
                    Ringtone r = RingtoneManager.getRingtone(ctx, pickedUri);
                    if (r != null) {
                        String t = r.getTitle(ctx);
                        if (t != null && !t.trim().isEmpty()) title = t.trim();
                    }
                } catch (Exception ignored) {}
                DirectGpsTripService.saveCustomRingtone(ctx, pickedUri.toString(), title);
                JSObject ret = new JSObject();
                ret.put("changed", true);
                ret.put("uri", pickedUri.toString());
                ret.put("title", title);
                call.resolve(ret);
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("changed", false);
        ret.put("uri", DirectGpsTripService.getCustomRingtoneUri(ctx));
        ret.put("title", DirectGpsTripService.getCustomRingtoneTitle(ctx));
        call.resolve(ret);
    }

    // ── Compartir imagen PNG/JPG nativamente por WhatsApp / Android Share Sheet ─
    @PluginMethod
    public void shareImageBase64(PluginCall call) {
        String dataUrl = call.getString("dataUrl");
        String rawName = call.getString("filename");
        String title = call.getString("title");
        if (dataUrl == null || !dataUrl.contains(",")) {
            call.reject("Imagen inválida");
            return;
        }
        String safeName = (rawName != null && !rawName.trim().isEmpty() ? rawName.trim() : "direct-gps-horarios.png")
            .replaceAll("[^0-9A-Za-z._-]", "_");
        boolean isJpg = safeName.toLowerCase().endsWith(".jpg") || safeName.toLowerCase().endsWith(".jpeg");
        String mime = isJpg ? "image/jpeg" : "image/png";

        try {
            Context ctx = getContext();
            String b64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            File baseDir = ctx.getExternalCacheDir();
            if (baseDir == null) baseDir = ctx.getCacheDir();
            File outDir = new File(baseDir, "shares");
            if (!outDir.exists()) outDir.mkdirs();
            File outFile = new File(outDir, safeName);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
                fos.flush();
            }

            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", outFile);
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType(mime);
            share.putExtra(Intent.EXTRA_STREAM, uri);
            if (title != null && !title.isEmpty()) {
                share.putExtra(Intent.EXTRA_SUBJECT, title);
                share.putExtra(Intent.EXTRA_TEXT, title);
            }
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(share, "Compartir grilla de horarios");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(chooser);

            JSObject ok = new JSObject();
            ok.put("shared", true);
            call.resolve(ok);
        } catch (Exception e) {
            call.reject("No se pudo compartir la imagen: " + e.getMessage());
        }
    }

    // ── Diagnóstico nativo Android ────────────────────────────────────────────
    @PluginMethod
    public void getNativeStatus(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        try {
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long vCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
            ret.put("versionName", pi.versionName != null ? pi.versionName : "3.1.3");
            ret.put("versionCode", vCode);
        } catch (Exception e) {
            ret.put("versionName", "3.1.3");
            ret.put("versionCode", 313);
        }
        boolean batteryIgnoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) batteryIgnoring = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }
        ret.put("androidRelease", Build.VERSION.RELEASE);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
        ret.put("serviceRunning", DirectGpsTripService.isServiceRunning());
        ret.put("activeWatchCount", DirectGpsTripService.loadPersistedWatchesArray(ctx).length());
        ret.put("ringtoneTitle", DirectGpsTripService.getCustomRingtoneTitle(ctx));
        ret.put("ringtoneUri", DirectGpsTripService.getCustomRingtoneUri(ctx));
        ret.put("batteryUnrestricted", batteryIgnoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long vCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
            ret.put("versionName", pi.versionName != null ? pi.versionName : "3.1.3");
            ret.put("versionCode", vCode);
        } catch (Exception e) {
            ret.put("versionName", "3.1.3");
            ret.put("versionCode", 313);
        }
        call.resolve(ret);
    }

    private JSObject buildPermissionsSnapshot() {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        boolean locGranted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        boolean bgLocGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || (locGranted && ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED);
        boolean batteryIgnoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                batteryIgnoring = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
            }
        }
        boolean installAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || ctx.getPackageManager().canRequestPackageInstalls();

        ret.put("notifications", notifGranted ? "granted" : "prompt");
        ret.put("location", locGranted ? "granted" : "prompt");
        ret.put("backgroundLocation", bgLocGranted ? "granted" : "prompt");
        ret.put("batteryOptimization", batteryIgnoring ? "granted" : "prompt");
        ret.put("installPackages", installAllowed ? "granted" : "prompt");
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        return ret;
    }

    @PluginMethod
    public void getPermissionsStatus(PluginCall call) {
        call.resolve(buildPermissionsSnapshot());
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        boolean needNotif = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED;
        if (!needNotif) {
            call.resolve(buildPermissionsSnapshot());
            return;
        }
        requestPermissionForAlias("notifications", call, "permsCallback");
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        boolean needNotif = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED;
        boolean needLoc = getPermissionState("location") != PermissionState.GRANTED;

        if (!needNotif && !needLoc) {
            call.resolve(buildPermissionsSnapshot());
            return;
        }
        if (needNotif && needLoc) {
            requestPermissionForAliases(new String[]{"notifications", "location"}, call, "permsCallback");
        } else if (needNotif) {
            requestPermissionForAlias("notifications", call, "permsCallback");
        } else {
            requestPermissionForAlias("location", call, "permsCallback");
        }
    }

    @PluginMethod
    public void requestBackgroundLocationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.resolve(buildPermissionsSnapshot());
            return;
        }
        boolean locGranted = getPermissionState("location") == PermissionState.GRANTED;
        if (!locGranted) {
            requestPermissionForAlias("location", call, "permsCallback");
            return;
        }
        if (getPermissionState("backgroundLocation") == PermissionState.GRANTED) {
            call.resolve(buildPermissionsSnapshot());
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "permsCallback");
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PermissionCallback
    private void permsCallback(PluginCall call) {
        call.resolve(buildPermissionsSnapshot());
    }

    // ── Campanitas de parada persistentes (en tiempo real) ────────────────────
    @PluginMethod
    public void upsertWatchAlert(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_UPSERT_WATCH, call.getData(), true);
        call.resolve();
    }

    @PluginMethod
    public void removeWatchAlert(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_REMOVE_WATCH, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void clearWatchAlerts(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_CLEAR_WATCHES, null, false);
        call.resolve();
    }

    @PluginMethod
    public void getWatchedAlerts(PluginCall call) {
        JSONArray arr = DirectGpsTripService.loadPersistedWatchesArray(getContext());
        JSObject ret = new JSObject();
        try {
            ret.put("alerts", new JSArray(arr.toString()));
        } catch (Exception e) {
            ret.put("alerts", new JSArray());
        }
        call.resolve(ret);
    }

    // ── Seguimiento de línea y Modo A Bordo ───────────────────────────────────
    @PluginMethod
    public void startWaiting(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_START_WAITING, call.getData(), true);
        call.resolve();
    }

    @PluginMethod
    public void updateWaitingFromJs(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_UPDATE_WAITING, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void requestBoard(PluginCall call) {
        boolean immediate = Boolean.TRUE.equals(call.getBoolean("immediate", false));
        dispatchServiceIntent(
            immediate ? DirectGpsTripService.ACTION_BOARD_NOW : DirectGpsTripService.ACTION_BOARD,
            call.getData(),
            true
        );
        call.resolve();
    }

    @PluginMethod
    public void alight(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_ALIGHT, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void stopTrip(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_STOP, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void syncPrefs(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_SYNC_PREFS, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void sendAlertNotification(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_SEND_ALERT, call.getData(), false);
        JSObject ret = new JSObject();
        ret.put("delivered", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void speakNative(PluginCall call) {
        dispatchServiceIntent(DirectGpsTripService.ACTION_SPEAK_ONLY, call.getData(), false);
        call.resolve();
    }

    @PluginMethod
    public void getTripState(PluginCall call) {
        JSONObject snap = DirectGpsTripService.getLastKnownSnapshot();
        if (snap == null) {
            JSObject idle = new JSObject();
            idle.put("phase", "idle");
            call.resolve(idle);
            return;
        }
        try {
            call.resolve(JSObject.fromJSONObject(snap));
        } catch (Exception e) {
            JSObject idle = new JSObject();
            idle.put("phase", "idle");
            call.resolve(idle);
        }
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        try {
            Context ctx = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + ctx.getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(i);
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.resolve();
        }
    }

    // ── Auto-actualizador nativo in-app (descarga APK y abre instalador Android) ──
    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        String rawUrl = call.getString("url");
        final String apkUrl = rawUrl != null ? rawUrl.trim() : "";
        String rawVer = call.getString("version");
        final String version = (rawVer != null && !rawVer.trim().isEmpty() ? rawVer : "latest")
            .replaceAll("[^0-9A-Za-z._-]", "");
        if (apkUrl.isEmpty() || !apkUrl.startsWith("https://")) {
            call.reject("URL de actualización inválida");
            return;
        }

        final Context ctx = getContext();
        // Verificar permiso "Instalar apps desconocidas" en Android 8+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent permIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                permIntent.setData(Uri.parse("package:" + ctx.getPackageName()));
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(permIntent);
            } catch (Exception ignored) {}
            JSObject needPerm = new JSObject();
            needPerm.put("status", "permission_required");
            call.resolve(needPerm);
            return;
        }

        downloadExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File baseDir = ctx.getExternalCacheDir();
                if (baseDir == null) baseDir = ctx.getCacheDir();
                File outDir = new File(baseDir, "updates");
                if (!outDir.exists()) outDir.mkdirs();
                File apkFile = new File(outDir, "direct-gps-v" + version + ".apk");
                if (apkFile.exists()) apkFile.delete();

                // Seguir redirecciones de GitHub Releases (302 -> objects.githubusercontent.com)
                URL currentUrl = new URL(apkUrl);
                int redirects = 0;
                while (redirects < 6) {
                    conn = (HttpURLConnection) currentUrl.openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setRequestProperty("User-Agent", "DIRECT-GPS-Android/" + version);
                    int code = conn.getResponseCode();
                    if (code == HttpURLConnection.HTTP_MOVED_TEMP
                        || code == HttpURLConnection.HTTP_MOVED_PERM
                        || code == HttpURLConnection.HTTP_SEE_OTHER
                        || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.isEmpty()) throw new Exception("Redirección sin destino");
                        currentUrl = new URL(currentUrl, loc);
                        redirects++;
                        continue;
                    }
                    if (code != HttpURLConnection.HTTP_OK) {
                        throw new Exception("HTTP " + code);
                    }
                    break;
                }

                long totalBytes = conn.getContentLengthLong();
                long downloaded = 0;
                int lastPct = -1;
                long lastUnknownEmit = 0;

                try (InputStream in = new BufferedInputStream(conn.getInputStream());
                     FileOutputStream out = new FileOutputStream(apkFile)) {
                    byte[] buf = new byte[16384];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
                        downloaded += read;
                        int pct = totalBytes > 0
                            ? (int) Math.min(100, Math.round((downloaded * 100.0) / totalBytes))
                            : -1;
                        boolean shouldEmit = totalBytes > 0
                            ? (pct != lastPct && (pct == 100 || pct - lastPct >= 2))
                            : (downloaded - lastUnknownEmit >= 200_000);
                        if (shouldEmit) {
                            lastPct = pct;
                            lastUnknownEmit = downloaded;
                            JSObject prog = new JSObject();
                            prog.put("percent", pct);
                            prog.put("bytesDownloaded", downloaded);
                            prog.put("totalBytes", totalBytes);
                            notifyListeners("apkDownloadProgress", prog, false);
                        }
                    }
                    out.flush();
                }

                if (apkFile.length() < 100_000) {
                    throw new Exception("El archivo descargado está incompleto");
                }

                Uri apkUri = FileProvider.getUriForFile(
                    ctx,
                    ctx.getPackageName() + ".fileprovider",
                    apkFile
                );
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(installIntent);

                JSObject ok = new JSObject();
                ok.put("status", "installing");
                ok.put("bytes", apkFile.length());
                call.resolve(ok);
            } catch (Exception e) {
                call.reject("No se pudo descargar la actualización: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }
}
