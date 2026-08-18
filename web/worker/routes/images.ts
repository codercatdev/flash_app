import { Hono } from "hono";

import type { AppContext } from "../types";

const images = new Hono<AppContext>();

/**
 * Serve a generated PNG out of R2.
 *
 * Keys are UUIDs, so they're unguessable and need no presigning -- which also
 * means no S3 credentials have to live inside the Worker. Objects are immutable
 * once written, hence the long immutable cache.
 */
images.get("/i/:key", async (c) => {
  const key = c.req.param("key");

  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
});

export default images;
