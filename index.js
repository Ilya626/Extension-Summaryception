/**
 * Summaryception v5.5.4-local.21 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';
import { getModelOutputIssue, requireModelOutput, stripReasoningBlocks, InvalidModelOutputError } from './output-validation.js';
import { syncContextOverrides, recordManualContext, setContextForMessages, applySummaryContextPolicy, restoreAutomaticGhosts } from './context-control.js';
import { collectSummaryWorldInfo, attachSummaryWorldInfo, installWorldInfoTracking, summaryWorldInfoBudget } from './world-info-context.js';
import { planRawContext, blindZoneStart } from './raw-context.js';
import { layerBudgets, layerTokens, countOnce, archiveL0, preserveSourceRevision, pruneArchive, prepareTokenMemory, rebalanceMemory } from './token-memory.js';
import { sourceId, ensureSummarySources, coveredSourceIds, pendingSourceIds, updateSourceBoundary, collectPassage, resolveSnippetSources, mergedSources, newSnippetSources, formatSourceIndices, captureSourceFingerprints, changedL0Sources } from './summary-sources.js';
import { installWorldMemoryBridge } from './world-memory-bridge.js';

const MODULE_NAME = 'summaryception';
const RUNTIME_VERSION = '5.5.4-local.21';
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ═══════════════════════════════════════════════════════════════════════
//  TUNING — Centralised operational constants.
//  Change these instead of hunting through function bodies.
// ═══════════════════════════════════════════════════════════════════════

const TUNING = Object.freeze({
    requestIdleTimeout: 120_000,
    // ── Backlog / Catchup ──────────────────────────────────────────
    backlogMultiplier:        2,        // eligible tokens > batch budget × this triggers catchup dialog

    // ── Event Debouncing ───────────────────────────────────────────
    messageReceivedDelay:     500,      // ms — delay after new message before summarisation check
    chatChangedDelay:         100,      // ms — delay after chat switch before UI refresh
    catchupInterBatchDelay:   200,      // ms — breathing room between catchup batches

    // ── Toast Durations (ms) ───────────────────────────────────────
    // Named by intent so you can tune notification verbosity in one place.
    toastShort:               1_500,
    toastDefault:             2_000,
    toastMedium:              3_000,
    toastLong:                4_000,
    toastLonger:              5_000,
    toastExtended:            6_000,
    toastError:               8_000,

    // ── Connection UI ──────────────────────────────────────────────
    connectionStatusTimeout:  8_000,    // ms — auto-hide the status indicator
});

const LEGACY_DEFAULT_USER_PROMPT = `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`;

const PREVIOUS_DETAIL_REQUIREMENTS = `Track concrete events and state, not a vague synopsis. Preserve:
- Who did exactly what, to whom, in what order, with which object, and the immediate result. Keep proper names, aliases, distinctive descriptions, exact numbers, times, quantities, directions, and named places.
- Physical and spatial details: positions, movement, contact, clothing, equipment, injuries, bodily changes, and relevant sensory observations. Keep explicit details explicit; do not replace them with euphemisms or generic labels.
- Short exact dialogue when its wording carries a clue, promise, threat, condition, password, boundary, or misunderstanding. Attribute speakers and pronouns unambiguously.
- Each character's actual knowledge, observations, beliefs, secrets, motives, and relationship changes. Attribute uncertain claims to their source; do not turn them into established facts or share private knowledge between characters.
- Pending plans, commitments, conflicts, clues, constraints, and consequences. Distinguish an intention or attempt from a completed action, and preserve causal links and chronology.
Never invent events, motives, player actions, resolutions, or missing details. Do not add commentary, moral judgments, disclaimers, or story continuation.
Use concise, specific factual clauses. Remove repetition and ornamental prose, not details needed to reconstruct the scene. There is no fixed phrase-count limit. These rules also apply when compressing existing summaries into deeper layers.`;

const PREVIOUS_DETAIL_PROMPT_HEADER = `<player_name>
{{player_name}}
</player_name>
<prior_context>
{{context_str}}
</prior_context>
<passage_in_question>
{{story_txt}}
</passage_in_question>
Record the new information in passage_in_question that is not already present in prior_context. Retain enough context to identify actors and changes. If prior_context is empty, establish the scene concretely. Second-person 'you' refers to the named player; use that name.`;

const PREVIOUS_PROMPT_PRESETS = {
    narrative: PREVIOUS_DETAIL_PROMPT_HEADER + '\n\n' + PREVIOUS_DETAIL_REQUIREMENTS + '\n\nPreserve the specific actions, exchanges, physical details, emotional evidence, and subtext that make this RP scene distinct. Output only the memory text.',
    gamestate: PREVIOUS_DETAIL_PROMPT_HEADER + '\n\n' + PREVIOUS_DETAIL_REQUIREMENTS + '\n\nAlso preserve exact inventory, resources, stats, rules, cooldowns, quest stages, map locations, interactables, and changes to world state. Output only the memory text.',
};

const DETAIL_REQUIREMENTS = `Write compact continuity memory, not a turn-by-turn retelling.
Combine related actions and dialogue into a connected account of consequential changes: what happened, why it matters, the resulting state, and what remains unresolved. A scene can span many messages; do not give each response its own recap. State each fact once. Omit repeated descriptions, routine gestures, unchanged background and exchanges that add no lasting information.
Preserve the concrete details needed to continue correctly: who acted, meaningful choices and results, causal order, relevant names, places, times, quantities, objects, injuries, clues, commitments and constraints. Keep physical details when they establish identity, a consequential change or a condition that still matters. Quote only short wording whose exact form matters, such as a password, condition or promise; summarize ordinary dialogue.
Keep motives, relationship changes and knowledge boundaries when supported. Attribute uncertain claims and private knowledge. Distinguish intention, attempt and permission from completed action; do not invent player choices, success, explanations or missing facts.
Use prior_context to identify actors and avoid repeating known events; output the new developments, not another copy of prior_context. When the input is earlier summaries, consolidate their overlapping facts and changes by the same rules. Preserve useful specificity without reconstructing every step. Output only the memory, with no commentary or continuation.`;

const DETAIL_PROMPT_HEADER = `<player_name>
{{player_name}}
</player_name>
<prior_context>
{{context_str}}
</prior_context>
<passage_in_question>
{{story_txt}}
</passage_in_question>
Summarize the consequential new developments in passage_in_question for later continuation. If prior_context is empty, briefly establish the scene. Second-person 'you' refers to the named player; use that name.`;

const PROMPT_PRESETS = {
    narrative: DETAIL_PROMPT_HEADER + '\n\n' + DETAIL_REQUIREMENTS + '\n\nWrite short connected paragraphs, grouping developments by scene or consequence rather than by input message.',
    gamestate: DETAIL_PROMPT_HEADER + '\n\n' + DETAIL_REQUIREMENTS + '\n\nAlso retain meaningful changes to inventory, resources, stats, quest stages, locations and world state with their exact values and relevant rules. Consolidate repeated actions; do not reproduce unchanged status sheets.',
    custom: null,
};

const SUMMARY_LANGUAGES = Object.freeze({ en: 'English', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese', it: 'Italian', uk: 'Ukrainian' });

function summaryLanguageInstruction(settings) {
    const language = settings.summaryLanguage === 'custom' ? settings.summaryCustomLanguage.trim()
        : SUMMARY_LANGUAGES[settings.summaryLanguage];
    return language ? `Write the summary in ${language}. Apply this language to new summaries, layer compression, regeneration and refinement, even if the source or existing memory uses another language. Preserve proper names and exact quoted clues in their original form when translation would lose information.` : '';
}

const defaultSettings = Object.freeze({
    enabled: true,
    retainedContextTokens: 12000,
    batchContextTokens: 24000,
    blindZoneExchanges: 1,
    memoryTokenBudget: 15500,
    layerDivisor: 2,
    overrideLayerBudgets: false,
    layerTokenBudgets: [8000, 4000, 2000, 1000, 500],
    // Native ST extension_prompt_types / extension_prompt_roles.
    injectionPosition: 1,
    injectionDepth: 12,
    injectionScan: false,
    summarizerWorldInfo: true,
    summarizerWorldInfoPercent: 20,
    summaryLanguage: 'en',
    summaryCustomLanguage: '',
    injectionRole: 1,
    injectionTemplate: '[Summary of earlier events]\n{{summary}}',
    promptRevision: 3,

    summarizerSystemPrompt:
        'You summarize roleplay for continuity. Consolidate consequential events and current state into compact memory, preserving the concrete facts needed to continue correctly. Do not transcribe or recap every response. Output only the memory text.',

    summarizerUserPrompt: PROMPT_PRESETS.narrative,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    ghostUserMessages: true,
    ghostAssistantMessages: true,
    reapplyGhostingOnSummary: false,

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    debugMode: false,
    traceMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerStreaming: false,          // One request mode for every connection and summary operation.
    summarizerResponseLength: 0,          // 0 = use preset default.
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const LEGACY_PROMPT_PRESETS = {
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the final response instead of 'you'.

IF prior_context has no content: include establishing details in the generated summary, extend the maximum number of short phrases up to 40.

Priority Elements: Time + location changes + narrative themes and subtext + sensory details that establish tone + atmosphere + mood + plot developments + proper names + character motivations + character interactions + dialogue tone + relationship dynamics + emotional beats + unresolved tensions.

Exclude anything insubstantial, fluff, or events already covered in prior_context.

Write in short *phrases* — up to 20; final response must be a single line:`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const needsMigration = !extensionSettings[MODULE_NAME]
        || extensionSettings[MODULE_NAME].promptRevision !== defaultSettings.promptRevision;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    if (!Object.hasOwn(settings, 'ghostUserMessages')) {
        settings.ghostUserMessages = !settings.disableGhosting;
        settings.ghostAssistantMessages = !settings.disableGhosting;
    }
    if (settings.promptRevision !== defaultSettings.promptRevision) {
        const stockPrompts = [LEGACY_DEFAULT_USER_PROMPT, LEGACY_PROMPT_PRESETS.narrative, LEGACY_PROMPT_PRESETS.gamestate,
            PREVIOUS_PROMPT_PRESETS.narrative, PREVIOUS_PROMPT_PRESETS.gamestate];
        if (stockPrompts.includes(settings.summarizerUserPrompt)) {
            settings.summarizerUserPrompt = settings.promptPreset === 'gamestate' ? PROMPT_PRESETS.gamestate : PROMPT_PRESETS.narrative;
        }
        if (['Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',
            'You are a precise RP continuity archivist. Preserve concrete details and factual distinctions, including when compressing earlier memories. Output only the memory text; no preamble or commentary.'].includes(settings.summarizerSystemPrompt)) {
            settings.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        }
        if (settings.injectionTemplate === '\n\n<auto_injected_historical_context>\n[system guidance: this is a historical summary of messages that occurred prior to the oldest assistant message currently in context for this chat]\n{{summary}}\n</auto_injected_historical_context>\n\n') {
            settings.injectionTemplate = defaultSettings.injectionTemplate;
        }
        settings.promptRevision = defaultSettings.promptRevision;
    }
    let defaultsAdded = false;
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
            defaultsAdded = true;
        }
    }
    if (needsMigration || defaultsAdded) SillyTavern.getContext().saveSettingsDebounced();
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],
        };
    }
    const store = chatMetadata[MODULE_NAME];

    // Existing migrations
    if (!Array.isArray(store.layers)) store.layers = [];
    if (!Array.isArray(store.ghostedIndices)) store.ghostedIndices = [];

    // Migrate summarizedUpTo if missing/invalid (e.g. store written by
    // another version of the extension). Comparing against undefined
    // yields NaN → always false → every turn looks "already summarized"
    // while nothing is.
    if (!Number.isInteger(store.summarizedUpTo)) {
        const layer0 = Array.isArray(store.layers[0]) ? store.layers[0] : [];
        const ends = layer0.map(sn => sn?.turnRange?.[1]).filter(Number.isInteger);
        store.summarizedUpTo = ends.length ? Math.max(...ends) : -1;
        log(`Store migration: summarizedUpTo was missing/invalid → derived ${store.summarizedUpTo}`);
    }

    ensureSummarySources(store, SillyTavern.getContext().chat);
    return store;
}

async function saveChatStore() {
    const context = SillyTavern.getContext();
    await context.saveMetadata();
    // Stable source IDs live on the messages, not just in chat metadata.
    await context.saveChat();
    // Companions schedule their own work; WI generation never holds this save open.
    if (globalThis.SummaryceptionAPI && context.eventSource) {
        void context.eventSource.emit('summaryception:memory-changed', { metadata: context.chatMetadata })
            .catch(error => console.error(LOG_PREFIX, 'Companion notification failed:', error));
    }
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    await restoreAutomaticGhosts(chat);
    getChatStore().ghostedIndices = [];
}

async function clearMemory() {
    await unghostAllMessages();
    const store = getChatStore();
    store.layers = [];
    store.l0Archive = {};
    delete store.skippedMessageIds;
    delete store.legacySourceIds;
    store.summarizedUpTo = -1;
    store.ghostedIndices = [];
    await saveChatStore();
    updateInjection();
    updateUI();
}

async function applyGhostingAfterSummary(chat, indices) {
    const settings = getSettings();
    const covered = coveredSourceIds(getChatStore());
    const boundary = blindZoneStart(chat, settings);
    const targets = (settings.reapplyGhostingOnSummary
        ? chat.flatMap((message, index) => covered.has(sourceId(message)) ? [index] : []) : indices)
        .filter(index => index < boundary);
    await applySummaryContextPolicy(chat, settings, targets[0], targets.at(-1), targets);
    await protectBlindZone(chat);
    getChatStore().ghostedIndices = chat.flatMap((message, index) => message.extra?.sc_ghosted ? [index] : []);
}

async function protectBlindZone(chat) {
    if (SillyTavern.getContext().chat !== chat) return;
    syncContextOverrides(chat);
    const boundary = blindZoneStart(chat, getSettings());
    const restore = chat.flatMap((message, index) => index >= boundary && message.extra?.sc_ghosted
        && !message.extra.sc_context?.manual ? [index] : []);
    if (!restore.length) return;
    await setContextForMessages(chat, restore, false);
    if (SillyTavern.getContext().chat !== chat) return;
    getChatStore().ghostedIndices = chat.flatMap((message, index) => message.extra?.sc_ghosted ? [index] : []);
    await saveChatStore();
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Remove summaries with deleted source IDs. Numeric index shifts alone do not
 * invalidate a summary; a branch that drops actual sources does.
 */
async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    if (!chat.length) return;
    const store = getChatStore();
    const previous = coveredSourceIds(store);
    let removed = 0;
    for (const layer of store.layers) {
        if (!layer) continue;
        for (let index = layer.length - 1; index >= 0; index--) {
            const sources = resolveSnippetSources(layer[index], chat);
            if (sources.known && sources.missing) {
                layer.splice(index, 1);
                removed++;
            }
        }
    }
    if (removed) {
        await releaseUncoveredMessages(chat, store, previous);
        toastr.warning(`Removed ${removed} summaries whose linked messages were deleted or are absent in this branch.`, 'Summaryception');
    }
    updateSourceBoundary(store, chat);
    await saveChatStore();
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    return chat.flatMap((message, index) => {
        const isAssistant = !message.is_user && (!message.is_system || message.extra?.sc_ghosted);
        return isAssistant && !getModelOutputIssue(message.mes, message)
            ? [{ index, mes: message.mes, name: message.name || 'Assistant' }] : [];
    });
}

function getPendingAssistantTurns(chat) {
    const covered = pendingSourceIds(getChatStore());
    return getAssistantTurns(chat).filter(turn => !covered.has(sourceId(chat[turn.index])) && !chat[turn.index].is_system);
}

function latestAssistantIssue(chat) {
    const message = chat.findLast(message => !message.is_user && (!message.is_system || message.extra?.sc_context || message.extra?.sc_ghosted));
    return message ? getModelOutputIssue(message.mes, message) : null;
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

// Output cleaning

function cleanSummarizerOutput(raw) {
    let text = stripReasoningBlocks(raw);

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns.filter(Boolean)) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;
let summarizationStopRequested = false;
let cancelCatchupDialog = null;
let isChatGenerating = () => false;
let summaryStatus = { message: 'Ready', state: 'idle' };

function setSummaryStatus(message, state = 'working') {
    summaryStatus = { message, state };
    $('#sc_request_status').text(message).attr('data-state', state);
}

function waitForRequest(request, signal) {
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('Request stopped'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    return Promise.race([request, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

function abortSummarization() {
    summarizationStopRequested = true;
    if (isSummarizing) setSummaryStatus(`Stop requested. Waiting for the active step: ${summaryStatus.message}`, 'warning');
    cancelCatchupDialog?.();
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
}

// ─── Core: LLM Summarization ──────────────────────────────

const sourceMessageTexts = (chat, indices) => indices.map(index => {
    const message = chat[index];
    return `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes?.trim() || ''}`;
});

async function callSummarizer(storyTxt, contextStr, existingSummary = null, sourceMessages = null) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const systemPrompt = [s.summarizerSystemPrompt, summaryLanguageInstruction(s)].filter(Boolean).join('\n\n');

    let prompt = s.summarizerUserPrompt
        .replace('{{player_name}}', () => getPlayerName())
        .replace('{{context_str}}', () => contextStr || '(none yet)')
        .replace('{{story_txt}}', () => storyTxt);
    if (existingSummary !== null) {
        prompt += `\n\n<existing_summary>\n${existingSummary}\n</existing_summary>\nRefine existing_summary using exactly the supplied source messages. Return the COMPLETE revised memory, preserving its supported facts and adding omitted concrete details: actors, actions, objects, exact wording, numbers, positions, chronology, knowledge boundaries and unresolved consequences. Correct unsupported claims using the source. This is not a delta to existing_summary: do not drop its supported facts as already known. Do not invent details or continue the scene. Output only the complete revised memory.`;
    }

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const controller = new AbortController();
    currentAbortController = controller;
    const { signal } = controller;
    if (summarizationStopRequested) controller.abort();
    let phase = 'Summary request';
    let idleTimer;
    let timedOut = false;
    const onActivity = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            timedOut = true;
            controller.abort(new Error('No response data received for 120 seconds'));
        }, TUNING.requestIdleTimeout);
    };
    try {
        signal.throwIfAborted();
        if (s.summarizerWorldInfo) {
            phase = 'World Info scan';
            setSummaryStatus('Scanning World Info.');
            const worldInfo = await collectSummaryWorldInfo(storyTxt, [contextStr, existingSummary].filter(Boolean).join('\n'), {
                maxTokens: summaryWorldInfoBudget(s), sourceMessages, signal,
                onProgress: ({ tokens, limit }) => setSummaryStatus(`Scanning World Info: ${tokens} / ${limit} tokens. Newest sources first.`),
                onComplete: ({ tokens, limit, partial }) => {
                    if (partial) toastr.warning(`World Info was partially included (${tokens} / ${limit} tokens). Entries that did not fit were left out; source messages are unchanged.`, 'Summaryception');
                },
            });
            prompt = attachSummaryWorldInfo(prompt, worldInfo);
        }
        signal.throwIfAborted();
        phase = 'Summary request';
        setSummaryStatus(`Waiting for ${getConnectionDisplayName(s)}. ${s.summarizerStreaming ? 'Streaming' : 'Regular'} request. Timeout: 120s without response data.`);
        onActivity();
        const result = await waitForRequest(sendSummarizerRequest(s, systemPrompt, prompt, { signal, returnDetails: true, onActivity }), signal);
        clearTimeout(idleTimer);
        signal.throwIfAborted();
        const text = cleanSummarizerOutput(result.text || '');
        requireModelOutput(text);
        phase = 'Summary token count';
        setSummaryStatus('Response received. Counting summary output tokens.');
        const summary = await countOnce({ ...result, text });
        signal.throwIfAborted();
        return summary;
    } catch (error) {
        if (timedOut) {
            setSummaryStatus(error.message, 'error');
            toastr.error(`${error.message}. Memory was kept.`, 'Summaryception');
        } else if (signal.aborted || error.name === 'AbortError') {
            setSummaryStatus('Stopped. No summary result was applied.', 'idle');
        } else if (error instanceof InvalidModelOutputError) {
            setSummaryStatus(`Summary rejected: ${error.message}`, 'error');
            toastr.warning(`Summary rejected: ${error.message}. Memory and message context were kept.`, 'Summaryception', { timeOut: TUNING.toastError });
        } else {
            const message = `${phase} failed: ${error.message || String(error)}`;
            setSummaryStatus(message, 'error');
            console.error(LOG_PREFIX, message, error);
            toastr.error(`${message}. Memory was kept.`, 'Summaryception', { timeOut: TUNING.toastError });
        }
        return '';
    } finally {
        clearTimeout(idleTimer);
        if (currentAbortController === controller) currentAbortController = null;
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const settings = getSettings();
    if (!settings.enabled || settings.pauseSummarization || isSummarizing || isChatGenerating()) return;
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    if (latestAssistantIssue(chat)) return;
    isSummarizing = true;
    summarizationStopRequested = false;
    let repeat = false;
    try {
        setSummaryStatus('Preparing message context and counting source tokens.');
        syncContextOverrides(chat);
        await protectBlindZone(chat);
        const plan = await planRawContext(chat, store, settings, () => summarizationStopRequested);
        if (!plan.ready || summarizationStopRequested || isChatGenerating() || SillyTavern.getContext().chat !== chat || getChatStore() !== store) return;
        if (plan.availableTokens > plan.batchBudget * TUNING.backlogMultiplier && !catchupDismissed) {
            const choice = await showCatchupDialog(plan.availableTokens, plan.batchCount);
            if (SillyTavern.getContext().chat !== chat || getChatStore() !== store || summarizationStopRequested) return;
            if (choice === 'skip') {
                const current = await planRawContext(chat, store, getSettings(), () => summarizationStopRequested);
                if (SillyTavern.getContext().chat !== chat || summarizationStopRequested) return;
                store.skippedMessageIds = [...new Set([...(store.skippedMessageIds || []), ...current.availableMessageIds])];
                updateSourceBoundary(store, chat);
                catchupDismissed = true;
                await saveChatStore();
            } else if (choice === 'catchup') await runCatchup();
            else if (choice === 'partial') await summarizeOneBatchFromTurns();
            return;
        }
        repeat = await summarizeOneBatchFromTurns() === true && !summarizationStopRequested;
    } finally {
        isSummarizing = false;
    }
    if (repeat && SillyTavern.getContext().chat === chat) await maybeSummarizeTurns();
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch() {
    summarizationStopRequested = false;
    isSummarizing = true;
    try {
        return await summarizeOneBatchFromTurns();
    } finally {
        isSummarizing = false;
    }
}

async function summarizeOneBatchFromTurns() {
    if (isChatGenerating()) return false;
    const settings = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    setSummaryStatus('Preparing message context and counting source tokens.');
    syncContextOverrides(chat);
    await protectBlindZone(chat);
    const plan = await planRawContext(chat, store, settings, () => summarizationStopRequested);
    if (!plan.hasBatch || summarizationStopRequested || isChatGenerating() || SillyTavern.getContext().chat !== chat || getChatStore() !== store) return false;
    const passage = plan.passage;
    const startIndex = passage.indices[0];
    const endIndex = passage.indices.at(-1);
    if (!passage.text.trim()) {
        toastr.warning('No valid source text. Memory and message context were kept.', 'Summaryception');
        return false;
    }
    try {
        const memoryBefore = JSON.stringify(store);
        const summary = await callSummarizer(passage.text, buildFullContext(0), null, sourceMessageTexts(chat, passage.indices));
        if (!summary) return false;
        if (SillyTavern.getContext().chat !== chat || getChatStore() !== store
            || JSON.stringify(store) !== memoryBefore || resolveSnippetSources(passage, chat).text !== passage.text
            || passage.indices.some(index => index >= blindZoneStart(chat, getSettings()))) {
            toastr.warning('Chat or memory changed during summarization. Result discarded.', 'Summaryception');
            return false;
        }
        store.layers[0] ??= [];
        const snippet = { ...summary, ...newSnippetSources(passage), turnRange: [startIndex, endIndex], timestamp: Date.now() };
        store.layers[0].push(snippet);
        setSummaryStatus('Saving the summary and updating message context.');
        archiveL0(store, snippet);
        updateSourceBoundary(store, chat);
        await saveChatStore();
        await applyGhostingAfterSummary(chat, passage.indices);
        await SillyTavern.getContext().saveChat();
        updateInjection();
        if (!await maybePromoteLayer()) return 'saved-promotion-stopped';
        setSummaryStatus('Summary saved.', 'success');
        updateInjection();
        return true;
    } catch (error) {
        console.error(LOG_PREFIX, 'Summary batch failed:', error);
        toastr.error('Batch stopped: ' + error.message, 'Summaryception', { timeOut: TUNING.toastError });
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup() {
    isSummarizing = true;
    try { return await runCatchupLoop(); }
    finally { isSummarizing = false; }
}

async function runCatchupLoop() {
    summarizationStopRequested = false;
    const startingChat = SillyTavern.getContext().chat;
    const startingStore = getChatStore();

    trace('>>> ENTERING runCatchup');

    const s = getSettings();
    const initialPlan = await planRawContext(startingChat, startingStore, s, () => summarizationStopRequested);
    const totalBatches = Math.max(1, initialPlan.batchCount);
    let completed = 0;
    let failed = 0;
    let promotionStopped = false;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            if (summarizationStopRequested || isChatGenerating() || chat !== startingChat || getChatStore() !== startingStore) {
                cancelled = true;
                break;
            }
            const plan = await planRawContext(chat, startingStore, getSettings(), () => summarizationStopRequested);
            if (!plan.hasBatch) break;
            if (summarizationStopRequested || SillyTavern.getContext().chat !== startingChat) { cancelled = true; break; }
            const result = await summarizeOneBatchFromTurns();

            if (result === true) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
            } else if (result === 'saved-promotion-stopped') {
                completed++;
                if (summarizationStopRequested) cancelled = true;
                else promotionStopped = true;
                break;
            } else {
                if (summarizationStopRequested) { cancelled = true; break; }
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;

                break;
            }

            const pct = Math.min(100, Math.round((completed / totalBatches) * 100));
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, TUNING.catchupInterBatchDelay));
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Saved progress retained.`,
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else if (promotionStopped) {
            toastr.warning(`Saved ${completed} batches. Layer transfer stopped; the latest summary remains saved.`, 'Summaryception', { timeOut: TUNING.toastLong });
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: TUNING.toastLong }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: TUNING.toastExtended }
            );
        }

        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} eligible source tokens</strong>
        in this chat (outside the retained token budget and blind zone).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Process these ${overflowCount} source tokens — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Process up to ${s.batchContextTokens} source tokens now, keeping whole exchanges</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);
        const finish = choice => {
            overlay.remove();
            cancelCatchupDialog = null;
            resolve(choice);
        };
        cancelCatchupDialog = () => finish('cancel');
        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => finish('catchup'));
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => finish('skip'));
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => finish('partial'));
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function commitBalancedMemory(store, draft, before, chat) {
    const commit = async () => {
        if (getChatStore() !== store || SillyTavern.getContext().chat !== chat || JSON.stringify(store) !== before) {
            throw new Error('Chat or memory changed during compression. Result discarded.');
        }
        store.layers = structuredClone(draft.layers);
        store.l0Archive = structuredClone(draft.l0Archive);
        before = JSON.stringify(store);
        await saveChatStore();
    };
    try {
        await rebalanceMemory(draft, getSettings(), callSummarizer, mergedSources, commit);
        await commit();
        return true;
    } catch (error) {
        toastr.warning(error.message, 'Summaryception', { timeOut: TUNING.toastError });
        return false;
    }
}

async function maybePromoteLayer() {
    const store = getChatStore();
    const before = JSON.stringify(store);
    return commitBalancedMemory(store, structuredClone(store), before, SillyTavern.getContext().chat);
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) return '';

    const snippets = [];

    for (let i = store.layers.length - 1; i >= 1; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            snippets.push(sn.text);
        }
    }

    if (store.layers[0] && store.layers[0].length > 0) {
        for (const sn of store.layers[0]) {
            snippets.push(sn.text);
        }
    }

    if (snippets.length === 0) return '';

    return s.injectionTemplate.replace('{{summary}}', () => snippets.join(' '));
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjection = '';
const STORY_MEMORY_START = '<summaryception_story_memory>';
const STORY_MEMORY_END = '</summaryception_story_memory>';
let promptSourceChat = null;

// ST supplies its processed source messages before formatting and truncation.
// Keep the reference; do not edit the chat or the other interceptors' results.
globalThis.summaryceptionCapturePromptSources = chat => { promptSourceChat = chat; };

function updateInjection() {
    try {
        const { setExtensionPrompt, mainApi } = SillyTavern.getContext();
        const settings = getSettings();
        let text = settings.enabled ? (globalThis.SummaryceptionAPI?.historyText?.() || assembleSummaryBlock()) : '';
        const beforeChat = settings.injectionPosition === 0;
        if (beforeChat && text) text = `${STORY_MEMORY_START}\n${text}\n${STORY_MEMORY_END}`;
        // CC counts memory at depth 0 before trimming history; the ready event
        // moves that already-budgeted block to the retained history boundary.
        // TC preallocates in-chat injections, including those before all chat.
        const position = beforeChat ? 1 : settings.injectionPosition;
        const depth = beforeChat ? (mainApi === 'openai' ? 0 : 10000) : settings.injectionDepth;
        const args = [text, position, depth, settings.injectionScan, settings.injectionRole];
        const signature = JSON.stringify(args);
        if (signature === _lastInjection) return;
        setExtensionPrompt(MODULE_NAME, ...args);
        _lastInjection = signature;
    } catch (error) {
        console.error(LOG_PREFIX, 'Could not update summary injection:', error);
    }
}

async function placeMemoryBeforeChat({ chat }) {
    if (!Array.isArray(chat)) return;
    const sourceIndex = chat.findIndex(message => typeof message.content === 'string' && message.content.includes(STORY_MEMORY_START));
    if (sourceIndex < 0) return; // Raw/profile summarization requests have no memory injection.
    const { promptManager, setOpenAIMessages } = await import('/scripts/openai.js');
    const nativeMessages = promptManager.messages.flatten().filter(message => message.content || message.tool_calls);
    const context = SillyTavern.getContext();
    const sources = setOpenAIMessages(promptSourceChat || context.chat.filter(message => !message.is_system));
    const sourceText = new Set(sources.map(message => `${message.role}\0${context.substituteParams(message.content)}`));
    const textContent = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    let boundaryOffset = 0;
    const boundary = nativeMessages.find(message => {
        if (!/^(?:chatHistory-|toolCall-chatHistory-|continuePrefill)/.test(message.identifier)) return false;
        const text = textContent(message.content);
        if (sourceText.has(`${message.role}\0${text}`) || message.tool_calls) return true;
        // ST can squash a narrator message together with a leading system note.
        if (message.role !== 'system') return false;
        const offsets = sources.filter(source => source.role === 'system' && source.content)
            .map(source => text.indexOf(context.substituteParams(source.content))).filter(offset => offset >= 0);
        if (!offsets.length) return false;
        boundaryOffset = Math.min(...offsets);
        return true;
    })
        || nativeMessages.find(message => message.identifier === 'newMainChat');
    let insertionIndex = boundary ? chat.findIndex(message => message.role === boundary.role && message.content === boundary.content) : chat.length;
    if (insertionIndex < 0) insertionIndex = chat.length;
    else if (boundary.identifier === 'newMainChat') insertionIndex++;
    const source = chat[sourceIndex];
    const start = source.content.indexOf(STORY_MEMORY_START);
    const end = source.content.indexOf(STORY_MEMORY_END, start);
    if (end < 0) return;
    const memory = source.content.slice(start + STORY_MEMORY_START.length, end).trim();
    const remainder = (source.content.slice(0, start) + source.content.slice(end + STORY_MEMORY_END.length)).trim();
    if (remainder) source.content = remainder;
    else {
        chat.splice(sourceIndex, 1);
        if (sourceIndex < insertionIndex) insertionIndex--;
    }
    if (boundaryOffset > 0) {
        const message = chat[insertionIndex];
        const prefix = message.content.slice(0, boundaryOffset).trimEnd();
        message.content = message.content.slice(boundaryOffset).trimStart();
        chat.splice(insertionIndex++, 0, { role: 'system', content: prefix });
    }
    chat.splice(insertionIndex, 0, { role: ['system', 'user', 'assistant'][getSettings().injectionRole], content: memory });
}

function placeTextMemoryBeforeChat({ finalMesSend }) {
    if (!Array.isArray(finalMesSend)) return;
    const index = finalMesSend.findIndex(message => message.injected && message.message.includes(STORY_MEMORY_START));
    if (index < 0) return;
    // Move the formatted, budgeted injection intact; preserve instruct syntax.
    const [memory] = finalMesSend.splice(index, 1);
    memory.message = memory.message.replace(STORY_MEMORY_START, '').replace(STORY_MEMORY_END, '');
    const boundary = finalMesSend.findIndex(message => !message.injected);
    finalMesSend.splice(boundary < 0 ? finalMesSend.length : boundary, 0, memory);
}

// ─── Event Handlers ──────────────────────────────────────────────────

const rejectedReplyWarnings = new WeakMap();
const sourceChangeNotices = new WeakMap();
let sourceChangeTimer;

function updateSourceWarning(notify = false) {
    const store = getChatStore();
    const { chat } = SillyTavern.getContext();
    const changes = changedL0Sources(store, chat);
    const warning = $('#sc_l0_source_warning');
    warning.prop('hidden', !changes.length);
    warning.find('summary').text(`Chat edits affect ${changes.length} L0 ${changes.length === 1 ? 'summary' : 'summaries'}`);
    warning.find('.sc-source-change-content').html(changes.map(({ snippetIndex, indices }) =>
        `<div class="sc-source-change-item"><span>L0 #${snippetIndex + 1}: messages ${formatSourceIndices(indices)} changed. This memory may describe their previous version.</span><button class="sc-source-regenerate menu_button" data-idx="${snippetIndex}">Regenerate</button></div>`
    ).join(''));
    warning.find('.sc-source-regenerate').on('click', function () {
        // Reuse the browser action, including saving an active inline edit.
        $(`#sc_snippet_browser .sc-snippet[data-layer="0"][data-idx="${Number($(this).data('idx'))}"] .sc-snippet-redo`).trigger('click');
    });
    const signature = changes.map(({ snippet, indices }) => snippet.id + ':'
        + JSON.stringify(captureSourceFingerprints(chat, indices.map(index => sourceId(chat[index]))))).join('|');
    if (notify && signature && sourceChangeNotices.get(store) !== signature) {
        toastr.warning('Summarized messages were edited. Open Summaryception → Snippet Browser to review and regenerate the affected L0 summaries.', 'Summaryception', { timeOut: TUNING.toastError });
    }
    if (notify || !signature) sourceChangeNotices.set(store, signature);
}

function onSourceMessagesChanged() {
    clearTimeout(sourceChangeTimer);
    const { chat } = SillyTavern.getContext();
    sourceChangeTimer = setTimeout(() => {
        if (SillyTavern.getContext().chat === chat && !isChatGenerating()) updateSourceWarning(true);
    }, TUNING.messageReceivedDelay);
}

function onMessageReceived(messageIndex) {
    if (!getSettings().enabled) return;
    const { chat } = SillyTavern.getContext();
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) return;
    const issue = getModelOutputIssue(message.mes, message);
    if (issue) {
        if (!rejectedReplyWarnings.has(message) || rejectedReplyWarnings.get(message) !== message.mes) {
            rejectedReplyWarnings.set(message, message.mes);
            toastr.warning('Assistant reply ignored by Summaryception: ' + issue + '. It does not count as a turn or trigger summarization.', 'Summaryception', { timeOut: TUNING.toastError });
        }
        return;
    }
    syncContextOverrides(chat);
    setTimeout(async () => {
        if (SillyTavern.getContext().chat !== chat || chat[messageIndex] !== message) return;
        if (getModelOutputIssue(message.mes, message) || latestAssistantIssue(chat)) return;
        await maybeSummarizeTurns();
        updateInjection();
        updateUI();
    }, TUNING.messageReceivedDelay);
}

function onChatChanged() {
    promptSourceChat = null;
    if (isSummarizing || currentAbortController) abortSummarization();
    cancelCatchupDialog?.();
    catchupDismissed = false;
    _lastInjection = '';
    const { chat } = SillyTavern.getContext();
    syncContextOverrides(chat);
    setTimeout(async () => {
        if (SillyTavern.getContext().chat !== chat) return;
        await repairIfBranched();
        await protectBlindZone(chat);
        await hydrateTokenCounts();
        updateInjection();
        updateUI();
        updateSourceWarning(true);
    }, TUNING.chatChangedDelay);
}

async function hydrateTokenCounts() {
    const store = getChatStore();
    const before = JSON.stringify(store);
    const draft = structuredClone(store);
    await prepareTokenMemory(draft);
    if (getChatStore() === store && JSON.stringify(store) === before) {
        store.layers = draft.layers;
        store.l0Archive = draft.l0Archive;
        if (JSON.stringify(store) !== before) await saveChatStore();
    }
}

function onGenerationStarted() {
    promptSourceChat = null;
    syncContextOverrides(SillyTavern.getContext().chat);
    updateInjection();
}

function onGenerationEnded() {
    onSourceMessagesChanged();
    const { chat } = SillyTavern.getContext();
    const index = chat.findLastIndex(message => !message.is_user && !message.is_system);
    if (index >= 0) onMessageReceived(index);
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Newest covered index: ${store.summarizedUpTo}`);
                lines.push(`Linked source messages: ${coveredSourceIds(store).size}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${layerTokens(l)} / ${layerBudgets(getSettings())[i] ?? 'legacy'} tokens (${l.length} summaries)`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                if (!canModifyMemory()) return 'Stop the current summary request before clearing memory.';
                await clearMemory();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI({ refreshSnippets = true } = {}) {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_ghost_user_messages').prop('checked', s.ghostUserMessages);
        $('#sc_ghost_assistant_messages').prop('checked', s.ghostAssistantMessages);
        $('#sc_reapply_ghosting').prop('checked', s.reapplyGhostingOnSummary);
        $('#sc_injection_position').val(s.injectionPosition === 1 && s.injectionDepth === 0 ? 'chat_end' : s.injectionPosition);
        $('#sc_injection_depth_controls').toggle(s.injectionPosition === 1 && s.injectionDepth !== 0);
        $('#sc_injection_depth').val(s.injectionDepth).prop('disabled', s.injectionPosition !== 1);
        $('#sc_injection_role').val(s.injectionRole).prop('disabled', s.injectionPosition !== 0 && s.injectionPosition !== 1);
        $('#sc_injection_scan').prop('checked', s.injectionScan);
        $('#sc_summarizer_world_info').prop('checked', s.summarizerWorldInfo);
        $('#sc_summarizer_world_info_percent').val(s.summarizerWorldInfoPercent).prop('disabled', !s.summarizerWorldInfo);
        $('#sc_world_info_budget_controls').toggleClass('sc-disabled', !s.summarizerWorldInfo);
        $('#sc_world_info_budget_tokens').text(`${summaryWorldInfoBudget(s).toLocaleString()} tokens maximum at ${s.batchContextTokens.toLocaleString()} source tokens per summary.`);
        $('#sc_summary_language').val(s.summaryLanguage);
        $('#sc_summary_custom_language').val(s.summaryCustomLanguage).toggle(s.summaryLanguage === 'custom');
        $('#sc_retained_context_tokens').val(s.retainedContextTokens);
        $('#sc_batch_context_tokens').val(s.batchContextTokens);
        $('#sc_blind_zone_exchanges').val(s.blindZoneExchanges);
        const budgets = layerBudgets(s);
        $('#sc_memory_token_budget').val(s.memoryTokenBudget).prop('disabled', s.overrideLayerBudgets);
        $('#sc_layer_divisor').val(s.layerDivisor);
        $('#sc_override_layer_budgets').prop('checked', s.overrideLayerBudgets);
        for (let i = 0; i < 5; i++) $('#sc_layer_budget_' + i).val(budgets[i]).prop('disabled', !s.overrideLayerBudgets);
        $('#sc_budget_total').text('Total: ' + budgets.reduce((a, b) => a + b, 0) + ' tokens across L0–L4.');
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        // ── Prompt preset migration & sync ──
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);
        $('#summaryception_streaming').prop('checked', s.summarizerStreaming);

        const { chat } = SillyTavern.getContext();
        const hiddenCount = chat.filter(message => message.is_system && message.extra?.sc_context).length;
        const manualCount = chat.filter(message => message.extra?.sc_context?.manual).length;
        let statsHtml = '<div class="sc-layer-stat">Excluded from ST prompts: <strong>' + hiddenCount + '</strong>; manual choices: <strong>' + manualCount + '</strong></div>';
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layerTokens(layer)}</strong> / ${budgets[i] ?? 'legacy'} tokens · ${layer.length} summaries${layer.some(sn => !Number.isFinite(sn.tokenCount)) ? ' · count pending' : layer.some(sn => sn.tokenCountSource?.startsWith('estimated')) ? ' · includes estimates' : ''}
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Linked source messages: ${coveredSourceIds(store).size}; newest covered chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateSourceWarning();
        if (refreshSnippets) updateSnippetBrowser();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append(
            $('<option></option>')
            .val(name)
            .text(`${name}`)
            .attr('title', preview)
        );
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

async function rewriteSnippet(layerIndex, snippetIndex, refine = false) {
    if (isSummarizing) {
        toastr.warning('Already summarizing. Please wait.', 'Summaryception');
        return false;
    }
    const store = getChatStore();
    const snippet = store.layers[layerIndex]?.[snippetIndex];
    if (!snippet) {
        setSummaryStatus('The selected summary is no longer present. Refresh the snippet browser.', 'error');
        return false;
    }
    setSummaryStatus(`${refine ? 'Refine' : 'Regenerate'}: checking source messages.`);
    const { chat } = SillyTavern.getContext();
    const sources = resolveSnippetSources(snippet, chat);
    if (!sources.known || sources.missing || !sources.text.trim()) {
        setSummaryStatus('Cannot rewrite: source messages are missing or were never recorded.', 'error');
        toastr.warning('Source messages are missing or were never recorded. Check the sources; a numeric range will not be substituted.', 'Summaryception');
        return false;
    }
    const issue = sources.indices.some(index => !chat[index].is_user && getModelOutputIssue(chat[index].mes, chat[index]));
    if (issue) {
        setSummaryStatus('Cannot rewrite: a linked assistant message is empty or a refusal.', 'error');
        toastr.warning('A linked assistant message is now empty or a refusal. Summary kept.', 'Summaryception');
        return false;
    }
    const previousText = snippet.text;
    const sourceIds = [...snippet.sourceMessageIds];
    const sourceFingerprints = layerIndex === 0 ? captureSourceFingerprints(chat, sourceIds) : null;
    // Later memories may already depend on this snippet. Supplying them as
    // prior_context can make regeneration erase facts as "already recorded".
    const context = [];
    const firstSource = Math.min(...sources.indices);
    for (let index = store.layers.length - 1; index >= 0; index--) {
        for (const item of store.layers[index] || []) {
            if (item === snippet) continue;
            const previous = resolveSnippetSources(item, chat);
            if (previous.known && !previous.missing && previous.indices.length
                && previous.indices.every(sourceIndex => sourceIndex < firstSource)) context.push(item.text);
        }
    }
    isSummarizing = true;
    summarizationStopRequested = false;
    try {
        const result = await callSummarizer(sources.text, context.join(' '), refine ? previousText : null, sourceMessageTexts(chat, sources.indices));
        if (!result) return false;
        if (SillyTavern.getContext().chat !== chat || getChatStore() !== store
            || !store.layers.some(layer => layer?.includes(snippet)) || snippet.text !== previousText
            || JSON.stringify(snippet.sourceMessageIds) !== JSON.stringify(sourceIds)
            || resolveSnippetSources(snippet, chat).text !== sources.text) {
            toastr.warning('Chat, summary or source messages changed during the request. Result discarded.', 'Summaryception');
            return false;
        }
        Object.assign(snippet, result, { sourceStatus: 'exact', timestamp: Date.now(), [refine ? 'refined' : 'regenerated']: true });
        setSummaryStatus('Saving the revised summary.');
        if (layerIndex === 0) {
            snippet.sourceFingerprints = sourceFingerprints;
            snippet.sourceFingerprintOrigin = 'generated';
            archiveL0(store, snippet);
        }
        else preserveSourceRevision(snippet);
        await saveChatStore();
        updateInjection();
        const transferred = await maybePromoteLayer();
        updateInjection();
        updateUI();
        if (transferred) toastr.success(refine ? 'Summary refined' : 'Summary regenerated', 'Summaryception');
        else toastr.warning('Revised summary saved. Layer transfer stopped.', 'Summaryception');
        setSummaryStatus(transferred ? (refine ? 'Summary refined.' : 'Summary regenerated.') : 'Revised summary saved. Layer transfer stopped.', transferred ? 'success' : 'warning');
        return true;
    } finally {
        isSummarizing = false;
    }
}

async function releaseUncoveredMessages(chat, store, previous) {
    ensureSummarySources(store, chat);
    pruneArchive(store);
    const covered = coveredSourceIds(store);
    syncContextOverrides(chat);
    const freed = chat.flatMap((message, index) => previous.has(sourceId(message))
        && !covered.has(sourceId(message)) && message.extra?.sc_ghosted && !message.extra.sc_context?.manual ? [index] : []);
    await setContextForMessages(chat, freed, false);
    updateSourceBoundary(store, chat);
    store.ghostedIndices = chat.flatMap((message, index) => message.extra?.sc_ghosted ? [index] : []);
}

async function deleteSnippet(layerIndex, snippetIndex) {
    if (isSummarizing) {
        toastr.warning('Wait for the summary request to finish.', 'Summaryception');
        return false;
    }
    const store = getChatStore();
    const layer = store.layers[layerIndex];
    if (!layer?.[snippetIndex]) return false;
    const { chat } = SillyTavern.getContext();
    const previous = coveredSourceIds(store);
    layer.splice(snippetIndex, 1);
    pruneArchive(store);
    await releaseUncoveredMessages(chat, store, previous);
    await saveChatStore();
    updateInjection();
    updateUI();
    toastr.info('Summary removed; messages with no remaining summary are available again.', 'Summaryception');
    return true;
}

async function applyManualSummaryEdit(store, snippet, layerIndex, text) {
    if (!canModifyMemory() || getChatStore() !== store || !store.layers[layerIndex]?.includes(snippet)) return false;
    const revised = await countOnce({ text });
    if (!canModifyMemory() || getChatStore() !== store || !store.layers[layerIndex]?.includes(snippet)) return false;
    Object.assign(snippet, revised);
    delete snippet.usage;
    if (layerIndex === 0) archiveL0(store, snippet);
    else preserveSourceRevision(snippet);
    if (layerTokens(store.layers[layerIndex]) > layerBudgets(getSettings())[layerIndex]) {
        toastr.warning('Manual edit exceeds this layer budget. It will be rebalanced on the next summary request.', 'Summaryception');
    }
    return true;
}

function canModifyMemory() {
    if (!isSummarizing) return true;
    toastr.warning('Stop the current summary request before editing, clearing or importing memory.', 'Summaryception');
    return false;
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let pendingEdit = Promise.resolve(true);
    let finishActiveEdit = null;
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const sources = resolveSnippetSources(sn, SillyTavern.getContext().chat);
                const rangeStr = sources.known ? `Messages: ${formatSourceIndices(sources.indices) || '(none)'}`
                    : sn.sourceStatus === 'unlinked' ? 'Imported memory; source messages are not linked in this chat' : 'Source messages unavailable (legacy summary)';
                const sourceWarning = !sources.known ? '' : sources.missing ? ` · ${sources.missing} missing` : sn.sourceStatus === 'inferred' ? ' · recovered from legacy range; verify' : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = sources.known && !sources.missing && sources.indices.length;
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <div class="sc-snippet-actions">${redoBtn}
                ${canRedo ? '<button class="sc-snippet-refine menu_button" title="Add missing details using the same source messages and the current summary">Refine</button>' : ''}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                </div>
                <details class="sc-snippet-sources"><summary>${rangeStr}${sourceWarning}${seedStr}</summary><pre class="sc-source-list"></pre></details>
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    $('.sc-snippet-sources').on('toggle', function () {
        if (!this.open) return;
        const parent = $(this).closest('.sc-snippet');
        const snippet = store.layers[Number(parent.data('layer'))]?.[Number(parent.data('idx'))];
        if (!snippet) return;
        const { chat } = SillyTavern.getContext();
        const sources = resolveSnippetSources(snippet, chat);
        $(this).find('.sc-source-list').text(sources.indices.map(index => `#${index} ${chat[index].name || (chat[index].is_user ? 'User' : 'Assistant')}: ${chat[index].mes}`).join('\n\n') || 'Original message membership was not stored by the old version.');
    });

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        if (!canModifyMemory()) return;
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        let finished = false;
        const finishEdit = (save = true) => {
            if (finished) return pendingEdit;
            finished = true;
            const newText = textarea.val().trim();
            pendingEdit = pendingEdit.then(async () => {
                if (save && newText && newText !== sn.text) {
                    if (!await applyManualSummaryEdit(store, sn, layerIdx, newText)) return false;
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                }
                return true;
            }).catch(error => {
                console.error(LOG_PREFIX, 'Summary edit failed:', error);
                toastr.error(`Could not save summary edit: ${error.message}`, 'Summaryception');
                return false;
            }).finally(() => {
                // Blur runs before the tapped button's click. Keep its DOM node
                // in place so touch and mouse clicks both reach the action.
                textarea.replaceWith(textEl.text(sn.text));
                if (finishActiveEdit === finishEdit) finishActiveEdit = null;
                if (getChatStore() === store) updateUI({ refreshSnippets: false });
            });
            return pendingEdit;
        };
        finishActiveEdit = finishEdit;
        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void finishEdit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    void finishEdit(false);
                }
            })
            .on('blur', () => { void finishEdit(); });

        textEl.after(textarea).detach();

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    // Keep focus until click: blurring on pointerdown can resize the editor
    // and move the button away before a touch is released.
    $('.sc-snippet-actions button').off('pointerdown').on('pointerdown', event => event.preventDefault());

    $('.sc-snippet-redo, .sc-snippet-refine').off('click').on('click', async function () {
        const parent = $(this).closest('.sc-snippet');
        const refine = $(this).hasClass('sc-snippet-refine');
        $(this).prop('disabled', true);
        try {
            if (!isSummarizing) setSummaryStatus('Saving any pending edit before rewriting.');
            if (!await (finishActiveEdit ? finishActiveEdit() : pendingEdit)) return;
            await rewriteSnippet(Number(parent.data('layer')), Number(parent.data('idx')), refine);
        } catch (error) {
            setSummaryStatus(`Summary rewrite failed: ${error.message}`, 'error');
            console.error(LOG_PREFIX, 'Summary rewrite failed:', error);
            toastr.error(`Could not ${refine ? 'refine' : 'regenerate'} summary: ${error.message}`, 'Summaryception');
        } finally {
            $(this).prop('disabled', false);
        }
    });

    $('.sc-snippet-delete').off('click').on('click', async function () {
        const parent = $(this).closest('.sc-snippet');
        if (!await (finishActiveEdit ? finishActiveEdit() : pendingEdit)) return;
        await deleteSnippet(Number(parent.data('layer')), Number(parent.data('idx')));
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bindUIEvents() {
    $('#sc_summary_language').on('change', function () {
        getSettings().summaryLanguage = $(this).val();
        $('#sc_summary_custom_language').toggle($(this).val() === 'custom');
        saveSettings();
    });
    $('#sc_summary_custom_language').on('input', function () {
        getSettings().summaryCustomLanguage = $(this).val();
        saveSettings();
    });
    $(document).on('change', '#sc_enabled', async function () {
        const enabled = $(this).prop('checked');
        try {
            if (!enabled) {
                if (isSummarizing) abortSummarization();
                await unghostAllMessages();
                await saveChatStore();
            }
            getSettings().enabled = enabled;
            saveSettings();
            updateInjection();
        } catch (error) {
            $(this).prop('checked', getSettings().enabled);
            toastr.error(error.message, 'Summaryception');
        }
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            if (isSummarizing) abortSummarization();
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: TUNING.toastLonger }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: TUNING.toastMedium }
            );
        }
    });

    for (const [id, key] of [
        ['#sc_ghost_user_messages', 'ghostUserMessages'],
        ['#sc_ghost_assistant_messages', 'ghostAssistantMessages'],
        ['#sc_reapply_ghosting', 'reapplyGhostingOnSummary'],
        ['#sc_injection_scan', 'injectionScan'],
        ['#sc_summarizer_world_info', 'summarizerWorldInfo'],
    ]) {
        $(document).on('change', id, function () {
            getSettings()[key] = $(this).prop('checked');
            saveSettings();
            if (key === 'injectionScan') updateInjection();
            if (key === 'summarizerWorldInfo') updateUI({ refreshSnippets: false });
        });
    }
    $(document).on('change', '#sc_summarizer_world_info_percent', function () {
        getSettings().summarizerWorldInfoPercent = Math.min(100, Math.max(1, Number($(this).val()) || 20));
        saveSettings();
        updateUI({ refreshSnippets: false });
    });
    $(document).on('change', '#sc_injection_position', function () {
        const selected = $(this).val();
        const settings = getSettings();
        settings.injectionPosition = selected === 'chat_end' ? 1 : Number(selected);
        if (selected === 'chat_end') settings.injectionDepth = 0;
        else if (selected === '1' && settings.injectionDepth === 0) settings.injectionDepth = 1;
        saveSettings();
        updateInjection();
        updateUI();
    });
    for (const [id, key, min, max] of [
        ['#sc_injection_depth', 'injectionDepth', 0, 9999],
        ['#sc_injection_role', 'injectionRole', 0, 2],
    ]) {
        $(document).on('change', id, function () {
            const value = Number($(this).val());
            if (!Number.isInteger(value) || value < min || value > max) return;
            getSettings()[key] = value;
            saveSettings();
            updateInjection();
            updateUI();
        });
    }
    // Native ST buttons are explicit user choices, including a repeated choice.
    $(document).on('click', '.mes_hide, .mes_unhide', async function () {
        const { chat, saveChat } = SillyTavern.getContext();
        const index = Number($(this).closest('.mes').attr('mesid'));
        if (!chat[index]) return;
        recordManualContext(chat[index], $(this).hasClass('mes_hide'));
        await saveChat();
        updateUI();
    });
    for (const [id, hidden] of [['#sc_context_include', false], ['#sc_context_exclude', true]]) {
        $(document).on('click', id, async function () {
            const { chat, saveChat } = SillyTavern.getContext();
            const range = String($('#sc_context_range').val()).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            const start = Number(range?.[1]);
            const end = Number(range?.[2] ?? range?.[1]);
            if (!range || start > end || end >= chat.length) {
                toastr.warning('Enter an existing message ID or inclusive range, e.g. 54-55.', 'Summaryception');
                return;
            }
            try {
                await setContextForMessages(chat, Array.from({ length: end - start + 1 }, (_, offset) => start + offset), hidden, true);
                await saveChat();
                updateUI();
            } catch (error) {
                toastr.error(error.message, 'Summaryception');
            }
        });
    }

    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    $(document).on('change', '#sc_retained_context_tokens, #sc_batch_context_tokens, #sc_blind_zone_exchanges', async function () {
        const settings = getSettings();
        settings.retainedContextTokens = Math.max(1, Math.floor(Number($('#sc_retained_context_tokens').val()) || defaultSettings.retainedContextTokens));
        settings.batchContextTokens = Math.max(1, Math.floor(Number($('#sc_batch_context_tokens').val()) || defaultSettings.batchContextTokens));
        settings.blindZoneExchanges = Math.max(0, Math.floor(Number($('#sc_blind_zone_exchanges').val()) || 0));
        if (isSummarizing) abortSummarization();
        saveSettings();
        await protectBlindZone(SillyTavern.getContext().chat);
        updateUI();
    });

    $(document).on('change', '#sc_memory_token_budget, #sc_layer_divisor, #sc_override_layer_budgets, .sc-layer-budget-input', function () {
        const s = getSettings();
        const manual = $('#sc_override_layer_budgets').prop('checked');
        if (manual && !s.overrideLayerBudgets) s.layerTokenBudgets = layerBudgets(s);
        s.memoryTokenBudget = Math.max(5, Math.floor(Number($('#sc_memory_token_budget').val()) || 15500));
        s.layerDivisor = Math.max(1.01, Number($('#sc_layer_divisor').val()) || 2);
        if (manual && s.overrideLayerBudgets) s.layerTokenBudgets = Array.from({ length: 5 }, (_, i) => Math.max(1, Math.floor(Number($('#sc_layer_budget_' + i).val()) || 1)));
        s.overrideLayerBudgets = manual;
        saveSettings();
        updateUI();
    });

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
            updateInjection();
        });
    }

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
        const { chat, saveChat } = SillyTavern.getContext();
        if (syncContextOverrides(chat)) await saveChat();
        updateUI();
        toastr.info('Context status refreshed. No message inclusion was changed.', 'Summaryception');
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!canModifyMemory()) return;
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;
        try {
            await clearMemory();
            toastr.success('Memory cleared & messages unghosted', 'Summaryception');
        } catch (error) {
            toastr.error('Clear failed: ' + error.message + '. Summary memory was kept.', 'Summaryception');
        }
    });

    $(document).on('click', '#sc_force_summarize', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (isChatGenerating()) {
            toastr.info('Wait for the current chat response to finish.', 'Summaryception');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }
        $(this).prop('disabled', true).text(' Working…');
        isSummarizing = true;
        summarizationStopRequested = false;
        try {
            catchupDismissed = false;
            setSummaryStatus('Preparing message context and counting source tokens.');

            const { chat } = SillyTavern.getContext();
            await protectBlindZone(chat);
            const plan = await planRawContext(chat, getChatStore(), s, () => summarizationStopRequested);
            if (summarizationStopRequested) return;
            if (!plan.hasBatch) {
                setSummaryStatus('Nothing to summarize outside the retained context and blind zone.', 'idle');
                toastr.info('Nothing to summarize outside the retained token budget and blind zone.', 'Summaryception');
                return;
            }
            if (SillyTavern.getContext().chat !== chat) return;
            toastr.info(plan.availableTokens + ' source tokens to process.', 'Summaryception', { timeOut: TUNING.toastDefault });
            await runCatchup();
            updateInjection();
        } finally {
            isSummarizing = false;
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Stop requested. Waiting for the active step to finish.', 'Summaryception', { timeOut: TUNING.toastLong });
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $(document).on('click', '#sc_import', function () {
        if (!canModifyMemory()) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!canModifyMemory()) return;
                const data = JSON.parse(text);
                if (!Array.isArray(data.layers) || data.layers.some(layer => !Array.isArray(layer)
                    || layer.some(snippet => !snippet || typeof snippet.text !== 'string' || !snippet.text.trim()))) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                const draft = { ...structuredClone(store), layers: data.layers, l0Archive: data.l0Archive || {},
                    skippedMessageIds: data.skippedMessageIds || [], legacySourceIds: data.legacySourceIds,
                    summarizedUpTo: data.summarizedUpTo ?? -1,
                    ghostedIndices: chat.flatMap((message, index) => message.extra?.sc_ghosted ? [index] : []) };
                const messageIds = new Set(chat.map(sourceId));
                for (const snippet of draft.layers.flat()) {
                    if (!Array.isArray(snippet.sourceMessageIds) || snippet.sourceMessageIds.some(id => !messageIds.has(id))) {
                        snippet.importedSourceMessageIds ??= snippet.sourceMessageIds;
                        delete snippet.sourceMessageIds;
                        snippet.sourceStatus = 'unlinked';
                    }
                }
                ensureSummarySources(draft, chat);
                await prepareTokenMemory(draft);
                if (!canModifyMemory() || SillyTavern.getContext().chat !== chat || getChatStore() !== store) return;
                Object.assign(store, draft);

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded. Message inclusion was preserved.`,
                               'Summaryception',
                               { timeOut: TUNING.toastLong }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) s.savedCustomPrompts = {};

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(
            `Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`,
            'Summaryception',
            { timeOut: TUNING.toastDefault }
        );
    });

    // ── Custom Prompt: Load from named slot ──
    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Delete named slot ──
    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) return;

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Export as .txt ──
    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: TUNING.toastDefault });
    });

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.text';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!text.trim()) {
                    toastr.warning('File is empty.', 'Summaryception');
                    return;
                }

                const s = getSettings();
                $('#sc_summarizer_user_prompt').val(text);
                s.summarizerUserPrompt = text;
                s.lastCustomPrompt = text;
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                saveSettings();
                updateCustomPromptSlots();

                toastr.success(
                    `Prompt imported from "${file.name}".`,
                    'Summaryception',
                    { timeOut: TUNING.toastMedium }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.', 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_reset_defaults', function () {
        if (!confirm(
            'Reset all Advanced Settings to defaults?\n\n' +
            'This will reset sliders, prompts, injection template, and strip patterns.\n' +
            'It will NOT clear your summary memory or connection settings.'
        )) return;

        const s = getSettings();

        // Reset sliders
        s.retainedContextTokens = defaultSettings.retainedContextTokens;
        s.batchContextTokens = defaultSettings.batchContextTokens;
        s.blindZoneExchanges = defaultSettings.blindZoneExchanges;
        s.memoryTokenBudget = defaultSettings.memoryTokenBudget;
        s.layerDivisor = defaultSettings.layerDivisor;
        s.overrideLayerBudgets = false;
        s.layerTokenBudgets = structuredClone(defaultSettings.layerTokenBudgets);

        for (const key of ['injectionPosition', 'injectionDepth', 'injectionRole', 'injectionScan', 'summarizerWorldInfo', 'summarizerWorldInfoPercent', 'ghostUserMessages', 'ghostAssistantMessages', 'reapplyGhostingOnSummary']) {
            s[key] = defaultSettings[key];
        }

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;
        s.summarizerStreaming = defaultSettings.summarizerStreaming;
        s.summaryLanguage = defaultSettings.summaryLanguage;
        s.summaryCustomLanguage = defaultSettings.summaryCustomLanguage;

        // Reset debug
        s.debugMode = defaultSettings.debugMode;
        s.traceMode = defaultSettings.traceMode;

        saveSettings();
        updateInjection();
        updateUI();

        toastr.success(
            'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
            'Summaryception',
            { timeOut: TUNING.toastLong }
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    const streamingToggle = document.getElementById('summaryception_streaming');
    streamingToggle.checked = s().summarizerStreaming;
    streamingToggle.addEventListener('change', () => {
        s().summarizerStreaming = streamingToggle.checked;
        save();
    });

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        populateProfileDropdown(profileSelect, s().connectionProfileId, profileId => {
            s().connectionProfileId = profileId;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel, s.summarizerStreaming);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, TUNING.connectionStatusTimeout);
    }
}


// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

    getSettings();
    installWorldMemoryBridge({ getStore: getChatStore, getSettings,
        isBusy: () => isSummarizing || isChatGenerating(), version: RUNTIME_VERSION,
        sendRequest: sendSummarizerRequest, sourceId, captureSourceFingerprints, cleanText: cleanSummarizerOutput, refreshInjection: updateInjection });
    const native = await import('/script.js');
    if (typeof native.isGenerating === 'function') isChatGenerating = native.isGenerating;
    installWorldInfoTracking();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);
    $('.sc-settings > .inline-drawer > .inline-drawer-toggle > b').text(`🧠 Summaryception · ${RUNTIME_VERSION}`);
    setSummaryStatus(`Ready · ${RUNTIME_VERSION}`, 'idle');

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    for (const type of new Set([event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_RECEIVED].filter(Boolean))) {
        eventSource.on(type, onSourceMessagesChanged);
    }
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, placeMemoryBeforeChat);
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, placeTextMemoryBeforeChat);
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    registerSlashCommands();
    await hydrateTokenCounts();
    await protectBlindZone(SillyTavern.getContext().chat);
    syncContextOverrides(SillyTavern.getContext().chat);
    updateInjection();
    updateUI();

    eventSource.on(event_types.APP_READY, async () => {
        await hydrateTokenCounts();
        await protectBlindZone(SillyTavern.getContext().chat);
        syncContextOverrides(SillyTavern.getContext().chat);
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, `${RUNTIME_VERSION} loaded. Raw context token budgets and protected blind zone available`);
    });
})();
