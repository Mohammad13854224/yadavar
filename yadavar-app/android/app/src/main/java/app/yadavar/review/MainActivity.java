package app.yadavar.review;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AnkiBackendPlugin.class);
        super.onCreate(savedInstanceState);

        // The back button goes to the app first (a dialog closes, the info tab goes one folder up: src/lib/back.ts);
        // only when nothing there uses it does Android do its usual thing (leave the app).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    leave();
                    return;
                }
                web.evaluateJavascript("window.yadavarBack ? window.yadavarBack() : false", (used) -> {
                    if (!"true".equals(used)) leave();
                });
            }

            private void leave() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
