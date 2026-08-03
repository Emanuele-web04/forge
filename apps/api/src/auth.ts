import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import { createDb } from "./db";

// This is a Task 4 placeholder: full BetterAuth wiring (route mounting, hooks,
// error handling) lands there. It exists here only so the BetterAuth CLI can
// introspect `plugins` to generate `src/db/auth-schema.ts` (see Step 1 of the
// Task 2 brief).
//
// The `as unknown as ReturnType<typeof betterAuth>` cast below is a deliberate
// type-erasing compromise, not a formatting nicety:
// - Why it's needed: `apps/api/tsconfig.json` sets `composite: true`, which
//   makes `tsc` require every exported declaration's type to be nameable for
//   `.d.ts` emission. `betterAuth(...)`'s *inferred* return type (with the
//   `jwt()` + `deviceAuthorization()` plugins applied) transitively references
//   an internal, unexported zod subpath, which fails that check (TS2742). A
//   plain `ReturnType<typeof betterAuth>` annotation alone doesn't satisfy the
//   generic's structural constraints either (TS2322/TS2352), hence the double
//   cast through `unknown`.
// - What is lost: the annotated/cast type is `Auth<BetterAuthOptions>`, i.e.
//   the *default* generic instantiation. It does NOT carry the concrete
//   `jwt`/`deviceAuthorization` plugin-specific endpoint and option shapes
//   that the real, uncast return value has at runtime.
// - What Task 4 must do: when replacing this stub with the full wiring, do
//   not just re-import `createAuth` and trust its exported type for anything
//   plugin-specific (e.g. typed access to `auth.api.getJwks` or device-code
//   endpoints) — re-derive the concrete `Auth<...>` type at the call site
//   (or re-evaluate whether `composite` can be dropped for this package)
//   instead of propagating this erasure further.
export const createAuth = (options: {
  databaseUrl: string;
  baseUrl: string;
  secret: string;
}): ReturnType<typeof betterAuth> => {
  const { db } = createDb(options.databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    baseURL: options.baseUrl,
    secret: options.secret,
    emailAndPassword: { enabled: true },
    plugins: [jwt(), deviceAuthorization()],
  }) as unknown as ReturnType<typeof betterAuth>;
};
