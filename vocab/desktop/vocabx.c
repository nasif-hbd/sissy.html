/*
 * VocabX for Windows — a launcher, not a rewrite.
 *
 * The app is a web app. On a desktop the honest way to run it is to serve the
 * same files over loopback and open the browser at them: one small native
 * binary, no runtime to install, no second copy of the code to keep in step
 * with the web one.
 *
 * Build (from Linux or Windows, with mingw-w64):
 *     x86_64-w64-mingw32-gcc -O2 -s -o VocabX.exe vocabx.c -lws2_32 -lshell32 -mwindows
 *
 * It serves ONLY the `app` folder sitting beside the exe, ONLY to 127.0.0.1,
 * and it exits when the tray-less window is closed from the console or the
 * process is ended. Nothing is uploaded and no port is exposed to the network.
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define FIRST_PORT 8749
#define LAST_PORT  8779
#define BUF        16384

static char root[MAX_PATH];

/* ---------------------------------------------------------------- helpers */

/* Content types the app actually needs. A wrong type here is fatal rather than
   cosmetic: browsers refuse to execute an ES module served as text/plain, so
   getting this wrong means a blank page, not a slow one. */
static const char *mime_for(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!_stricmp(dot, ".html")) return "text/html; charset=utf-8";
    if (!_stricmp(dot, ".js"))   return "text/javascript; charset=utf-8";
    if (!_stricmp(dot, ".mjs"))  return "text/javascript; charset=utf-8";
    if (!_stricmp(dot, ".css"))  return "text/css; charset=utf-8";
    if (!_stricmp(dot, ".json")) return "application/json; charset=utf-8";
    if (!_stricmp(dot, ".webmanifest")) return "application/manifest+json";
    if (!_stricmp(dot, ".woff2")) return "font/woff2";
    if (!_stricmp(dot, ".svg"))  return "image/svg+xml";
    if (!_stricmp(dot, ".png"))  return "image/png";
    if (!_stricmp(dot, ".ico"))  return "image/x-icon";
    if (!_stricmp(dot, ".txt"))  return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

static void send_all(SOCKET s, const char *data, int len) {
    int sent = 0;
    while (sent < len) {
        int n = send(s, data + sent, len - sent, 0);
        if (n <= 0) return;
        sent += n;
    }
}

static void send_status(SOCKET s, const char *status, const char *body) {
    char head[512];
    int n = snprintf(head, sizeof head,
        "HTTP/1.1 %s\r\nContent-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: %d\r\nConnection: close\r\n\r\n", status, (int)strlen(body));
    send_all(s, head, n);
    send_all(s, body, (int)strlen(body));
}

/*
 * Turn a request path into a path inside `root`, or fail.
 *
 * This is the security boundary. A request for /../../Windows/System32 must
 * never resolve, so the decoded path is rejected outright if it contains a
 * parent-directory step, a drive letter, or a backslash, and the result is
 * checked to still start with root after Windows has canonicalised it.
 */
static int resolve(const char *urlpath, char *out, size_t outsz) {
    char decoded[MAX_PATH] = {0};
    size_t j = 0;

    for (size_t i = 0; urlpath[i] && j + 1 < sizeof decoded; i++) {
        if (urlpath[i] == '?' || urlpath[i] == '#') break;
        if (urlpath[i] == '%' && urlpath[i+1] && urlpath[i+2]) {
            char hex[3] = { urlpath[i+1], urlpath[i+2], 0 };
            decoded[j++] = (char)strtol(hex, NULL, 16);
            i += 2;
        } else {
            decoded[j++] = urlpath[i];
        }
    }
    decoded[j] = 0;

    if (strstr(decoded, "..") || strchr(decoded, '\\') || strchr(decoded, ':')) return 0;
    if (decoded[0] != '/') return 0;

    /* A bare directory means its index.html. */
    const char *rel = decoded + 1;
    char joined[MAX_PATH * 2];
    if (!*rel || rel[strlen(rel) - 1] == '/')
        snprintf(joined, sizeof joined, "%s\\%sindex.html", root, rel);
    else
        snprintf(joined, sizeof joined, "%s\\%s", root, rel);

    for (char *p = joined; *p; p++) if (*p == '/') *p = '\\';

    char full[MAX_PATH];
    if (!GetFullPathNameA(joined, sizeof full, full, NULL)) return 0;
    /* Belt and braces: after canonicalisation it must still be under root. */
    if (_strnicmp(full, root, strlen(root)) != 0) return 0;

    strncpy(out, full, outsz - 1);
    out[outsz - 1] = 0;
    return 1;
}

static void serve(SOCKET client) {
    char req[BUF];
    int n = recv(client, req, sizeof req - 1, 0);
    if (n <= 0) { closesocket(client); return; }
    req[n] = 0;

    if (strncmp(req, "GET ", 4) != 0) { send_status(client, "405 Method Not Allowed", "GET only."); closesocket(client); return; }

    char *path = req + 4;
    char *space = strchr(path, ' ');
    if (!space) { send_status(client, "400 Bad Request", "Malformed request."); closesocket(client); return; }
    *space = 0;

    char file[MAX_PATH];
    if (!resolve(path, file, sizeof file)) {
        send_status(client, "403 Forbidden", "Outside the app folder.");
        closesocket(client);
        return;
    }

    HANDLE fh = CreateFileA(file, GENERIC_READ, FILE_SHARE_READ, NULL,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (fh == INVALID_HANDLE_VALUE) {
        send_status(client, "404 Not Found", "Not found.");
        closesocket(client);
        return;
    }

    LARGE_INTEGER size;
    GetFileSizeEx(fh, &size);

    char head[512];
    int hn = snprintf(head, sizeof head,
        "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %lld\r\n"
        "Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
        mime_for(file), (long long)size.QuadPart);
    send_all(client, head, hn);

    char chunk[BUF];
    DWORD got;
    while (ReadFile(fh, chunk, sizeof chunk, &got, NULL) && got > 0)
        send_all(client, chunk, (int)got);

    CloseHandle(fh);
    closesocket(client);
}

static DWORD WINAPI worker(LPVOID param) {
    serve((SOCKET)(UINT_PTR)param);
    return 0;
}

/* ------------------------------------------------------------------- main */

int main(void) {
    /* The app folder lives beside the exe, so the launcher works from a USB
       stick or any folder the user drops it in. */
    GetModuleFileNameA(NULL, root, sizeof root);
    char *slash = strrchr(root, '\\');
    if (slash) *slash = 0;
    strncat(root, "\\app", sizeof root - strlen(root) - 1);

    char probe[MAX_PATH];
    snprintf(probe, sizeof probe, "%s\\index.html", root);
    if (GetFileAttributesA(probe) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxA(NULL,
            "Could not find the app folder.\n\n"
            "Keep VocabX.exe and the 'app' folder together in the same place.",
            "VocabX", MB_ICONERROR);
        return 1;
    }

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    SOCKET server = INVALID_SOCKET;
    int port = 0;
    for (port = FIRST_PORT; port <= LAST_PORT; port++) {
        server = socket(AF_INET, SOCK_STREAM, 0);
        if (server == INVALID_SOCKET) continue;
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof addr);
        addr.sin_family = AF_INET;
        /* Loopback only. This is a local app, not a server on the network. */
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons((u_short)port);
        if (bind(server, (struct sockaddr *)&addr, sizeof addr) == 0
            && listen(server, 16) == 0) break;
        closesocket(server);
        server = INVALID_SOCKET;
    }
    if (server == INVALID_SOCKET) {
        MessageBoxA(NULL, "Could not open a local port for VocabX.", "VocabX", MB_ICONERROR);
        return 1;
    }

    char url[64];
    snprintf(url, sizeof url, "http://127.0.0.1:%d/index.html", port);
    ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);

    for (;;) {
        SOCKET client = accept(server, NULL, NULL);
        if (client == INVALID_SOCKET) continue;
        /* One thread per request: the app pulls many small files at once, and
           a sequential loop would make the first load crawl. */
        HANDLE t = CreateThread(NULL, 0, worker, (LPVOID)(UINT_PTR)client, 0, NULL);
        if (t) CloseHandle(t); else serve(client);
    }
    return 0;
}
