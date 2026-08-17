#!/bin/bash
# Dual-mode entrypoint. MODE_TO_RUN picks the behavior:
#   pod         -> SSH + Jupyter for interactive dev, then sleep forever
#   serverless  -> run handler.py under the Runpod serverless SDK
# Vendored + trimmed from the community repo justinwlin/Runpod-GPU-And-Serverless-Base (provenance only).
set -e

WORKSPACE_DIR="${WORKSPACE_DIR:-/app}"

setup_ssh() {
    # Runpod injects PUBLIC_KEY when you add an SSH key to the pod.
    if [[ $PUBLIC_KEY ]]; then
        echo "Setting up SSH..."
        mkdir -p ~/.ssh
        echo "$PUBLIC_KEY" >> ~/.ssh/authorized_keys
        chmod 700 -R ~/.ssh
        ssh-keygen -A
        service ssh start
    fi
}

start_jupyter() {
    echo "Starting Jupyter Lab (no token)..."
    mkdir -p "$WORKSPACE_DIR"
    nohup jupyter lab --allow-root --no-browser --port=8888 --ip=* \
        --NotebookApp.token='' --NotebookApp.password='' \
        --ServerApp.allow_origin=* --ServerApp.preferred_dir="$WORKSPACE_DIR" \
        &> /jupyter.log &
}

echo "Container started in MODE_TO_RUN=$MODE_TO_RUN"
setup_ssh

case $MODE_TO_RUN in
    serverless)
        # Foreground: the SDK owns the process and listens for jobs.
        python "$WORKSPACE_DIR/handler.py"
        ;;
    pod)
        # Background dev services, then idle so you can SSH in and iterate.
        start_jupyter
        echo "Pod ready. SSH in and run:  python $WORKSPACE_DIR/handler.py"
        sleep infinity
        ;;
    *)
        echo "Invalid MODE_TO_RUN: '$MODE_TO_RUN' (expected 'pod' or 'serverless')"
        exit 1
        ;;
esac
