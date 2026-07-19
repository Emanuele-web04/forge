// FILE: IntegrationsSettingsSection.tsx
// Purpose: Linear API key + GitHub CLI hint for composer work-item references.
// Layer: Settings UI

import type { ServerSettings } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { DebouncedSettingTextInput } from "~/components/settings/DebouncedSettingTextInput";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";

export function IntegrationsSettingsSection() {
  const queryClient = useQueryClient();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const linearApiKey = serverSettingsQuery.data?.integrations.linearApiKey ?? "";
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const commitLinearApiKey = (value: string) => {
    const latest = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    if (latest) {
      queryClient.setQueryData(serverQueryKeys.settings(), {
        ...latest,
        integrations: { ...latest.integrations, linearApiKey: value },
      });
    }
    void ensureNativeApi()
      .server.updateSettings({ integrations: { linearApiKey: value } })
      .then((next) => {
        queryClient.setQueryData(serverQueryKeys.settings(), next);
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  const checkLinear = async () => {
    setChecking(true);
    setStatusMessage(null);
    try {
      const result = await ensureNativeApi().workItems.authStatus({
        cwd: "/",
        provider: "linear",
      });
      if (result.authStatus === "ready") {
        setStatusMessage("Linear connected.");
      } else {
        setStatusMessage(result.message ?? "Linear is not connected.");
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not check Linear.");
    } finally {
      setChecking(false);
    }
  };

  const checkGitHub = async () => {
    setChecking(true);
    setStatusMessage(null);
    try {
      const result = await ensureNativeApi().workItems.authStatus({
        cwd: "/",
        provider: "github",
      });
      if (result.authStatus === "ready") {
        setStatusMessage("GitHub CLI authenticated.");
      } else {
        setStatusMessage(result.message ?? "GitHub CLI is not ready.");
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not check GitHub CLI.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsSection title="Work item references">
      <SettingsRow
        title="Linear API key"
        description="Used to search and attach Linear issues as composer references. Create a personal API key in Linear → Settings → API."
        control={
          <DebouncedSettingTextInput
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="lin_api_…"
            value={linearApiKey}
            onCommit={commitLinearApiKey}
            aria-label="Linear API key"
            className="w-56"
          />
        }
      />
      <SettingsRow
        title="GitHub CLI"
        description="GitHub issues and PRs use your local `gh` authentication (same as Synara's pull request features). No extra token is stored."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={() => void checkGitHub()}
            >
              Check GitHub
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={checking || linearApiKey.trim().length === 0}
              onClick={() => void checkLinear()}
            >
              Check Linear
            </Button>
          </div>
        }
      />
      {statusMessage ? (
        <p className="text-xs text-muted-foreground" role="status">
          {statusMessage}
        </p>
      ) : null}
    </SettingsSection>
  );
}
