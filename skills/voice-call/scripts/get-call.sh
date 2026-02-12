#!/usr/bin/env bash
set -euo pipefail

# Get call details from VAPI API.
#
# Usage: get-call.sh <call_id>
#
# Requires env var: VAPI_API_KEY

CALL_ID="${1:?Call ID required}"

: "${VAPI_API_KEY:?VAPI_API_KEY not set}"

curl -s "https://api.vapi.ai/call/$CALL_ID" \
  -H "Authorization: Bearer $VAPI_API_KEY"
