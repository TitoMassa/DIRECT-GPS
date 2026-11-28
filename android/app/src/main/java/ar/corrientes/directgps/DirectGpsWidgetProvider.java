package ar.corrientes.directgps;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Widget nativo para la pantalla de inicio de Android (v3.0.0).
 * Muestra en vivo el próximo colectivo seguido por campanita o viaje activo y abre directo esa parada al tocarlo.
 */
public class DirectGpsWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int widgetId : appWidgetIds) {
            updateSingleWidget(context, appWidgetManager, widgetId);
        }
    }

    public static void updateAllWidgets(Context context) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            ComponentName comp = new ComponentName(context, DirectGpsWidgetProvider.class);
            int[] ids = mgr.getAppWidgetIds(comp);
            if (ids != null && ids.length > 0) {
                for (int id : ids) {
                    updateSingleWidget(context, mgr, id);
                }
            }
        } catch (Exception ignored) {}
    }

    private static void updateSingleWidget(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_direct_gps);

        JSONArray watches = DirectGpsTripService.loadPersistedWatchesArray(ctx);
        JSONObject active = null;
        int bestEta = Integer.MAX_VALUE;
        for (int i = 0; i < watches.length(); i++) {
            JSONObject w = watches.optJSONObject(i);
            if (w == null) continue;
            int e = w.optInt("etaMin", 999);
            int rank = e >= 0 ? e : 999;
            if (active == null || rank < bestEta) {
                active = w;
                bestEta = rank;
            }
        }

        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        if (active != null) {
            String line = active.optString("lineName", "Bus");
            String coche = active.optString("coche", "");
            String stopId = active.optString("stopId", "");
            String stopName = SpanishTtsFormatter.shortLabel(active.optString("stopName", stopId), 30);
            String sched = active.optString("scheduledHHMM", "");
            int eta = active.optInt("etaMin", -1);
            double dist = active.optDouble("distM", -1);

            String etaTxt = eta < 0 ? "En camino" : (eta <= 0 ? "LLEGANDO" : eta + " min");
            String title = line + (coche.isEmpty() ? "" : " · Coche #" + coche);
            String distPart = dist > 0 ? " · " + SpanishTtsFormatter.formatDistance(dist) : "";
            String sub = stopName + distPart;

            views.setTextViewText(R.id.widget_brand, "DIRECT GPS · SEGUIMIENTO EN VIVO");
            views.setTextViewText(R.id.widget_sched, sched.isEmpty() ? "" : "Prog. " + sched);
            views.setTextViewText(R.id.widget_title, title);
            views.setTextViewText(R.id.widget_eta, etaTxt);
            views.setTextViewText(R.id.widget_subtitle, sub);

            if (!stopId.isEmpty()) {
                launch.putExtra("dgps_stop_id", stopId);
            }
        } else {
            views.setTextViewText(R.id.widget_brand, "DIRECT GPS · CORRIENTES");
            views.setTextViewText(R.id.widget_sched, "GPS");
            views.setTextViewText(R.id.widget_title, "Ver colectivos en vivo");
            views.setTextViewText(R.id.widget_eta, "→");
            views.setTextViewText(R.id.widget_subtitle, "Tocá para abrir paradas cercanas o activar una campanita");
            launch.putExtra("dgps_action", "locate");
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 700 + widgetId, launch, flags);
        views.setOnClickPendingIntent(R.id.widget_root, pi);

        mgr.updateAppWidget(widgetId, views);
    }
}
