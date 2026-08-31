# Plan — Generic file drag & drop attachments (text / PDF / ZIP / any file)

> Executor target: **Codex GPT‑5.5 @ reasoning effort `xhigh`**.
> Do **not** commit. Do **not** push. Leave the working tree dirty for review.
> Gate before finishing: `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` must all pass
> (NEVER run `bun test`). Run them as ONE final verification pass, not repeatedly.

## 1. Goal

Today the composer accepts **image** attachments only (drop/paste). Everything else is
silently dropped (`useComposerDropzone` + `buildComposerImageAttachmentsFromFiles` filter to
`image/*`). We want to drop/paste **any** file (`.txt`, `.md`, `.pdf`, `.zip`, binaries, …),
show a dedicated **file chip**, and deliver the file to the coding agent.

### Delivery model (the core decision — keep it predictable)

Coding agents have filesystem tools. We do **not** inline arbitrary bytes into the model.
The universal, provider‑agnostic v1 behavior is **path reference**:

1. The file is persisted on disk by the server (same on‑disk attachment store images use).
2. The provider prompt gets an appended block listing each attached file with its
   **absolute path**, instructing the agent to read/extract it with its own tools.

Images keep their current native‑multimodal path (server re‑encodes to base64 inline).

Two enrichments are **optional** (Section 7) and only after core is green:
inline‑small‑text and native‑PDF‑for‑Claude.

## 2. Headline risk — agent filesystem access to `attachmentsDir`

`attachmentsDir = join(stateDir, "attachments")` (see `apps/server/src/config.ts:67`) lives in the
**app state dir, outside the project workspace**. Path‑reference only works if the agent can
read that absolute path.

- **Claude Agent SDK (`claudeAgent`)**: Read/Bash generally read any absolute path. Expected OK.
- **Codex app‑server**: runs under a sandbox. `workspace-write`/`read-only` sandboxes normally
  allow filesystem **reads** anywhere and only constrain writes/network, so reading the state dir
  should work — but this MUST be verified.

**Required verification (do this during implementation, before declaring done):** run the app,
drop a small `.zip` and a `.txt`, send a turn to BOTH Claude and Codex asking the agent to read
the attached file, and confirm the agent can open it.

**Fallback if a provider's sandbox blocks the read:** stage the file into a workspace‑relative
dir instead (e.g. `<threadWorkspaceRoot>/.synara/attachments/<id>.<ext>`) and reference that
relative path. Implement the fallback ONLY if verification shows the absolute path is unreadable;
document whichever path is chosen in code comments. Do not pollute the repo unless required.

## 3. Constraints / out of scope (explicit — no silent gaps)

- **No localStorage persistence of file bytes.** Images persist as base64 data URLs in
  localStorage; a 25 MB zip must not. File attachments are **in‑memory only** and are lost on
  reload — the chip MUST show the existing `nonPersisted` warning affordance for every file chip.
- **No server‑side zip extraction** (zip‑bomb / security). The agent extracts on demand.
- **No browser serving of file bytes** (`/attachments/:id`). The file chip is icon‑only, so the
  `resolveAttachmentPathById` fixed‑extension route is NOT involved for files. Do not extend it.
- Combined attachment cap stays `PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8` (images + files + others).

## 4. Maintainability rules (from CLAUDE.md)

- Do NOT duplicate the image pipeline into a parallel file pipeline where logic is shared.
  Extract shared helpers. Specifically:
  - Server normalizer: image + file branches share parse→size‑check→id→resolve→mkdir→write.
    Extract a shared `persistBinaryAttachment(...)` Effect helper.
  - Web: `buildComposerImageAttachmentsFromFiles` and the new file builder share the count/limit
    loop shape — factor the common guard logic.
- `packages/contracts` stays schema‑only (no runtime logic).
- `packages/shared` uses explicit subpath exports (no barrel index).

## 5. Core implementation (REQUIRED)

### 5.1 Contracts — `packages/contracts/src/orchestration.ts`

Around the existing image schemas (lines ~251–316):

- Add constants:
  ```ts
  export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
  const PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS = 35_000_000; // ~base64 of 25MB + header
  ```
- Add **persisted** schema (mirrors `ChatImageAttachment` but `mimeType` is unconstrained and uses
  the file size cap):
  ```ts
  export const ChatFileAttachment = Schema.Struct({
    type: Schema.Literal("file"),
    id: ChatAttachmentId,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)), // no /^image\// constraint
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  });
  export type ChatFileAttachment = typeof ChatFileAttachment.Type;
  ```
  Note: an empty mimeType is possible from the browser for unknown types — default it to
  `application/octet-stream` on the WEB side before upload so `TrimmedNonEmptyString` holds.
- Add **upload** schema:
  ```ts
  const UploadChatFileAttachment = Schema.Struct({
    type: Schema.Literal("file"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
    sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
    dataUrl: TrimmedNonEmptyString.check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS),
    ),
  });
  export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;
  ```
- Add both variants to the unions:
  ```ts
  export const ChatAttachment = Schema.Union([
    ChatImageAttachment,
    ChatFileAttachment,
    ChatAssistantSelectionAttachment,
  ]);
  const UploadChatAttachment = Schema.Union([
    UploadChatImageAttachment,
    UploadChatFileAttachment,
    UploadChatAssistantSelectionAttachment,
  ]);
  ```
  Exhaustiveness across the codebase will now flag every `switch (attachment.type)` /
  `attachment.type === "image"` site — fix each (TypeScript will guide you).

### 5.2 Extension inference — `apps/server/src/imageMime.ts` (or new `apps/server/src/fileMime.ts`)

Add a generic, safe extension resolver used for file attachments:

```ts
export function inferAttachmentExtension(input: { mimeType: string; fileName?: string }): string;
```

Behavior: prefer a sanitized extension from `fileName` (lowercase, `^[a-z0-9]{1,8}$`), else map
from mimeType via `Mime.getExtension`, else `.bin`. Reject path separators / dots in the middle.
Keep image inference (`inferImageExtension`) unchanged; the file path uses the new function.

### 5.3 On‑disk store — `apps/server/src/attachmentStore.ts`

`attachmentRelativePath(attachment)` switch (line ~56) — add:

```ts
case "file": {
  const extension = inferAttachmentExtension({ mimeType: attachment.mimeType, fileName: attachment.name });
  return `${attachment.id}${extension}`;
}
```

Do NOT touch `resolveAttachmentPathById` / `ATTACHMENT_FILENAME_EXTENSIONS` (not used for files;
see §3).

### 5.4 Normalizer — `apps/server/src/orchestration/dispatchCommandNormalization.ts`

- Extract shared `persistBinaryAttachment` helper covering the common image/file steps
  (parse data URL, size check, `createAttachmentId`, `resolveAttachmentPath`, mkdir, writeFile),
  parameterized by `{ type, maxBytes, requireImageMime }`.
- Image branch: keep `requireImageMime: true`, `maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`.
- New `attachment.type === "file"` branch: `requireImageMime: false`,
  `maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES`, persisted shape `{ type: "file", id, name, mimeType, sizeBytes }`.
  Use the parsed data‑url mimeType lowercased; if empty, fall back to `application/octet-stream`.

### 5.5 NEW shared projection — `apps/server/src/provider/attachmentProjection.ts`

Single source of truth for turning non‑native file attachments into prompt text. Pure +
filesystem‑free for v1 (path reference only):

```ts
export function buildFileAttachmentsPromptBlock(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly include: "all-files" | "non-pdf-files"; // Claude handles PDF natively only in §7; v1 use "all-files"
}): string | null;
```

- Filter to `attachment.type === "file"` (and exclude PDFs only if `include === "non-pdf-files"`).
- For each, `resolveAttachmentPath({ attachmentsDir, attachment })` → absolute path; skip (and
  log) any that fail to resolve.
- Return a single block (or `null` if no files), e.g.:
  ```
  <attached_files>
  The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.
  - "data.zip" — application/zip — 4.0 MB — /abs/state/attachments/<id>.zip
  - "notes.md" — text/markdown — 2 KB — /abs/state/attachments/<id>.md
  </attached_files>
  ```
- Reuse an existing human byte formatter if one exists in `packages/shared` (search first);
  otherwise add a tiny local `formatBytes`.

### 5.6 Claude adapter — `apps/server/src/provider/Layers/ClaudeAdapter.ts`

In `buildUserMessageEffect` (line ~852): images unchanged. After the attachment loop, compute
`buildFileAttachmentsPromptBlock({ attachments: input.attachments, attachmentsDir, include: "all-files" })`
and, if non‑null, push a `{ type: "text", text: block }` content block (or append to the leading
text block). Do NOT error on non‑image, non‑file types.

### 5.7 Codex adapter — `apps/server/src/provider/Layers/CodexAdapter.ts`

Two near‑identical blocks: `sendTurn` (line ~1619) and `steerTurn` (line ~1691). In BOTH:
images unchanged (skip non‑image when building `codexAttachments`). Compute the same prompt block
and append it to the prompt input:

```ts
const fileBlock = buildFileAttachmentsPromptBlock({
  attachments: input.attachments,
  attachmentsDir: serverConfig.attachmentsDir,
  include: "all-files",
});
const composedInput = fileBlock
  ? `${input.input ?? ""}${input.input ? "\n\n" : ""}${fileBlock}`
  : input.input;
// then: ...(composedInput !== undefined ? { input: composedInput } : {})
```

Factor the duplicated send/steer composition into a small local helper to avoid drift.

### 5.8 Other providers (Cursor / Gemini / Grok / Kilo / OpenCode / Pi)

Investigate each adapter: do they receive `input.attachments` / forward a prompt string today?

- If an adapter already forwards a prompt string: append the same `buildFileAttachmentsPromptBlock`
  output to it (so files arrive as path references everywhere). Keep it minimal and consistent.
- If an adapter cannot take extra prompt text in v1: `log`/comment the gap explicitly — do NOT
  silently drop files. List any such gaps in the final report.

### 5.9 Web draft store — `apps/web/src/composerDraftStore.ts`

- Add `ComposerFileAttachment` interface:
  ```ts
  export interface ComposerFileAttachment extends Omit<ChatFileAttachment, never> {
    file: File;
  }
  // i.e. { type: "file"; id; name; mimeType; sizeBytes; file: File }  — NO previewUrl, NO persistence
  ```
- Add `files: ComposerFileAttachment[]` to `ComposerThreadDraftState` (line ~355) and to the
  empty/default draft factories. Mark all file ids as non‑persisted (reuse the existing
  `nonPersistedImageIds` pattern or add `nonPersistedFileIds` — prefer a single generalized
  `nonPersistedAttachmentIds` if low‑risk; otherwise mirror images).
- Actions: `addFiles(threadId, files)`, `removeFile(threadId, fileId)`. Dedup with a key like
  `mimeType\u0000sizeBytes\u0000name` (mirror `composerImageDedupKey`).
- **Persistence**: EXCLUDE `files` from all `Persisted*` schemas and from localStorage hydration.
  Do not add files to `PersistedComposerImageAttachment`‑style schemas. On hydration, `files`
  always starts empty.
- `QueuedComposerChatTurn` (line ~119): add in‑memory `files: ComposerFileAttachment[]` so files
  ride along queued turns; EXCLUDE from `PersistedQueuedComposerChatTurn` (consistent: in‑memory only).
- Cleanup: no object URLs to revoke for files (no preview). Ensure reset/clear empties `files`.

### 5.10 Web send helpers — `apps/web/src/lib/composerSend.ts`

- Add `buildComposerFileAttachmentsFromFiles({ files, existingAttachmentCount })` mirroring the
  image builder but: accept ANY type, enforce `PROVIDER_SEND_TURN_MAX_FILE_BYTES`, default empty
  `file.type` to `application/octet-stream`, no `previewUrl`. Share the count/limit guard with the
  image builder via a small helper.
- Extend `buildUploadComposerAttachments` to also map `files` →
  `{ type: "file", name, mimeType, sizeBytes, dataUrl: await readFileAsDataUrl(file) }`.
  Update its input type to include `files`.
- `readFileAsDataUrl` already works for any file (rename its error strings from "image" to
  "file"/"attachment" if shared). Keep behavior generic.

### 5.11 Web dropzone — `apps/web/src/hooks/useComposerDropzone.ts`

- Add `addFiles: (files: readonly File[]) => void` to the hook input.
- `onComposerPaste`: split clipboard files into images (existing `addImages`) and non‑images
  (`addFiles`). `preventDefault` if either set is non‑empty.
- `onComposerDrop`: after the `CHAT_FILE_REFERENCE_DRAG_TYPE` early‑return, split
  `event.dataTransfer.files` into images → `addImages`, rest → `addFiles`.
- `isComposerHandledDrag` already returns true for any `Files` drag — unchanged.

### 5.12 NEW chip — `apps/web/src/components/chat/ComposerFileAttachmentChip.tsx`

Model on `ComposerPastedTextCard` shell (`PastedTextChip.tsx`) — a small horizontal tile, NOT the
64px image thumbnail. Contents: a file‑type icon (derive from extension/mime; reuse `~/lib/icons`),
truncated file name, a secondary line with human size (and ext/type), `AttachmentRemoveButton`,
and the `nonPersisted` amber warning affordance (reuse the tooltip pattern from
`ComposerImageAttachmentChip.tsx`). Memoize. Props: `{ file, nonPersisted, onRemoveFile }`.

### 5.13 Wire chips — `apps/web/src/components/chat/ComposerReferenceAttachments.tsx`

- Add props: `files: ReadonlyArray<ComposerFileAttachment>`, `nonPersistedFileIdSet`,
  `onRemoveFile`.
- Include `files.length` in the empty‑guard.
- Render file chips in the same flex‑wrap row (after pasted texts, before or after images —
  pick a consistent order; suggest: pasted → files → images).

### 5.14 Wire ChatView — `apps/web/src/components/ChatView.tsx`

- Build an `addFiles` callback (uses `buildComposerFileAttachmentsFromFiles` + draft store
  `addFiles`, surfaces the same error toast/inline message the image path uses).
- Pass `addFiles` into `useComposerDropzone`.
- Read `files` + non‑persisted file id set from the draft and pass to
  `ComposerReferenceAttachments` with an `onRemoveFile` handler.
- Include `files` in the send path: pass to `buildUploadComposerAttachments` (line ~6110 area) so
  they go out with `thread.turn.start`. Include `files` when constructing queued turns.
- Find the image size‑limit error UX and mirror it for files (`buildComposerFileAttachmentsFromFiles`
  returns `{ files, error }`).

## 6. Tests (add alongside existing suites; run with `bun run test`)

- contracts: `ChatFileAttachment` / `UploadChatFileAttachment` encode/decode round‑trip; union
  accepts all three variants; oversize `sizeBytes` rejected.
- `attachmentStore`: `attachmentRelativePath` for a `file` attachment (`.zip`, `.md`, unknown→`.bin`);
  `inferAttachmentExtension` cases.
- normalizer (`dispatchCommandNormalization`): persists a file attachment to disk and returns the
  stripped persisted shape; rejects oversize / empty.
- `attachmentProjection`: builds the expected block; returns `null` with no files; excludes images.
- `CodexAdapter.test.ts` / `ClaudeAdapter.test.ts`: a `file` attachment results in the prompt block
  being appended (Codex `input`, Claude text block); images still produce native content.
- web (vitest): `buildComposerFileAttachmentsFromFiles` accepts non‑images, enforces size + the
  shared 8‑attachment cap, defaults empty mime; dropzone routes non‑image drop/paste to `addFiles`.

## 7. OPTIONAL enhancements (only after §5–§6 are fully green; each behind its own commit‑sized change)

1. **Inline small text files.** In `attachmentProjection`, for `file` attachments whose mime/ext is
   text‑like AND `sizeBytes <= 32 * 1024`, read bytes (needs FileSystem in the helper → make an
   Effect variant), decode UTF‑8, and inline as
   `<attached_file name="..." path="...">…</attached_file>` instead of a bare path reference.
2. **Native PDF for Claude.** In the Claude adapter, for `application/pdf` files push a
   `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }` block and
   call the projection with `include: "non-pdf-files"`. Codex keeps PDF as a path reference.

If you implement these, gate them so behavior stays predictable and add focused tests.

## 8. Acceptance checklist

- [ ] Drop/paste of `.txt`, `.md`, `.pdf`, `.zip`, and an unknown‑type binary each create a file chip.
- [ ] File chip shows icon + name + size + remove + non‑persisted warning; removing works; 8‑cap enforced across images+files.
- [ ] Sending delivers files to disk and appends the path‑reference block to the prompt for Claude AND Codex (verified by reading the outgoing payload in tests + a live run).
- [ ] Live verification (§2): Claude and Codex agents can actually open a dropped file from the referenced path; if not, the workspace‑staging fallback is implemented and documented.
- [ ] No file bytes written to localStorage; files cleared on reload (chip warning present).
- [ ] Other providers either receive the block or have a documented, logged gap.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` all pass (one final pass).
- [ ] Working tree left dirty (no commit/push). Final report lists touched files + any gaps/decisions (esp. the §2 path‑access outcome).
