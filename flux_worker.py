"""FLUX.1-schnell text-to-image endpoint — the quality challenger to SDXL-Turbo.

Same shape as image_worker.py on purpose: a class endpoint with exactly one public
method, every import inside the body, and an identical return dict so the Cloudflare
Worker can treat both models through one code path.

Two things differ from the Turbo endpoint and both cost real money:

  * ~34GB of weights in bf16 (transformer 23.8GB + T5-XXL 9.5GB + CLIP/VAE), so this
    needs a 48GB GPU tier. The 24GB tier the Turbo endpoint uses will OOM.
  * The repo is GATED. You must accept the license at
    huggingface.co/black-forest-labs/FLUX.1-schnell *and* supply HF_TOKEN. A valid
    token without accepting the terms still returns 403.
"""

import os

from runpod_flash import Endpoint, GpuGroup

# Read, don't index. Flash imports every module during discovery, so a missing
# HF_TOKEN with os.environ["HF_TOKEN"] would raise KeyError at scan time and take
# down the *other* (working) endpoint along with this one. Empty means the endpoint
# still provisions and fails later with a clear 403 from HuggingFace.
HF_TOKEN = os.getenv("HF_TOKEN", "")


@Endpoint(
    name="flashfun-flux",
    # 48GB tier: L40S / RTX 6000 Ada, or A40 / A6000. A list plus max workers >= 5 so
    # Flash can auto-switch tiers -- pinning one tier previously left us queued forever
    # with no availability (see docs/friction-log.md #6).
    gpu=[GpuGroup.ADA_48_PRO, GpuGroup.AMPERE_48],
    workers=(0, 5),
    idle_timeout=300,
    env={"HF_TOKEN": HF_TOKEN},
    # sentencepiece + protobuf are for the T5 tokenizer. They are easy to miss because
    # the failure happens at model load, not at import.
    dependencies=[
        "torch",
        "diffusers",
        "transformers",
        "accelerate",
        "sentencepiece",
        "protobuf",
        "pillow",
    ],
)
class FluxGenerator:
    """FLUX.1-schnell, loaded once per worker."""

    MODEL_ID = "black-forest-labs/FLUX.1-schnell"

    def __init__(self):
        import time

        import torch
        from diffusers import FluxPipeline

        started = time.perf_counter()

        # bfloat16, not float16: FLUX's transformer is trained in bf16 and fp16
        # produces black images on some layers.
        self.pipe = FluxPipeline.from_pretrained(
            self.MODEL_ID, torch_dtype=torch.bfloat16
        ).to("cuda")

        self.load_ms = round((time.perf_counter() - started) * 1000)
        self.gpu_name = torch.cuda.get_device_name(0)
        self.served = 0

        print(f"[flashfun] loaded {self.MODEL_ID} on {self.gpu_name} in {self.load_ms}ms")

    @staticmethod
    def _clamp_dim(value: int) -> int:
        """FLUX wants multiples of 16; it is trained at 1024."""
        value = max(256, min(1440, int(value)))
        return value - (value % 16)

    async def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        steps: int = 4,
        seed: int | None = None,
    ) -> dict:
        """Generate one PNG from a text prompt and return it base64-encoded."""
        import base64
        import io
        import time

        import torch

        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("prompt must not be empty")
        prompt = prompt[:800]

        width = self._clamp_dim(width)
        height = self._clamp_dim(height)
        # schnell is a 1-4 step timestep-distilled model; more steps buys nothing.
        steps = max(1, min(4, int(steps)))

        generator = None
        if seed is not None:
            generator = torch.Generator(device="cuda").manual_seed(int(seed))

        started = time.perf_counter()
        image = self.pipe(
            prompt=prompt,
            num_inference_steps=steps,
            # schnell is guidance-distilled -- it takes no CFG, same as SDXL-Turbo.
            guidance_scale=0.0,
            # schnell caps T5 conditioning at 256 tokens (dev allows 512).
            max_sequence_length=256,
            width=width,
            height=height,
            generator=generator,
        ).images[0]
        generate_ms = round((time.perf_counter() - started) * 1000)

        buffer = io.BytesIO()
        image.save(buffer, format="PNG")

        cold = self.served == 0
        self.served += 1

        return {
            "image": base64.b64encode(buffer.getvalue()).decode(),
            "prompt": prompt,
            "width": width,
            "height": height,
            "steps": steps,
            "seed": seed,
            "generate_ms": generate_ms,
            "model_load_ms": self.load_ms if cold else 0,
            "cold": cold,
            "gpu": self.gpu_name,
        }
