package app.yadavar.review;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import androidx.activity.result.ActivityResult;

import net.ankiweb.rsdroid.Backend;
import net.ankiweb.rsdroid.exceptions.BackendNotFoundException;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Bridge between the web UI and Anki's own Rust backend (the library AnkiDroid uses, same Anki version as the desktop app).
 * It does exactly two things: open the collection stored in the app's private folder, and forward numbered backend
 * calls (protobuf bytes) to the library. All logic lives in the library and in src/lib/engine (TypeScript).
 */
@CapacitorPlugin(
    name = "AnkiBackend",
    permissions = {
        @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"),
        @Permission(strings = {Manifest.permission.CAMERA}, alias = "camera")
    }
)
public class AnkiBackendPlugin extends Plugin {
    static {
        System.loadLibrary("rsdroid");
    }

    // the backend is used by one thread at a time: calls are queued here
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private OpenBackend backend;

    /** runMethodRaw is protected in the library's Backend class; a subclass makes it callable from here. */
    private static class OpenBackend extends Backend {
        OpenBackend() {
            super(Collections.singletonList("en"));
        }

        byte[] run(int service, int method, byte[] input) {
            return runMethodRaw(service, method, input);
        }
    }

    @PluginMethod
    public void open(final PluginCall call) {
        worker.execute(() -> {
            try {
                if (backend == null) {
                    File dir = home();
                    if (!dir.exists() && !dir.mkdirs()) {
                        call.reject("cannot create " + dir);
                        return;
                    }
                    backend = new OpenBackend();
                    backend.openCollection(collectionFile().getAbsolutePath());
                    mediaDir();
                    tidy();
                }
                JSObject out = new JSObject();
                out.put("dir", home().getAbsolutePath());
                out.put("mediaDir", new File(home(), "collection.media").getAbsolutePath());
                call.resolve(out);
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()), t instanceof Exception ? (Exception) t : null);
            }
        });
    }

    @PluginMethod
    public void run(final PluginCall call) {
        final int service = call.getInt("service", -1);
        final int method = call.getInt("method", -1);
        final String data = call.getString("data", "");
        worker.execute(() -> {
            try {
                if (backend == null) {
                    call.reject("backend is not open");
                    return;
                }
                byte[] input = Base64.decode(data, Base64.NO_WRAP);
                byte[] output = backend.run(service, method, input);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(output, Base64.NO_WRAP));
                call.resolve(out);
            } catch (BackendNotFoundException e) {
                call.reject(String.valueOf(e.getMessage()), "NOT_FOUND");
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()), "ERROR");
            }
        });
    }

    // ------------------------------------------------------------------ backup / restore (one .colpkg file)

    /**
     * Everything the app keeps lives in one folder named after it, inside the app's private storage (no other app can
     * read it; Android removes it on uninstall unless the user chooses to keep it, see hasFragileUserData):
     *   Ankio/collection.anki2       cards, folders, schedule and review history (Anki's own database)
     *   Ankio/collection.media/      pictures and sounds
     *   Ankio/backups/               the safety copy made before a backup file replaces everything
     * Older versions used files/anki and files/backups; they are moved in once.
     */
    private File home() {
        File files = getContext().getFilesDir();
        // (the folder keeps the app's first name: renaming it would leave every installed collection behind)
        File home = new File(files, "Ankio");
        if (!home.exists()) {
            File old = new File(files, "anki");
            // if the move ever fails, keep using the old folder: never open an empty collection next to the real one
            if (old.exists() && !old.renameTo(home)) return old;
        }
        File oldBackups = new File(files, "backups");
        if (oldBackups.exists() && home.exists() && !new File(home, "backups").exists()) //noinspection ResultOfMethodCallIgnored
            oldBackups.renameTo(new File(home, "backups"));
        return home;
    }

    /**
     * Older versions left big files behind: the backup made for «خروجی گرفتن» in the cache, a backup file being imported,
     * and a full safety copy for every import. Only the latest safety copy is kept.
     */
    private void tidy() {
        for (String name : new String[] {"yadavar-backup.colpkg", "yadavar-import.colpkg", "ankio-backup.colpkg", "ankio-import.colpkg"}) //noinspection ResultOfMethodCallIgnored
            new File(getContext().getCacheDir(), name).delete();
        File[] safe = new File(home(), "backups").listFiles((d, n) -> n.startsWith("before-import-"));
        if (safe == null || safe.length < 2) return;
        java.util.Arrays.sort(safe, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
        for (int i = 1; i < safe.length; i++) //noinspection ResultOfMethodCallIgnored
            safe[i].delete();
    }

    /** The folder of pictures and sounds; made if missing (a fresh install has none until the first one is added). */
    private File mediaDir() {
        File dir = new File(home(), "collection.media");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private File collectionFile() {
        return new File(home(), "collection.anki2");
    }

    /** Anki's package export closes the collection; open it again afterwards. */
    private void reopen() {
        backend.openCollection(collectionFile().getAbsolutePath());
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }

    /** Writes the whole collection to a .colpkg in the cache, then lets the user choose where to save it. */
    @PluginMethod
    public void exportBackup(final PluginCall call) {
        worker.execute(() -> {
            try {
                mediaDir();
                File out = new File(getContext().getCacheDir(), "yadavar-backup.colpkg");
                if (out.exists() && !out.delete()) throw new java.io.IOException("cannot replace old backup file");
                try {
                    backend.exportCollectionPackage(out.getAbsolutePath(), true, false);
                } finally {
                    reopen();
                }
                final String name = "yadavar-" + new SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(new Date()) + ".colpkg";
                getActivity().runOnUiThread(() -> {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/octet-stream");
                    intent.putExtra(Intent.EXTRA_TITLE, name);
                    startActivityForResult(call, intent, "exportPicked");
                });
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()), "ERROR");
            }
        });
    }

    @ActivityCallback
    private void exportPicked(final PluginCall call, final ActivityResult result) {
        if (call == null) return;
        final File made = new File(getContext().getCacheDir(), "yadavar-backup.colpkg");
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            //noinspection ResultOfMethodCallIgnored
            made.delete(); // (as big as everything: never left behind)
            call.reject("cancelled", "CANCELLED");
            return;
        }
        final Uri target = result.getData().getData();
        worker.execute(() -> {
            // "wt": the chosen file is written from scratch (plain "w" does not shorten an existing file on some phones)
            try (InputStream in = new FileInputStream(made);
                 OutputStream out = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new java.io.IOException("cannot write to the chosen place");
                copy(in, out);
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
            } catch (Throwable t) {
                call.reject(String.valueOf(t.getMessage()), "ERROR");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                made.delete();
            }
        });
    }

    /** Lets the user choose a .colpkg file and replaces the whole collection with it (a safety copy is made first). */
    @PluginMethod
    public void importBackup(final PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "importPicked");
    }

    @ActivityCallback
    private void importPicked(final PluginCall call, final ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled", "CANCELLED");
            return;
        }
        final Uri source = result.getData().getData();
        worker.execute(() -> {
            File incoming = new File(getContext().getCacheDir(), "yadavar-import.colpkg");
            try {
                try (InputStream in = getContext().getContentResolver().openInputStream(source);
                     OutputStream out = new FileOutputStream(incoming)) {
                    if (in == null) throw new java.io.IOException("cannot read the chosen file");
                    copy(in, out);
                }
                if (incoming.length() < 100) throw new java.io.IOException("the chosen file is empty (" + incoming.length() + " bytes)");
                // safety copy of what is there now, kept inside the app; only the latest one is kept (each is as big as
                // everything, pictures and sounds included)
                mediaDir(); // (a backup with media reads this folder: on a fresh install it does not exist yet)
                File dir = new File(home(), "backups");
                if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("cannot create backups folder");
                File safe = new File(dir, "before-import-" + System.currentTimeMillis() + ".colpkg");
                try {
                    backend.exportCollectionPackage(safe.getAbsolutePath(), true, false);
                } finally {
                    reopen();
                }
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (!f.equals(safe) && f.getName().startsWith("before-import-")) //noinspection ResultOfMethodCallIgnored
                    f.delete();
                File col = collectionFile();
                String base = col.getAbsolutePath().replace(".anki2", "");
                backend.closeCollection(false);
                try {
                    backend.importCollectionPackage(col.getAbsolutePath(), incoming.getAbsolutePath(), base + ".media", base + ".media.db");
                } finally {
                    reopen();
                }
                JSObject ok = new JSObject();
                ok.put("ok", true);
                call.resolve(ok);
            } catch (Throwable t) {
                // the reason goes to the screen: «the file is broken» is not always why
                call.reject(t.getClass().getSimpleName() + ": " + t.getMessage(), "ERROR");
            } finally {
                //noinspection ResultOfMethodCallIgnored
                incoming.delete();
            }
        });
    }

    /** Opens this app's page in Android's settings (for permissions that were denied for good). */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> {
            try {
                if (backend != null) {
                    backend.closeCollection(false);
                    backend.close();
                    backend = null;
                }
            } catch (Throwable ignored) {
                // closing on exit: nothing more to do
            }
        });
        worker.shutdown();
        super.handleOnDestroy();
    }
}
