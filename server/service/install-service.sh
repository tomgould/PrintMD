#!/usr/bin/env bash
# Install the PrintMD PDF API as a systemd USER service: it starts when you log in (and at boot when
# lingering is on), listens on 127.0.0.1 only, and costs nothing while idle (the browser closes when there
# is nothing to render). No root, no container. For macOS see "Run it as a service" in server/README.md.
#
#   server/service/install-service.sh [options]
#
#   --port N         port on 127.0.0.1 (default 8787, where the branded-pdf skill looks)
#   --idle S         close the browser after S quiet seconds (default 60; 0 keeps it open)
#   --chrome WHAT    auto (default): your Chrome or Chromium if one is on the PATH, else the Playwright browser;
#                    playwright: the Playwright browser; or the path of a Chrome or Chromium binary
#   --node PATH      node binary (default: the one on the PATH; version 22 or newer)
#   --repo DIR       the checkout to run (default: the one this script is in)
#   --dry-run        print the unit and change nothing
#   --unit-dir DIR   write the unit there and do not call systemctl (tests)
#   --no-start       write the unit but do not enable or start it
#   --uninstall      stop, disable and remove the service
#
# Run it again after changing the Node version or the options; it replaces the unit and restarts the service.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
port=8787
idle=60
chrome=auto
node_bin=''
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
dry=0
nostart=0
uninstall=0
name=printmd-api.service

die() {
    echo "install-service: $*" >&2
    exit 1
}

usage() {
    sed -n '2,19p' "${BASH_SOURCE[0]}" | cut -c3-
}

while (($#)); do
    case $1 in
        --port) port=${2:-}; shift 2 ;;
        --idle) idle=${2:-}; shift 2 ;;
        --chrome) chrome=${2:-}; shift 2 ;;
        --node) node_bin=${2:-}; shift 2 ;;
        --repo) repo=${2:-}; shift 2 ;;
        --unit-dir) unit_dir=${2:-}; nostart=1; shift 2 ;;
        --dry-run) dry=1; shift ;;
        --no-start) nostart=1; shift ;;
        --uninstall) uninstall=1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) die "unknown option: $1 (try --help)" ;;
    esac
done

unit_file="$unit_dir/$name"

if ((uninstall)); then
    if ((!nostart)); then
        systemctl --user disable --now "$name" 2>/dev/null || true
    fi
    rm -f "$unit_file"
    if ((!nostart)); then systemctl --user daemon-reload; fi
    echo "Removed $name."
    exit 0
fi

[[ $port =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || die "--port must be a number from 1 to 65535"
[[ $idle =~ ^[0-9]+$ ]] && ((idle <= 86400)) || die "--idle must be a number of seconds from 0 to 86400"
repo=$(cd "$repo" 2>/dev/null && pwd) || die "--repo is not a folder"
case $repo in
    *[[:space:]%\$\"\'\\]*) die "the checkout path must not contain spaces, quotes, % or \$ (systemd would misread it): $repo" ;;
esac
[[ -f $repo/server/src/main.mjs ]] || die "no server/src/main.mjs under $repo"
[[ -f $here/printmd-api.service.in ]] || die "the unit template is missing next to this script"

node_bin=${node_bin:-$(command -v node || true)}
[[ -n $node_bin && -x $node_bin ]] || die "node was not found. Install Node 22 or newer, or pass --node PATH."
major=$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[[ $major =~ ^[0-9]+$ ]] && ((major >= 22)) || die "Node 22 or newer is needed (this one is version $major: $node_bin)"
case $node_bin in
    *[[:space:]%\$\"\'\\]*) die "the node path must not contain spaces, quotes, % or \$: $node_bin" ;;
esac

chrome_path=''
case $chrome in
    auto)
        for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
            found=$(command -v "$candidate" || true)
            if [[ -n $found ]]; then
                chrome_path=$found
                break
            fi
        done
        ;;
    playwright) ;;
    *)
        [[ -x $chrome ]] || die "--chrome $chrome is not an executable file"
        chrome_path=$chrome
        ;;
esac
case $chrome_path in
    *[[:space:]%\$\"\'\\]*) die "the browser path must not contain spaces, quotes, % or \$: $chrome_path" ;;
esac

chrome_env=''
if [[ -n $chrome_path ]]; then chrome_env="Environment=PRINTMD_CHROME=$chrome_path"; fi

unit=$(<"$here/printmd-api.service.in")
unit=${unit//@NODE@/$node_bin}
unit=${unit//@REPO@/$repo}
unit=${unit//@PORT@/$port}
unit=${unit//@IDLE@/$idle}
unit=${unit//@CHROME_ENV@/$chrome_env}

if ((dry)); then
    printf '%s\n' "$unit"
    exit 0
fi

if ((!nostart)); then
    [[ -d $repo/server/node_modules/playwright ]] \
        || die "the server's packages are not installed. Run: npm --prefix $repo/server ci"
    if [[ -z $chrome_path ]]; then
        echo "install-service: no Chrome or Chromium on the PATH; the Playwright browser is used. If it is missing, run:" >&2
        echo "  npx --prefix $repo/server playwright install chromium" >&2
    fi
    command -v systemctl >/dev/null || die "systemctl was not found. This script is for Linux with systemd (macOS: see server/README.md)."
fi

mkdir -p "$unit_dir"
printf '%s\n' "$unit" >"$unit_file"
chmod 644 "$unit_file"
echo "Wrote $unit_file"

if ((nostart)); then exit 0; fi

systemctl --user daemon-reload
systemctl --user enable "$name" >/dev/null
systemctl --user restart "$name"

url="http://127.0.0.1:$port"
for _ in $(seq 1 40); do
    if curl -fsS "$url/api/v1/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
done
curl -fsS "$url/api/v1/health" >/dev/null 2>&1 \
    || die "the service did not answer on $url. See: journalctl --user -u ${name%.service} -n 30"

# One real render, so a missing browser shows up now and not on the first use.
pdf=$(mktemp)
trap 'rm -f "$pdf"' EXIT
curl -fsS -X POST -H 'content-type: text/markdown' --data-binary $'# It works\n\nA test page.' \
    "$url/api/v1/render?template=unbranded" -o "$pdf" || die "a test render failed. See: journalctl --user -u ${name%.service} -n 30"
[[ $(head -c 4 "$pdf") == '%PDF' ]] || die "the test render did not return a PDF"

echo "The PDF API is running on $url and a test render worked."
if [[ -n $chrome_path ]]; then echo "Browser: $chrome_path"; else echo "Browser: Playwright's Chromium"; fi
echo "It starts at login. The browser closes ${idle}s after the last render, so while idle only a small Node process stays."
echo "Logs:      journalctl --user -u ${name%.service} -f"
echo "Stop:      systemctl --user stop ${name%.service}      Restart: systemctl --user restart ${name%.service}"
echo "Remove:    $here/install-service.sh --uninstall"
if command -v loginctl >/dev/null && [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true) != yes ]]; then
    echo "To also start it at boot, before you log in: loginctl enable-linger $USER"
fi
