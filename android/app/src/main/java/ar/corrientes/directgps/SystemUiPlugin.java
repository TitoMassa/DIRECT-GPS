package ar.corrientes.directgps;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small native plugin for the bits of system UI that the official Capacitor
 * plugins don't cover: navigation bar color/icons (to follow the in-app
 * light / dark theme) and keeping the screen awake while arrival alerts are armed.
 */
@CapacitorPlugin(name = "SystemUi")
public class SystemUiPlugin extends Plugin {

    @PluginMethod
    public void setNavigationBar(PluginCall call) {
        final String colorStr = call.getString("color", "#10151c");
        final boolean lightButtons = Boolean.TRUE.equals(call.getBoolean("lightButtons", false));

        getActivity().runOnUiThread(() -> {
            try {
                Window window = getActivity().getWindow();
                int color = Color.parseColor(colorStr);
                window.setNavigationBarColor(color);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    View decor = window.getDecorView();
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
                    controller.setAppearanceLightNavigationBars(lightButtons);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("No se pudo actualizar la barra de navegación", e);
            }
        });
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }
}
