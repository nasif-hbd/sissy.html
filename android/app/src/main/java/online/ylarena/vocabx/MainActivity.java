package online.ylarena.vocabx;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
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
