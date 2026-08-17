#!/usr/bin/env bash
# SSH setup (from-scratch pattern, see golden path 22) so we can exec in and inspect,
# then idle so the pod stays up.
set -e
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [ -n "$PUBLIC_KEY" ]; then
  echo "$PUBLIC_KEY" >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
fi
ssh-keygen -A
service ssh start
echo "pod up: baked model at /opt/baked-model, network volume at /workspace"
exec sleep infinity
