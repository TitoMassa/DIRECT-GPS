package ar.corrientes.directgps;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;

import androidx.annotation.Nullable;

import java.util.Locale;

/**
 * Renderizador gráfico estilo Uber para la barra de progreso única en las notificaciones en vivo.
 * Dibuja un bitmap anti-aliased con línea izquierda->derecha, punto de destino y cápsula del
 * colectivo moviéndose suavemente sin redundancia de barras nativas.
 */
public final class UberProgressBitmapRenderer {

    private UberProgressBitmapRenderer() {}

    public static boolean isDarkMode(Context ctx) {
        int nightMode = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return nightMode == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * Devuelve el color distintivo de cada familia de líneas de Corrientes (coherente con config.js).
     */
    public static int resolveLineColor(@Nullable String lineName) {
        if (lineName == null) return Color.parseColor("#10B981");
        String up = lineName.trim().toUpperCase(Locale.ROOT);
        if (up.startsWith("101")) return Color.parseColor("#E11D48");
        if (up.startsWith("102")) return Color.parseColor("#2563EB");
        if (up.startsWith("103")) return Color.parseColor("#D97706");
        if (up.startsWith("104")) return Color.parseColor("#7C3AED");
        if (up.startsWith("105")) return Color.parseColor("#059669");
        if (up.startsWith("106")) return Color.parseColor("#0284C7");
        if (up.startsWith("108")) return Color.parseColor("#EA580C");
        if (up.startsWith("109")) return Color.parseColor("#16A34A");
        if (up.startsWith("110")) return Color.parseColor("#DC2626");
        if (up.startsWith("904")) return Color.parseColor("#0891B2");
        if (up.startsWith("902")) return Color.parseColor("#4F46E5");
        return Color.parseColor("#10B981");
    }

    /**
     * Genera la barra recta estilo Uber (una sola línea limpia con cápsula del colectivo
     * avanzando de izquierda a derecha hasta el círculo de destino).
     */
    public static Bitmap renderTrack(Context ctx, double progress01, int accentColor, boolean compact) {
        float density = Math.max(2.0f, ctx.getResources().getDisplayMetrics().density);
        int widthPx = Math.round(310f * density);
        int heightPx = Math.round((compact ? 24f : 32f) * density);

        Bitmap bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);

        boolean dark = isDarkMode(ctx);
        double clamped = Math.max(0.03, Math.min(1.0, progress01));

        float padX = 14f * density;
        float cy = heightPx / 2f;
        float trackStart = padX;
        float trackEnd = widthPx - padX;
        float trackLen = Math.max(1f, trackEnd - trackStart);

        float strokeW = (compact ? 3.2f : 4.0f) * density;
        float destRadius = (compact ? 4.8f : 5.8f) * density;
        float busW = (compact ? 28f : 34f) * density;
        float busH = (compact ? 14f : 17.5f) * density;

        // Posición X del centro de la cápsula del colectivo (sin salirse de los bordes)
        float minBusX = trackStart + busW * 0.5f;
        float maxBusX = trackEnd - destRadius - busW * 0.42f;
        float busCx = minBusX + (float) clamped * Math.max(1f, maxBusX - minBusX);

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        // 1) Tramo restante (derecha) — gris translúcido estilo Uber
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeWidth(strokeW);
        p.setColor(dark ? Color.argb(85, 255, 255, 255) : Color.argb(58, 15, 23, 42));
        c.drawLine(trackStart, cy, trackEnd - destRadius, cy, p);

        // 2) Tramo recorrido (izquierda -> colectivo) — línea sólida nítida estilo Uber
        p.setColor(dark ? Color.WHITE : Color.parseColor("#111827"));
        c.drawLine(trackStart, cy, Math.max(trackStart, busCx - busW * 0.35f), cy, p);

        // 3) Punto de parada destino a la derecha (anillo limpio estilo Uber)
        p.setStyle(Paint.Style.FILL);
        p.setColor(dark ? Color.argb(90, 255, 255, 255) : Color.argb(45, 15, 23, 42));
        c.drawCircle(trackEnd - destRadius * 0.2f, cy, destRadius, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1.8f * density);
        p.setColor(clamped >= 0.96
            ? Color.parseColor("#10B981")
            : (dark ? Color.argb(175, 255, 255, 255) : Color.argb(140, 15, 23, 42)));
        c.drawCircle(trackEnd - destRadius * 0.2f, cy, destRadius * 0.85f, p);

        // 4) Sombra sutil bajo la cápsula del colectivo
        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.argb(dark ? 110 : 55, 0, 0, 0));
        RectF shadowRect = new RectF(
            busCx - busW / 2f,
            cy - busH / 2f + 1.2f * density,
            busCx + busW / 2f,
            cy + busH / 2f + 1.6f * density
        );
        c.drawRoundRect(shadowRect, busH * 0.36f, busH * 0.36f, p);

        // 5) Cuerpo de la cápsula del colectivo (vista superior estilo Uber, orientada -> derecha)
        RectF body = new RectF(
            busCx - busW / 2f,
            cy - busH / 2f,
            busCx + busW / 2f,
            cy + busH / 2f
        );
        p.setColor(Color.WHITE);
        c.drawRoundRect(body, busH * 0.34f, busH * 0.34f, p);

        // Borde sutil en modo claro para que la cápsula blanca contraste impecable
        if (!dark) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.2f * density);
            p.setColor(Color.argb(95, 15, 23, 42));
            c.drawRoundRect(body, busH * 0.34f, busH * 0.34f, p);
            p.setStyle(Paint.Style.FILL);
        }

        // Franja de color de la línea sobre el techo del colectivo
        float stripeInsetY = busH * 0.24f;
        RectF roof = new RectF(
            body.left + busW * 0.16f,
            body.top + stripeInsetY,
            body.right - busW * 0.28f,
            body.bottom - stripeInsetY
        );
        p.setColor(accentColor);
        c.drawRoundRect(roof, busH * 0.16f, busH * 0.16f, p);

        // Parabrisas delantero (a la derecha, indicando avance izquierda -> derecha)
        RectF windshield = new RectF(
            body.right - busW * 0.22f,
            body.top + busH * 0.16f,
            body.right - busW * 0.08f,
            body.bottom - busH * 0.16f
        );
        p.setColor(Color.parseColor("#1E293B"));
        c.drawRoundRect(windshield, busH * 0.12f, busH * 0.12f, p);

        // Luneta trasera (a la izquierda)
        RectF rearGlass = new RectF(
            body.left + busW * 0.06f,
            body.top + busH * 0.22f,
            body.left + busW * 0.13f,
            body.bottom - busH * 0.22f
        );
        p.setColor(Color.parseColor("#475569"));
        c.drawRoundRect(rearGlass, busH * 0.08f, busH * 0.08f, p);

        return bmp;
    }

    /**
     * Genera la placa de línea redondeada con color real (ej. 102C, 106C) para la tarjeta interna.
     */
    public static Bitmap renderLineBadge(Context ctx, String lineName, int bgColor) {
        float density = Math.max(2.0f, ctx.getResources().getDisplayMetrics().density);
        String txt = (lineName == null || lineName.trim().isEmpty()) ? "BUS" : lineName.trim();
        int widthPx = Math.round(58f * density);
        int heightPx = Math.round(36f * density);

        Bitmap bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.FILL);
        p.setColor(bgColor);
        c.drawRoundRect(new RectF(0, 0, widthPx, heightPx), 10f * density, 10f * density, p);

        p.setColor(Color.WHITE);
        p.setTextAlign(Paint.Align.CENTER);
        p.setFakeBoldText(true);
        p.setTextSize((txt.length() >= 4 ? 14f : 16f) * density);
        Paint.FontMetrics fm = p.getFontMetrics();
        float textY = (heightPx / 2f) - (fm.ascent + fm.descent) / 2f;
        c.drawText(txt, widthPx / 2f, textY, p);

        return bmp;
    }
}
