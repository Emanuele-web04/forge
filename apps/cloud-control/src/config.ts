// FILE: config.ts
// Purpose: Fail-fast configuration boundary for the independently deployable cloud control plane.

export type CloudControlConfig = Readonly<{
  host: string;
  port: number;
  databaseUrl: string;
  environment: "development" | "staging" | "production";
}>;

const environments = new Set(["development", "staging", "production"]);

export function loadCloudControlConfig(
  env: Record<string, string | undefined>,
): CloudControlConfig {
  const databaseUrl = env.CORTEX_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("CORTEX_DATABASE_URL is required.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("CORTEX_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (parsedUrl.protocol !== "postgres:" && parsedUrl.protocol !== "postgresql:") {
    throw new Error("CORTEX_DATABASE_URL must use the postgres or postgresql protocol.");
  }

  const portValue = env.PORT?.trim() ?? "8787";
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const environment = env.CORTEX_ENVIRONMENT?.trim() ?? "development";
  if (!environments.has(environment)) {
    throw new Error("CORTEX_ENVIRONMENT must be development, staging, or production.");
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    databaseUrl,
    environment: environment as CloudControlConfig["environment"],
  };
}
