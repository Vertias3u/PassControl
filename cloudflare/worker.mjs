import passControl from "../.open-next/worker.js";
import { runReconcile } from "./reconcile.mjs";

// OpenNext's generated Worker owns request handling; this thin entry point adds
// the one platform event PassControl needs without forking generated code.
export default {
  fetch: passControl.fetch,
  scheduled(controller, env, ctx) {
    const job = runReconcile(passControl.fetch, env, ctx);
    ctx.waitUntil(job);
  },
};

export { DOQueueHandler } from "../.open-next/.build/durable-objects/queue.js";
export { DOShardedTagCache } from "../.open-next/.build/durable-objects/sharded-tag-cache.js";
export { BucketCachePurge } from "../.open-next/.build/durable-objects/bucket-cache-purge.js";
