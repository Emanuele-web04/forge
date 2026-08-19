/**
 * CopilotAdapter - Configurable Agent Client Protocol provider.
 *
 * The concrete agent is selected by server settings (`command` + `args`), so
 * adding another standards-compliant ACP agent does not require a Synara build.
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "copilot";
}

export class CopilotAdapter extends ServiceMap.Service<CopilotAdapter, CopilotAdapterShape>()(
  "synara/provider/Services/CopilotAdapter",
) {}
