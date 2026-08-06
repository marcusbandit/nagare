#!/usr/bin/env bash
# Wrap nagare as a desktop app you can double click.
#
#   ./build.sh                   this machine's format
#   ./build.sh macos             Build/macOS/Nagare.app
#   ./build.sh ubuntu            Build/Ubuntu/Nagare.AppImage + .deb
#   ./build.sh arch              Build/Arch/Nagare.AppImage + .pkg.tar.zst
#   ./build.sh all               everything the host can manage
#   ./build.sh macos --universal a .app that also runs on Intel macs
#   ./build.sh arch --arm64      linux artifacts for an arm machine
#
# Nothing is installed anywhere: the artifacts land in Build/ and moving them is
# your business. Drag the .app to /Applications if you want it there.
set -euo pipefail

# Resolve our own location, so the checkout can live anywhere and this still
# works through a symlink on PATH.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *) SELF="$(dirname "$SELF")/$TARGET" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
cd "$DIR"

BUILD="$DIR/Build"

say() { printf 'build: %s\n' "$1" >&2; }
die() { printf 'build: %s\n' "$1" >&2; exit 1; }

# ------------------------------------------------------------------ arguments

TARGETS=()
UNIVERSAL=0
# x64 by default: an Ubuntu desktop is overwhelmingly likely to be one, even when
# the machine doing the building is not.
LINUX_ARCH="x64"
for arg in "$@"; do
  case "$arg" in
    macos | mac | darwin) TARGETS+=("macos") ;;
    ubuntu | debian | linux) TARGETS+=("ubuntu") ;;
    arch | archlinux) TARGETS+=("arch") ;;
    all) TARGETS+=("macos" "ubuntu" "arch") ;;
    --universal) UNIVERSAL=1 ;;
    --arm64) LINUX_ARCH="arm64" ;;
    -h | --help)
      sed -n '2,13p' "$SELF" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg  (try: macos, ubuntu, arch, all)" ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  case "$(uname -s)" in
    Darwin) TARGETS=("macos") ;;
    # Ask the distro what it is rather than guessing: an AppImage runs anywhere,
    # but only one of these two packages is any use on the machine at hand.
    Linux)
      if [ -f /etc/os-release ] && grep -qiE '^ID(_LIKE)?=.*arch' /etc/os-release; then
        TARGETS=("arch")
      else
        TARGETS=("ubuntu")
      fi
      ;;
    *) die "no idea what to build on $(uname -s). Ask for macos, ubuntu or arch." ;;
  esac
fi

# --------------------------------------------------------------- dependencies

if command -v bun >/dev/null 2>&1; then
  RUN=(bun x)
  INSTALL=(bun install)
elif command -v npm >/dev/null 2>&1; then
  RUN=(npx --no-install)
  INSTALL=(npm install)
else
  case "$(uname -s)" in
    Darwin) hint="brew install oven-sh/bun/bun" ;;
    Linux)
      if [ -f /etc/os-release ] && grep -qiE '^ID(_LIKE)?=.*arch' /etc/os-release; then
        hint="sudo pacman -S bun"
      else
        hint="install Node.js/npm from your distro, or install bun from https://bun.sh"
      fi
      ;;
    *) hint="install bun or npm for this system" ;;
  esac
  die "need bun or npm to package the Electron shell. Install one: $hint"
fi

if [ ! -d ./node_modules/electron-builder ] || [ ! -d ./node_modules/electron ]; then
  say "installing the packaging toolchain (one time, ~200 MB)..."
  "${INSTALL[@]}"
fi
[ -d ./node_modules/electron-builder ] ||
  die "electron-builder did not install. Run '${INSTALL[*]}' and look at what it says."

# The python side ships as source, so the lockfile has to be there to ship.
[ -f uv.lock ] || die "uv.lock is missing. Run 'uv lock' first."

# ------------------------------------------------------------------- building

# Staging happens outside the repo on purpose. A folder synced by iCloud (or any
# other file provider) stamps FinderInfo and fileprovider attributes onto files as
# they appear, codesign calls all of that "detritus", and it refuses to sign a
# bundle that carries any. Build where nothing is watching, then deliver.
STAGE="${TMPDIR:-/tmp}/nagare-build-$$"
trap 'rm -rf "$STAGE"' EXIT

# electron-builder writes <out>/<platform>-<arch>/ for a directory target and
# <out>/<name>-<version>.AppImage for an AppImage. Both get lifted up to a plain
# name afterwards, because Build/macOS/Nagare.app is what was asked for.
build_macos() {
  [ "$(uname -s)" = "Darwin" ] ||
    die "a .app can only be built on macOS (Apple's own tools do the signing)."
  local out="$STAGE/macos"
  mkdir -p "$out"
  local args=(--mac --config electron-builder.yml "-c.directories.output=$out")
  [ "$UNIVERSAL" = "1" ] && args+=(--universal)
  say "packaging the .app$([ "$UNIVERSAL" = "1" ] && echo ' (universal)')..."
  "${RUN[@]}" electron-builder "${args[@]}"

  local app
  app="$(find "$out" -maxdepth 2 -name "Nagare.app" -print -quit)"
  [ -n "$app" ] || die "electron-builder produced no .app; see the output above."

  # Repackaging an Electron bundle invalidates the signature it shipped with, and
  # macOS on Apple silicon will not run unsigned code at all. Ad-hoc is enough
  # here: it says "nothing has changed since this was built", which is the most a
  # machine without a developer certificate can say.
  say "signing ad-hoc (no developer certificate needed)..."
  xattr -cr "$app" 2>/dev/null || true
  codesign --force --deep --sign - "$app" 2>&1 | sed 's/^/  /' >&2 ||
    die "could not sign the bundle; macOS will not run it unsigned."
  codesign --verify --deep --strict "$app" ||
    die "the signature did not verify, so macOS would refuse to launch it."

  mkdir -p "$BUILD/macOS"
  rm -rf "$BUILD/macOS/Nagare.app"
  # ditto rather than mv: it copies a bundle the way the OS expects, and works
  # across the filesystem boundary between the temp dir and the repo.
  ditto "$app" "$BUILD/macOS/Nagare.app"
  say "done: Build/macOS/Nagare.app"

  # The delivered copy is what gets launched, so it is the one worth checking. A
  # synced folder can re-stamp it the moment it lands, which does not stop it
  # running but does mean the strict check no longer passes.
  if ! codesign --verify --deep --strict "$BUILD/macOS/Nagare.app" 2>/dev/null; then
    say "note: Build/ is inside a synced folder (iCloud, Dropbox), which has"
    say "      already decorated the bundle. It still runs; move it somewhere"
    say "      unsynced if macOS ever complains."
  fi
}

# An arch package is a tar under some compression, and the name is supposed to
# say which: electron-builder hands back a ".pacman" whatever is inside it, so
# read the magic bytes rather than promise zstd and deliver xz.
pkg_extension() {
  case "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" in
    28b52ffd*) echo "pkg.tar.zst" ;;
    fd377a58*) echo "pkg.tar.xz" ;;
    1f8b*) echo "pkg.tar.gz" ;;
    *) echo "pkg.tar" ;;
  esac
}

# One linux build, told which distro it is dressing up for. The AppImage is the
# same everywhere, so only the native package differs: a deb for Ubuntu, a pacman
# package for Arch.
#
#   build_linux <label> <folder> <electron-builder target>...
build_linux() {
  local label="$1" folder="$2"
  shift 2
  local out="$STAGE/$label"
  mkdir -p "$out"
  local suffix=""
  [ "$LINUX_ARCH" = "arm64" ] && suffix="-arm64"
  say "packaging for $label ($LINUX_ARCH): $*"
  if ! "${RUN[@]}" electron-builder --linux "$@" "--$LINUX_ARCH" \
    --config electron-builder.yml "-c.directories.output=$out"; then
    [ "$(uname -s)" = "Linux" ] &&
      die "the $label build failed; see the output above."
    die "the $label build failed; see the output above. If what it is missing is
       linux tooling rather than something in this repo, build on linux or in
       the electron-builder docker image, which carries the toolchain:

         docker run --rm -v \"\$PWD\":/project -w /project \\
           electronuserland/builder:latest ./build.sh $label"
  fi

  mkdir -p "$BUILD/$folder"
  local built=0 found
  # Deliver whatever the requested targets produced, under a plain name. The
  # native package is best effort: cross-building one is not always possible, and
  # the AppImage that runs on any distro is reason enough not to fail the run.
  local name
  for pattern in "*.AppImage" "*.deb" "*.pacman" "*.pkg.tar.zst" "*.pkg.tar.xz"; do
    found="$(find "$out" -maxdepth 1 -name "$pattern" -print -quit)"
    [ -n "$found" ] || continue
    case "$found" in
      *.AppImage) name="Nagare$suffix.AppImage" ;;
      *.deb) name="Nagare$suffix.deb" ;;
      # electron-builder calls a pacman package ".pacman"; arch calls the same
      # bytes .pkg.tar.<compression>, which is the name pacman -U expects.
      *) name="Nagare$suffix.$(pkg_extension "$found")" ;;
    esac
    rm -f "$BUILD/$folder/$name"
    cp "$found" "$BUILD/$folder/$name"
    case "$name" in *.AppImage) chmod +x "$BUILD/$folder/$name" ;; esac
    say "done: Build/$folder/$name"
    built=$((built + 1))
  done
  [ "$built" -gt 0 ] ||
    die "the $label build produced nothing; see the output above."
}

for target in "${TARGETS[@]}"; do
  case "$target" in
    macos) build_macos ;;
    # An AppImage to double click, plus the package the distro would rather have.
    ubuntu) build_linux ubuntu Ubuntu AppImage deb ;;
    arch) build_linux arch Arch AppImage pacman ;;
  esac
done

# ---------------------------------------------------------------------- after

cat >&2 <<'EOF'

The app still needs uv and ffmpeg on the machine that runs it, the same two
things `uv run nagare` needs; it finds them itself rather than relying on the
PATH a double-clicked app is given. The first launch builds the python
environment (once, in the app's own data folder) and takes a minute.
EOF
ls -1 "$BUILD" 2>/dev/null | sed 's/^/  Build\//' >&2 || true
