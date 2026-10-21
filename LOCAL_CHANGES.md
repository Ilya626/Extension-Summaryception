# Local version 5.5.4-local.13

Based on [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception), commit `6a0afdc`. Distributed at [ilya626/Extension-Summaryception](https://github.com/ilya626/Extension-Summaryception). Manual ST updates use this fork; unattended updates remain disabled.

## local.13 request simplification and addon audit

- Replaced the multi-attempt request loop with one cancellable request. Errors surface immediately. OpenAI's 120-second timeout now measures inactivity: response headers and every incoming stream chunk reset it. There is no total-duration deadline for an active stream. Protocol completion still ends reading without waiting for HTTP EOF.
- Removed global prompt-toggle manipulation from native raw requests. Provider errors inside SSE and JSON replies retain their actual diagnosis.
- Chat changes cancel the active request; source-token planning checks Stop between exchanges. Removed the artificial Stop-button cooldown and the extra token cache; ST owns tokenizer caching.
- Disabling restores automatically hidden messages before removing injected memory, while preserving manual hiding. UI and slash-command Clear share one operation; a context-restoration failure keeps the memory.
- Every completed layer transition is saved immediately. A later refusal or full L4 keeps already completed work and the new L0 summary.
- Foreign imported memories remain available as explicitly unlinked memory after reload; they cannot claim unrelated current-chat messages as sources.
- Memory position has plain English labels, order examples and a direct After the conversation option. Depth and message role are explained separately. No unsupported always-last promise is made.

Verification: all 57 existing tests pass. Mobile Edge and native ST transport verified continuous streaming beyond an accelerated 400 ms inactivity interval, cancellation after silence, one request per operation, unchanged memory after cancellation, and direct provider-error reporting. The production interval remains 120,000 ms. Desktop/mobile placement was inspected visually; native injection used position 1/depth 0. Disabling preserved manual hiding, Clear removed memory, and a foreign import survived reopening the same chat after reload. No new test cases or gating framework were added.

## local.12 finish streaming without waiting for HTTP EOF

The SSE reader previously recognized `[DONE]` and final `finish_reason`, but still awaited the next HTTP read until EOF. A complete response could therefore be discarded by the 120-second timer while its HTTP body remained open. It now stops at `[DONE]`, or after a finish reason and usage; it allows one bounded two-second grace for optional trailing usage and cancels the remaining transport without awaiting shutdown. Keepalive events cannot renew the grace. Partial streams without a completion marker are still rejected. The 120-second request timeout is unchanged.

Verified over real native ST transport with a provider deliberately keeping its body open for ten seconds: the previous reader aborted at a 1.5-second probe deadline despite having the complete response; the corrected reader completed in 124–132 ms and retained 37 provider tokens. Finish reason without usage completed in 2.02 seconds despite periodic keepalives; premature EOF was rejected. All 57 existing tests pass.

## local.11 OpenAI Compatible server transport

OpenAI Compatible no longer sends cloud requests directly from the browser or relies on the optional CORS proxy for local addresses. All requests go through ST's native `/api/backends/chat-completions/generate` Custom backend with this connection's explicit URL, model and key. Streaming, provider usage, cancellation and response limits are preserved. A blank key does not inherit the main Custom API secret.

This fixes providers that reject browser CORS preflights: the previous request never reached ST and repeated without a useful terminal log. Verified using mobile Edge, a real local provider with no CORS headers, and native ST with `enableCorsProxy: false`; direct browser fetch failed, while Regenerate and Force succeeded through ST with the correct key/model and 22 saved output tokens. No browser request interception was used for this check. Stop aborted a delayed request and unlocked deletion; a provider authentication failure retained memory and showed its actual error. All 57 existing tests pass.

The UI now shows the running script version and persistent request stage/error above Snippet Browser. Final errors retain the underlying diagnosis instead of only reporting five exhausted retries. Stop no longer announces that work has finished while an asynchronous step is still active.

## local.10 mobile Regenerate and Refine

Fixed taps being lost when a summary editor had focus. Blurring previously rebuilt the entire snippet browser before the action's click, removing or moving the tapped button. Action buttons now keep focus stable through pointer activation; edits finish before Regenerate, Refine or Delete proceeds, and closing an editor preserves its text click handler and the action nodes. Refine receives the saved edited summary. Unexpected rewrite/edit exceptions produce a visible error.

Verified in mobile Edge at 390x844 and with mouse clicks at 1440x1000 against native ST 1.19.0. Requests retained the configured addon OpenAI endpoint, native ST Custom API URL/model/custom fields/headers, and selected Connection Profile. Model responses were intercepted; no external model calls were made. All 57 existing tests still pass.

## local.9 defaults and native update instructions

New installations default to 12,000 retained raw tokens and 24,000 source tokens per summary; saved user values remain unchanged. Memory-layer capacities and the one-exchange blind zone are unchanged. README documents native Git installation/update from this fork and a one-time migration that preserves chat metadata and settings. The manifest homepage points to this fork. The published distribution includes only the addon, license and documentation.

## local.8 raw-context tokens and protected exchanges

Replaced assistant-turn counters with Retained Raw Context (8,000 tokens) and Source Tokens per Summary (2,000 tokens). ST's current tokenizer counts both sides of complete exchanges; unchanged exchange counts are cached by text and tokenizer model. The newest whole exchanges reaching the retained budget remain raw. Older whole exchanges are packed up to the batch budget; one oversized exchange stays intact. Force can process a partial older batch. Old turn-count values are retained in existing settings but ignored, rather than being misread as token counts.

Blind Zone defaults to one latest completed exchange. It is excluded before counting, threshold calculation and source selection, including Force. It groups consecutive character replies to the same user message together. Trailing unanswered user text is always protected. Automatic hiding and Reapply filter out the protected range; existing automatic ghosts there are restored while manual hiding remains. Changing these settings cancels active processing. Native ST's `isGenerating` prevents processing a chat response that is still in progress.

The token migration also fixes backlog-dialog ownership: a single job lock covers planning and the dialog, chat changes close it, and the original chat/store are checked again after selection. The progress estimate packs whole exchanges instead of dividing token volume alone.

Verification: 57/57 local tests, native ST 1.19.0 with Edge, desktop/mobile controls, protected Force/Reapply and automatic restoration.

## local.7 maintenance fixes

- Injection treats `$&`, dollar-backtick and `$'` in summary text literally instead of interpreting JavaScript replacement expressions.
- Deep manual edits, Regenerate and Refine retain revised compression sources across subsequent promotions. Archived L0 token lineage remains recorded.
- Stop works between catch-up batches, Pause stops the current job, and switching chats prevents catch-up from continuing in the newly opened chat. Manual stopping is reported as a pause rather than a generation failure.
- Clear, import and manual edits share the busy guard already used by delete/Refine. Import validates snippet shape and prepares a draft before replacing memory. In-flight generation also rejects a changed memory store.
- OpenAI/Ollama fetches receive the abort signal, proxy fallback is suppressed after cancellation, and request timeout aborts the previous attempt before retrying. Default uses ST's native stop event.
- Profiles use native extraction for content arrays. Raw Text Completion responses receive the selected instruct preset's native stopping-sequence cleanup while preserving provider usage. Default raw responses use native `cleanUpMessage` like `generateRaw`.
- OpenAI SSE requires a terminal finish reason or `[DONE]`; an interrupted stream is rejected instead of saving its partial text.

Verification: 48/48 tests at this revision. Connection fixes were inspected manually through native ST 1.19.0 in local Edge with intercepted responses.

## Token-based layers

Five layers now use saved output-token counts instead of snippet counts. With total budget B and divisor d, L0 = B / (1 + 1/d + 1/d² + 1/d³ + 1/d⁴); Li = L0/dⁱ. Integer rounding preserves the exact total. The default 15,500-token budget and divisor 2 produce 8,000 / 4,000 / 2,000 / 1,000 / 500 tokens. Advanced Settings exposes the divisor and a checkbox for individual layer-budget overrides.

Active connections use native `generateRawData`; profiles use native `sendRequest` with `extractData: false`. OpenAI streams request the terminal usage chunk, and Ollama preserves `eval_count`. Each summary stores the provider's output-token count, source field and raw usage. Reasoning tokens are not subtracted. Counts are never retokenized after a model change. Missing usage and legacy summaries get one marked estimate using ST's tokenizer, with a character estimate only for older hosts without that API.

When a layer exceeds its budget, the oldest complete summaries covering the excess are summarized into the next layer. There is no free first promotion. Requests use the same normal summarization prompt and configured connection response limit: no extra output-size instruction, ratio check or automatic output ceiling. The divisor controls layer capacities only. Actual returned output size is accepted and counted.

Original L0 texts and counts remain in chat metadata and memory exports, outside the injected context. Deep transitions read these originals rather than repeatedly rewriting an already compressed text. Exact message membership is retained through every merge. Deletion prunes unreferenced originals. Existing deep memories without archived L0 sources are preserved, but compression stops with a migration warning instead of inventing lost originals.

New summaries commit to L0 before any overflow check or promotion request, including their source coverage and normal visibility policy. Compression then operates on the saved memory. A compression refusal, request failure, changed source/store, or L4 overflow stops transfers and retains the saved new summary; the source messages are not summarized again. Catch-up reports the batch as saved and stops. Successful Refine/Regenerate results are also saved before overflow processing. A failure of the initial generation still leaves memory and visibility unchanged. No automatic L4 deletion or additional compression is performed. Manual edits are counted once and can temporarily exceed their layer budget; the next summary request rebalances them. The budget counts stored summary output tokens, excluding prompt wrappers, WI and retained raw chat.

Verification: 42/42 host-API tests at this revision; real local ST 1.19.0 with Edge, native profile requests and intercepted model responses.

## Connection Profiles

Requests go directly through ST's `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, options)`. The previous adapter incorrectly passed `{ignoreInstruct: true}` as the third argument: real ST sent that object as `max_tokens`. The fixed adapter sends a number only when Response Length is greater than zero; zero passes undefined and inherits the saved preset.

ST owns endpoint, model, secret selection, generation preset, instruct formatting and prompt postprocessing. The adapter leaves native preset/instruct defaults enabled, does not switch the main connection, and sends one system message plus one user message. For Text Completion, ST applies the profile's instruct format once. Stop forwards the abort signal to the native profile request.

The profile selector reads ST's live profiles and listens to native creation/update/deletion events. New profiles appear even when the initial list was empty; renaming retains selection; deletion clears only the removed selection. There is no request to the nonexistent `/api/connection-manager/profiles` endpoint.

Provider errors retain their nested `Error.cause` diagnosis and status. A 401 is reported as an authentication error, not guessed to be a deleted profile or a particular historical ST bug. An actually missing profile is detected separately. Unexpected provider errors may still lose details inside ST itself.

This completes the previously queued Connection Profile investigation. Native Chat Completion and Text Completion paths were exercised in isolated ST 1.19.0.

## Language and English UI

The extension UI and built-in instructions are English, including **Refine**. Summary Language defaults to English. The selector also supports Auto, Russian, Chinese, Japanese, Korean, German, French, Spanish, Portuguese, Italian, Ukrainian and an arbitrary language name.

The selected language is appended to the system instruction for every batch, layer compression, regeneration and refinement. Auto adds no language override. Existing/custom prompt text is preserved. Existing memory is not translated until regenerated, refined or compressed. Exact quoted clues and proper names may retain their original spelling. This is a model instruction, not a deterministic translation or language detector.

## Prompt and layer structure

The system message contains archivist instructions and the selected summary language. The user message contains triggered World Info as reference, player name, prior memory, the selected passage and detailed factual requirements. Refine additionally includes the current summary and requests the complete revised memory.

Defaults: retain at least 12,000 source tokens outside a one-exchange blind zone; summarize older source text in whole-exchange batches up to 24,000 tokens; distribute 15,500 saved output tokens across five memory layers using divisor 2. User settings override these token budgets and the blind-zone size.

When a layer overflows, its oldest summaries covering the excess are summarized from their archived L0 originals, with deeper memory as context. This also applies to an empty next layer. Source message membership is carried forward as the union of child sources. Chat injection assembles deeper/older layers first and Layer 0 last; recent messages remain verbatim. No promotion goes beyond L4.

## Exact source membership and Refine

Each new summary stores `sourceMessageIds`, the exact messages submitted as its passage. Messages receive stable `extra.sc_message_id` values saved with the chat. Merged summaries retain the union of message IDs and `sourceSummaryIds` for their children. `turnRange` is descriptive, not the authority for regeneration or coverage.

Snippet Browser expands to show current message numbers and text. Gaps remain explicit, for example `0–1, 3–5`. Index changes and visibility toggles do not change membership. Repeat requests read the current text of the saved sources, including hidden sources; missing sources block the request instead of substituting neighbours. A changed chat, summary or source text during a request causes its result to be discarded. Only summaries with provably earlier source messages enter regeneration's prior context; later memories cannot suppress details as already recorded.

**Refine** sends the same sources plus `existing_summary` and asks for a complete revised memory preserving supported facts and recovering omitted detail. It also works on deeper summaries with known sources. Empty/refusal outputs retain the original summary, links and visibility.

Coverage is checked against surviving source links, including holes before the newest covered index. Deleting a summary releases only messages with no other covering summary. Automatic hiding is removed; manual inclusion/exclusion survives. Deleting a real source message or cutting a branch invalidates dependent summaries; shifting numeric indices alone does not. Explicit backlog skipping is stored separately.

Legacy ranges can only yield approximate membership, visibly marked **recovered from legacy range; verify**. A successful repeat request records exact membership for that request. Old deeper summaries without ranges have unavailable sources and cannot be regenerated/refined by guessing neighbouring messages. While such summaries remain, legacy coverage prevents wholesale accidental reprocessing of old history.

## Native context controls and output validation

Insertion uses ST's native labels and values: None; Before Main Prompt / Story String; After Main Prompt / Story String; In-chat @ Depth, with depth, role and an independent World Info Scan flag.

User/Assistant automatic exclusion is configurable separately. Disable both for manual control. Range controls and native `/hide`/`/unhide` update `message.is_system`. Manual choices are preserved by default. Default-off Reapply overwrites those choices only after a successful new batch, including earlier covered sources. Changing settings, importing, refreshing or refining does not reapply hiding. Clearing memory restores only automatic ghosts.

Summaries preserve concrete actors, actions, objects, quantities, spatial details, exact meaningful dialogue, chronology, knowledge boundaries and unresolved consequences. No 20-phrase cap applies. Only recognized old stock prompts are migrated; custom prompts are retained.

Empty, reasoning-only, recognized textual refusals and exposed provider refusal/content-filter results are rejected. Invalid assistant replies do not count as turns or trigger summaries. Catch-up stops on a failed batch; failed promotion retains its inputs. Textual detection is heuristic (EN/RU/ZH); provider flags already discarded by ST's string/extraction APIs cannot be recovered by the extension.

Native ST hides ordinary messages before attaching normal files, media descriptions and reasoning. Tool invocations can be retained independently. Vector Storage has its own `keep_hidden` setting; Data Bank and independent extensions are separate context sources.

## World Info for summarization

Enabled by default and independent of scanning the memory injection for ordinary chat. Native `checkWorldInfo` handles connected global/character/chat/persona books, key/regex matching, secondary logic, recursion, probability, groups, filters, normal triggers, current sticky/cooldown/delay and ST's WI budget. Match Persona/Character/Scenario flags use the native card fields.

Selected prior memory plus passage form one scan unit, so the ordinary two-message scan depth cannot discard most of a batch. Zero scan depth keeps its native meaning. Blank slots preserve the actual chat clock for timed rules. Unselected messages and live extension injections do not enter scanning.

All WI positions (Before/After, examples, depth, Author's Note and outlets) become a labelled reference block, not ordinary chat messages at those positions. Instructions distinguish lore from witnessed events and character knowledge. Refine also scans its existing summary.

Extension prompts, Author's Note and timed metadata are restored in finally. Forced entries tracked since extension load remain available for the next normal scan. The ordinary generation activation event is not emitted; native scan hooks remain active. A failed WI scan skips the batch with a warning before the model request. WI uses the current ST context budget even with a separate summary connection and consumes additional input tokens.

## Earlier verification

The profile/language/source-membership revision passed **34/34** local tests. The current revision passes **57/57**.

Isolated real ST 1.19.0, release `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, was checked in local Edge at 1440x1000 and 390x844. Model responses were supplied at the HTTP boundary; no external/paid model calls were made. This verifies routing and request instructions, not live model translation quality.

For installation and migration without clearing memory, follow [README.md](README.md). Installing from the upstream GitHub URL does not include this fork's changes.
