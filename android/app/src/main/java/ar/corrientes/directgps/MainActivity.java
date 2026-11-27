package ar.corrientes.directgps;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registrar el plugin nativo ANTES de super.onCreate() (requisito de Capacitor 7)
        registerPlugin(DirectGpsNativePlugin.class);
        super.onCreate(savedInstanceState);

        Window win = getWindow();
        if (win != null) {
            win.setStatusBarColor(Color.parseColor("#0b0d10"));
            win.setNavigationBarColor(Color.parseColor("#0b0d10"));
        }
    }
}
