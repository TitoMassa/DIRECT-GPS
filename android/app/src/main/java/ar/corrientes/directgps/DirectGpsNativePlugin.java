package ar.corrientes.directgps;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
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
 * Plugin nativo Capacitor para DIRECT GPS Android (v2.8.0).
 * Expone `window.Capacitor.Plugins.DirectGpsNative`:
 *  - Campanitas persistentes en tiempo real (actualización en el lugar + barra Uber + timbre + TTS)
 *  - Modo Subir / A Bordo / Bajar autónomo incluso con la app cerrada
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
        )
    }
)
public class DirectGpsNativePlugin extends Plugin {

    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        super.load();
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
        if (asForeground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long vCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
            ret.put("versionName", pi.versionName != null ? pi.versionName : "2.8.0");
            ret.put("versionCode", vCode);
        } catch (Exception e) {
            ret.put("versionName", "2.8.0");
            ret.put("versionCode", 280);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void getPermissionsStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        boolean locGranted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        ret.put("notifications", notifGranted ? "granted" : "prompt");
        ret.put("location", locGranted ? "granted" : "prompt");
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        boolean needNotif = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED;
        boolean needLoc = getPermissionState("location") != PermissionState.GRANTED;

        if (!needNotif && !needLoc) {
            getPermissionsStatus(call);
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

    @PermissionCallback
    private void permsCallback(PluginCall call) {
        getPermissionsStatus(call);
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
