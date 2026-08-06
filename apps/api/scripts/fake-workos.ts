// FILE: scripts/fake-workos.ts
// Purpose: Runs the test double from src/testing/fakeWorkos.ts as a standalone
// dev server, so a full `synara auth` flow can be exercised without a WorkOS
// account. Auto-approves device authorizations on a timer, which is what makes
// the flow headless — there is no hosted page to click through.
// Layer: API dev tooling (never imported by the service)
// Depends on: src/testing/fakeWorkos.ts.

import { startFakeWorkos } from "../src/testing/fakeWorkos";

const DEFAULT_PORT = 8790;
const DEFAULT_APPROVE_AFTER_SECONDS = 5;
const DEFAULT_CLIENT_ID = "client_01FAKE";
const DEFAULT_ACCESS_TOKEN_TTL = "5m";

type Options = {
  port: number;
  approveAfterSeconds: number;
  clientId: string;
  accessTokenTtl: string;
  preCreateOrganizations: readonly string[];
};

const USAGE = `Usage: bun run scripts/fake-workos.ts [options]

  --port <n>             Port to listen on (default ${DEFAULT_PORT})
  --approve-after <s>    Seconds before a device authorization self-approves
                         (default ${DEFAULT_APPROVE_AFTER_SECONDS}; 0 approves immediately)
  --client-id <id>       WorkOS client id to serve (default ${DEFAULT_CLIENT_ID})
  --access-token-ttl <s> Access-token lifetime as a jose span, e.g. 30s
                         (default ${DEFAULT_ACCESS_TOKEN_TTL}; short values force the refresh path)
  --organization <name>  Pre-create an organization the approved user joins.
                         Repeatable; pass it twice to exercise the workspace
                         picker. Omitted (the default), the API provisions a
                         personal organization lazily on first use.
  --help                 Print this message
`;

function parseArgs(argv: readonly string[]): Options {
  const preCreateOrganizations: string[] = [];
  const options: Options = {
    port: DEFAULT_PORT,
    approveAfterSeconds: DEFAULT_APPROVE_AFTER_SECONDS,
    clientId: DEFAULT_CLIENT_ID,
    accessTokenTtl: DEFAULT_ACCESS_TOKEN_TTL,
    preCreateOrganizations,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    index += 1;

    switch (flag) {
      case "--port":
        options.port = Number.parseInt(value, 10);
        break;
      case "--approve-after":
        options.approveAfterSeconds = Number.parseFloat(value);
        break;
      case "--client-id":
        options.clientId = value;
        break;
      case "--access-token-ttl":
        options.accessTokenTtl = value;
        break;
      case "--organization":
        preCreateOrganizations.push(value);
        break;
      default:
        throw new Error(`Unknown option: ${flag}\n\n${USAGE}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`--port must be a valid port number, got "${options.port}"`);
  }
  if (!Number.isFinite(options.approveAfterSeconds) || options.approveAfterSeconds < 0) {
    throw new Error("--approve-after must be a non-negative number of seconds");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const workos = await startFakeWorkos({
    port: options.port,
    clientId: options.clientId,
    accessTokenTtl: options.accessTokenTtl,
    // Stands in for a human clicking through the hosted approval page, on a
    // timer so the CLI actually polls at least once before succeeding.
    onDeviceAuthorization(deviceCode) {
      process.stdout.write("  → device authorization requested\n");
      setTimeout(() => {
        const user = workos.approveDevice(deviceCode, { first_name: "Dev", last_name: "User" });
        process.stdout.write(`  ✓ approved as ${user.email}\n`);
        // Joined only after approval, since there is no user to add before
        // then. With none configured the user belongs to nothing, which is
        // what makes the API's lazy provisioning the default path exercised.
        for (const name of options.preCreateOrganizations) {
          const organization = workos.addOrganization({ name });
          workos.addMembership(organization.id, user.id);
          process.stdout.write(`  ✓ joined ${organization.name}\n`);
        }
      }, options.approveAfterSeconds * 1000);
    },
  });

  process.stdout.write(
    [
      "",
      `  Fake WorkOS listening on ${workos.origin}`,
      `  Device authorizations self-approve after ${options.approveAfterSeconds}s.`,
      `  Access tokens live ${options.accessTokenTtl}.`,
      "",
      "  Point the account API at it (issuer and JWKS are discovered from the",
      "  OIDC metadata this stub serves, so neither needs an override):",
      "",
      `    export WORKOS_API_URL=${workos.origin}`,
      "    export WORKOS_API_KEY=fake",
      `    export WORKOS_CLIENT_ID=${workos.clientId}`,
      "",
      "  Then run the API and `synara auth` as usual. Ctrl-C to stop.",
      "",
      "",
    ].join("\n"),
  );

  const shutdown = async (): Promise<void> => {
    await workos.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
