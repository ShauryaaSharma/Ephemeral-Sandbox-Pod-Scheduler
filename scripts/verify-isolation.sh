#!/usr/bin/env bash
# Run this INSIDE a live project pod's terminal (i.e. paste it into the
# browser terminal, or `kubectl exec -it deploy/<replId> -n sandbox-<replId>
# -- bash` and paste it there) - it never runs as part of any build or CI
# step, and this repo makes no claim that it has been run against a live
# cluster unless the final report for whatever change touched this says so
# explicitly, with the actual output.
#
# Checks, each printing PASS or FAIL:
#   1. `env` leaks no AWS/JWT/internal-token secret material into the shell.
#   2. `cat /proc/1/environ` (the runner process's own env) leaks none of
#      that either - this is the actual check for the uid-separation fix
#      (see README "Per-pod internal token & process isolation"): it only
#      passes if the shell runs as a different uid than the runner, since
#      same-uid is otherwise sufficient to read another process's environ.
#   3. No Kubernetes service-account token is mounted (automountServiceAccountToken: false).
#   4. The NetworkPolicy's egress rules actually block the cloud metadata
#      endpoint and the RFC1918 ranges, while still allowing the open
#      internet (A6) - tested with real connection attempts, not just by
#      reading the manifest.
set -uo pipefail

PASS=0
FAIL=0

check() {
  local label="$1" result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

# A simple case-insensitive pattern covering every secret this pod ever
# holds: AWS keys, the JWT public key(s - PEM header is enough to catch
# them), and the internal token env var name itself.
SECRET_PATTERN='AWS_ACCESS_KEY_ID=|AWS_SECRET_ACCESS_KEY=|AWS_SESSION_TOKEN=.|BEGIN (EC )?PUBLIC KEY|BEGIN (EC )?PRIVATE KEY|INTERNAL_API_TOKEN=.|INTERNAL_API_MASTER_KEY'

echo "== 1. env =="
if env | grep -qE "$SECRET_PATTERN"; then
  check "env has no secret material" 1
  env | grep -E "$SECRET_PATTERN" | sed -E 's/=.*/=<redacted>/'
else
  check "env has no secret material" 0
fi

echo
echo "== 2. /proc/1/environ (the runner process, a different uid - see A3) =="
MY_UID="$(id -u)"
PID1_UID="$(stat -c %u /proc/1 2>/dev/null || echo unknown)"
echo "This shell's uid: $MY_UID; PID 1's uid: $PID1_UID"
if [ "$MY_UID" = "$PID1_UID" ]; then
  echo "FAIL: this shell shares a uid with PID 1 - the uid-separation fix is not in effect, so the check below is not meaningful (same-uid alone is normally enough to read another process's environ)."
  FAIL=$((FAIL + 1))
elif ENVIRON="$(cat /proc/1/environ 2>/dev/null | tr '\0' '\n')"; then
  if echo "$ENVIRON" | grep -qE "$SECRET_PATTERN"; then
    check "/proc/1/environ has no secret material" 1
    echo "$ENVIRON" | grep -E "$SECRET_PATTERN" | sed -E 's/=.*/=<redacted>/'
  else
    check "/proc/1/environ has no secret material" 0
  fi
else
  check "/proc/1/environ is unreadable (different uid, no CAP_SYS_PTRACE - this is the expected/desired outcome)" 0
fi

echo
echo "== 3. Kubernetes service-account token =="
if [ -d /var/run/secrets/kubernetes.io/serviceaccount ] && [ -n "$(ls -A /var/run/secrets/kubernetes.io/serviceaccount 2>/dev/null)" ]; then
  check "no service-account token mounted" 1
  ls -la /var/run/secrets/kubernetes.io/serviceaccount
else
  check "no service-account token mounted" 0
fi
if [ -d /var/run/secrets ]; then
  echo "/var/run/secrets contents:"
  ls -la /var/run/secrets 2>/dev/null || true
fi

echo
echo "== 4. Egress NetworkPolicy (A6) =="
# bash's /dev/tcp pseudo-device needs nothing installed (no curl/wget/nc
# required) - a successful connect means the destination is reachable, a
# timeout/refusal means it's blocked (by the NetworkPolicy, assuming the
# CNI enforces it - see README "Network policy" for the CNI caveat).
#
# Covers exactly what the NetworkPolicy's egress except list covers (see
# orchestrator-simple/service.yaml): the cloud metadata endpoint, all three
# RFC1918 ranges, and this cluster's own pod/service CIDRs specifically
# (not just "some address in 10.0.0.0/8" - a cluster using a non-RFC1918
# CIDR wouldn't be caught by the RFC1918 checks alone). Override
# POD_CIDR_TEST_IP/SERVICE_CIDR_TEST_IP if your cluster's CIDRs aren't the
# k3s defaults these fall back to.
tcp_connect() {
  timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

if tcp_connect 169.254.169.254 80; then
  check "cloud metadata endpoint (169.254.169.254) is blocked" 1
else
  check "cloud metadata endpoint (169.254.169.254) is blocked" 0
fi

if tcp_connect 10.0.0.1 80; then
  check "RFC1918 10.0.0.0/8 is blocked" 1
else
  check "RFC1918 10.0.0.0/8 is blocked" 0
fi

if tcp_connect 172.16.0.1 80; then
  check "RFC1918 172.16.0.0/12 is blocked" 1
else
  check "RFC1918 172.16.0.0/12 is blocked" 0
fi

if tcp_connect 192.168.0.1 80; then
  check "RFC1918 192.168.0.0/16 is blocked" 1
else
  check "RFC1918 192.168.0.0/16 is blocked" 0
fi

POD_CIDR_TEST_IP="${POD_CIDR_TEST_IP:-10.42.0.1}"
SERVICE_CIDR_TEST_IP="${SERVICE_CIDR_TEST_IP:-10.43.0.1}"
if tcp_connect "$POD_CIDR_TEST_IP" 80; then
  check "cluster pod CIDR ($POD_CIDR_TEST_IP) is blocked" 1
else
  check "cluster pod CIDR ($POD_CIDR_TEST_IP) is blocked" 0
fi

if tcp_connect "$SERVICE_CIDR_TEST_IP" 443; then
  check "cluster service CIDR ($SERVICE_CIDR_TEST_IP) is blocked" 1
else
  check "cluster service CIDR ($SERVICE_CIDR_TEST_IP) is blocked" 0
fi

if tcp_connect 8.8.8.8 53; then
  check "open internet (8.8.8.8:53) is still reachable" 0
else
  check "open internet (8.8.8.8:53) is still reachable" 1
fi

echo
echo "== Summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
