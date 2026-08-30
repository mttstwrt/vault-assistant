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

- [ ] `props.ts`: `serverContextSize` / `clearPropsCache`, `?model=…&autoload=false`
- [ ] `request.ts`: `cache_n` on `ApiTimings`, `toStats` counts the reused prefix
- [ ] `agent.ts`: `onStats` on `AgentEvents`, reported on both call paths
- [ ] `ui/context-ring.ts`: the dial, thresholds, tooltip
- [ ] `chat-view.ts`: mount it, feed it, reset it with the conversation
- [ ] `styles.css`: `.va-ring`

## QOL-3 — Model selector

- [ ] `models.ts`: `{ id, status? }` entries, session cache, `clearModelCache`
- [ ] `settings.ts`: picker adapts to the richer entries
- [ ] `chat-view.ts`: the dropdown, disabled while busy, re-reads `n_ctx` on change
- [ ] `styles.css`: `.va-model`

## Close-out

- [ ] `npm run lint` and `npm run build`
- [ ] Fold the durable parts into `README.md`, delete `docs/_planning/chat-panel-qol/`
