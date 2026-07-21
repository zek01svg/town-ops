#!/bin/sh
set -eu

namespace="${TEMPORAL_NAMESPACE:-default}"
until temporal operator cluster health --address "$TEMPORAL_ADDRESS"; do
  sleep 2
done

temporal operator namespace describe -n "$namespace" --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1 || \
  temporal operator namespace create -n "$namespace" --address "$TEMPORAL_ADDRESS"
