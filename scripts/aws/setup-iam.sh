#!/usr/bin/env bash
# Creates (or updates, idempotently) the IAM role orchestrator-simple assumes
# to issue per-project, prefix-scoped S3 credentials - see
# orchestrator-simple/src/sts.ts and README "Scoped S3 credentials".
#
# Defaults to a DRY RUN: prints every AWS CLI call it would make and the
# rendered policy documents, but changes nothing. Pass --apply to actually
# run them.
#
# Usage:
#   export S3_BUCKET=your-bucket-name
#   export ORCH_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/orchestrator-host-role
#   ./scripts/aws/setup-iam.sh              # dry run
#   ./scripts/aws/setup-iam.sh --apply       # actually create/update
#
# ORCH_PRINCIPAL_ARN is optional - if unset, this detects the caller's own
# identity via `aws sts get-caller-identity` (i.e. run this as/for whatever
# AWS identity orchestrator-simple itself authenticates as).
#
# Never prints or commits credentials: it only ever reads S3_BUCKET and
# ORCH_PRINCIPAL_ARN from the environment, and the only secret-shaped output
# anywhere is the role ARN itself, which is not a credential.
set -euo pipefail

ROLE_NAME="ephemeral-sandbox-project-s3"
ROLE_POLICY_NAME="ephemeral-sandbox-project-s3-permissions"
ASSUME_POLICY_NAME="ephemeral-sandbox-assume-project-s3"
MAX_SESSION_DURATION=43200 # 12h - see README "Scoped S3 credentials" / A4
TAGS="Key=app,Value=ephemeral-sandbox"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APPLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

: "${S3_BUCKET:?Set S3_BUCKET in your environment first (the bucket orchestrator-simple/init-service/runner already use)}"

if ! command -v aws >/dev/null 2>&1; then
  echo "FAIL: the AWS CLI ('aws') is not installed or not on PATH - install it first (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)." >&2
  exit 1
fi

echo "== Identity check =="
if ! CALLER_JSON=$(aws sts get-caller-identity 2>&1); then
  echo "FAIL: 'aws sts get-caller-identity' did not succeed - the AWS CLI has no usable credentials in this environment." >&2
  echo "$CALLER_JSON" >&2
  echo "Set up credentials (e.g. 'aws configure', an instance profile, or env vars) for the identity orchestrator-simple itself will run as, then re-run this script." >&2
  exit 1
fi
CALLER_ARN=$(echo "$CALLER_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).Arn)" 2>/dev/null || true)
if [ -z "$CALLER_ARN" ]; then
  # node may not be available in every environment this runs in - fall back
  # to a plain grep/sed parse of the CLI's own JSON output.
  CALLER_ARN=$(echo "$CALLER_JSON" | grep -o '"Arn": *"[^"]*"' | sed -E 's/.*"Arn": *"([^"]*)".*/\1/')
fi
echo "Caller identity: $CALLER_ARN"

# An assumed-role caller identity (e.g. an EC2 instance profile, or a
# federated/SSO session) reports as
# arn:aws:sts::ACCOUNT:assumed-role/ROLE_NAME/SESSION-NAME, not the actual
# IAM role ARN - translate it back, since that's what the trust policy and
# the orchestrator's own inline policy both need to reference.
normalize_principal_arn() {
  local arn="$1"
  if [[ "$arn" =~ ^arn:aws:sts::([0-9]+):assumed-role/([^/]+)/.*$ ]]; then
    echo "arn:aws:iam::${BASH_REMATCH[1]}:role/${BASH_REMATCH[2]}"
  else
    echo "$arn"
  fi
}

if [ -n "${ORCH_PRINCIPAL_ARN:-}" ]; then
  PRINCIPAL_ARN="$ORCH_PRINCIPAL_ARN"
  echo "Using ORCH_PRINCIPAL_ARN from the environment: $PRINCIPAL_ARN"
else
  PRINCIPAL_ARN="$(normalize_principal_arn "$CALLER_ARN")"
  echo "Detected orchestrator principal (from the current caller identity): $PRINCIPAL_ARN"
fi

if [[ "$PRINCIPAL_ARN" == *:role/* ]]; then
  PRINCIPAL_TYPE="role"
  PRINCIPAL_NAME="${PRINCIPAL_ARN##*:role/}"
elif [[ "$PRINCIPAL_ARN" == *:user/* ]]; then
  PRINCIPAL_TYPE="user"
  PRINCIPAL_NAME="${PRINCIPAL_ARN##*:user/}"
else
  echo "FAIL: could not determine whether the orchestrator principal ($PRINCIPAL_ARN) is an IAM role or user." >&2
  echo "Set ORCH_PRINCIPAL_ARN explicitly to an 'arn:aws:iam::ACCOUNT:role/...' or '...:user/...' ARN and re-run." >&2
  exit 1
fi
echo "Orchestrator principal type: $PRINCIPAL_TYPE ($PRINCIPAL_NAME)"

echo
echo "== IRSA check =="
if [ -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ]; then
  echo "WARNING: AWS_WEB_IDENTITY_TOKEN_FILE is set - this looks like an EKS IRSA identity."
  echo "         Role chaining through IRSA caps the resulting session at 1 hour"
  echo "         (regardless of MaxSessionDuration/DurationSeconds requested), so"
  echo "         AWS_STS_SESSION_DURATION_SECONDS=43200 (A4's default) will NOT be"
  echo "         honored end to end. A4's credential-refresh endpoint (see"
  echo "         docs/ROADMAP.md) is mandatory in this setup, not optional."
  IRSA_DETECTED=true
else
  echo "AWS_WEB_IDENTITY_TOKEN_FILE is not set in this environment - no IRSA role chaining detected here."
  IRSA_DETECTED=false
fi

ACCOUNT_ID=$(echo "$PRINCIPAL_ARN" | sed -E 's/^arn:aws:iam::([0-9]+):.*$/\1/')
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

TRUST_POLICY=$(sed "s|__ORCH_PRINCIPAL_ARN__|${PRINCIPAL_ARN}|g" "$SCRIPT_DIR/trust-policy.json.tpl")
PERMISSION_POLICY=$(sed "s|__S3_BUCKET__|${S3_BUCKET}|g" "$SCRIPT_DIR/permission-policy.json.tpl")
ASSUME_POLICY=$(sed "s|__ROLE_ARN__|${ROLE_ARN}|g" "$SCRIPT_DIR/assume-role-policy.json.tpl")

echo
echo "== Planned changes =="
echo "Role: $ROLE_NAME (MaxSessionDuration=${MAX_SESSION_DURATION}s, tag app=ephemeral-sandbox)"
echo "Trust policy (who can assume it - only the orchestrator principal above):"
echo "$TRUST_POLICY"
echo "Permission policy '$ROLE_POLICY_NAME' attached to that role:"
echo "$PERMISSION_POLICY"
echo "Inline policy '$ASSUME_POLICY_NAME' attached ONLY to the orchestrator principal ($PRINCIPAL_TYPE $PRINCIPAL_NAME) - granting sts:AssumeRole on $ROLE_ARN and nothing else, on no other role or user:"
echo "$ASSUME_POLICY"
echo

if [ "$APPLY" = false ]; then
  echo "Dry run only - no changes were made. Re-run with --apply to create/update these."
  exit 0
fi

echo "== Applying =="

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME already exists - updating its trust policy and MaxSessionDuration."
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY"
  aws iam update-role --role-name "$ROLE_NAME" --max-session-duration "$MAX_SESSION_DURATION"
else
  echo "Creating role $ROLE_NAME."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --max-session-duration "$MAX_SESSION_DURATION" \
    --tags "$TAGS"
fi
aws iam tag-role --role-name "$ROLE_NAME" --tags "$TAGS"

echo "Attaching permission policy $ROLE_POLICY_NAME to $ROLE_NAME."
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$ROLE_POLICY_NAME" \
  --policy-document "$PERMISSION_POLICY"

echo "Attaching assume-role policy $ASSUME_POLICY_NAME to $PRINCIPAL_TYPE $PRINCIPAL_NAME (only this principal - no other role or user is touched)."
if [ "$PRINCIPAL_TYPE" = "role" ]; then
  aws iam put-role-policy \
    --role-name "$PRINCIPAL_NAME" \
    --policy-name "$ASSUME_POLICY_NAME" \
    --policy-document "$ASSUME_POLICY"
else
  aws iam put-user-policy \
    --user-name "$PRINCIPAL_NAME" \
    --policy-name "$ASSUME_POLICY_NAME" \
    --policy-document "$ASSUME_POLICY"
fi

ROLE_ARN_OUT=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo
echo "== Done =="
echo "Role ARN: $ROLE_ARN_OUT"
echo
echo "Set these on orchestrator-simple:"
echo "  AWS_STS_ROLE_ARN=$ROLE_ARN_OUT"
echo "  AWS_STS_SESSION_DURATION_SECONDS=43200"
if [ "$IRSA_DETECTED" = true ]; then
  echo
  echo "WARNING: IRSA detected earlier - the actual session will still be capped at 1h by role chaining. See docs/ROADMAP.md for the mandatory credential-refresh endpoint design."
fi
