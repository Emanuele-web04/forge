/**
 * AcpAdapter - Configurable Agent Client Protocol provider.
 *
 * The concrete agent is selected by server settings (`command` + `args`), so
 * adding another standards-compliant ACP agent does not require a Synara build.
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface AcpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "acp";
}

export class AcpAdapter extends ServiceMap.Service<AcpAdapter, AcpAdapterShape>()(
  "synara/provider/Services/AcpAdapter",
) {}
