package ar.corrientes.directgps;

import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registrar el plugin nativo ANTES de super.onCreate() (requisito de Capacitor 7)
        registerPlugin(DirectGpsNativePlugin.class);
        super.onCreate(savedInstanceState);

        applySystemBars("#12161a", false);

        if (bridge != null && bridge.getWebView() != null) {
            WebView wv = bridge.getWebView();
            wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
            wv.setBackgroundColor(Color.parseColor("#0b0d10"));
        }

        handleDeepLinkIntent(getIntent());

        // Botón/gesto Atrás nativo: primero cierra modales/paneles en JS; en inicio minimiza sin matar el proceso
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (!DirectGpsNativePlugin.dispatchHardwareBack()) {
                    moveTaskToBack(true);
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null) return;
        String stopId = intent.getStringExtra("dgps_stop_id");
        String tab = intent.getStringExtra("dgps_tab");
        String action = intent.getStringExtra("dgps_action");
        if ((stopId != null && !stopId.isEmpty())
            || (tab != null && !tab.isEmpty())
            || (action != null && !action.isEmpty())) {
            DirectGpsNativePlugin.dispatchDeepLink(stopId, tab, action);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Evitar que Android suspenda los timers JS del WebView al minimizar la app
        if (bridge != null && bridge.getWebView() != null) {
            try {
                bridge.getWebView().resumeTimers();
            } catch (Exception ignored) {}
        }
        // Asegurar que el Foreground Service nativo siga vivo si hay campanitas o viaje activo
        if (DirectGpsTripService.hasPersistedActiveWork(this)) {
            try {
                Intent keepAlive = new Intent(this, DirectGpsTripService.class);
                keepAlive.setAction(DirectGpsTripService.ACTION_ENSURE_ALIVE);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(keepAlive);
                } else {
                    startService(keepAlive);
                }
            } catch (Exception ignored) {}
        }
        DirectGpsNativePlugin.dispatchAppState(false);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (bridge != null && bridge.getWebView() != null) {
            try {
                bridge.getWebView().onResume();
                bridge.getWebView().resumeTimers();
            } catch (Exception ignored) {}
        }
        DirectGpsNativePlugin.dispatchAppState(true);
    }

    public void minimizeWithoutClosing() {
        runOnUiThread(() -> moveTaskToBack(true));
    }

    public void applySystemBars(String hexColor, boolean lightIcons) {
        runOnUiThread(() -> {
            Window win = getWindow();
            if (win == null) return;
            try {
                int parsed = Color.parseColor(hexColor);
                win.setStatusBarColor(parsed);
                win.setNavigationBarColor(parsed);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    win.setNavigationBarContrastEnforced(false);
                }
                WindowInsetsControllerCompat ctrl = new WindowInsetsControllerCompat(win, win.getDecorView());
                ctrl.setAppearanceLightStatusBars(lightIcons);
                ctrl.setAppearanceLightNavigationBars(lightIcons);
            } catch (Exception ignored) {}
        });
    }
}
