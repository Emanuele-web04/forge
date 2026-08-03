/**
 * WorkItemService - Fetch Linear / GitHub issues and PRs for composer references.
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type {
  WorkItemsAuthStatusInput,
  WorkItemsAuthStatusResult,
  WorkItemsGetInput,
  WorkItemsGetResult,
  WorkItemsSearchInput,
  WorkItemsSearchResult,
  WorkItemsUnavailableError,
} from "@synara/contracts";

export interface WorkItemServiceShape {
  readonly search: (
    input: WorkItemsSearchInput,
  ) => Effect.Effect<WorkItemsSearchResult, WorkItemsUnavailableError>;
  readonly get: (
    input: WorkItemsGetInput,
  ) => Effect.Effect<WorkItemsGetResult, WorkItemsUnavailableError>;
  readonly authStatus: (
    input: WorkItemsAuthStatusInput,
  ) => Effect.Effect<WorkItemsAuthStatusResult, WorkItemsUnavailableError>;
}

export class WorkItemService extends ServiceMap.Service<WorkItemService, WorkItemServiceShape>()(
  "synara/workItems/Services/WorkItemService",
) {}
