import os

from runpod_flash import DataCenter, Endpoint, GpuGroup, NetworkVolume

# A NetworkVolume caches the ~7GB of model weights so a cold worker reads them
# locally instead of re-downloading from HuggingFace. The catch: a volume forces
# the endpoint into a single datacenter, and that datacenter must actually have
# free GPUs. Both halves of that bit us -- see docs/friction-log.md:
#
#   * Not every member of flash's DataCenter enum can host a volume. US_KS_2 (the
#     value in Flash's own caching example) is accepted by the SDK and then
#     rejected by the API at provision time. The enum and the volume-capable
#     region list disagree in both directions.
#   * Pinning US_CA_2 then failed with "no gpu availability for gpu type ADA_24
#     in selected locations".
#
# So the volume is opt-in. Default off = no region pin = widest GPU supply, at the
# cost of re-downloading weights on every cold start. Turn it on to measure the
# difference:  FLASHFUN_USE_VOLUME=1 flash dev
USE_VOLUME = os.getenv("FLASHFUN_USE_VOLUME", "0") == "1"
DATACENTER = DataCenter.US_IL_1

_placement: dict = {}
if USE_VOLUME:
    _placement = {
        "datacenter": DATACENTER,
        "volume": NetworkVolume(
            name="flashfun-hf-cache", size=50, datacenter=DATACENTER
        ),
        # Point HuggingFace's cache at the volume so weights survive scale-to-zero.
        "env": {"HF_HUB_CACHE": "/runpod-volume/hf"},
    }


@Endpoint(
    name="flashfun-sdxl",
    # A list widens the supply pool. Flash only auto-switches between GPU types
    # when max workers is >= 5 (hence (0, 5) rather than (0, 3)); with a smaller
    # cap it pins the first type and queues when that type is unavailable.
    gpu=[GpuGroup.ADA_24, GpuGroup.AMPERE_24, GpuGroup.AMPERE_48],
    # Scales to zero -- cheap, but every burst pays a cold start. Flip the minimum
    # to 1 for the live demo to keep a worker warm, then flip it back (a pinned
    # 4090 bills continuously).
    workers=(0, 5),
    idle_timeout=300,
    dependencies=["torch", "diffusers", "transformers", "accelerate", "pillow"],
    **_placement,
)
class ImageGenerator:
    """Stable Diffusion XL Turbo, loaded once per worker."""

    MODEL_ID = "stabilityai/sdxl-turbo"

    def __init__(self):
        # Every import lives inside the class body: `flash dev` ships only the body
        # to the remote worker, so a module-level import would raise NameError there
        # even though `flash deploy` (which imports the whole module) would mask it.
        import time

        import torch
        from diffusers import AutoPipelineForText2Image

        started = time.perf_counter()

        try:
            self.pipe = AutoPipelineForText2Image.from_pretrained(
                self.MODEL_ID, torch_dtype=torch.float16, variant="fp16"
            )
        except Exception:
            # Not every mirror of the repo publishes the fp16 variant files.
            # Fall back to the default weights rather than failing the worker.
            self.pipe = AutoPipelineForText2Image.from_pretrained(
                self.MODEL_ID, torch_dtype=torch.float16
            )

        self.pipe = self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)

        self.load_ms = round((time.perf_counter() - started) * 1000)
        self.gpu_name = torch.cuda.get_device_name(0)
        self.served = 0

        print(f"[flashfun] loaded {self.MODEL_ID} on {self.gpu_name} in {self.load_ms}ms")

    @staticmethod
    def _clamp_dim(value: int) -> int:
        """SDXL needs dimensions that are multiples of 8; turbo is trained at 512."""
        value = max(256, min(1024, int(value)))
        return value - (value % 8)

    async def generate(
        self,
        prompt: str,
        width: int = 512,
        height: int = 512,
        steps: int = 2,
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
        steps = max(1, min(8, int(steps)))

        generator = None
        if seed is not None:
            generator = torch.Generator(device="cuda").manual_seed(int(seed))

        started = time.perf_counter()
        image = self.pipe(
            prompt=prompt,
            num_inference_steps=steps,
            # SDXL-Turbo is a distilled model trained without classifier-free
            # guidance. Any non-zero guidance_scale produces washed-out mush.
            guidance_scale=0.0,
            width=width,
            height=height,
            generator=generator,
        ).images[0]
        generate_ms = round((time.perf_counter() - started) * 1000)

        buffer = io.BytesIO()
        image.save(buffer, format="PNG")

        # `served == 0` means this request paid for the worker's model load; the
        # Cloudflare UI badges it as a cold start so cold vs warm is visible without
        # opening the Runpod dashboard.
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
