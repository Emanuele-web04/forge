// Production-component probe; synthetic store ingress, no providers or WebSocket.
// Fixed history and delta cadence PER thread. See concurrent-runner.mjs for paired runs.
import "../src/index.css";
import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { Profiler, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatMarkdown from "../src/components/ChatMarkdown";
import { useChatAutomationSetup } from "../src/components/chat/useChatAutomationSetup";
import { useStore } from "../src/store";
import type { ChatMessage } from "../src/types";
import { createThreadSelector } from "../src/storeSelectors";
import { makeDomainEvent, makeState, makeThread } from "../src/storeTestFixtures";
import { createFrameCollector, frameReport, sleep } from "./metrics";

const params = new URLSearchParams(location.search);
const count = Number(params.get("threads") ?? 5);
const mode = params.get("mode") ?? "hidden";
const panels = Number(params.get("panels") ?? 1);
const STREAM_ID = MessageId.makeUnsafe("stream");
const ids = Array.from({ length: count + panels }, (_, i) => ThreadId.makeUnsafe(`perf-${i}`));
const code = Array.from({ length: 240 }, (_, i) => `const value${i} = { name: "representative", count: ${i} };`).join("\n");
const initialText = `\`\`\`javascript\n${code}\n\`\`\`\n\nStreaming explanation: `;
const state = makeState(makeThread({ id: ids[0]! }));
for (const id of ids) {
  const entry = makeState(makeThread({ id, messages: Array.from<unknown, ChatMessage>({ length: 200 }, (_, i) => ({
    id: MessageId.makeUnsafe(`history-${i}`), role: i % 2 ? "assistant" : "user",
    text: "Settled transcript text. ".repeat(40), createdAt: "2026-09-01T00:00:00Z", streaming: false,
  })).concat([{ id: STREAM_ID, role: "assistant", text: initialText,
    createdAt: "2026-09-01T00:01:00Z", streaming: true }]) }));
  for (const key of Object.keys(entry) as Array<keyof typeof entry>) {
    if (key.endsWith("ById") || key.endsWith("ByThreadId")) Object.assign(state[key]!, entry[key]);
  }
}
state.threadIds = ids;
useStore.setState(state);
const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
let commits = 0;
let renderMs = 0;
let hookRenders = 0;
let removedCodeBlocks = 0;
const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.removedNodes) {
    if (node instanceof Element) removedCodeBlocks += Number(node.matches("pre")) + node.querySelectorAll("pre").length;
  }
});
observer.observe(document.getElementById("root")!, { subtree: true, childList: true });
function Panel({ index }: { index: number }) {
  const id = ids[index]!;
  const thread = useStore(useMemo(() => createThreadSelector(id), [id]));
  const promptRef = useRef("");
  const setup = useChatAutomationSetup({ threadId: id, hasLiveTurn: true, promptRef, setComposerDraftPrompt: () => {} });
  hookRenders++;
  return <section style={{ width: `${100 / panels}%`, height: "100vh", overflow: "auto" }} data-dialog-open={setup.automationDraftOpen}>
    <ChatMarkdown cwd={undefined} text={thread?.messages.at(-1)?.text ?? ""} isStreaming={mode === "visible"} />
  </section>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}>
  <Profiler id="concurrent" onRender={(_id, _phase, duration) => { commits++; renderMs += duration; }}>
    <main style={{ display: "flex" }}>{Array.from({ length: panels }, (_, i) => <Panel key={i} index={i} />)}</main>
  </Profiler>
</QueryClientProvider>);
const frames = createFrameCollector();
let sequence = 1;
async function run(batches = 60) {
  commits = 0; renderMs = 0; hookRenders = 0; removedCodeBlocks = 0;
  const startedAt = performance.now();
  let flushMs = 0;
  const targets = mode === "hidden" ? ids.slice(panels) : ids.slice(0, count);
  const before = targets.map(id => useStore.getState().messageByThreadId?.[id]?.[STREAM_ID]?.text ?? "");
  const chunk = " Additional streamed text with **details** and context. ";
  frames.start();
  for (let batch = 0; batch < batches; batch++) {
    const events = targets.map(id => makeDomainEvent("thread.message-sent", {
      threadId: id, messageId: STREAM_ID, role: "assistant", text: chunk,
      turnId: TurnId.makeUnsafe(`turn-${id}`), streaming: true, source: "native",
      createdAt: "2026-09-01T00:01:00Z", updatedAt: new Date(1788220860000 + sequence).toISOString(),
    }, { sequence: sequence++ }));
    const flushStart = performance.now();
    useStore.getState().applyOrchestrationEventsHotPath(events);
    flushMs += performance.now() - flushStart;
    await sleep(Math.max(0, startedAt + (batch + 1) * 100 - performance.now()));
  }
  await sleep(300); // trailing presentation updates are part of measured work
  return { count, mode, panels, batches, elapsedMs: performance.now() - startedAt, commits, renderMs, hookRenders, removedCodeBlocks, flushMs,
    frames: frameReport(frames.stop()),
    correct: targets.every((id, index) => useStore.getState().messageByThreadId?.[id]?.[STREAM_ID]?.text === before[index] + chunk.repeat(batches)),
  };
}
Object.assign(window, { __synaraConcurrentPerf: { run } });
