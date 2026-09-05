package online.ylarena.vocabx;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.app.DownloadManager;
import android.os.Bundle;
import android.os.Environment;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

/**
 * VocabX for Android.
 *
 * The whole app — every word, every pack, the grammar bank, the fonts — is
 * packed into the APK and served from inside it. Nothing is fetched to start,
 * so it works on a plane, on a dead SIM, on the first launch after install.
 *
 * The one subtlety worth knowing: this does NOT load the files as file:// URLs.
 * A file:// page has no origin, and a page with no origin cannot run ES
 * modules, cannot use localStorage, and cannot register a service worker —
 * which is to say the app would not run at all. WebViewAssetLoader serves the
 * same files over https://appassets.androidplatform.net/, a real secure origin
 * that never touches the network, and everything works exactly as it does in a
 * browser.
 */
public class MainActivity extends Activity {

    /** Where the bundled app is served from. Local; no request leaves the device. */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // The app keeps every word, streak and schedule in localStorage. Without
        // this it starts fresh every launch, which looks like data loss.
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);

        /* The parts of the web platform WebView lacks. Reachable from any page
           in this WebView — which is only ever our own, since every other link
           is handed to the browser below. */
        web.addJavascriptInterface(new AndroidHost(this), "AndroidHost");

        /* Settings offers the desktop app as a file. In a WebView a download
           link does nothing at all unless something is listening, so the tap
           would look broken rather than unsupported. */
        web.setDownloadListener((url, agent, disposition, mime, size) -> {
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType(mime);
                req.addRequestHeader("cookie", CookieManager.getInstance().getCookie(url));
                req.setDescription("Downloading " + name);
                req.setTitle(name);
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(req);
                    Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                Toast.makeText(this, "Could not start the download", Toast.LENGTH_SHORT).show();
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri url = req.getUrl();
                // Our own pages stay inside. A link to anywhere else opens in the
                // browser, rather than trapping someone in a window with no
                // address bar and no way back out.
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    // No browser installed to handle it; better to do nothing
                    // than to crash the app over a link.
                }
                return true;
            }
        });

        /* The app registers a service worker. Its requests do not go through
           the WebViewClient above, so without this they would miss the loader
           and fail — the app would still run, but noisily. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                    new ServiceWorkerClientCompat() {
                        @Override
                        public WebResourceResponse shouldInterceptRequest(WebResourceRequest req) {
                            return loader.shouldInterceptRequest(req.getUrl());
                        }
                    });
        }

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(START);
    }

    /** Rotation keeps the page rather than reloading it mid-session. */
    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /* Back walks the app's own history first — inside a card, back should
       leave the card, not the app. Only at the start does it close. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
