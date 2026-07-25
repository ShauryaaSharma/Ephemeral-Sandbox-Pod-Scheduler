#!/usr/bin/env bash
# Creates/updates the "sandbox-secrets" Secret that service.yaml references via
# secretKeyRef, instead of committing real credentials to the manifest.
#
# Usage:
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   export JWT_SECRET=$(openssl rand -hex 32)
#   ./k8s/create-secret.sh [namespace]
#
# Safe to commit: it only reads values from your shell environment at run
# time, it never contains real credentials itself.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in your environment first}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in your environment first}"
: "${JWT_SECRET:?Set JWT_SECRET in your environment first (e.g. export JWT_SECRET=$(openssl rand -hex 32))}"

NAMESPACE="${1:-default}"

kubectl create secret generic sandbox-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret 'sandbox-secrets' applied in namespace '$NAMESPACE'."
