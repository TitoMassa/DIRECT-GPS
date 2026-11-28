package ar.corrientes.directgps;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;

import androidx.annotation.Nullable;

import java.util.Locale;

/**
 * Renderizador gráfico estilo Uber (v3.1.0) para la barra de progreso única en las notificaciones
 * push en tiempo real de Android:
 *  - Gradiente con el color real de la línea en el tramo recorrido (izquierda -> colectivo)
 *  - Puntos de referencia sutiles en el tramo restante para percibir el avance continuo
 *  - Faro de parada destino que brilla en verde esmeralda cuando el colectivo está próximo
 *  - Cápsula superior del colectivo con luces delanteras suaves apuntando hacia la derecha
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

    private static int withAlpha(int color, int alpha) {
        return Color.argb(Math.max(0, Math.min(255, alpha)), Color.red(color), Color.green(color), Color.blue(color));
    }

    /**
     * Genera la barra recta estilo Uber (una sola línea limpia con cápsula del colectivo
     * avanzando de izquierda a derecha hasta el punto de parada destino).
     */
    public static Bitmap renderTrack(Context ctx, double progress01, int accentColor, boolean compact) {
        return renderTrack(ctx, progress01, accentColor, compact, false);
    }

    public static Bitmap renderTrack(Context ctx, double progress01, int accentColor, boolean compact, boolean imminent) {
        float density = Math.max(2.0f, ctx.getResources().getDisplayMetrics().density);
        int widthPx = Math.round(316f * density);
        int heightPx = Math.round((compact ? 25f : 33f) * density);

        Bitmap bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);

        boolean dark = isDarkMode(ctx);
        double clamped = Math.max(0.03, Math.min(1.0, progress01));

        float padX = 14f * density;
        float cy = heightPx / 2f;
        float trackStart = padX;
        float trackEnd = widthPx - padX;

        float strokeW = (compact ? 3.4f : 4.2f) * density;
        float destRadius = (compact ? 5.0f : 6.0f) * density;
        float busW = (compact ? 29f : 35f) * density;
        float busH = (compact ? 14.5f : 18f) * density;

        float minBusX = trackStart + busW * 0.5f;
        float maxBusX = trackEnd - destRadius - busW * 0.44f;
        float busCx = minBusX + (float) clamped * Math.max(1f, maxBusX - minBusX);
        float destCx = trackEnd - destRadius * 0.2f;

        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        // 1) Tramo restante (derecha) — riel translúcido limpio
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeWidth(strokeW);
        p.setColor(dark ? Color.argb(72, 255, 255, 255) : Color.argb(52, 15, 23, 42));
        c.drawLine(trackStart, cy, destCx - destRadius, cy, p);

        // 2) Micro-hitos sutiles en el tramo restante para percibir el deslizamiento continuo
        p.setStyle(Paint.Style.FILL);
        p.setColor(dark ? Color.argb(95, 255, 255, 255) : Color.argb(75, 15, 23, 42));
        float dotR = (compact ? 1.4f : 1.7f) * density;
        for (int i = 1; i <= 4; i++) {
            float mx = trackStart + (destCx - trackStart) * (i / 5.0f);
            if (mx > busCx + busW * 0.65f && mx < destCx - destRadius * 2.1f) {
                c.drawCircle(mx, cy, dotR, p);
            }
        }

        // 3) Tramo recorrido (izquierda -> colectivo) con gradiente del color real de la línea
        float filledEnd = Math.max(trackStart + 1f, busCx - busW * 0.34f);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeWidth(strokeW);
        int startCol = withAlpha(accentColor, dark ? 150 : 185);
        int endCol = imminent ? Color.parseColor("#10B981") : accentColor;
        p.setShader(new LinearGradient(trackStart, cy, filledEnd, cy, startCol, endCol, Shader.TileMode.CLAMP));
        c.drawLine(trackStart, cy, filledEnd, cy, p);
        p.setShader(null);

        // 4) Faro de parada destino a la derecha (anillo esmeralda cuando está próximo / llegando)
        boolean glowStop = imminent || clamped >= 0.86;
        if (glowStop) {
            p.setStyle(Paint.Style.FILL);
            p.setColor(Color.argb(dark ? 65 : 50, 16, 185, 129));
            c.drawCircle(destCx, cy, destRadius * 1.55f, p);
        }
        p.setStyle(Paint.Style.FILL);
        p.setColor(glowStop
            ? Color.parseColor("#10B981")
            : (dark ? Color.argb(85, 255, 255, 255) : Color.argb(42, 15, 23, 42)));
        c.drawCircle(destCx, cy, destRadius * 0.62f, p);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(1.9f * density);
        p.setColor(glowStop
            ? Color.parseColor("#34D399")
            : (dark ? Color.argb(185, 255, 255, 255) : Color.argb(145, 15, 23, 42)));
        c.drawCircle(destCx, cy, destRadius * 0.92f, p);

        // 5) Haz suave de luces delanteras (apuntando hacia la derecha)
        if (busCx + busW * 0.72f < destCx - destRadius) {
            float beamLeft = busCx + busW * 0.44f;
            float beamRight = Math.min(destCx - destRadius * 1.1f, beamLeft + 10f * density);
            p.setStyle(Paint.Style.FILL);
            p.setShader(new LinearGradient(
                beamLeft, cy, beamRight, cy,
                Color.argb(dark ? 115 : 65, 253, 224, 71),
                Color.argb(0, 253, 224, 71),
                Shader.TileMode.CLAMP
            ));
            RectF beam = new RectF(beamLeft, cy - busH * 0.34f, beamRight, cy + busH * 0.34f);
            c.drawRoundRect(beam, busH * 0.2f, busH * 0.2f, p);
            p.setShader(null);
        }

        // 6) Sombra bajo la cápsula del colectivo
        p.setStyle(Paint.Style.FILL);
        p.setColor(Color.argb(dark ? 125 : 60, 0, 0, 0));
        RectF shadowRect = new RectF(
            busCx - busW / 2f,
            cy - busH / 2f + 1.2f * density,
            busCx + busW / 2f,
            cy + busH / 2f + 1.8f * density
        );
        c.drawRoundRect(shadowRect, busH * 0.36f, busH * 0.36f, p);

        // 7) Cuerpo de la cápsula del colectivo (vista superior, orientada -> derecha)
        RectF body = new RectF(
            busCx - busW / 2f,
            cy - busH / 2f,
            busCx + busW / 2f,
            cy + busH / 2f
        );
        p.setColor(Color.WHITE);
        c.drawRoundRect(body, busH * 0.35f, busH * 0.35f, p);

        if (!dark) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(1.2f * density);
            p.setColor(Color.argb(95, 15, 23, 42));
            c.drawRoundRect(body, busH * 0.35f, busH * 0.35f, p);
            p.setStyle(Paint.Style.FILL);
        }

        // Franja de color de la línea sobre el techo
        float stripeInsetY = busH * 0.23f;
        RectF roof = new RectF(
            body.left + busW * 0.16f,
            body.top + stripeInsetY,
            body.right - busW * 0.27f,
            body.bottom - stripeInsetY
        );
        p.setColor(accentColor);
        c.drawRoundRect(roof, busH * 0.16f, busH * 0.16f, p);

        // Parabrisas delantero (derecha)
        RectF windshield = new RectF(
            body.right - busW * 0.22f,
            body.top + busH * 0.16f,
            body.right - busW * 0.08f,
            body.bottom - busH * 0.16f
        );
        p.setColor(Color.parseColor("#0F172A"));
        c.drawRoundRect(windshield, busH * 0.12f, busH * 0.12f, p);

        // Luneta trasera (izquierda)
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
     * Genera la placa de línea redondeada con color real (ej. 102C, 106C) y brillo sutil.
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
        RectF outer = new RectF(0, 0, widthPx, heightPx);
        c.drawRoundRect(outer, 10f * density, 10f * density, p);

        // Sutil brillo superior estilo badge nativo
        p.setShader(new LinearGradient(
            0, 0, 0, heightPx * 0.55f,
            Color.argb(42, 255, 255, 255),
            Color.argb(0, 255, 255, 255),
            Shader.TileMode.CLAMP
        ));
        c.drawRoundRect(outer, 10f * density, 10f * density, p);
        p.setShader(null);

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
