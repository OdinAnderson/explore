#!/usr/bin/env bash
# Deploy a tagged release of explore to oaks. See docs/oaks.md.
#
#   bash deploy/deploy.sh v2026.11.18-1
#
# Exports the tag with `git archive` (the worktree is never touched), runs the
# oaks build there, copies the site to oaks, installs it as
# /opt/explore/releases/<tag>/ (verified by SHA256, VERSION written last),
# then atomically points /opt/explore/current at it and checks
# https://<hostname>/VERSION through the local Caddy.
# Safe to re-run with the same tag; run it with an older tag to roll back.
# Static files only: no service is restarted.
#
# Environment:
#   EXPLORE_DEPLOY_HOST  ssh host (default: oaks)
#   EXPLORE_HOSTNAME     Caddy site name to check (default: explore-new.odinz.net)
set -euo pipefail

HOST="${EXPLORE_DEPLOY_HOST:-oaks}"
SITE_HOSTNAME="${EXPLORE_HOSTNAME:-explore-new.odinz.net}"
BASE=/opt/explore

die() { echo "deploy: FAIL: $*" >&2; exit 1; }

[ "$#" -eq 1 ] && [ -n "$1" ] || die "usage: bash deploy/deploy.sh <tag>   (e.g. v2026.11.18-1)"
TAG="$1"
case "$TAG" in
    *[!A-Za-z0-9._-]*|-*|.*) die "tag '$TAG' has unexpected characters" ;;
esac
case "$SITE_HOSTNAME" in
    ''|*[!A-Za-z0-9.-]*|-*|.*) die "EXPLORE_HOSTNAME '$SITE_HOSTNAME' has unexpected characters" ;;
esac
case "$HOST" in
    ''|-*|*[!A-Za-z0-9.@_-]*) die "EXPLORE_DEPLOY_HOST '$HOST' has unexpected characters" ;;
esac
command -v node >/dev/null 2>&1 || die "node is required to build the site"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

REPO="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)"
cd "$REPO"

if ! SHA="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")"; then
    echo "deploy: tag $TAG not found locally, fetching tags..."
    git fetch --quiet --tags origin || true
    SHA="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}")" \
        || die "tag $TAG does not exist (locally or on origin)"
fi
echo "deploy: $TAG -> $SHA to $HOST:$BASE (site $SITE_HOSTNAME)"

# --- Build locally from the tag's tree ------------------------------------------
LOCAL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/explore-deploy.XXXXXX")"
REMOTE_TMP=""
cleanup() {
    rm -rf "$LOCAL_TMP"
    if [ -n "$REMOTE_TMP" ]; then
        ssh "$HOST" "rm -rf '$REMOTE_TMP'" || echo "deploy: warning: could not remove $HOST:$REMOTE_TMP" >&2
    fi
}
trap cleanup EXIT

mkdir -p "$LOCAL_TMP/export" "$LOCAL_TMP/payload"
# Byte-for-byte LF files from the tag, whatever this machine's autocrlf says.
git -c core.autocrlf=false -c core.eol=lf archive --format=tar "$SHA" | tar -x -C "$LOCAL_TMP/export"

# Relative --out and a cd: no MSYS path conversion surprises on Git Bash.
(
    cd "$LOCAL_TMP/export"
    EXPLORE_TARGET=oaks EXPLORE_VERSION_TAG="$TAG" EXPLORE_VERSION_COMMIT="$SHA" \
        node scripts/build.mjs --out site
) || die "build of $TAG failed"
[ -f "$LOCAL_TMP/export/site/VERSION" ] && [ -f "$LOCAL_TMP/export/site/private/tiles.json" ] \
    || die "tag $TAG predates the oaks build (no VERSION or private/tiles.json); deploy a newer tag"
grep -qxF "tag=$TAG" "$LOCAL_TMP/export/site/VERSION" || die "built VERSION does not name $TAG"

P="$LOCAL_TMP/payload"
cp -R "$LOCAL_TMP/export/site" "$P/site"

# Relative paths, one per line; VERSION goes last so it is only written once the
# rest of the release is in place.
(cd "$P/site" && find . -type f ! -name VERSION | sed 's|^\./||' | LC_ALL=C sort; echo VERSION) \
    > "$P/files.txt"
(cd "$P/site" && xargs -d '\n' sha256sum -- < "$P/files.txt") > "$P/SHA256SUMS"
# sha256sum on Windows may mark binary files with '*'; normalise to text mode.
sed -i 's/^\([0-9a-f]\{64\}\) \*/\1  /' "$P/SHA256SUMS"

cat > "$P/remote.sh" <<'REMOTE'
#!/usr/bin/env bash
# Runs on oaks from the staging dir. Installs the release, verifies it, switches
# /opt/explore/current, prunes old releases and checks VERSION through Caddy.
set -euo pipefail
tag="$1"; site="$2"; base="$3"
cd "$(dirname "$0")"
fail() { echo "remote: FAIL: $*" >&2; exit 1; }
sudo -n true 2>/dev/null || fail "sudo needs a password; aborting"

releases="$base/releases"
manifests="$base/manifests"
rel="$releases/$tag"
manifest="$manifests/$tag.SHA256SUMS"

# Caddy must already have a site block for the hostname, or the check below
# can never pass. Look before changing anything.
if ! sudo -n grep -rqsF -- "$site" /etc/caddy; then
    fail "no Caddy site block for $site under /etc/caddy. Add the site block from docs/oaks.md, reload Caddy, then re-run."
fi

sudo -n install -d -o root -g root -m 755 "$base" "$releases" "$manifests"

# A release dir is good when every file matches its manifest and there are no
# extra files.
verify_release() { # dir manifest
    local dir="$1" sums="$2"
    [ -d "$dir" ] && [ -f "$sums" ] || return 1
    (cd "$dir" && sudo -n sha256sum --quiet --strict -c -) < "$sums" >/dev/null 2>&1 || return 1
    [ "$(cd "$dir" && sudo -n find . -type f | sed 's|^\./||' | LC_ALL=C sort)" \
      = "$(sed 's/^[0-9a-f]\{64\}  //' "$sums" | LC_ALL=C sort)" ] || return 1
}

stage=""
cleanup_stage() { if [ -n "$stage" ]; then sudo -n rm -rf -- "$stage" "$stage.sums"; fi; }
trap cleanup_stage EXIT

if verify_release "$rel" "$manifest"; then
    echo "remote: reusing $rel ($(wc -l < "$manifest") files verified)"
else
    [ -e "$rel" ] && echo "remote: $rel is missing files or fails verification; reinstalling"
    stage="$(sudo -n mktemp -d "$releases/.incoming.XXXXXX")"
    sudo -n chmod 755 "$stage"
    while IFS= read -r f; do
        if [ "$f" = VERSION ]; then
            # Everything else first, verified, then VERSION.
            grep -v '  VERSION$' SHA256SUMS | (cd "$stage" && sudo -n sha256sum --quiet --strict -c -) \
                || fail "installed files do not match SHA256SUMS"
        fi
        case "$f" in */*) sudo -n install -d -o root -g root -m 755 "$stage/$(dirname "$f")" ;; esac
        sudo -n install -o root -g root -m 644 "site/$f" "$stage/$f"
    done < files.txt
    sudo -n install -o root -g root -m 644 SHA256SUMS "$stage.sums"
    verify_release "$stage" "$stage.sums" || fail "staged release does not verify"
    if [ -e "$rel" ]; then
        old="$(sudo -n mktemp -d "$releases/.replaced.XXXXXX")"
        sudo -n mv -T "$rel" "$old/$tag"
        sudo -n mv -T "$stage" "$rel"
        sudo -n rm -rf "$old"
    else
        sudo -n mv -T "$stage" "$rel"
    fi
    sudo -n mv -T "$stage.sums" "$manifest"
    stage=""
    verify_release "$rel" "$manifest" || fail "$rel does not verify after install"
    echo "remote: installed $rel ($(wc -l < "$manifest") files verified)"
fi
sudo -n touch "$rel"

# Atomic switch: new symlink beside the old one, then rename over it.
current="$base/current"
if [ -e "$current" ] && [ ! -L "$current" ]; then
    fail "$current exists and is not a symlink; move it aside by hand first"
fi
prev="$(readlink "$current" 2>/dev/null || true)"
tmp_link="$base/.current.$$"
sudo -n ln -sfn "$rel" "$tmp_link"
sudo -n mv -T "$tmp_link" "$current"
echo "remote: $current -> $rel (was ${prev:-none})"

# Check what Caddy actually serves.
got=""
for _ in 1 2 3 4 5; do
    body="$(curl -s --max-time 5 --resolve "$site:443:127.0.0.1" "https://$site/VERSION" || true)"
    got="$(printf '%s\n' "$body" | sed -n 's/^tag=//p' | head -n 1)"
    [ "$got" = "$tag" ] && break
    sleep 1
done
if [ "$got" != "$tag" ]; then
    if [ -n "$prev" ] && [ "$prev" != "$rel" ] && [ -d "$prev" ]; then
        sudo -n ln -sfn "$prev" "$tmp_link"
        sudo -n mv -T "$tmp_link" "$current"
        echo "remote: switched $current back to $prev" >&2
    fi
    fail "https://$site/VERSION reports tag '${got:-<nothing>}', expected '$tag'. Is the Caddy site for $site serving $current?"
fi
echo "remote: https://$site/VERSION reports $tag"

# Keep the release `current` points at, plus the 3 most recent other releases
# (by install/use time). At most 4 stay. Never prune current, even when it is
# older than those three. Only other releases count toward the 3.
keep_current="$(basename "$(readlink "$current")")"
others=0
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' \
    | sort -rn | while read -r _ name; do
    if [ "$name" = "$keep_current" ]; then continue; fi
    others=$((others + 1))
    if [ "$others" -le 3 ]; then continue; fi
    echo "remote: pruning release $name"
    sudo -n rm -rf -- "$releases/$name"
    sudo -n rm -f -- "$manifests/$name.SHA256SUMS"
done

echo "--- $current/VERSION"
cat "$current/VERSION"
REMOTE

# --- Copy and run ----------------------------------------------------------------
REMOTE_TMP="$(ssh "$HOST" 'mktemp -d /tmp/explore-deploy.XXXXXX')"
case "$REMOTE_TMP" in /tmp/explore-deploy.*) ;; *) REMOTE_TMP=""; die "bad remote staging dir" ;; esac

echo "deploy: copying $(wc -l < "$P/files.txt") files to $HOST:$REMOTE_TMP"
# Relative source path: works with both MSYS and Windows OpenSSH scp.
(cd "$LOCAL_TMP" && scp -q -r payload "$HOST:$REMOTE_TMP/")

if ssh "$HOST" "bash '$REMOTE_TMP/payload/remote.sh' '$TAG' '$SITE_HOSTNAME' '$BASE'"; then
    echo "deploy: OK  $TAG ($SHA) on $HOST, https://$SITE_HOSTNAME/"
else
    die "$TAG ($SHA) on $HOST: see messages above"
fi
