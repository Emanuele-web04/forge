import { describe, expect, it } from "vitest";
import {
  ProviderLaunchArgsError,
  buildCodexAppServerArgs,
  parseProviderLaunchArgs,
} from "./providerLaunchArgs";

describe("parseProviderLaunchArgs", () => {
  it("returns empty sides for blank input", () => {
    expect(parseProviderLaunchArgs("")).toEqual({ prefix: [], suffix: [] });
    expect(parseProviderLaunchArgs("   ")).toEqual({ prefix: [], suffix: [] });
  });

  it("tokenizes quoted values and escaped spaces", () => {
    expect(
      parseProviderLaunchArgs(`-c model_provider="apitoken" -c 'model="gpt-6-astra"'`),
    ).toEqual({
      prefix: ["-c", "model_provider=apitoken", "-c", 'model="gpt-6-astra"'],
      suffix: [],
    });
    expect(parseProviderLaunchArgs(`--config model="gpt 6"`)).toEqual({
      prefix: ["--config", "model=gpt 6"],
      suffix: [],
    });
  });

  it("splits unquoted -- into prefix and suffix", () => {
    expect(parseProviderLaunchArgs(`--profile apitoken -- -c notify=[]`)).toEqual({
      prefix: ["--profile", "apitoken"],
      suffix: ["-c", "notify=[]"],
    });
  });

  it("rejects unmatched quotes and dangling escapes", () => {
    expect(() => parseProviderLaunchArgs(`-c model="gpt`)).toThrow(ProviderLaunchArgsError);
    expect(() => parseProviderLaunchArgs(`-c model=gpt\\`)).toThrow(ProviderLaunchArgsError);
  });
});

describe("buildCodexAppServerArgs", () => {
  it("spawns a bare app-server when launch args are empty", () => {
    expect(buildCodexAppServerArgs()).toEqual(["app-server"]);
    expect(buildCodexAppServerArgs("")).toEqual(["app-server"]);
  });

  it("inserts global flags before app-server", () => {
    expect(buildCodexAppServerArgs(`-c model_provider="apitoken"`)).toEqual([
      "-c",
      "model_provider=apitoken",
      "app-server",
    ]);
  });

  it("appends tokens after -- to the app-server subcommand", () => {
    expect(buildCodexAppServerArgs(`-c model_provider="apitoken" -- --listen stdio://`)).toEqual([
      "-c",
      "model_provider=apitoken",
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });
});
