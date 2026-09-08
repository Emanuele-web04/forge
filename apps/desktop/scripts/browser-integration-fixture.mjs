import { createServer } from "node:http";

const shell = (body) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synara browser fixture</title><style>body{max-width:640px;margin:48px auto;padding:0 24px;font:16px system-ui;color:#202020;background:#fff}label{display:block;margin:16px 0}input,button{font:inherit;padding:10px}input:not([type=file]){display:block;width:min(100%,320px);box-sizing:border-box}button{cursor:pointer}a{display:inline-block;margin:16px 16px 16px 0}h1{font-size:28px}</style>${body}</html>`;
const login = shell(
  `<h1>Fixture sign-in</h1><form action="/signin" method="post"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form><a href="/info" target="_blank">Open another tab</a>`,
);
const signup = shell(
  `<h1>Fixture signup</h1><form action="/signup" method="post"><label>Username<input name="username" autocomplete="username" required></label><label>New password<input name="password" type="password" autocomplete="new-password" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required></label><button>Create account</button></form>`,
);
const accounts = new Map([["fixture-user", "SynaraFixtureOnly42!"]]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.test");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/session-rotate") {
    response.setHeader(
      "Set-Cookie",
      "synara_synthetic_import=synthetic-session-only; Path=/; HttpOnly; SameSite=Lax",
    );
    response.end(shell("<h1>Synthetic session rotated</h1>"));
    return;
  }
  if (url.pathname === "/session-logout") {
    response.setHeader(
      "Set-Cookie",
      "synara_synthetic_import=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    response.end(shell("<h1>Synthetic session logged out</h1>"));
    return;
  }
  if (url.pathname === "/session-check") {
    const present = request.headers.cookie
      ?.split(";")
      .some((part) => part.trim() === "synara_synthetic_import=synthetic-session-only");
    response.end(
      shell(`<h1>${present ? "Session continuity verified" : "Session continuity absent"}</h1>`),
    );
    return;
  }
  if (url.pathname === "/cookie-check") {
    const imported = request.headers.cookie
      ?.split(";")
      .some((part) => part.trim() === "synara_synthetic_import=synthetic-only");
    response.end(
      shell(`<h1>${imported ? "Synthetic import verified" : "Synthetic import missing"}</h1>`),
    );
    return;
  }
  if (request.method === "POST") {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      if (url.pathname === "/signin" || url.pathname === "/signup") chunks.push(chunk);
    }
    if (url.pathname === "/signin") {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (accounts.get(form.get("username")) !== form.get("password")) {
        response.writeHead(403).end(shell("<h1>Sign-in rejected</h1>"));
        return;
      }
      response
        .writeHead(303, {
          Location: "/account",
          "Set-Cookie": "synara_fixture=accepted; Path=/; HttpOnly; SameSite=Lax",
        })
        .end();
      return;
    }
    if (url.pathname === "/signup") {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const username = form.get("username");
      const password = form.get("password");
      if (
        !username ||
        !password ||
        password.length < 12 ||
        password !== form.get("confirm") ||
        accounts.has(username)
      ) {
        response.writeHead(400).end(shell("<h1>Signup rejected</h1>"));
        return;
      }
      accounts.set(username, password);
      response
        .writeHead(303, {
          Location: "/account",
          "Set-Cookie": "synara_fixture=accepted; Path=/; HttpOnly; SameSite=Lax",
        })
        .end();
      return;
    }
    if (url.pathname === "/signout") {
      response
        .writeHead(303, {
          Location: "/",
          "Set-Cookie": "synara_fixture=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        })
        .end();
      return;
    }
    if (url.pathname === "/upload") {
      response.end(
        shell(
          `<h1>Upload received</h1><p>${bytes} bytes received.</p><a href="/account">Account</a>`,
        ),
      );
      return;
    }
  }
  if (url.pathname === "/account") {
    if (!request.headers.cookie?.includes("synara_fixture=accepted")) {
      response.writeHead(303, { Location: "/" }).end();
      return;
    }
    response.end(
      shell(
        `<h1>Signed in</h1><form action="/upload" method="post" enctype="multipart/form-data"><label>Fixture file<input type="file" name="file" required></label><button>Upload</button></form><form action="/signout" method="post"><button>Sign out</button></form><a href="/">Sign in again</a><a href="/download">Download fixture</a>`,
      ),
    );
    return;
  }
  if (url.pathname === "/download") {
    response
      .writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": 'attachment; filename="synara-fixture.txt"',
      })
      .end("Synthetic Synara browser fixture.\n");
    return;
  }
  response.end(
    url.pathname === "/signup"
      ? signup
      : url.pathname === "/info"
        ? shell("<h1>Second fixture tab</h1><p>Independent page.</p>")
        : login,
  );
});
server.listen(Number(process.env.SYNARA_FIXTURE_PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`http://127.0.0.1:${address.port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
