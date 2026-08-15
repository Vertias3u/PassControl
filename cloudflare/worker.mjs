import passControl from "../.open-next/worker.js";
import { BETA_RETENTION_CRON, runBetaRetention, runReconcile } from "./reconcile.mjs";

// OpenNext's generated Worker owns request handling; this thin entry point adds
// the one platform event PassControl needs without forking generated code.
export default {
  fetch: passControl.fetch,
  scheduled(controller, env, ctx) {
    const job = controller.cron === BETA_RETENTION_CRON
      ? runBetaRetention(passControl.fetch, env, ctx)
      : runReconcile(passControl.fetch, env, ctx);
    ctx.waitUntil(job);
  },
};

export { DOQueueHandler } from "../.open-next/.build/durable-objects/queue.js";
export { DOShardedTagCache } from "../.open-next/.build/durable-objects/sharded-tag-cache.js";
export { BucketCachePurge } from "../.open-next/.build/durable-objects/bucket-cache-purge.js";
