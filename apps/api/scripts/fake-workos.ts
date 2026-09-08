// FILE: scripts/fake-workos.ts
// Purpose: Runs the test double from src/testing/fakeWorkos.ts as a standalone
// dev server, so a full in-app sign-in flow can be exercised without a WorkOS
// account. The authorize page self-approves as the dev user and OTP codes are
// printed to stdout, which is what makes the flow headless — there is no
// hosted page to click through and no inbox to read.
// Layer: API dev tooling (never imported by the service)
// Depends on: src/testing/fakeWorkos.ts.

import { startFakeWorkos } from "../src/testing/fakeWorkos";

const DEFAULT_PORT = 8790;
const DEFAULT_CLIENT_ID = "client_01FAKE";
const DEFAULT_ACCESS_TOKEN_TTL = "5m";
const DEV_USER_EMAIL = "dev-user@example.com";

type Options = {
  port: number;
  clientId: string;
  accessTokenTtl: string;
  preCreateOrganizations: readonly string[];
};

const USAGE = `Usage: bun run scripts/fake-workos.ts [options]

  --port <n>             Port to listen on (default ${DEFAULT_PORT})
  --client-id <id>       WorkOS client id to serve (default ${DEFAULT_CLIENT_ID})
  --access-token-ttl <s> Access-token lifetime as a jose span, e.g. 30s
                         (default ${DEFAULT_ACCESS_TOKEN_TTL}; short values force the refresh path)
  --organization <name>  Pre-create an organization the dev user joins.
                         Repeatable; pass it twice to exercise the workspace
                         picker. Omitted (the default), the API provisions a
                         personal organization lazily on first use.
  --help                 Print this message
`;

function parseArgs(argv: readonly string[]): Options {
  const preCreateOrganizations: string[] = [];
  const options: Options = {
    port: DEFAULT_PORT,
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
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const workos = await startFakeWorkos({
    port: options.port,
    clientId: options.clientId,
    accessTokenTtl: options.accessTokenTtl,
    // Stands in for a human finishing the hosted provider page: the SSO
    // authorize endpoint 302s straight back to the loopback listener with a
    // fresh code, signed in as the dev user.
    autoApproveAuthorizeAs: DEV_USER_EMAIL,
    // Stands in for the inbox: the code real WorkOS would email is printed
    // here, for the operator at this terminal to type into the dialog.
    onMagicAuth(email, code) {
      process.stdout.write(`  → OTP for ${email}: ${code}\n`);
    },
  });

  // Joined up front, since the dev user is known. With none configured the
  // user belongs to nothing, which is what makes the API's lazy provisioning
  // the default path exercised.
  if (options.preCreateOrganizations.length > 0) {
    const user = workos.addUser({ email: DEV_USER_EMAIL, first_name: "Dev", last_name: "User" });
    for (const name of options.preCreateOrganizations) {
      const organization = workos.addOrganization({ name });
      workos.addMembership(organization.id, user.id);
      process.stdout.write(`  ✓ ${DEV_USER_EMAIL} joined ${organization.name}\n`);
    }
  }

  process.stdout.write(
    [
      "",
      `  Fake WorkOS listening on ${workos.origin}`,
      `  SSO sign-ins self-approve as ${DEV_USER_EMAIL}; OTP codes print here.`,
      `  Access tokens live ${options.accessTokenTtl}.`,
      "",
      "  Point the account API at it (issuer and JWKS are discovered from the",
      "  OIDC metadata this stub serves, so neither needs an override):",
      "",
      `    export WORKOS_API_URL=${workos.origin}`,
      "    export WORKOS_API_KEY=fake",
      `    export WORKOS_CLIENT_ID=${workos.clientId}`,
      "",
      "  Then run the API and sign in from the app as usual. Ctrl-C to stop.",
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
