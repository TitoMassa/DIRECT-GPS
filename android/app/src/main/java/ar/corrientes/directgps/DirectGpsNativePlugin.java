package ar.corrientes.directgps;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/**
 * Plugin nativo Capacitor para DIRECT GPS Android.
 * Expone `window.Capacitor.Plugins.DirectGpsNative` al frontend web/PWA para controlar
 * el Foreground Service (notificación barra de estado estilo Uber, timbre real + TTS es-AR,
 * seguimiento minuto a minuto y Modo Subir/Bajar incluso con la app cerrada).
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

    @Override
    public void load() {
        super.load();
        DirectGpsTripService.setStateListener(snapshot -> {
            try {
                JSObject data = JSObject.fromJSONObject(snapshot);
                notifyListeners("tripStateChanged", data, true);
            } catch (Exception ignored) {}
        });
    }

    @Override
    protected void handleOnDestroy() {
        DirectGpsTripService.setStateListener(null);
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
}
