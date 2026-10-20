#!/usr/bin/env bash
# Creates/updates the Secrets referenced via secretKeyRef/secretRef, instead
# of committing real credentials to any manifest.
#
# Usage:
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   # RS256 key pair - see README "Generating the JWT key pair"
#   export JWT_PRIVATE_KEY="$(cat jwt-private.pem)"
#   export JWT_PUBLIC_KEY="$(cat jwt-public.pem)"
#   ./k8s/create-secret.sh [namespace]
#
# Safe to commit: it only reads values from your shell environment at run
# time, it never contains real credentials itself.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID in your environment first}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY in your environment first}"
: "${JWT_PRIVATE_KEY:?Set JWT_PRIVATE_KEY in your environment first (see README 'Generating the JWT key pair')}"
: "${JWT_PUBLIC_KEY:?Set JWT_PUBLIC_KEY in your environment first (see README 'Generating the JWT key pair')}"

NAMESPACE="${1:-default}"

# sandbox-secrets: copied into every project namespace (namespace.ts) and
# read by orchestrator-simple's own deployment. Only the PUBLIC verify key
# goes in here - the private signing key must never reach a project
# namespace or a runner pod.
kubectl create secret generic sandbox-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  --from-literal=JWT_PUBLIC_KEY="$JWT_PUBLIC_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# init-service-secrets: the signing key. Only init-service's own deployment
# references this (see k8s/scheduler-services.yaml) - it is never copied
# into a project namespace.
kubectl create secret generic init-service-secrets \
  --namespace "$NAMESPACE" \
  --from-literal=JWT_PRIVATE_KEY="$JWT_PRIVATE_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secrets 'sandbox-secrets' and 'init-service-secrets' applied in namespace '$NAMESPACE'."
