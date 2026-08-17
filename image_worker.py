from runpod_flash import Endpoint, GpuType

@Endpoint(
    name="image_generator",
    gpu=GpuType.NVIDIA_GEFORCE_RTX_4090,
    workers=2,
    dependencies=["diffusers", "torch", "transformers", "pillow"]
)
async def generate_image(prompt: str, width: int = 512, height: int = 512) -> dict:
    import torch
    from diffusers import StableDiffusionPipeline
    import base64
    import io

    pipeline = StableDiffusionPipeline.from_pretrained(
        "runwayml/stable-diffusion-v1-5",
        torch_dtype=torch.float16
    ).to("cuda")

    image = pipeline(prompt=prompt, width=width, height=height).images[0]

    buffered = io.BytesIO()
    image.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()

    return {"image": img_str, "prompt": prompt}