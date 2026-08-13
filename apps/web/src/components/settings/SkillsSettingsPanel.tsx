// FILE: SkillsSettingsPanel.tsx
// Purpose: Settings → Skills panel. Lists every skill from the unified cross-provider
// catalog (~/.synara/skills plus each provider's skills folder), shows which provider
// a skill comes from, and lets the user enable/disable each one. Disabled skills are
// hidden from the composer skill picker on every provider.

import type { ProviderKind, ServerSettings } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ProviderIcon } from "~/components/ProviderIcon";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { SkillCubeIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import {
  providerDiscoveryQueryKeys,
  skillsCatalogQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import {
  buildSettingsSkillGroups,
  buildSettingsSkillSections,
  providerDisplayName,
  settingsSkillNameKey,
} from "./skillsSettingsModel";

function SkillProviderStack({ providers }: { providers: ReadonlyArray<ProviderKind> }) {
  if (providers.length === 0) {
    return null;
  }

  const label = providers.map(providerDisplayName).join(", ");
  const stackLabel = `Provider ${providers.length === 1 ? "copy" : "copies"}: ${label}`;
  return (
    <span
      className="inline-flex shrink-0 items-center -space-x-1"
      aria-label={stackLabel}
      title={stackLabel}
    >
      {providers.map((provider) => (
        <span
          key={provider}
          className="inline-flex size-4 items-center justify-center rounded-full border border-background bg-background"
        >
          <ProviderIcon provider={provider} className="size-3" />
        </span>
      ))}
    </span>
  );
}

export function SkillsSettingsPanel() {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery(skillsCatalogQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());

  const disabledSkillNames = new Set(
    (serverSettingsQuery.data?.skills.disabled ?? []).map((name) => settingsSkillNameKey(name)),
  );

  const skillGroups = buildSettingsSkillGroups(catalogQuery.data?.skills ?? []);
  const skillSections = buildSettingsSkillSections(catalogQuery.data?.skills ?? []);

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    // Read through the query cache (not the render closure) so rapid toggles
    // build on each other instead of clobbering the previous patch.
    const latestSettings = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    const currentDisabled = latestSettings?.skills.disabled ?? [...disabledSkillNames];
    const key = settingsSkillNameKey(skillName);
    const next = new Set(currentDisabled.map((name) => settingsSkillNameKey(name)));
    if (enabled) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const disabled = [...next].sort();
    if (latestSettings) {
      // Optimistic flip; a failed patch invalidates back to the server state.
      queryClient.setQueryData(serverQueryKeys.settings(), {
        ...latestSettings,
        skills: { disabled },
      });
    }
    void ensureNativeApi()
      .server.updateSettings({ skills: { disabled } })
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        // Composer skill pickers are served filtered by these toggles.
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  const totalSkills = skillGroups.length;
  const enabledSkills = skillGroups.filter((group) => !disabledSkillNames.has(group.key)).length;
  const synaraSkillsDir = catalogQuery.data?.synaraSkillsDir;

  return (
    <div className="space-y-8">
      <SettingsSection title="Portable skills">
        <SettingsRow
          title="Synara skills folder"
          description="Skills placed here are available on every provider. When a provider already ships its own copy of a skill, that copy is used; otherwise Synara's copy is the fallback."
          status={
            synaraSkillsDir ? (
              <code className="break-all text-[11px] text-muted-foreground">{synaraSkillsDir}</code>
            ) : null
          }
          control={
            <span className="text-xs font-medium text-muted-foreground">
              {catalogQuery.isLoading
                ? "Scanning…"
                : `${enabledSkills} of ${totalSkills} skill${totalSkills === 1 ? "" : "s"} enabled`}
            </span>
          }
        />
      </SettingsSection>

      {catalogQuery.isError ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title="Skill discovery failed"
            description="Synara could not scan the skill folders. Retry after checking that the server is running."
          />
        </SettingsSection>
      ) : null}

      {!catalogQuery.isLoading && !catalogQuery.isError && totalSkills === 0 ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title="No skills found"
            description="Add a skill folder containing a SKILL.md to the Synara skills folder above, or install skills for any supported provider."
          />
        </SettingsSection>
      ) : null}

      {skillSections.map((section) => {
        return (
          <SettingsSection key={section.key} title={section.title}>
            {section.groups.map((group) => {
              const enabled = !disabledSkillNames.has(group.key);
              return (
                <SettingsRow
                  key={group.key}
                  title={
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <SkillCubeIcon
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{group.displayName}</span>
                    </span>
                  }
                  description={group.description}
                  status={
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <SkillProviderStack providers={group.providers} />
                        <span className="truncate text-[11px] text-muted-foreground">
                          {group.sources.map((source) => source.originInfo.label).join(" · ")}
                        </span>
                      </span>
                      {group.sources.map((source) => (
                        <code
                          key={source.skill.path}
                          className="truncate text-[11px] text-muted-foreground"
                        >
                          {source.skill.path}
                        </code>
                      ))}
                    </span>
                  }
                  control={
                    <Switch
                      checked={enabled}
                      onCheckedChange={(checked) =>
                        setSkillEnabled(group.primarySkill.name, Boolean(checked))
                      }
                      aria-label={`Enable the ${group.displayName} skill`}
                    />
                  }
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </div>
  );
}
