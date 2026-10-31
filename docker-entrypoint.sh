#!/bin/sh
# Railway mounts the service volume as root when the container starts.
# A build-time chown of /data does not survive that mount (#580).
# Chown the live data directory, then drop to the image `node` user.
# The Railway start command must be this script: a start command replaces
# ENTRYPOINT, and `node server.mjs` alone would skip the chown.
set -eu

strip_slash() {
  s=$1
  while [ "$s" != "/" ] && [ "$s" != "${s%/}" ]; do
    s=${s%/}
  done
  printf '%s\n' "$s"
}

forbidden() {
  case "$1" in
    /|""|/app|/usr|/bin|/sbin|/lib|/lib64|/etc|/root|/home|/proc|/sys|/dev|/boot|/opt|/var|/run|/tmp)
      return 0
      ;;
  esac
  case "$1" in
    /app/*|/usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/etc/*|/root/*|/home/*|/proc/*|/sys/*|/dev/*|/boot/*|/opt/*|/run/*)
      return 0
      ;;
  esac
  return 1
}

# The volume can hold ~50k events. Node OOMs if it parses that document on boot.
# Python keeps the newest LIVE_FEED_CAP events, then the server starts.
cap_github_feed() {
  data=$(strip_slash "${MESH_DATA_DIR:-/data}")
  file="$data/feed/github-events.json"
  cap=/app/collector/feed_cap.py
  if [ ! -f "$file" ] || [ ! -f "$cap" ]; then
    return 0
  fi
  python3 "$cap" "$file" || echo "feed cap skipped" >&2
}

prepare_dir() {
  dir=$(strip_slash "$1")
  case "$dir" in
    /*) ;;
    *) echo "data dir must be absolute: $dir" >&2; exit 1 ;;
  esac
  case "$dir" in
    *..*) echo "refusing to chown $dir" >&2; exit 1 ;;
  esac
  if forbidden "$dir"; then
    echo "refusing to chown $dir" >&2
    exit 1
  fi
  # Resolve before mkdir so a parent symlink cannot redirect the chown.
  real=$(readlink -f "$dir")
  if [ -z "$real" ] || forbidden "$real"; then
    echo "refusing to chown ${real:-$dir}" >&2
    exit 1
  fi
  mkdir -p "$dir"
  landed=$(readlink -f "$dir")
  if [ "$landed" != "$real" ] || forbidden "$landed"; then
    echo "refusing to chown ${landed:-$dir}" >&2
    exit 1
  fi
  # --no-dereference: do not follow a symlink inside the volume out of the mount.
  chown -R --no-dereference node:node "$landed"
}

if [ "$(id -u)" -eq 0 ]; then
  write_dir=$(strip_slash "${MESH_DATA_DIR:-/data}")
  prepare_dir "$write_dir"
  if [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]; then
    mount_dir=$(strip_slash "$RAILWAY_VOLUME_MOUNT_PATH")
    if [ "$mount_dir" != "$write_dir" ]; then
      prepare_dir "$mount_dir"
    fi
  fi
  cap_github_feed
  if [ "$#" -eq 0 ]; then
    if [ "${HEALTH_EXIT:-}" = "off" ]; then
      set -- node server.mjs
    elif [ -n "${RAILWAY_ENVIRONMENT:-}" ] || [ "${HEALTH_EXIT:-}" = "on" ]; then
      set -- node health-exit.mjs
    else
      set -- node server.mjs
    fi
  fi
  exec gosu node "$@"
fi

cap_github_feed
if [ "$#" -eq 0 ]; then
  if [ "${HEALTH_EXIT:-}" = "off" ]; then
    set -- node server.mjs
  elif [ -n "${RAILWAY_ENVIRONMENT:-}" ] || [ "${HEALTH_EXIT:-}" = "on" ]; then
    set -- node health-exit.mjs
  else
    set -- node server.mjs
  fi
fi
exec "$@"
