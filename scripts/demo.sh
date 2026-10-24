#!/usr/bin/env bash
# End-to-end demo of SkeletonKey, entirely on localhost.
#
# Spins up a throwaway SKELETONKEY_HOME, stores a FAKE key, starts a local echo
# server plus the injecting proxy, curls through the proxy, and shows that:
#   1. the echo server received the injected Authorization header,
#   2. keys.yaml contains no secret,
#   3. the ledger got one row for the call.
# Everything is removed on exit. Nothing leaves this machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAKE_SECRET="sk-demo-FAKE-123"
ALIAS="demo-api"

ECHO_PID=""
PROXY_PID=""
SKELETONKEY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/skeletonkey-demo-XXXXXX")"
export SKELETONKEY_HOME
# The plaintext `file` backend is test-only and refused without this opt-in.
export SKELETONKEY_ALLOW_TEST_BACKEND=1

cleanup() {
  local status=$?
  echo
  echo "== cleanup =="
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "$ECHO_PID" ] && kill "$ECHO_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$SKELETONKEY_HOME"
  echo "removed $SKELETONKEY_HOME"
  exit "$status"
}
trap cleanup EXIT INT TERM

say() { printf '\n== %s ==\n' "$1"; }

if [ ! -f dist/cli.js ]; then
  say "building"
  npm run build
fi

SKELETONKEY="node --no-warnings $REPO_ROOT/dist/cli.js"

say "temp skeletonkey home"
echo "SKELETONKEY_HOME=$SKELETONKEY_HOME"

say "skeletonkey init (test-only plaintext file backend)"
$SKELETONKEY init --email skeletonkey-demo@example.test --backend file

say "skeletonkey add $ALIAS (secret piped on stdin, never in argv)"
printf '%s' "$FAKE_SECRET" | $SKELETONKEY add "$ALIAS" \
  --platform DemoCo \
  --domain 127.0.0.1 \
  --header Authorization \
  --format "Bearer {key}"

say "skeletonkey list"
$SKELETONKEY list

say "starting local echo server"
ECHO_LOG="$SKELETONKEY_HOME/echo.log"
node "$REPO_ROOT/scripts/echo-server.mjs" 0 >"$ECHO_LOG" 2>&1 &
ECHO_PID=$!
ECHO_PORT=""
for _ in $(seq 1 50); do
  ECHO_PORT="$(sed -n 's/^PORT=//p' "$ECHO_LOG" | head -n1)"
  [ -n "$ECHO_PORT" ] && break
  sleep 0.1
done
[ -n "$ECHO_PORT" ] || { echo "echo server did not start"; cat "$ECHO_LOG"; exit 1; }
echo "echo server on http://127.0.0.1:$ECHO_PORT (pid $ECHO_PID)"

say "starting skeletonkey proxy"
PROXY_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
PROXY_LOG="$SKELETONKEY_HOME/proxy.log"
$SKELETONKEY proxy --port "$PROXY_PORT" --upstream-scheme http >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PROXY_PORT/__skeletonkey/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PROXY_PORT/__skeletonkey/health" >/dev/null || {
  echo "proxy did not start"; cat "$PROXY_LOG"; exit 1; }
cat "$PROXY_LOG"

say "curl through the proxy (client sends a deliberately wrong Authorization header)"
echo "+ curl http://127.0.0.1:$PROXY_PORT/127.0.0.1:$ECHO_PORT/v1/demo"
RESPONSE="$(curl -fsS \
  -H 'Authorization: Bearer client-supplied-garbage' \
  "http://127.0.0.1:$PROXY_PORT/127.0.0.1:$ECHO_PORT/v1/demo")"
echo "$RESPONSE"

say "header the upstream actually received"
ECHOED="$(printf '%s' "$RESPONSE" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const headers = JSON.parse(raw).headers;
  console.log(`authorization: ${headers.authorization ?? "(missing)"}`);
});')"
echo "$ECHOED"
case "$ECHOED" in
  *"Bearer $FAKE_SECRET"*) echo "OK: the proxy replaced the client header with the vault secret" ;;
  *) echo "FAIL: expected the injected secret, got: $ECHOED"; exit 1 ;;
esac

say "keys.yaml (metadata only -- grep for the secret)"
cat "$SKELETONKEY_HOME/keys.yaml"
if grep -q "$FAKE_SECRET" "$SKELETONKEY_HOME/keys.yaml"; then
  echo "FAIL: secret leaked into keys.yaml"; exit 1
fi
echo "OK: $FAKE_SECRET does not appear in keys.yaml"
echo "(it lives in the dev vault: $(ls -l "$SKELETONKEY_HOME/dev-vault.json" | awk '{print $1, $NF}'))"

say "skeletonkey ledger"
$SKELETONKEY ledger --limit 5

say "proxy log (no secrets)"
cat "$PROXY_LOG"
if grep -q "$FAKE_SECRET" "$PROXY_LOG"; then
  echo "FAIL: secret leaked into the proxy log"; exit 1
fi
echo "OK: no secret in the proxy log"
