export type RemoteProvider = "github" | "bitbucket";

export interface RemoteRepositoryRef {
  readonly provider: RemoteProvider;
  readonly host: string;
  readonly owner: string;
  readonly slug: string;
  readonly webUrl: string;
  readonly identityKey: string;
  readonly displayName: string;
}

type RemoteRepositoryIdentity = Pick<RemoteRepositoryRef, "provider" | "host" | "owner" | "slug">;

export function remoteRepositoryIdentityKey(input: RemoteRepositoryIdentity): string {
  return `${input.provider}:${input.host.toLowerCase()}:${input.owner.toLowerCase()}/${input.slug.toLowerCase()}`;
}

/** Conservative validation for the `owner/repository` form accepted by supported providers. */
export function isValidRemoteRepositoryNameWithOwner(repository: string): boolean {
  const normalized = repository.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator !== normalized.lastIndexOf("/")) return false;

  const owner = normalized.slice(0, separator);
  const slug = normalized.slice(separator + 1);
  if (slug.length === 0 || slug.length > 100 || slug === "." || slug === "..") return false;

  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

type SupportedRemote = {
  readonly provider: RemoteProvider;
  readonly host: "github.com" | "bitbucket.org";
  readonly pattern: RegExp;
};

const SUPPORTED_REMOTES: ReadonlyArray<SupportedRemote> = [
  {
    provider: "github",
    host: "github.com",
    pattern:
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/i,
  },
  {
    provider: "bitbucket",
    host: "bitbucket.org",
    pattern:
      /^(?:git@bitbucket\.org:|https:\/\/bitbucket\.org\/)([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/i,
  },
];

/** Parse a credential-free supported remote URL into its canonical repository identity. */
export function parseRemoteRepositoryUrl(
  url: string | null | undefined,
): RemoteRepositoryRef | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  for (const supported of SUPPORTED_REMOTES) {
    const match = supported.pattern.exec(trimmed);
    const owner = match?.[1] ?? "";
    const slug = match?.[2] ?? "";
    const displayName = `${owner}/${slug}`;
    if (!isValidRemoteRepositoryNameWithOwner(displayName)) continue;
    if (supported.provider === "bitbucket" && owner.toLowerCase() !== "paraty") continue;

    return {
      provider: supported.provider,
      host: supported.host,
      owner,
      slug,
      webUrl: `https://${supported.host}/${displayName}`,
      identityKey: remoteRepositoryIdentityKey({
        provider: supported.provider,
        host: supported.host,
        owner,
        slug,
      }),
      displayName,
    };
  }

  return null;
}
