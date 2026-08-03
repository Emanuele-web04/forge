import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import { createDb } from "./db";

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
