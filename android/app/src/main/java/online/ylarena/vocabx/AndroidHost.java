package online.ylarena.vocabx;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;

import androidx.core.app.NotificationManagerCompat;

/**
 * The parts of the web platform Android's WebView does not have.
 *
 * WebView implements no part of the Web Notifications API, so the whole
 * reminder feature — the one thing people most expect from an installed app on
 * a phone — would silently do nothing. This is the other side of that: the app
 * calls `AndroidHost.notify(...)` and a real system notification appears.
 *
 * Everything here is reachable from JavaScript, so it is deliberately tiny and
 * deliberately dull: raise a notification, report whether we are allowed to,
 * ask for permission. Nothing reads data, nothing writes files, nothing takes
 * a URL. A bridge is the one place where a bug in the page becomes a bug in
 * the phone, so the smaller its surface, the better.
 */
public class AndroidHost {

    private static final String CHANNEL = "vocabx-reminders";
    private final Activity activity;

    AndroidHost(Activity activity) {
        this.activity = activity;
        createChannel();
    }

    /** Android 8+ shows nothing at all without a channel to show it in. */
    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "Study reminders", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("The words and questions you asked VocabX to send you.");
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    /**
     * "granted", "denied" or "default" — the same three words the web API uses,
     * so the page needs no special case beyond calling this instead.
     *
     * Asked fresh each time rather than remembered: on Android 13+ the person
     * can revoke it from system settings while the app is running.
     */
    @JavascriptInterface
    public String permission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Before Android 13 there was no runtime permission; notifications
            // work unless the person turned them off for the whole app.
            return NotificationManagerCompat.from(activity).areNotificationsEnabled()
                    ? "granted" : "denied";
        }
        boolean ok = activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (ok) return "granted";
        // "default" means never asked, "denied" means asked and refused. The
        // page uses the difference to decide whether asking again is rude.
        return activity.shouldShowRequestPermissionRationale(
                android.Manifest.permission.POST_NOTIFICATIONS) ? "denied" : "default";
    }

    /** Opens Android's own permission dialog. Nothing happens before 13. */
    @JavascriptInterface
    public void requestPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        activity.requestPermissions(
                new String[]{ android.Manifest.permission.POST_NOTIFICATIONS }, 1);
    }

    /**
     * Raise one notification. Tapping it opens the app.
     *
     * `tag` replaces an earlier notification with the same tag rather than
     * stacking a second one, which is what the web API's tag does and what
     * stops a day of reminders becoming a wall of them.
     */
    @JavascriptInterface
    public void notify(String title, String body, String tag) {
        if (!"granted".equals(permission())) return;

        Intent open = new Intent(activity, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(activity, 0, open, flags);

        // The only difference before and after Android 8 is the channel, so
        // that is the only thing that branches.
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(activity, CHANNEL)
                : new Notification.Builder(activity);

        Notification note = builder
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build();

        NotificationManager manager = (NotificationManager)
                activity.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            // The tag carries the identity; the id is fixed so the pair is
            // stable and a repeat replaces rather than piles up.
            manager.notify(tag == null ? "vocabx" : tag, 1, note);
        }
    }
}
