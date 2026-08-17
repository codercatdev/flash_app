# Minimal Runpod serverless (queue) worker.
# Runpod hosts are x86_64 Linux — always build with --platform=linux/amd64.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Dependency layer first (cached across code edits).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Code last.
COPY handler.py .

# Queue workers run the handler as the container command.
CMD ["python", "-u", "handler.py"]
