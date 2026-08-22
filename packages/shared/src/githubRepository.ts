/** Conservative validation for the `owner/repository` form accepted by GitHub CLI. */
export function isValidGitHubRepositoryNameWithOwner(repository: string): boolean {
  const normalized = repository.trim();
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator !== normalized.lastIndexOf("/")) return false;

  const owner = normalized.slice(0, separator);
  const name = normalized.slice(separator + 1);
  if (name.length === 0 || name.length > 100 || name === "." || name === "..") return false;

  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(name)
  );
}

/**
 * Parse the deliberately small input surface used when provisioning a GitHub project.
 * Accepts `owner/repository` or a credential-free GitHub.com HTTPS repository root.
 */
export function parseGitHubRepositoryInput(input: string | null | undefined): string | null {
  const trimmed = input?.trim() ?? "";
  if (isValidGitHubRepositoryNameWithOwner(trimmed)) return trimmed;

  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/?#\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return isValidGitHubRepositoryNameWithOwner(repositoryNameWithOwner)
    ? repositoryNameWithOwner
    : null;
}

/** Normalize a supported GitHub remote URL into its `owner/repository` identity. */
export function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(
  url: string | null | undefined,
): string | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  const repositoryNameWithOwner = match?.[1]?.trim() ?? "";
  return isValidGitHubRepositoryNameWithOwner(repositoryNameWithOwner)
    ? repositoryNameWithOwner
    : null;
}

/** Extract the `owner/repository` identity from a GitHub pull-request web URL. */
export function parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(
  url: string | null | undefined,
): string | null {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:[/?#].*)?$/i.exec(
    url?.trim() ?? "",
  );
  const owner = match?.[1]?.trim() ?? "";
  const repository = match?.[2]?.trim() ?? "";
  const nameWithOwner = `${owner}/${repository}`;
  return isValidGitHubRepositoryNameWithOwner(nameWithOwner) ? nameWithOwner : null;
}

// Repository-level pull-request identity and local-project association helpers live in their own
// module, but are exposed through this established GitHub subpath so dev servers do not need a
// restart when the helper set grows.
export {
  coalescePullRequestListEntries,
  pullRequestListEntryHasProject,
  pullRequestListProjectContexts,
  pullRequestListProjectPin,
  pullRequestListRepositoryIdentity,
  updatePullRequestListEntryProjectPin,
} from "./pullRequestList";
