#!/bin/sh

set -eu

data_dir="${DATA_DIR:-/app/data}"
db_dir="${DB_DIR:-/app/db}"
frontend_dir="${FRONTEND_DIR:-/app/html}"
frontend_seed_dir="${FRONTEND_SEED_DIR:-/app/html-seed}"
runtime_user="${RUNTIME_USER:-node}"
pocketbase_bin="${POCKETBASE_BIN:-/app/pocketbase}"
pocketbase_dir="${POCKETBASE_DIR:-$db_dir}"
pocketbase_http="${POCKETBASE_HTTP:-0.0.0.0:8090}"

# BusyBox `su -c` treats the first argument after the command string as $0,
# so we pass a placeholder before the real arguments that the nested shell uses.
run_shell_as_runtime_user() {
    shell_command="$1"
    shift

    if [ "$(id -u)" -eq 0 ]; then
        current_dir=$(pwd)
        # BusyBox `su -c` consumes the first post-command argument as $0.
        su "$runtime_user" -s /bin/sh -c 'cd "$1" && shift && command="$1" && shift && exec sh -c "$command" runtime-sh "$@"' -- su-placeholder "$current_dir" "$shell_command" "$@"
        return
    fi

    sh -c "$shell_command" runtime-sh "$@"
}

# Preserve the current working directory so relative CMD paths like
# `node backend/server.js` still resolve after dropping privileges.
run_as_runtime_user() {
    if [ "$(id -u)" -eq 0 ]; then
        current_dir=$(pwd)
        # Keep a placeholder for $0 so the preserved working directory stays in $1.
        su "$runtime_user" -s /bin/sh -c 'cd "$1" && shift && exec "$@"' -- su-placeholder "$current_dir" "$@"
        return
    fi

    exec "$@"
}

runtime_user_can_write_dir() {
    dir="$1"
    run_shell_as_runtime_user 'test -w "$1"' "$dir"
}

ensure_writable_dir() {
    dir="$1"
    label="$2"

    mkdir -p "$dir"

    if [ "$(id -u)" -eq 0 ]; then
        if ! chown "$runtime_user":"$runtime_user" "$dir"; then
            echo "Error: ${label} directory '$dir' could not be assigned to ${runtime_user}." >&2
            echo "Please update the host volume permissions for the mapped path and restart the container." >&2
            exit 1
        fi
    fi

    if ! runtime_user_can_write_dir "$dir"; then
        echo "Error: ${label} directory '$dir' is not writable by runtime user '${runtime_user}'." >&2
        echo "Please update the host volume permissions for the mapped path and restart the container." >&2
        exit 1
    fi
}

ensure_writable_dir "$data_dir" "Data"
ensure_writable_dir "$frontend_dir" "Frontend"
ensure_writable_dir "$pocketbase_dir" "PocketBase"

# Always sync bundled frontend files into the (possibly mounted) frontend
# directory so that image upgrades take effect without removing the volume.
if [ ! -f "$frontend_dir/index.html" ]; then
    echo "First run detected. Populating $frontend_dir with frontend files..."
else
    echo "Updating frontend files in $frontend_dir from bundled seed..."

    # Remove files that no longer exist in the new image so that renamed or
    # deleted assets from previous versions do not linger on mounted volumes.
    (cd "$frontend_dir" && find . -type f) | while IFS= read -r rel_path; do
        if [ ! -f "$frontend_seed_dir/$rel_path" ]; then
            rm -f "$frontend_dir/$rel_path"
        fi
    done
    # Clean up directories that became empty after stale file removal.
    find "$frontend_dir" -depth -type d ! -path "$frontend_dir" -exec rmdir {} \; 2>/dev/null || true
fi

# Copy files directly as root to avoid BusyBox su limitations.
# Existing files are overwritten; user data lives in $data_dir, not here.
cp -R "$frontend_seed_dir"/. "$frontend_dir"

# Immediately hand ownership to the runtime user
if [ "$(id -u)" -eq 0 ]; then
    chown -R "$runtime_user":"$runtime_user" "$frontend_dir"
fi

echo "Frontend files synced successfully."

# Hand over control to the Node application
start_pocketbase() {
    if [ ! -x "$pocketbase_bin" ]; then
        echo "PocketBase binary not found at $pocketbase_bin. Skipping embedded PocketBase startup."
        return 1
    fi
    run_shell_as_runtime_user 'exec "$1" serve --dir "$2" --http "$3" >/tmp/pocketbase.log 2>&1 &' "$pocketbase_bin" "$pocketbase_dir" "$pocketbase_http"
    return 0
}

wait_for_pocketbase() {
    pocketbase_port="$pocketbase_http"
    case "$pocketbase_port" in
        *:*) pocketbase_port="${pocketbase_port##*:}" ;;
    esac
    case "$pocketbase_port" in
        ''|*[!0-9]*)
            echo "Error: Invalid PocketBase HTTP binding '$pocketbase_http'." >&2
            exit 1
            ;;
    esac

    attempts=0
    until run_shell_as_runtime_user 'wget -qO- "http://127.0.0.1:${1}/api/health" >/dev/null 2>&1' "$pocketbase_port"; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 50 ]; then
            echo "Error: PocketBase did not become ready in time." >&2
            exit 1
        fi
        sleep 1
    done
}

if start_pocketbase; then
    wait_for_pocketbase
fi

run_as_runtime_user "$@"
