export const AUTOMATION_NAME_AUTHORING_GUIDANCE =
  'Use a specific 3–8 word outcome label that preserves the target, omits cadence, and is not generic (for example, "Watch PR 142 CI", not "Monitor").';

export const AUTOMATION_PROMPT_AUTHORING_GUIDANCE =
  "Write a self-contained future-run brief with the objective, exact scope, relevant identifiers/paths/URLs, required checks or actions, and explicit notify-versus-silent criteria. Assume no chat context and do not repeat the schedule.";

export const AUTOMATION_AUTHORING_GUIDANCE = `${AUTOMATION_NAME_AUTHORING_GUIDANCE} ${AUTOMATION_PROMPT_AUTHORING_GUIDANCE}`;
