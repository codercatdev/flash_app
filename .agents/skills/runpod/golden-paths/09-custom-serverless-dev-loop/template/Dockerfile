# Dual-mode Runpod image (pod dev + serverless), built on an official Runpod base
# so torch/CUDA already match Runpod hosts. Swap the base with --build-arg:
#   docker build --platform linux/amd64 -t <you>/whisper-dualmode:v1 . --push
# Default base is the exact image behind the `runpod-torch-v280` pod template
# (torch 2.8.0 / CUDA 12.8, Ubuntu 24.04) — so `python handler.py` on that pod and
# the built image run identical torch/CUDA. See the golden path for other tags.
ARG BASE_IMAGE=runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    MODE_TO_RUN=pod \
    WORKSPACE_DIR=/app

WORKDIR $WORKSPACE_DIR

# Install deps first so the layer caches across handler edits.
# Two gotchas on the runpod/pytorch base (both hit live, 2026-07-10):
#   1. pip is PEP-668 "externally managed" -> need --break-system-packages.
#   2. `runpod` wants a newer `cryptography` than the base's Debian-managed one,
#      which pip can't uninstall ("no RECORD file") -> --ignore-installed cryptography.
# faster-whisper installs cleanly on its own; keep the two installs separate so
# --ignore-installed is scoped to just the cryptography/runpod pair.
# NOTE: requirements.txt is a copied-in **manifest for reference** (and mirrors the pod
# install) — we deliberately do NOT `pip install -r` it, because each package needs
# different flags (see the two RUN lines below). The COPY keeps the manifest in the image.
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages faster-whisper \
 && pip install --no-cache-dir --break-system-packages --ignore-installed cryptography runpod

COPY handler.py start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
