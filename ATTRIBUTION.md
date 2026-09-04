# Attribution

Synara adapts ideas and sometimes code from other open source projects. This file credits the ones that shaped a feature.

What belongs here: code, constants, or prose Synara copied or adapted, and features materially shaped with no code copied.

What does not belong here: ordinary dependencies, even large ones (Effect, Pi). `package.json` and `bun.lock` already record those with their licenses.

Credit is not a license notice. If you copy code or prose, carry the upstream notice with it.

<!-- Style: no em dashes in this file. Use commas or colons. -->

## Adapted work (license notice required)

| Project | Author   | Source                           | License | Used in + How                                                                                                                                                                                                         |
| ------- | -------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mind    | Da7-Tech | https://github.com/Da7-Tech/mind | MIT     | Mind memory feature: storage foundation (PR #899: memory tables, scoring constants; upstream snapshot 2026-09-04) and standing-order prose (PR #909). Adapted: scoring constants, near-verbatim standing-order prose. |

### License notice for mind

<!-- DO NOT EDIT below. Byte-match with upstream Da7-Tech/mind LICENSE. Do not move behind a link or details tag. -->

```text
MIT License

Copyright (c) 2026 Da7-Tech

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Inspiration and reference (no code copied, no notice needed)

| Project      | Author                      | Source                                    | License    | Used in + How                                                                                                        |
| ------------ | --------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| codex        | OpenAI                      | https://github.com/openai/codex           | Apache-2.0 | Codex app-server protocol handling (`apps/server/src/codexAppServerManager.ts`). Inspired: protocol reference.       |
| CodexMonitor | Thomas Ricouard (Dimillian) | https://github.com/Dimillian/CodexMonitor | MIT        | Agent-session UX flows and operational safeguards (AGENTS.md "Reference Repos"). Inspired: reference implementation. |
