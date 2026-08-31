# Attribution

Synara adapts ideas and, occasionally, code from other open-source projects. This file
records the significant ones so credit is visible in one place.

What belongs here:

- Projects whose code, designs, constants, or prose Synara copied or adapted.
- Projects that materially shaped a Synara feature, even when no code was copied.

What does not belong here:

- Ordinary dependencies. `package.json` and `bun.lock` already record those, and each
  package ships its own license.

Attribution complements licenses; it never replaces them. If code or prose is copied or
derived from an MIT/BSD-style project, carry the upstream copyright and permission notice
alongside the copied portions as the license requires. A row in this table is not a
substitute.

## Adapted work

| Project | Author   | Source                           | License | Used in                                                                | Nature                                                                                                    |
| ------- | -------- | -------------------------------- | ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| mind    | Da7-Tech | https://github.com/Da7-Tech/mind | MIT     | Mind memory feature, https://github.com/Emanuele-web04/synara/pull/863 | Adapted in the linked PR. Memory lifecycle concepts, confirm-driven reinforcement, and exponential decay. |

### License notice for mind

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

## Inspiration and reference (no code copied)

| Project      | Author                      | Source                                    | License    | Used in                                                                         | Nature                                                                 |
| ------------ | --------------------------- | ----------------------------------------- | ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| codex        | OpenAI                      | https://github.com/openai/codex           | Apache-2.0 | Codex app-server protocol handling (`apps/server/src/codexAppServerManager.ts`) | Inspired. Protocol and behavior reference.                             |
| CodexMonitor | Thomas Ricouard (Dimillian) | https://github.com/Dimillian/CodexMonitor | MIT        | Agent-session UX flows and operational safeguards                               | Inspired. Reference implementation, per `AGENTS.md` "Reference Repos". |
