# Minimal Runpod POD image built from a plain base.
# Runpod hosts are x86_64 Linux — always build with --platform=linux/amd64.
#
# NOTE: prefer FROM runpod/pytorch:<tag> for real GPU work — it's host-cached AND already
# sets up SSH via /start.sh, so you can skip this whole SSH block. This slim base is used
# here only to show the from-scratch SSH-preservation pattern with a tiny, fast image.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

# openssh-server so the pod is reachable — the base image doesn't include it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/*

COPY start.sh /start.sh
RUN chmod +x /start.sh

# start.sh sets up SSH THEN runs the workload. Overriding CMD without this = no SSH.
CMD ["/start.sh"]
