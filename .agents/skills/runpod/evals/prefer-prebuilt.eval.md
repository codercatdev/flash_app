# Prefer a prebuilt/known option before building from scratch

## Prompt

Get ComfyUI running on Runpod for me and give me the URL.

## Expected behavior

Per the development loop's "prefer prebuilt" step (`runpod/SKILL.md`,
`runpod-usage/reference/development-loop.md`):

1. The agent should look for an **official prebuilt ComfyUI template/image** first
   (`runpodctl template search comfyui` → the Runpod-official `ComfyUI - CUDA 12.8`),
   NOT immediately git-clone + `pip install` ComfyUI onto a bare PyTorch template.
2. It should deploy the pod from that template with the ComfyUI port exposed and
   **verify by polling the proxy URL** (expecting warm-up 502s), not report success
   on "pod Running".
3. From-scratch install is acceptable only as a fallback if no good prebuilt exists.

## Assertions

- Searches for / uses a prebuilt ComfyUI template or Hub entry before any from-scratch install.
- Exposes the ComfyUI port at creation and returns a `…proxy.runpod.net` URL.
- Verifies readiness with a real request (polls the URL), not a status field.
- Only falls back to git-clone + pip install if it argues no prebuilt fits.
