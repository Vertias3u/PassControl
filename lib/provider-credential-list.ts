// One provider_credentials row, as the Settings page hands it to
// ProviderKeysManager. Metadata only: the secret is in Vault and has no column
// here to select.
export type CredentialListItem = {
  id: string;
  provider: string;
  label: string | null;
  created_at: string;
  is_active: boolean;
  endpoint_base_url: string | null;
};

export function toCredentialListItem(row: Record<string, unknown>): CredentialListItem {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: typeof row.label === "string" ? row.label : null,
    created_at: String(row.created_at),
    is_active: row.is_active === true,
    endpoint_base_url: typeof row.endpoint_base_url === "string" ? row.endpoint_base_url : null,
  };
}
