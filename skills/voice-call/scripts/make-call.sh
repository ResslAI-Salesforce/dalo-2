#!/usr/bin/env bash
set -euo pipefail

# Make an outbound phone call via VAPI API.
#
# Usage: make-call.sh <phone_number> <first_message>
#
# The first message is injected via assistantOverrides so the
# assistant greets with context (who's calling, why, etc.)
#
# Requires env vars: VAPI_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID

PHONE="${1:?Phone number required (E.164 format, e.g. +15551234567)}"
FIRST_MESSAGE="${2:?First message required — include who is calling, why, and context}"

: "${VAPI_API_KEY:?VAPI_API_KEY not set}"
: "${VAPI_ASSISTANT_ID:?VAPI_ASSISTANT_ID not set}"
: "${VAPI_PHONE_NUMBER_ID:?VAPI_PHONE_NUMBER_ID not set}"

BODY=$(jq -n \
  --arg aid "$VAPI_ASSISTANT_ID" \
  --arg pid "$VAPI_PHONE_NUMBER_ID" \
  --arg num "$PHONE" \
  --arg msg "$FIRST_MESSAGE" \
  '{
    assistantId: $aid,
    phoneNumberId: $pid,
    customer: { number: $num },
    assistantOverrides: { 
      firstMessage: $msg,
      variableValues: { callerId: $num }
    }
  }')

curl -s -X POST "https://api.vapi.ai/call/phone" \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY"
