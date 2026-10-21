# Summaryception for SillyTavern

Maintained fork of [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception), based on upstream commit `6a0afdc`. Version **5.5.4-local.10**. Detailed changes: [LOCAL_CHANGES.md](LOCAL_CHANGES.md).

This fork adds token-based context and memory budgets, protected recent exchanges, exact source tracking, Refine, native World Info and Connection Profiles, manual visibility preservation, refusal validation, and English UI with a summary-language selector.

Summaryception records detailed RP memories, links them to their source messages, and injects the retained summaries into SillyTavern. Recent assistant turns remain available verbatim. Summarization is lossy; the prompts ask for concrete actions, dialogue, objects, spatial details, knowledge boundaries and unresolved consequences.

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

Provider output counts are saved unchanged with each response, including any reasoning tokens counted by that provider. Changing models does not retokenize existing memory. If an API omits usage, a one-time estimate is saved and marked in Layer Stats. This budget measures stored summary counts; retained raw chat, WI and prompt wrappers consume additional context.

Original L0 summaries are archived in chat metadata and exports, outside injected context. Deep transitions use those original texts to avoid repeatedly summarizing only a compressed version. If L4 overflows, transfers stop with a warning. The new summary remains saved, with its source coverage and normal visibility policy applied. Increase the budget or delete a summary to continue. Legacy deep summaries lacking original L0 records remain intact; compression warns rather than pretending their originals are known.

Manual edits, Regenerate and Refine in deeper layers replace the compression source for their own lineage. Later transfers preserve these revisions instead of silently reverting to old L0 text. Original token counts and message membership remain recorded.

## Connections and language

- **Default (Main API)** uses ST's native raw-generation API.
- **Connection Profile** uses ST's native profile service, including its saved endpoint, model, key, preset and instruct formatting. Response Length = 0 inherits the preset.
- **Ollama** and **OpenAI Compatible** offer separate endpoints. Local requests use ST's CORS proxy where required.
- **Summary Language** selects the output language for new summaries, transitions, regeneration and Refine. Auto adds no language requirement. Custom prompts are preserved.

The interface and stock prompts are English. World Info uses ST's native trigger scan on the selected passage and prior memory, including recursion and all insertion positions. Temporary scan state is restored afterward.

## Source messages and visibility

Each summary stores stable IDs for the messages it actually used. **Sources** shows that membership. **Regenerate** uses those same messages; **Refine** supplies them together with the current summary and asks for a complete revision with omitted details. Deleted or missing sources are reported, never replaced with a guessed numeric range.

Deleting a summary releases messages with no remaining summary. Automatic hiding is removed from those messages while manual visibility choices are preserved. Automatic inclusion/exclusion uses ST's native `/hide` and `/unhide`. User choices remain until a successful new batch, and are reapplied then only if **Reapply Ghosting on New Summary** is checked.

Empty outputs, model refusals and provider content-filter responses are rejected. Invalid assistant replies do not count toward the trigger. Failed initial generation leaves memory and visibility unchanged. Failed compression retains the already saved new summary and stops transfers; it does not delete that summary or request its source messages again.

Summary insertion uses standard ST positions: None, Before Main Prompt / Story String, After Main Prompt / Story String, or In-chat @ Depth, with role and scan settings.

## Compatibility and verification

Validated against SillyTavern 1.19.0. Preserve chat metadata when transferring memory; Export Memory includes source membership, archived originals and token counts.

All 57 local behavior tests pass. Tests substitute ST host APIs and model replies. Desktop/mobile Edge checks use native ST with intercepted model responses; they do not establish real-model summary quality. This distribution contains only extension files, license and documentation. Local tests, screenshots, reports, chat data and credentials are not included.
