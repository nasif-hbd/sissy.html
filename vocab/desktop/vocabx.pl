#!/usr/bin/perl
#
# VocabX for macOS — the same launcher, in the one language every Mac has.
#
# The Windows and Linux downloads ship a compiled binary. A Mac binary has to
# be built on a Mac, so this is the honest alternative rather than a download
# that only runs if you already have Xcode: macOS has shipped /usr/bin/perl
# since forever, IO::Socket::INET is part of it, and nothing here is fetched
# or installed. It does exactly what vocabx.c does — serve ./app on loopback,
# open the browser at it, and nothing else.
#
#   perl vocabx.pl [path-to-app-folder]
#
use strict;
use warnings;
use IO::Socket::INET;
use POSIX qw(:sys_wait_h);
use File::Spec;
use Cwd qw(abs_path);

my $FIRST_PORT = 8749;
my $LAST_PORT  = 8779;

# The app folder: told to us, or sitting beside this script.
my $root = abs_path($ARGV[0] // (File::Spec->catdir($0 =~ m{(.*)/[^/]+$} ? $1 : '.', 'app')));
die "VocabX: could not find the app folder.\nKeep VocabX and its files together.\n"
    unless defined $root && -f "$root/index.html";

# A wrong type here is fatal rather than cosmetic: browsers refuse to execute
# an ES module served as text/plain, so getting this wrong is a blank page.
my %MIME = (
    html => 'text/html; charset=utf-8',
    js   => 'text/javascript; charset=utf-8',
    mjs  => 'text/javascript; charset=utf-8',
    css  => 'text/css; charset=utf-8',
    json => 'application/json; charset=utf-8',
    webmanifest => 'application/manifest+json',
    woff2 => 'font/woff2',
    woff => 'font/woff',
    svg  => 'image/svg+xml',
    png  => 'image/png',
    webp => 'image/webp',
    ico  => 'image/x-icon',
    txt  => 'text/plain; charset=utf-8',
);

sub mime_for {
    my ($path) = @_;
    return $MIME{lc $1} // 'application/octet-stream' if $path =~ /\.([A-Za-z0-9]+)$/;
    return 'application/octet-stream';
}

# The security boundary. A request must not escape the app folder, so the
# decoded path is refused outright if it steps upward, and the resolved path
# is checked to still sit under root once symlinks are followed.
sub resolve {
    my ($urlpath) = @_;
    $urlpath =~ s/[?#].*$//;
    $urlpath =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
    return undef if $urlpath =~ /\.\./ || $urlpath =~ /\\/ || $urlpath !~ m{^/};

    my $rel = substr($urlpath, 1);
    my $joined = ($rel eq '' || $rel =~ m{/$}) ? "$root/${rel}index.html" : "$root/$rel";

    my $full = abs_path($joined);
    return undef unless defined $full
        && ($full eq $root || index($full, "$root/") == 0);
    return undef unless -f $full;
    return $full;
}

sub serve {
    my ($client) = @_;
    my $req = '';
    # Read only the request line; the app never sends a body.
    while (sysread($client, my $buf, 4096)) {
        $req .= $buf;
        last if $req =~ /\r?\n/;
        last if length($req) > 16384;
    }

    my $send_status = sub {
        my ($status, $body) = @_;
        print $client "HTTP/1.1 $status\r\nContent-Type: text/plain; charset=utf-8\r\n"
            . 'Content-Length: ' . length($body) . "\r\nConnection: close\r\n\r\n$body";
    };

    unless ($req =~ m{^GET\s+(\S+)\s}) {
        $send_status->('405 Method Not Allowed', 'GET only.');
        return;
    }

    my $file = resolve($1);
    unless (defined $file) {
        $send_status->('404 Not Found', 'Not found.');
        return;
    }

    open(my $fh, '<:raw', $file) or do { $send_status->('404 Not Found', 'Not found.'); return };
    my $size = -s $file;
    print $client "HTTP/1.1 200 OK\r\nContent-Type: " . mime_for($file) . "\r\n"
        . "Content-Length: $size\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    my $buf;
    print $client $buf while read($fh, $buf, 65536);
    close $fh;
}

# Loopback only. This is a local app, not a server on the network.
my $server;
my $port;
for ($port = $FIRST_PORT; $port <= $LAST_PORT; $port++) {
    $server = IO::Socket::INET->new(
        LocalAddr => '127.0.0.1', LocalPort => $port,
        Proto => 'tcp', Listen => 16, ReuseAddr => 1,
    );
    last if $server;
}
die "VocabX: could not open a local port.\n" unless $server;

my $url = "http://127.0.0.1:$port/index.html";
print "VocabX is running at $url\nLeave this open; quit VocabX to stop.\n";

# A browser that hangs up mid-file would otherwise kill the whole launcher.
$SIG{PIPE} = 'IGNORE';
$SIG{CHLD} = 'IGNORE';

if (my $pid = fork()) { } elsif (defined $pid) {
    # `open` is the macOS one. xdg-open is only here so the same script can be
    # run and checked on Linux; exec returns only when the opener is missing.
    no warnings 'exec';
    exec($_, $url) for qw(open xdg-open);
    exit 127;
}

# One process per request: the app pulls many small files at once, and a
# sequential loop would make the first load crawl.
while (my $client = $server->accept) {
    my $pid = fork();
    if (!defined $pid) { serve($client); close $client; next; }
    if ($pid == 0) { serve($client); close $client; exit 0; }
    close $client;
}
