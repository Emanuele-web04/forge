import { Effect, Schema, ServiceMap } from "effect";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@synara/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for ${this.cwd}: ${this.detail}`;
  }
}

export class WorkspaceFileConflictError extends Schema.TaggedErrorClass<WorkspaceFileConflictError>()(
  "WorkspaceFileConflictError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file changed on disk after it was opened. Reload it before saving to avoid overwriting those changes.";
  }
}

export class WorkspaceFileDeletedError extends Schema.TaggedErrorClass<WorkspaceFileDeletedError>()(
  "WorkspaceFileDeletedError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return "This file was removed from disk after it was opened. Reload the Explorer before saving.";
  }
}

export interface WorkspaceFileSystemShape {
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    | WorkspaceFileConflictError
    | WorkspaceFileDeletedError
    | WorkspaceFileSystemError
    | WorkspacePathOutsideRootError
  >;
}

export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("synara/workspace/Services/WorkspaceFileSystem") {}
