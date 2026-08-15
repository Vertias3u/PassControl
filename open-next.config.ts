import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// PassControl does not depend on Next's incremental cache for correctness. Keep
// the first Cloud launch path stateless so it needs no R2 bucket or KV binding.
export default defineCloudflareConfig({});
