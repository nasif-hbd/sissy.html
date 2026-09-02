/*
 * VocabX for the desktop — a launcher, not a rewrite.
 *
 * The app is a web app. On a desktop the honest way to run it is to serve the
 * same files over loopback and open the browser at them: one small native
 * binary, no runtime to install, no second copy of the code to keep in step
 * with the web one.
 *
 * One source, three systems. Windows, Linux and macOS differ in four small
 * places — sockets, threads, "where am I", and "open this URL" — so those are
 * shimmed at the top and the server below is the same code everywhere. A
 * second implementation per platform would be three things to keep correct
 * instead of one.
 *
 *     ./build.sh                 (see the script for each toolchain)
 *
 * It serves ONLY the `app` folder sitting beside the binary, ONLY to
 * 127.0.0.1, and it exits when the process is ended. Nothing is uploaded and
 * no port is exposed to the network.
 */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <sys/stat.h>

/* ------------------------------------------------------- platform shims */

#ifdef _WIN32
  #define WIN32_LEAN_AND_MEAN
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #include <windows.h>
  #include <shellapi.h>

  typedef SOCKET sock_t;
  #define BAD_SOCK   INVALID_SOCKET
  #define close_sock closesocket
  #define ci_cmp     _stricmp
  #define SEP        '\\'
  #define PATH_CAP   MAX_PATH
#else
  #include <sys/socket.h>
  #include <sys/types.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  #include <pthread.h>
  #include <signal.h>
  #include <strings.h>
  #include <limits.h>
  #ifdef __APPLE__
    #include <mach-o/dyld.h>
  #endif

  typedef int sock_t;
  #define BAD_SOCK   (-1)
  #define close_sock close
  #define ci_cmp     strcasecmp
  #define SEP        '/'
  #ifdef PATH_MAX
    #define PATH_CAP PATH_MAX
  #else
    #define PATH_CAP 4096
  #endif
#endif

#define FIRST_PORT 8749
#define LAST_PORT  8779
#define BUF        16384

static char root[PATH_CAP];

/* Where the binary is, so `app` is found wherever the folder was dropped —
   a USB stick, the Desktop, Program Files. */
static int exe_dir(char *out, size_t cap) {
#ifdef _WIN32
    if (!GetModuleFileNameA(NULL, out, (DWORD)cap)) return 0;
#elif defined(__APPLE__)
    uint32_t n = (uint32_t)cap;
    if (_NSGetExecutablePath(out, &n) != 0) return 0;
#else
    ssize_t n = readlink("/proc/self/exe", out, cap - 1);
    if (n <= 0) return 0;
    out[n] = 0;
#endif
    char *slash = strrchr(out, SEP);
    if (!slash) return 0;
    *slash = 0;
    return 1;
}

/* Hand the URL to whatever the system calls a browser. */
static void open_browser(const char *url) {
#ifdef _WIN32
    ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
#else
  #ifdef __APPLE__
    const char *opener = "open";
  #else
    const char *opener = "xdg-open";
  #endif
    /* fork so the launcher keeps serving; the child replaces itself with the
       opener and its exit is nobody's business. */
    pid_t pid = fork();
    if (pid == 0) {
        execlp(opener, opener, url, (char *)NULL);
        /* No opener on PATH: the address is still printed below, so say
           nothing here and let the person paste it. */
        _exit(127);
    }
#endif
}

/* The one thing a person must see when it cannot start. */
static void fatal(const char *msg) {
#ifdef _WIN32
    MessageBoxA(NULL, msg, "VocabX", MB_ICONERROR);
#else
    fprintf(stderr, "VocabX: %s\n", msg);
#endif
}

/* ---------------------------------------------------------------- helpers */

/* Content types the app actually needs. A wrong type here is fatal rather than
   cosmetic: browsers refuse to execute an ES module served as text/plain, so
   getting this wrong means a blank page, not a slow one. */
static const char *mime_for(const char *path) {
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!ci_cmp(dot, ".html")) return "text/html; charset=utf-8";
    if (!ci_cmp(dot, ".js"))   return "text/javascript; charset=utf-8";
    if (!ci_cmp(dot, ".mjs"))  return "text/javascript; charset=utf-8";
    if (!ci_cmp(dot, ".css"))  return "text/css; charset=utf-8";
    if (!ci_cmp(dot, ".json")) return "application/json; charset=utf-8";
    if (!ci_cmp(dot, ".webmanifest")) return "application/manifest+json";
    if (!ci_cmp(dot, ".woff2")) return "font/woff2";
    if (!ci_cmp(dot, ".woff"))  return "font/woff";
    if (!ci_cmp(dot, ".svg"))  return "image/svg+xml";
    if (!ci_cmp(dot, ".png"))  return "image/png";
    if (!ci_cmp(dot, ".webp")) return "image/webp";
    if (!ci_cmp(dot, ".ico"))  return "image/x-icon";
    if (!ci_cmp(dot, ".txt"))  return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

static void send_all(sock_t s, const char *data, int len) {
    int sent = 0;
    while (sent < len) {
        int n = (int)send(s, data + sent, len - sent, 0);
        if (n <= 0) return;
        sent += n;
    }
}

static void send_status(sock_t s, const char *status, const char *body) {
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
 * This is the security boundary. A request for /../../etc/passwd must never
 * resolve, so the decoded path is rejected outright if it contains a
 * parent-directory step, a drive letter, or a backslash, and the result is
 * checked to still start with root after the system has canonicalised it.
 */
static int resolve(const char *urlpath, char *out, size_t outsz) {
    char decoded[PATH_CAP];
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
    char joined[PATH_CAP * 2];
    if (!*rel || rel[strlen(rel) - 1] == '/')
        snprintf(joined, sizeof joined, "%s%c%sindex.html", root, SEP, rel);
    else
        snprintf(joined, sizeof joined, "%s%c%s", root, SEP, rel);

#ifdef _WIN32
    for (char *p = joined; *p; p++) if (*p == '/') *p = '\\';

    char full[PATH_CAP];
    if (!GetFullPathNameA(joined, sizeof full, full, NULL)) return 0;
    /* Belt and braces: after canonicalisation it must still be under root. */
    if (_strnicmp(full, root, strlen(root)) != 0) return 0;
#else
    char full[PATH_CAP];
    /* realpath resolves symlinks too, so a link planted inside app/ cannot
       point out of it. A missing file returns NULL, which the caller turns
       into the 404 it is. */
    if (!realpath(joined, full)) return 0;
    if (strncmp(full, root, strlen(root)) != 0) return 0;
#endif
    /* The prefix alone would also accept a sibling folder whose name merely
       starts with root's — app-backup next to app. The next character has to
       be the separator, or nothing. */
    if (full[strlen(root)] != SEP && full[strlen(root)] != '\0') return 0;

    snprintf(out, outsz, "%s", full);
    return 1;
}

static void serve(sock_t client) {
    char req[BUF];
    int n = (int)recv(client, req, sizeof req - 1, 0);
    if (n <= 0) { close_sock(client); return; }
    req[n] = 0;

    if (strncmp(req, "GET ", 4) != 0) { send_status(client, "405 Method Not Allowed", "GET only."); close_sock(client); return; }

    char *path = req + 4;
    char *space = strchr(path, ' ');
    if (!space) { send_status(client, "400 Bad Request", "Malformed request."); close_sock(client); return; }
    *space = 0;

    char file[PATH_CAP];
    if (!resolve(path, file, sizeof file)) {
        send_status(client, "404 Not Found", "Not found.");
        close_sock(client);
        return;
    }

    /* A directory opens happily on Linux and then reads as nothing, which
       would answer 200 with an empty body — worse than saying it is not
       there. Only regular files are served. */
    struct stat st;
    if (stat(file, &st) != 0 || !(st.st_mode & S_IFREG)) {
        send_status(client, "404 Not Found", "Not found.");
        close_sock(client);
        return;
    }

    FILE *fh = fopen(file, "rb");
    if (!fh) {
        send_status(client, "404 Not Found", "Not found.");
        close_sock(client);
        return;
    }
    long size = (long)st.st_size;

    char head[512];
    int hn = snprintf(head, sizeof head,
        "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\n"
        "Cache-Control: no-cache\r\nConnection: close\r\n\r\n",
        mime_for(file), size);
    send_all(client, head, hn);

    char chunk[BUF];
    size_t got;
    while ((got = fread(chunk, 1, sizeof chunk, fh)) > 0)
        send_all(client, chunk, (int)got);

    fclose(fh);
    close_sock(client);
}

/* One thread per request: the app pulls many small files at once, and a
   sequential loop would make the first load crawl. */
#ifdef _WIN32
static DWORD WINAPI worker(LPVOID param) {
    serve((sock_t)(UINT_PTR)param);
    return 0;
}
#else
static void *worker(void *param) {
    serve((sock_t)(intptr_t)param);
    return NULL;
}
#endif

static void spawn(sock_t client) {
#ifdef _WIN32
    HANDLE t = CreateThread(NULL, 0, worker, (LPVOID)(UINT_PTR)client, 0, NULL);
    if (t) CloseHandle(t); else serve(client);
#else
    pthread_t t;
    if (pthread_create(&t, NULL, worker, (void *)(intptr_t)client) == 0) pthread_detach(t);
    else serve(client);
#endif
}

/* ------------------------------------------------------------------- main */

int main(void) {
    /* The app folder lives beside the binary, so the launcher works from a USB
       stick or any folder it is dropped in. */
    if (!exe_dir(root, sizeof root)) {
        fatal("Could not work out where VocabX is installed.");
        return 1;
    }
    size_t len = strlen(root);
    snprintf(root + len, sizeof root - len, "%capp", SEP);

    char probe[PATH_CAP];
    snprintf(probe, sizeof probe, "%s%cindex.html", root, SEP);
    FILE *check = fopen(probe, "rb");
    if (!check) {
        fatal("Could not find the app folder.\n\n"
              "Keep VocabX and the 'app' folder together in the same place.");
        return 1;
    }
    fclose(check);

#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;
#else
    /* A browser that closes a connection mid-file would otherwise kill the
       whole launcher with SIGPIPE. */
    signal(SIGPIPE, SIG_IGN);
#endif

    sock_t server = BAD_SOCK;
    int port = 0;
    for (port = FIRST_PORT; port <= LAST_PORT; port++) {
        server = socket(AF_INET, SOCK_STREAM, 0);
        if (server == BAD_SOCK) continue;
        struct sockaddr_in addr;
        memset(&addr, 0, sizeof addr);
        addr.sin_family = AF_INET;
        /* Loopback only. This is a local app, not a server on the network. */
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons((unsigned short)port);
        if (bind(server, (struct sockaddr *)&addr, sizeof addr) == 0
            && listen(server, 16) == 0) break;
        close_sock(server);
        server = BAD_SOCK;
    }
    if (server == BAD_SOCK) {
        fatal("Could not open a local port for VocabX.");
        return 1;
    }

    char url[64];
    snprintf(url, sizeof url, "http://127.0.0.1:%d/index.html", port);
#ifndef _WIN32
    /* Printed as well as opened: if there is no desktop opener, or the browser
       comes up on the wrong screen, the address is right there to paste. */
    printf("VocabX is running at %s\nLeave this open; press Ctrl+C to stop.\n", url);
    fflush(stdout);
#endif
    open_browser(url);

    for (;;) {
        sock_t client = accept(server, NULL, NULL);
        if (client == BAD_SOCK) continue;
        spawn(client);
    }
    return 0;
}
