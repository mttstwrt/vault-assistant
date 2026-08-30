# Tasks: chat panel quality-of-life

Design: [design.md](design.md) · Requirements: [requirements.md](requirements.md)

Approved 2026-08-30, including the loaded/unloaded marker in §3.

## QOL-1 — Remove the effort selector

- [x] `settings.ts`: drop `ReasoningEffort`, `effortLabel`, the setting and its default
- [x] `request.ts`: drop `CallOverrides.reasoningEffort` and `body.reasoning_effort`
- [x] `chat-view.ts`: drop the selector, its handler and the levels lookup
- [x] `props.ts`: drop the chat-template heuristic (module rewritten in QOL-2)
- [x] `styles.css`: drop `.va-effort`
- [x] `README.md`: effort becomes a future-work note pointing at extra parameters

## QOL-2 — Context usage ring

- [x] `props.ts`: `serverContextSize` / `clearPropsCache`, `?model=…&autoload=false`
- [x] `request.ts`: `cache_n` on `ApiTimings`, `toStats` counts the reused prefix
- [x] `agent.ts`: `onStats` on `AgentEvents`, reported on both call paths
- [x] `ui/context-ring.ts`: the dial, thresholds, tooltip
- [x] `chat-view.ts`: mount it, feed it, reset it with the conversation
- [x] `styles.css`: `.va-ring`

## QOL-3 — Model selector

- [x] `models.ts`: `{ id, status? }` entries, session cache, `clearModelCache`
- [x] `settings.ts`: picker adapts to the richer entries
- [x] `chat-view.ts`: the dropdown, disabled while busy, re-reads `n_ctx` on change
- [x] `styles.css`: `.va-model`

## Close-out

- [x] `npm run lint` and `npm run build`
- [ ] Fold the durable parts into `README.md`, delete `docs/_planning/chat-panel-qol/`
