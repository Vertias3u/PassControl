// The Settings page reads each credential's endpoint_base_url and hands the list
// to ProviderKeysManager, whose Endpoint panel opens pre-filled with it. From
// 7a60791 until 2026-09-29 the page selected the column and then dropped it in
// its row mapping, so the panel always opened EMPTY. For an Azure key that meant
// the one address the key is ever sent to was shown nowhere, in a box that also
// says it "cannot be cleared" — found in the Package 2 browser check.
import { describe, expect, it } from "vitest";
import { toCredentialListItem } from "@/lib/provider-credential-list";

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "azure",
  label: "prod",
  created_at: "2026-09-29T20:25:12Z",
  is_active: true,
  endpoint_base_url: "https://contoso-ai.openai.azure.com/openai/v1",
};

describe("toCredentialListItem", () => {
  it("carries the stored endpoint through to the Settings panel", () => {
    expect(toCredentialListItem(ROW).endpoint_base_url).toBe("https://contoso-ai.openai.azure.com/openai/v1");
  });

  it("reads a missing or non-string endpoint as none", () => {
    expect(toCredentialListItem({ ...ROW, endpoint_base_url: null }).endpoint_base_url).toBeNull();
    expect(toCredentialListItem({ ...ROW, endpoint_base_url: undefined }).endpoint_base_url).toBeNull();
    expect(toCredentialListItem({ ...ROW, endpoint_base_url: 42 }).endpoint_base_url).toBeNull();
  });

  it("keeps the other fields exactly as the page mapped them", () => {
    expect(toCredentialListItem({ ...ROW, label: null, is_active: null })).toEqual({
      id: ROW.id,
      provider: "azure",
      label: null,
      created_at: ROW.created_at,
      is_active: false,
      endpoint_base_url: ROW.endpoint_base_url,
    });
  });
});
