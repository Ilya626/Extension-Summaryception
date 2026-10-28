# Summaryception for SillyTavern

Maintained fork of [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception), based on upstream commit `6a0afdc`. Version **5.5.4-local.19**. Detailed changes: [LOCAL_CHANGES.md](LOCAL_CHANGES.md).

Summaryception keeps recent chat verbatim and replaces older context with layered memories. **This fork puts more emphasis on concrete RP details, traceable sources and player control.** Its stock prompts ask to preserve who did what, meaningful dialogue, objects, quantities, locations, knowledge boundaries and unresolved consequences. Summarization remains lossy; no prompt can guarantee that every detail survives.

## What changes from the original?

This comparison is against the [upstream version this fork started from](https://github.com/Lodactio/Extension-Summaryception/tree/6a0afdc84fbd8f410db53738fa0f91d6a009eeb6), not a claim about later upstream releases.

| Area | Original at that revision | This fork |
|---|---|---|
| Summary style | Short state changes, at most 20 phrases in one line. | Detailed continuity memories, without the stock 20-phrase cap. Custom prompts are preserved. |
| Raw chat and batch size | Count assistant replies. | Count source tokens, keeping whole user/assistant exchanges together. |
| Recent replies | A retained raw tail. | A retained raw tail **plus a blind zone**: exclude the newest N exchanges from source selection and trigger counting; never automatically hide them. |
| Layer capacity | A limit on the number of snippets per layer. | Five token budgets: by default **8,000 / 4,000 / 2,000 / 1,000 / 500**. Set a total and divisor, or override each layer. |
| Layer transfers | Seed an empty next layer without a model call; later merge summaries from the previous layer. | Every transfer calls the summarizer. Deep transfers use archived **original L0 summaries**, preserving subsequent manual revisions. |
| Repeat requests | Rebuild from a numeric message range. | Save the exact source-message IDs. **Sources** shows them; **Regenerate** reuses them; **Refine** adds the current summary to recover omitted details. |
| Replayed scenes | No source-edit warning. | An expandable warning identifies changed L0 sources after edits or swipes, with a regeneration action. |
| Ghosting | Automatic range hiding with addon ghost markers. | ST's native inclusion/exclusion, separate user/assistant controls, and preserved manual choices. Reapplying the policy is opt-in after a successful new summary. |
| World Info and language | No dedicated passage-triggered WI scan or summary-language selector. | Scan connected WI against the selected passage and prior memory; choose the summary language. UI and stock prompts are English. |
| Connections and failures | Already has connection profiles, several backends and retries. | Correct native profile arguments/preset inheritance, an ST-backed Custom API path, one streaming switch, an inactivity timeout, and immediate error reporting without automatic retries. |

The original's layered-memory idea, Snippet Browser, manual editing, Regenerate, injection preview and memory import/export remain. Connection Profiles are an existing feature whose integration is corrected here.

## Optional World Memory companion

[World Memory](https://github.com/Ilya626/Extension-WorldMemory) builds separate character profiles and reference World Info from saved L0 packets. It uses this fork's connection and source links; it does not replace the narrative summaries or edit the character's original lorebook. Install it separately if you want generated WI. [Russian WI Forms](https://github.com/Ilya626/Extension-RussianWI) lets its ordinary Russian keywords activate on inflected forms.

Version local.19 exposes `SummaryceptionAPI` protocol 1 (saved-packet snapshot, busy state and summarizer connection) and emits `summaryception:memory-changed` after a save. Original L0 archives now retain source IDs/fingerprints for companions. Without a companion installed, the normal summarization workflow is unchanged. Older deep archives may have only their saved summary text available.

## How it works in a chat

Think of the history as **older text eligible for a summary → retained raw tail → protected newest exchanges**.

For example, outside the default one-exchange blind zone, suppose there are 36,000 eligible source tokens and whole-exchange boundaries line up with the budgets. The newest 12,000 stay raw; the older 24,000 become one new L0 summary. The blind exchange stays raw on top of that. Longer exchanges can push these boundaries over the configured amounts.

The new summary is saved **before** checking layer overflow. If L0 then exceeds its 8,000-token budget, its oldest summaries covering the excess are summarized into L1. The same rule applies up to L4. The budgets limit stored memory; **they do not tell the model to "compress to half" or require a particular output length**.

Deeper transfers read the archived L0 **summary texts**, not the entire original chat and not just the latest compressed version. The archive is stored with the chat and exported, but is not injected into ordinary chat context. A failed transfer keeps the already saved memory and warns; a full L4 does not silently delete old memories.

Detailed memories and WI can make requests larger and slower. The memory budget covers saved output tokens in active layers, not the entire model input. Keeping original L0 summaries also increases chat-metadata storage.

See [installation and native updates](#installation-and-native-updates) to switch from upstream without clearing memory. The sections below explain the controls and limitations.

## Raw context and blind zone

Advanced Settings controls both the retained raw tail and the source batch in tokens:

- **Retained Raw Context:** 12,000 tokens by default, measured across user and assistant source text through ST's current tokenizer.
- **Source Tokens per Summary:** 24,000 tokens by default. Automatic generation waits until at least this many older tokens are available outside the retained tail.
- **Blind Zone:** the latest **1 completed exchange** by default. An exchange includes user messages and the following assistant replies, including multiple group replies. Set 0 to disable or increase the number to protect more exchanges.

The blind zone is removed before tokenization and trigger calculation. It contributes no tokens toward a new batch and never enters source selection, even with Force Summarize. An unanswered trailing user message is also protected. Regenerating the newest answer does not advance the token trigger when that exchange is blind. Processing waits while native ST is generating a chat response.

Outside the blind zone, the newest whole exchanges totaling at least the retained budget stay raw. Older whole exchanges form batches up to the source budget. A single oversized exchange is sent whole rather than split; the retained tail can also exceed its budget at an exchange boundary. Force Summarize can process a smaller older remainder but still preserves the retained tail and blind zone. Prior summaries, World Info and instructions are additional prompt tokens. Output-token accounting for memory layers remains separate.

Automatic ghosting cannot hide blind exchanges, including in Reapply mode. Increasing the zone or loading a chat restores any automatic ghosts inside it. Explicit manual hiding remains the user's choice. Changing raw-context settings stops the active summary job before replanning. The former assistant-count settings are no longer used; the new token settings start with the defaults above.

Backlog processing uses source tokens and whole-exchange batches. Only one backlog dialog can be open; switching chats or stopping closes it without processing a different chat.

Existing token settings are preserved on upgrade. Set the two controls explicitly to use the new defaults in an existing installation.

## Installation and native updates

Open **Extensions > Install extension** and paste:

```text
https://github.com/ilya626/Extension-Summaryception
```

Use **Manage extensions > Update** for subsequent versions, then reload the page. Manual updates work with `auto_update: false`; unattended updates remain disabled. ST pulls from the installed repository's `origin` and current branch. The manifest homepage does not select the update source, and the original author's repository does not distribute this fork's changes.

To move an existing installation to this fork, back up ST's user data, remove the old extension through Manage extensions without selecting **Also clean up extension data**, then install the URL above with the same installation target (current user or all users). Keep only one installed copy and reload. Summary memory remains in chat metadata and settings remain under `extensionSettings.summaryception`; ordinary extension deletion only removes the extension directory. Alternatively, change the existing installation's Git `origin` to this fork on the ST host once, then use native Update.

Replacing extension files from a ZIP preserves user data too, but does not change an existing Git `origin` or enable Git updates for a directory without `.git`.

## Memory layer token budgets

Five layers are limited by saved output-token counts, not the number of summaries. Set **Total Memory Budget** in Advanced Settings. The **Layer Divisor** defaults to 2:

`L0 = total / (1 + 1/d + 1/d² + 1/d³ + 1/d⁴)`; `Li = L0 / dⁱ`.

| Layer | Default token budget |
|---|---:|
| L0 | 8,000 |
| L1 | 4,000 |
| L2 | 2,000 |
| L3 | 1,000 |
| L4 | 500 |
| Total | 15,500 |

Check **Override Individual Layer Budgets** to set all five capacities yourself. The displayed total becomes their sum. The divisor determines capacities only: it does not constrain model output or dictate how many summaries enter one request.

New summaries are saved in L0 first, even if this exceeds its budget. Only then does overflow processing start: the oldest complete summaries covering the excess move through a normal summarization request into the next layer. The first transition also calls the model. Every transition uses the normal configured prompts and response limit; no extra output-size instruction or compression ratio is imposed. Actual output size determines whether further transitions are needed.

Provider output counts are saved unchanged with each response, including any reasoning tokens counted by that provider. Changing models does not retokenize existing memory. If an API omits usage, a one-time estimate is saved and marked in Layer Stats. This budget measures saved summary output tokens; retained raw chat, WI and prompt wrappers consume additional context.

Original L0 summaries are archived in chat metadata and exports, outside injected context. Deep transitions use those original texts to avoid repeatedly summarizing only a compressed version. If L4 overflows, transfers stop with a warning. The new summary remains saved, with its source coverage and normal visibility policy applied. Increase the budget or delete a summary to continue. Legacy deep summaries lacking original L0 records remain intact; compression warns rather than pretending their originals are known.

Manual edits, Regenerate and Refine in deeper layers replace the compression source for their own lineage. Later transfers preserve these revisions instead of silently reverting to old L0 text. Original token counts and message membership remain recorded.

## Connections and language

- **Default (Main API)** uses ST's native raw-generation API.
- **Connection Profile** uses ST's native profile service, including its saved endpoint, model, key, preset and instruct formatting. Response Length = 0 inherits the preset.
- **OpenAI Compatible** uses its configured URL, key and model through ST's native Custom backend. Browser CORS and `enableCorsProxy` are not required; ST's main connection/settings are not changed.
- **Ollama** offers a separate endpoint using ST's optional CORS proxy.
- **Summary Language** selects the output language for new summaries, transitions, regeneration and Refine. English is the default; Auto adds no language requirement. Custom prompts are preserved.

The interface and stock prompts are English. World Info uses ST's native trigger scan on the selected passage and prior memory, including recursion. Activated entries from all WI positions are gathered into a labelled **reference block** in the summary request, rather than inserted at their ordinary chat positions. Lore helps interpret events; it is not evidence that an event happened or that a character knows a fact. Temporary scan state, including Author's Note and WI timers, is restored afterward.

**World Info for Summarization > Maximum WI** limits that block to a percentage of **Source Tokens per Summary**. The default is **20%: 4,800 WI tokens with a 24,000-token source budget**. Changing the source budget updates the WI allowance automatically. The allowance includes WI labels and its reference instructions, measured through ST's active tokenizer; it is separate from the source budget and is not a check against the selected API's full context window.

Scanning starts with the newest **selected source message**, expands toward older selected messages, and considers prior memory last. Each growing window uses the native scanner, including matching across messages, recursion, probability, inclusion groups and native per-scan budgets. Whole entries fill the buffer in that order, deduplicated by book and entry ID. Entries that do not fit are omitted, not cut mid-text; smaller later entries can still fit. A nonblocking warning reports partial WI inclusion. Source membership and message visibility do not change because a lore entry was omitted. Layer transfers scan their archived source-summary texts newest first; Regenerate and Refine use their saved source messages. This does not pull live messages from the blind zone into a new batch.

Uncheck **Include triggered World Info in summarizer requests** to skip scanning entirely. The limit field becomes grey and disabled; its value is retained. Ordinary chat World Info settings are independent.

The settings header shows the running script version. A persistent status above Snippet Browser shows preparation, World Info scanning, API waiting, saving and the actual failure message. Each model call is attempted once, without automatic retries; a saved batch can trigger additional calls for layer transfers. Stop cancels the active request; token planning checks cancellation between exchanges. Switching chats also cancels the old operation.

**Advanced Settings > Summarizer Connection > Streaming responses** selects one response mode for Default, Connection Profile, OpenAI Compatible and Ollama. It applies to new summaries, Regenerate, Refine, layer transfers and Test Connection. Off is the default, including after upgrading a version without this control: wait for one complete response. On requests a stream. This changes only addon requests, leaving ST's chat-streaming settings and connection presets intact. The status line names the selected mode. Native ST streaming adapters may omit usage metadata; those results receive the existing marked token estimate. Horde has no streaming backend and continues to use regular responses.

OpenAI streaming finishes at `[DONE]`, or once a final `finish_reason` and usage have arrived. It does not wait for the HTTP connection to close after completion. If usage is omitted after a final finish reason, a single two-second grace permits a trailing usage event; subsequent keepalives do not extend that grace. A stream cut off before a completion marker is rejected. The timeout is 120 seconds without incoming response data: it starts when the request is sent, resets when response headers arrive, then resets on every received stream chunk, including keepalives. An active stream has no total-duration limit.

## Source messages and visibility

Each new summary stores stable IDs for the messages it actually used. **Sources** shows that membership, including gaps. **Regenerate** uses those same messages with their current text; **Refine** supplies them together with the current summary and asks for a complete revision with omitted details. Repeat requests do not substitute neighbouring messages for missing sources.

Older summaries may have only numeric ranges. Recovered membership is labelled approximate until a successful repeat request records its actual sources. Deep legacy summaries without recoverable sources cannot be regenerated by guessing a range.

Deleting a source message or cutting a branch removes summaries that depend on the missing sources and releases their coverage, with a warning. Renumbering surviving messages alone does not invalidate them. Editing text or choosing another swipe instead leaves the summary in place and can show the L0 warning below.

Deleting a summary releases messages with no remaining summary. Automatic hiding is removed from those messages while manual visibility choices are preserved. Automatic inclusion/exclusion uses ST's native `/hide` and `/unhide`; messages remain readable in the chat. User choices are overwritten only after a successful new batch and only if **Reapply Ghosting on New Summary** is checked. Disable both automatic exclusion checkboxes for fully manual control.

Empty outputs, recognized model refusals and exposed provider content-filter responses are rejected. Refusal detection is heuristic, not a guarantee of catching every wording. Invalid assistant replies do not count toward the trigger. Failed initial generation leaves memory and visibility unchanged. Failed compression retains the already saved new summary and stops transfers; it does not delete that summary or request its source messages again.

Memory position uses plain labels and order examples: before system/setup; immediately before the conversation; after the conversation; or inside the conversation at a chosen distance. **Immediately before the conversation** places memory directly before the first retained source message, after the setup and prefix instructions preceding that message. It follows the actual history boundary when ST trims older messages. The former After system/setup selection automatically uses this corrected placement; there is no manual migration. Memory is counted by native ST before context trimming, then positioned through native prompt events. Text Completion retains its instruct formatting. Preset blocks deliberately placed after or inside chat keep their configured positions. After the conversation means depth 0; other extensions or final preset instructions may still follow. ST has no native always-last position. The selected role controls who sends the memory, independently of its position.

## Edited source messages

L0 summaries save compact fingerprints of the source text, speaker name and role submitted for summarization. Editing a linked message or selecting a different swipe shows an expandable warning above the Snippet Browser, listing the changed chat indices. **Regenerate** rebuilds that summary from its saved source membership using the current messages. Successful regeneration or Refine updates the fingerprints; a failed or refused request preserves both the summary and the warning. Reverting the source text clears the warning too. No request runs automatically, and the warning does not block chat or change message visibility.

Only L0 is monitored. Existing summaries without fingerprints start tracking from their first observation after this update; changes made before that point cannot be reconstructed. Message IDs survive ST replacing swipe-specific metadata, so selecting a variant retains its summary links. Fingerprints persist in chat metadata and memory exports.

## Post-History Instructions

Summary requests use the addon's configured system and user prompts, selected sources, prior memory and optional triggered World Info. Native ST does not automatically append preset or character-card Post-History Instructions to these raw/profile requests. This was checked in ST 1.19.0 with actual local-provider payloads for Default, Profile, OpenAI Compatible and Ollama, streaming on and off. Other installed extensions can still modify native raw-generation hooks.

Ordinary ST chat uses a different prompt assembly path: **Prefer character instructions** allows the card's Post-History Instructions to override the preset PHI. Summaryception does not change that preference.

## Compatibility and verification

Validated against SillyTavern 1.19.0. Preserve chat metadata when transferring memory; Export Memory includes source membership, archived originals and token counts.

The local.18 verification recorded 57 passing behavior tests with substituted ST host APIs and model replies. Desktop/mobile Edge checks used native ST with intercepted model responses; native WI checks also exercised the token cap, recent-source priority, recursion and restored scan state. These checks do not establish real-model summary quality. This distribution contains only extension files, license and documentation. Local tests, screenshots, reports, chat data and credentials are not included.

Based on [Lodactio's Summaryception](https://github.com/Lodactio/Extension-Summaryception). Licensed under AGPL-3.0; see [LICENSE](LICENSE).
