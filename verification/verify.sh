#!/usr/bin/env bash
# /source is a read-only bind mount; dependencies and outputs stay in the container.
set -euo pipefail
mkdir -p /workspace
tar -C /source --exclude=.git --exclude=node_modules --exclude=target --exclude=dist --exclude=.nx --exclude=.work --exclude=test-results --exclude=playwright-report -cf - . | tar -C /workspace -xf -
cd /workspace
npm ci
exec bash -euo pipefail -c "${VERIFY_COMMAND:-npm run verify}"
