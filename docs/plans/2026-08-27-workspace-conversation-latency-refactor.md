# Workspace and Conversation Latency Refactor Plan

## Goal

Make workspace opening and conversation switching feel immediate without weakening Pi Web's identity, integrity, trust, lease, or prompt-delivery guarantees.

The refactor ends at P2. P3 optimizations are explicitly deferred in the conversation Agent Notebook.

## First-principles boundary

Today one operation named "focus conversation" serves two consumers with different observation boundaries:

| Consumer | Safe observation point | Required result |
|---|---|---|
| Browser presentation | after an exact, read-only conversation proof | bounded history and display metadata |
| Agent execution | after writer lease, SessionManager open, role/model/resources, extensions, and AgentSession ownership | executable ConversationActor |

These must become separate phases. A presentation may be shown read-only before execution is ready. Prompt, Stop, role mutation, deletion, and other focus commands still require the exact executable focus identity.

Project integrity proof and repeated use of that proof are also separate concerns. The first complete scan remains fail-closed; later consumers in the same unchanged directory generation must reuse its result rather than repeat equivalent whole-project work.

## Non-negotiable invariants

- `src/shared/protocol.ts` remains the sole wire contract.
- The browser never treats a presentation cache or preview as transcript authority for commands.
- `sessionId + conversationId + focusId` remains the executable focus identity.
- A cold read must not create an AgentSession, load executable project resources, or acquire a writer lease merely to render history.
- Every cold open/delete decision still has a complete, fresh integrity proof. Reuse is allowed only while the controlled directory generation is proven unchanged.
- Project trust is resolved before executable resources load.
- Background actors and runs survive view changes.
- User-owned working-tree changes remain untouched.

## P0 — Establish the observation and remove deterministic stalls

### P0.1 Empty-project transition settlement

Write a failing App integration test for an initialized project with no conversation. Make the no-conversation `focus_attached`/state boundary settle workspace synchronization and expose the role-selection page without waiting for a conversation snapshot that cannot exist.

Acceptance:

- Empty project reaches an interactive role-selection page.
- No stale event from the previous observation can settle the new workspace.
- Existing conversation initialization still waits for its exact conversation snapshot before enabling focus-bound commands.

### P0.2 Transition timing probes

Add a small client-side timing owner for workspace and conversation transitions using `performance.mark/measure` when available. Measure intent-to-attach and intent-to-ready without changing the wire protocol or product state. Tests use an injected/no-op performance surface.

Acceptance:

- One measure is emitted for successful attach and one for ready.
- Cancellation, replacement, and failure clear marks without completing the wrong transition.
- Unsupported Performance APIs are a no-op.

### P0.3 Reconnect scheduling

Replace the unconditional 1200 ms reconnect pause with immediate first retry followed by bounded backoff for repeated failures.

Acceptance:

- First unexpected close retries without a fixed 1200 ms floor.
- Repeated failures do not spin.
- Protocol-fatal close still does not reconnect.

Checkpoint: focused tests, inspect status/diff, commit.

## P1 — Remove server work from the presentation critical path

### P1.1 Verified project catalog generation

Introduce a host-owned verified catalog value containing the complete validated session index plus the controlled session-directory identity set used to prove it. `ProjectStore` publishes a new generation only after the existing full disk/SDK cross-check succeeds.

Consumers may reuse the catalog only after rechecking that the controlled directory identity set has not changed. A mismatch performs a fresh complete scan. Target open still revalidates the exact regular file, header identity, and content before `SessionManager.open()` because the SDK may migrate it.

Acceptance:

- Cold `initialize(recent)` performs one complete catalog scan in the no-mutation case.
- Cold exact open does not repeat the whole disk/SDK scan when the verified generation is unchanged.
- Add/remove/replace/change during or after proof invalidates reuse and fails closed or rescans.
- Corrupt, linked, duplicate, omitted, and identity-changing JSONL cases retain existing rejection behavior.

### P1.2 Read-only conversation presentation

Add a coordinator-owned read path that consumes the verified catalog and projects bounded conversation history/profile without creating `ConversationActor`, `AgentSession`, project model catalog, extension UI route, or writer lease.

Add an explicitly correlated wire event for a read-only presentation. It carries `sessionId + commandId + projectId + conversationId` and is never a focus snapshot. The client may render it while the existing `focus_conversation` command continues toward executable attach.

Acceptance:

- A cold target's history can be displayed before AgentSession creation completes.
- Preview cannot enable prompt, Stop, role changes, truncation, deletion, or settings commands.
- Preview from a cancelled/replaced command is ignored.
- Exact `focus_attached + conversation_snapshot` atomically replaces preview and enables commands.
- A running warm actor continues to use its live actor snapshot; no stale disk preview may overwrite it.

### P1.3 Lazy executable activation

Refactor cold focus into `prepare presentation -> activate actor -> attach focus`, with one singleflight lifecycle owner and unified cleanup. The prepared read value owns no writer resource; activation independently acquires the lease and rechecks its proof before opening.

Acceptance:

- Cancelling during either phase leaks no lease, actor opening, extension route, or waiter.
- Warm actor focus remains direct.
- Cold focus errors leave the previous executable focus valid while removing the target preview.
- Existing ABA, generation, and focus identity tests remain valid.

Checkpoint after each accepted server subtask: focused tests, status/diff, commit.

## P2 — Make the client remain usable during synchronization

### P2.1 Bounded resident presentation store

Replace ad-hoc temporary workspace/conversation presentation fields with one bounded store keyed by `workspaceKey + projectId + conversationId`. Each entry records authority (`preview | snapshot`), chat projection, role/window/control projection, and last access. Snapshot/live updates preserve stable entry identity where values do not change.

The store is display state, not command authority. Drafts, pending commands, focus IDs, and admissions remain outside it.

Acceptance:

- Revisiting one of the retained conversations paints synchronously.
- Correlated read-only presentation upgrades the target entry without hydrating command state.
- Exact snapshot upgrades it to authoritative display and readiness.
- Deletion, invalidation, project mismatch, and bounded eviction remove the correct entries.

### P2.2 Narrow transition locks

Separate transport availability, navigation availability, and executable-focus readiness.

During workspace/conversation synchronization:

- workspace rail and non-destructive conversation navigation remain available;
- displayed history remains scrollable and copyable;
- only prompt, Stop, role/model/context mutation, delete/truncate, and other focus-bound commands are disabled;
- synchronization is not presented as offline.

Acceptance:

- Rapid `A -> B -> C` cancels/replaces pending transitions and ends on C.
- Late preview/attach/snapshot/error from A or B cannot change C.
- Cached/preview content cannot execute commands.
- Sidebar remains navigable during a target transition.

### P2.3 State subscription split

Extract workspace rail/index and focused conversation transition state from the monolithic App render path into external stores/selectors. Memoize sidebar ordering/time formatting so streaming transcript events do not rebuild the entire list.

Acceptance:

- Streaming deltas do not change sidebar row references when list facts are unchanged.
- Workspace activity updates do not rebuild transcript items.
- Existing UI behavior tests remain green.

## Implementation closure

P0–P2 landed on 2026-08-27. Two implementation refinements kept the same observable acceptance criteria with less state duplication:

- P2.3 retains `App` as the state owner and splits React render subscriptions with memoized `WorkspaceRail`, `ConversationSidebar`, and `Chat` boundaries plus commit-safe stable callbacks. Streaming transcript changes therefore do not rebuild navigation, and workspace activity changes do not rebuild transcript items. A second external store was unnecessary for this boundary.
- The workspace rail remains replaceable during workspace initialization. Conversation navigation remains replaceable during conversation focus synchronization, but not before a new workspace has an attached project identity and authoritative conversation index; sending a conversation command across that observation boundary would violate session correlation.

Final audit also closed crash recovery for deletion quarantine, post-unlink replacement proof, superseded cold-opening waits, unstable-open reconnect backoff, and a pre-existing credential reload retirement race exposed by the full gate. None of the deferred P3 work was introduced.

## Documentation and verification

Update the relevant knowledge pages only after behavior lands:

- `.knowledge/kb-client-state.md`
- `.knowledge/kb-server-runtime.md` only if it can be edited without overwriting the user's concurrent change
- `.knowledge/kb-project-sessions.md`
- `.knowledge/kb-wire-protocol.md`

Required final gates:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

WebSocket integration tests must be allowed to bind temporary `127.0.0.1` ports.

## Explicitly deferred P3

Not implemented in this plan: background/hover prefetch, transcript or sidebar virtualization, a deeper keyed-message renderer rewrite, and animation-frame batching of streaming assistant projection. These remain in the conversation Agent Notebook pending post-P2 measurements.
