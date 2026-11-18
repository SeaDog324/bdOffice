package office.bigdog.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.webkit.WebView;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.JSONObject;
import java.io.*;
import java.util.*;

/** Decodes only a camera capture or an image explicitly selected by the user. */
final class NativeQr {
    private static final int IMAGE = 5104;
    private final Activity activity;
    private final WebView web;
    private String pending;
    NativeQr(Activity activity, WebView web) { this.activity = activity; this.web = web; }
    void scan(String id, String mode) {
        activity.runOnUiThread(() -> {
            if (id == null || !id.matches("qr-[0-9]{1,10}")) return;
            if (pending != null) { reply(id, null, "PAIRING_SCAN_BUSY"); return; }
            pending = id;
            try {
                if ("image".equals(mode)) {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
                    activity.startActivityForResult(intent, IMAGE);
                } else if ("camera".equals(mode)) {
                    new IntentIntegrator(activity).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                        .setPrompt("扫描电脑「手机协作」中的二维码").setBeepEnabled(false).setOrientationLocked(false).initiateScan();
                } else finish(null, "INVALID_PAIRING_INVITATION");
            } catch (Exception e) { finish(null, "PAIRING_SCAN_UNAVAILABLE"); }
        });
    }
    boolean result(int request, int result, Intent data) {
        if (request != IMAGE && request != IntentIntegrator.REQUEST_CODE) return false;
        if (pending == null) return true;
        if (result != Activity.RESULT_OK || data == null) { finish(null, "PAIRING_SCAN_CANCELLED"); return true; }
        if (request != IMAGE) {
            IntentResult value = IntentIntegrator.parseActivityResult(request, result, data);
            finish(value == null ? null : value.getContents(), value == null || value.getContents() == null ? "PAIRING_SCAN_CANCELLED" : null);
            return true;
        }
        if (data.getData() == null || !"content".equals(data.getData().getScheme())) { finish(null, "PAIRING_QR_NOT_FOUND"); return true; }
        new Thread(() -> {
            Bitmap bitmap = null;
            try (InputStream input = activity.getContentResolver().openInputStream(data.getData()); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[8192]; int count;
                while ((count = input.read(chunk)) != -1) {
                    if (bytes.size() + count > 20 * 1024 * 1024) throw new IOException("image too large");
                    bytes.write(chunk, 0, count);
                }
                byte[] image = bytes.toByteArray();
                BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(image, 0, image.length, options);
                if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("invalid image");
                options.inSampleSize = 1;
                while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 2048) options.inSampleSize *= 2;
                options.inJustDecodeBounds = false;
                bitmap = BitmapFactory.decodeByteArray(image, 0, image.length, options);
                if (bitmap == null) throw new IOException("invalid image");
                int width = bitmap.getWidth(), height = bitmap.getHeight(); int[] pixels = new int[width * height];
                bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
                Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
                hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
                hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
                String text = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(width, height, pixels))), hints).getText();
                activity.runOnUiThread(() -> finish(text, null));
            } catch (Exception e) { activity.runOnUiThread(() -> finish(null, "PAIRING_QR_NOT_FOUND")); }
            finally { if (bitmap != null) bitmap.recycle(); }
        }, "bigdog-qr-image").start();
        return true;
    }
    private void finish(String value, String error) {
        String id = pending; pending = null;
        if (id == null) return;
        if (value != null && value.length() > 2048) { value = null; error = "INVALID_PAIRING_INVITATION"; }
        reply(id, value, error);
    }
    private void reply(String id, String value, String error) {
        try {
            JSONObject packet = new JSONObject().put("id", id);
            if (error != null) packet.put("error", error); else packet.put("value", value);
            if (!activity.isFinishing()) web.evaluateJavascript("window.__bigdogQr?.(" + packet + ")", null);
        } catch (Exception ignored) {}
    }
}
