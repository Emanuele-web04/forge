// FILE: CortexApiTokensSettingsPanel.tsx
// Purpose: Honest CORTEX Cloud API-token settings boundary. It intentionally exposes no local
//          token state: cloud authentication and the control-plane token API are not live yet.
// Layer: Settings panel

import { CentralIcon } from "~/lib/central-icons";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { SettingsSection, SettingsSectionShell } from "./SettingsPanelPrimitives";

export function CortexApiTokensSettingsPanel({ active }: { readonly active: boolean }) {
  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSectionShell title="CORTEX API tokens">
        <Alert variant="info">
          <CentralIcon name="key" />
          <div>
            <AlertTitle>Private preview</AlertTitle>
            <AlertDescription>
              Cloud API token management will appear here after your organization is authenticated
              by the CORTEX control plane. No token is created, stored, or displayed by this local
              application.
            </AlertDescription>
          </div>
        </Alert>
      </SettingsSectionShell>

      <SettingsSection title="Planned token controls">
        <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-4 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Create a token</p>
              <p className="mt-1 text-muted-foreground">
                Tokens will have a name, explicit scopes, an expiration, and a one-time secret
                display. The raw token will never be recoverable from this page.
              </p>
            </div>
            <Button size="sm" disabled>
              <CentralIcon name="plus" />
              Create token
            </Button>
          </div>
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Initial scopes: <code>cortex.ai.invoke</code>, <code>projects.read</code>,
            <code>projects.write</code>, <code>workspaces.read</code>, <code>workspaces.write</code>,
            <code>repositories.read</code>, <code>repositories.write</code>, <code>tasks.read</code>,
            <code>tasks.write</code>, and <code>organizations.read</code>.
          </p>
        </div>
      </SettingsSection>
    </div>
  );
}
