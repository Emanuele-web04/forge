import type { ProviderMentionReference, ProviderSkillReference } from "@synara/contracts";

export type CodexImageInputItem =
  | { readonly type: "image"; readonly url: string }
  | { readonly type: "localImage"; readonly path: string };

export type CodexTurnInputItem =
  | { readonly type: "text"; readonly text: string; readonly text_elements: [] }
  | CodexImageInputItem
  | { readonly type: "skill"; readonly name: string; readonly path: string }
  | { readonly type: "mention"; readonly name: string; readonly path: string };

export function buildCodexTurnInput(input: {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<CodexImageInputItem>;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
  readonly mentions?: ReadonlyArray<ProviderMentionReference>;
}): CodexTurnInputItem[] {
  const items: CodexTurnInputItem[] = [];
  if (input.input) {
    items.push({
      type: "text",
      text: input.input,
      text_elements: [],
    });
  }
  for (const attachment of input.attachments ?? []) {
    items.push(attachment);
  }
  for (const skill of input.skills ?? []) {
    items.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }
  for (const mention of input.mentions ?? []) {
    items.push({
      type: "mention",
      name: mention.name,
      path: mention.path,
    });
  }
  return items;
}
