# GP25 — bake-vs-mount demo image. x86_64 Linux (build --platform=linux/amd64).
# Bakes a dummy "model" file INTO the image (rides on the host's local disk), so we can
# contrast it live against a file written to a mounted network volume (/workspace).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/*

# --- BAKED INTO THE IMAGE (local disk, fast, ephemeral per image) ---
# Stand-in for packages / many small static files you'd bake in.
RUN mkdir -p /opt/baked-model \
    && head -c 20000000 /dev/zero > /opt/baked-model/weights.bin \
    && echo "baked at image build time" > /opt/baked-model/SOURCE.txt

COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
