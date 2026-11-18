package office.bigdog.mobile;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Notification;
import android.os.Bundle;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.webkit.*;
import android.net.Uri;
import android.util.Base64;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.*;
import java.security.*;
import java.security.spec.ECGenParameterSpec;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** Hosts the locally bundled uni-app UI. Native bridges are exposed only to the app's asset origin. */
public class MainActivity extends Activity {
    private WebView web;
    private NativeRtc rtc;
    private NativeNetwork network;
    private NativeQr qr;
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String IDENTITY = "bigdog.mobile.identity.v1";
    private static final String VAULT = "bigdog.mobile.vault.v1";
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this); setContentView(web);
        web.setOnApplyWindowInsetsListener((view,insets)->{
            if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(android.view.WindowInsets.Type.systemBars());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);}
            else view.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
            return insets;
        });
        web.setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        rtc = new NativeRtc(this, web);
        network = new NativeNetwork(this, web);
        qr = new NativeQr(this, web);
        web.addJavascriptInterface(new Bridge(), "BigDogNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !ORIGIN.equals(request.getUrl().getScheme() + "://" + request.getUrl().getHost());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!"appassets.androidplatform.net".equals(url.getHost())) return null;
                String path = url.getPath();
                if (path == null || path.contains("..") || !path.startsWith("/")) return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                if (path.equals("/")) path = "/index.html";
                try {
                    String ext = path.substring(path.lastIndexOf('.') + 1);
                    String mime = switch (ext) { case "js", "mjs" -> "application/javascript"; case "css" -> "text/css"; case "html" -> "text/html"; case "svg" -> "image/svg+xml"; case "png" -> "image/png"; case "woff2" -> "font/woff2"; default -> "application/octet-stream"; };
                    return new WebResourceResponse(mime, "UTF-8", getAssets().open("www" + path));
                } catch (Exception ignored) { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.loadUrl(ORIGIN + "/index.html");
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel("tasks", "大狗任务", NotificationManager.IMPORTANCE_DEFAULT));
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.dispatchEvent(new Event('bigdog-back'))", null);
    }
    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        if (qr != null && qr.result(request, result, data)) return;
        super.onActivityResult(request, result, data);
    }
    @Override protected void onNewIntent(android.content.Intent intent){super.onNewIntent(intent);setIntent(intent);if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('bigdog-foreground'))",null);}
    @Override protected void onResume(){super.onResume();if(web!=null){web.onResume();web.evaluateJavascript("window.dispatchEvent(new Event('bigdog-foreground'))",null);}}
    @Override protected void onPause(){if(web!=null){web.evaluateJavascript("window.dispatchEvent(new Event('bigdog-background'))",null);web.onPause();}super.onPause();}
    @Override protected void onDestroy() { rtc.closeAll(); network.close(); web.destroy(); super.onDestroy(); }
    private synchronized KeyStore keys() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(IDENTITY)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(IDENTITY, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
            generator.generateKeyPair();
        }
        if (!store.containsAlias(VAULT)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(VAULT, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return store;
    }
    private String encode(byte[] bytes) { return Base64.encodeToString(bytes, Base64.NO_WRAP); }
    private String failure(String code) { return "{\"error\":\"" + code + "\"}"; }
    public class Bridge {
        @JavascriptInterface public void appearance(String mode) {
            if (!"dark".equals(mode) && !"light".equals(mode)) return;
            final boolean dark = "dark".equals(mode);
            runOnUiThread(() -> {
                int flags = web.getSystemUiVisibility();
                int lightBars = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                web.setSystemUiVisibility(dark ? flags & ~lightBars : flags | lightBars);
                if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
                    int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    getWindow().getInsetsController().setSystemBarsAppearance(dark ? 0 : mask, mask);
                }
                web.setBackgroundColor(dark ? Color.rgb(34, 39, 53) : Color.rgb(228, 236, 252));
            });
        }
        @JavascriptInterface public void scanQr(String id, String mode) { qr.scan(id, mode); }
        @JavascriptInterface public void showNotices(){runOnUiThread(()->{
            try(java.io.InputStream input=getAssets().open("www/static/THIRD-PARTY-NOTICES.txt")){
                java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];int count;
                while((count=input.read(buffer))!=-1)bytes.write(buffer,0,count);
                android.widget.TextView text=new android.widget.TextView(MainActivity.this);text.setText(bytes.toString("UTF-8"));text.setTextSize(12);text.setPadding(24,16,24,16);text.setTextIsSelectable(true);
                android.widget.ScrollView scroll=new android.widget.ScrollView(MainActivity.this);scroll.addView(text);
                new android.app.AlertDialog.Builder(MainActivity.this).setTitle("开源致谢").setView(scroll).setPositiveButton("关闭",(dialog,which)->dialog.dismiss()).show();
            }catch(Exception ignored){}
        });}
        @JavascriptInterface public void closeApp(){runOnUiThread(()->finish());}
        @JavascriptInterface public String identity() {
            try { return encode(keys().getCertificate(IDENTITY).getPublicKey().getEncoded()); }
            catch(Exception e) { throw new IllegalStateException("IDENTITY_UNAVAILABLE"); }
        }
        @JavascriptInterface public String sign(String payload) {
            if (payload == null || !payload.startsWith("bigdog.mobile.auth.v1\n") || payload.length() > 2048) throw new IllegalArgumentException("INVALID_AUTH_PAYLOAD");
            try {
                Signature signature = Signature.getInstance("SHA256withECDSA"); signature.initSign((PrivateKey)keys().getKey(IDENTITY, null));
                signature.update(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8)); return encode(signature.sign());
            } catch(Exception e) { throw new IllegalStateException("SIGNING_FAILED"); }
        }
        @JavascriptInterface public synchronized String secureGet(String key) {
            try {
                String value = getSharedPreferences("vault", MODE_PRIVATE).getString(key, null); if (value == null) return "";
                JSONObject packet = new JSONObject(value); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, keys().getKey(VAULT, null), new GCMParameterSpec(128, Base64.decode(packet.getString("iv"), Base64.DEFAULT)));
                cipher.updateAAD(key.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                return new String(cipher.doFinal(Base64.decode(packet.getString("data"), Base64.DEFAULT)), java.nio.charset.StandardCharsets.UTF_8);
            } catch(Exception e) { throw new IllegalStateException("VAULT_READ_FAILED"); }
        }
        @JavascriptInterface public synchronized boolean secureSet(String key, String value) {
            if (key == null || key.length() > 512 || value == null || value.length() > 4 * 1024 * 1024) return false;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, keys().getKey(VAULT, null));
                cipher.updateAAD(key.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                JSONObject packet = new JSONObject().put("iv", encode(cipher.getIV())).put("data", encode(cipher.doFinal(value.getBytes(java.nio.charset.StandardCharsets.UTF_8))));
                return getSharedPreferences("vault", MODE_PRIVATE).edit().putString(key, packet.toString()).commit();
            } catch(Exception e) { return false; }
        }
        @JavascriptInterface public String pdfPage(String content, int pageIndex, int width) {
            if (content == null || content.length() > 34 * 1024 * 1024 || pageIndex < 0 || width < 100 || width > 1600) return failure("INVALID_PREVIEW");
            try {
                byte[] bytes = Base64.decode(content, Base64.DEFAULT);
                StringBuilder digestName = new StringBuilder(); for(byte item:MessageDigest.getInstance("SHA-256").digest(bytes))digestName.append(String.format(java.util.Locale.ROOT,"%02x",item&255));
                String name = digestName.toString();
                File directory = new File(getCacheDir(), "pdf"); directory.mkdirs();
                File file = new File(directory, name + ".pdf");
                if (!file.exists()) { File[] old = directory.listFiles(); if (old != null && old.length >= 8) for (File item : old) item.delete(); try(FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); } }
                try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY); PdfRenderer renderer = new PdfRenderer(descriptor)) {
                    if (pageIndex >= renderer.getPageCount()) return failure("PAGE_NOT_FOUND");
                    try (PdfRenderer.Page page = renderer.openPage(pageIndex)) {
                        int height = Math.max(1, Math.min(2400, (int)((long)width * page.getHeight() / page.getWidth())));
                        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.WHITE);
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        ByteArrayOutputStream output = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); bitmap.recycle();
                        return new JSONObject().put("pages", renderer.getPageCount()).put("page", pageIndex).put("image", "data:image/png;base64," + encode(output.toByteArray())).toString();
                    }
                }
            } catch(Exception e) { return failure("PDF_PREVIEW_FAILED"); }
        }
        @JavascriptInterface public void rtc(String request) { rtc.request(request); }
        @JavascriptInterface public void network(String request) { network.request(request); }
        @JavascriptInterface public void notificationPermission() {
            if (Build.VERSION.SDK_INT >= 33) runOnUiThread(() -> requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1));
        }
        @JavascriptInterface public String pushState() {
            try { return new JSONObject().put("endpoint",getSharedPreferences("push",MODE_PRIVATE).getString("endpoint",""))
                .put("error",getSharedPreferences("push",MODE_PRIVATE).getString("error",""))
                .put("distributors",new JSONArray(org.unifiedpush.android.connector.UnifiedPush.getDistributors(MainActivity.this))).toString(); }
            catch(Exception e){return failure("PUSH_UNAVAILABLE");}
        }
        @JavascriptInterface public void registerPush() {
            runOnUiThread(()->org.unifiedpush.android.connector.UnifiedPush.tryUseCurrentOrDefaultDistributor(MainActivity.this, success->{
                if(success)org.unifiedpush.android.connector.UnifiedPush.register(MainActivity.this,org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT,"大狗任务通知",null);
                return kotlin.Unit.INSTANCE;
            }));
        }
        @JavascriptInterface public boolean notifyTask(String id, String title, String body) {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
            ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(id.hashCode(), new Notification.Builder(MainActivity.this, "tasks")
                .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(body).setAutoCancel(true).build());
            return true;
        }
    }
}
