import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { EmailAccountConfig } from "../types.js";

export type ResolvedEmailAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  gmailAddress?: string;
  credentialsPath?: string;
  tokenPath?: string;
  projectId?: string;
  config: EmailAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.email?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listEmailAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultEmailAccountId(cfg: OpenClawConfig): string {
  const ids = listEmailAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): EmailAccountConfig | undefined {
  const accounts = cfg.channels?.email?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as EmailAccountConfig | undefined;
}

function mergeEmailAccountConfig(cfg: OpenClawConfig, accountId: string): EmailAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.email ?? {}) as EmailAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveEmailAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedEmailAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.email?.enabled !== false;
  const merged = mergeEmailAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    gmailAddress: merged.gmailAddress?.trim() || undefined,
    credentialsPath: merged.credentialsPath?.trim() || undefined,
    tokenPath: merged.tokenPath?.trim() || undefined,
    projectId: merged.projectId?.trim() || undefined,
    config: merged,
  };
}

export function listEnabledEmailAccounts(cfg: OpenClawConfig): ResolvedEmailAccount[] {
  return listEmailAccountIds(cfg)
    .map((accountId) => resolveEmailAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
