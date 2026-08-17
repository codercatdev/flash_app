import runpod


def handler(event):
    """Minimal queue-based Runpod serverless handler.

    The request's `input` dict is passed as `event["input"]`.
    """
    inp = event.get("input", {}) or {}
    return {"message": f"hello {inp.get('name', 'world')}", "echo": inp}


runpod.serverless.start({"handler": handler})
