#!/usr/bin/env bash
# Creates/updates the Secrets referenced via secretKeyRef/secretRef, instead
# of committing real credentials to any manifest.
#
# Usage:
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   # ES256 (ECDSA P-256) key pair - see README "JWT keys"
#   export JWT_PRIVATE_KEY="$(cat jwt-private.pem)"
#   export JWT_PUBLIC_KEY="$(cat jwt-public.pem)"
#   export JWT_PUBLIC_KEY_PREVIOUS=...   # optional, only set while rotating - see README "Rotating JWT keys"
#   export INTERNAL_API_TOKEN=$(openssl rand -hex 32)
#   ./k8s/create-secret.sh [namespace]
#
# Safe to commit: it only reads values from your shell environment at run
# time, it never contains real credentials itself.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in your environment first}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in your environment first}"
: "${JWT_PRIVATE_KEY:?Set JWT_PRIVATE_KEY in your environment first (see README 'JWT keys')}"
: "${JWT_PUBLIC_KEY:?Set JWT_PUBLIC_KEY in your environment first (see README 'JWT keys')}"
: "${INTERNAL_API_TOKEN:?Set INTERNAL_API_TOKEN in your environment first (e.g. export INTERNAL_API_TOKEN=\$(openssl rand -hex 32))}"

NAMESPACE="${1:-default}"

# sandbox-secrets: copied into every project namespace (namespace.ts) and
# read by orchestrator-simple's own deployment. Only the PUBLIC verify key
# goes in here - the private signing key must never reach a project
# namespace or a runner pod. INTERNAL_API_TOKEN gates the runner's internal
# /health and /shutdown endpoints (see runner/src/index.ts).
SANDBOX_SECRET_ARGS=(
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  --from-literal=JWT_PUBLIC_KEY="$JWT_PUBLIC_KEY"
  --from-literal=INTERNAL_API_TOKEN="$INTERNAL_API_TOKEN"
)
# Only set while rotating keys - see README "Rotating JWT keys".
if [ -n "${JWT_PUBLIC_KEY_PREVIOUS:-}" ]; then
  SANDBOX_SECRET_ARGS+=(--from-literal=JWT_PUBLIC_KEY_PREVIOUS="$JWT_PUBLIC_KEY_PREVIOUS")
fi
kubectl create secret generic sandbox-secrets \
  --namespace "$NAMESPACE" \
  "${SANDBOX_SECRET_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

# init-service-secrets: the signing key. Only init-service's own deployment
# references this (see k8s/scheduler-services.yaml) - it is never copied
# into a project namespace.
kubectl create secret generic init-service-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=JWT_PRIVATE_KEY="$JWT_PRIVATE_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets 'sandbox-secrets' and 'init-service-secrets' applied in namespace '$NAMESPACE'."
