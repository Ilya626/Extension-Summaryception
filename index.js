/**
 * Summaryception v5.5.4-local.9 — Layered Recursive Summarization for SillyTavern
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
import { collectSummaryWorldInfo, attachSummaryWorldInfo, installWorldInfoTracking } from './world-info-context.js';
import { planRawContext, blindZoneStart } from './raw-context.js';
import { layerBudgets, layerTokens, countOnce, archiveL0, preserveSourceRevision, pruneArchive, prepareTokenMemory, rebalanceMemory } from './token-memory.js';
import { sourceId, ensureSummarySources, coveredSourceIds, pendingSourceIds, updateSourceBoundary, collectPassage, resolveSnippetSources, mergedSources, newSnippetSources, formatSourceIndices } from './summary-sources.js';

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ═══════════════════════════════════════════════════════════════════════
//  TUNING — Centralised operational constants.
//  Change these instead of hunting through function bodies.
// ═══════════════════════════════════════════════════════════════════════

const TUNING = Object.freeze({

    // ── Retry / Resilience ─────────────────────────────────────────
    maxRetries:               5,        // LLM call retry attempts before giving up
    retryBaseDelay:           2_000,    // ms — initial back-off delay
    retryMaxDelay:            60_000,   // ms — ceiling for exponential back-off
    retryBackoffMultiplier:   2,        // exponential growth factor
    retryableStatuses:        [429, 500, 502, 503, 504],
    llmRequestTimeout:        120_000,  // ms — per-request hard timeout

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
    stopButtonCooldown:       2_000,    // ms — brief disable after clicking Stop
});

// Legacy alias — keeps RETRY_CONFIG references readable without a noisy diff.
const RETRY_CONFIG = Object.freeze({
    maxRetries:         TUNING.maxRetries,
    baseDelay:          TUNING.retryBaseDelay,
    maxDelay:           TUNING.retryMaxDelay,
    backoffMultiplier:  TUNING.retryBackoffMultiplier,
    retryableStatuses:  TUNING.retryableStatuses,
});

// ─── Default Settings ────────────────────────────────────────────────

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

const DETAIL_REQUIREMENTS = `Track concrete events and state, not a vague synopsis. Preserve:
- Who did exactly what, to whom, in what order, with which object, and the immediate result. Keep proper names, aliases, distinctive descriptions, exact numbers, times, quantities, directions, and named places.
- Physical and spatial details: positions, movement, contact, clothing, equipment, injuries, bodily changes, and relevant sensory observations. Keep explicit details explicit; do not replace them with euphemisms or generic labels.
- Short exact dialogue when its wording carries a clue, promise, threat, condition, password, boundary, or misunderstanding. Attribute speakers and pronouns unambiguously.
- Each character's actual knowledge, observations, beliefs, secrets, motives, and relationship changes. Attribute uncertain claims to their source; do not turn them into established facts or share private knowledge between characters.
- Pending plans, commitments, conflicts, clues, constraints, and consequences. Distinguish an intention or attempt from a completed action, and preserve causal links and chronology.
Never invent events, motives, player actions, resolutions, or missing details. Do not add commentary, moral judgments, disclaimers, or story continuation.
Use concise, specific factual clauses. Remove repetition and ornamental prose, not details needed to reconstruct the scene. There is no fixed phrase-count limit. These rules also apply when compressing existing summaries into deeper layers.`;

const DETAIL_PROMPT_HEADER = `<player_name>
{{player_name}}
</player_name>
<prior_context>
{{context_str}}
</prior_context>
<passage_in_question>
{{story_txt}}
</passage_in_question>
Record the new information in passage_in_question that is not already present in prior_context. Retain enough context to identify actors and changes. If prior_context is empty, establish the scene concretely. Second-person 'you' refers to the named player; use that name.`;

const PROMPT_PRESETS = {
    narrative: DETAIL_PROMPT_HEADER + '\n\n' + DETAIL_REQUIREMENTS + '\n\nPreserve the specific actions, exchanges, physical details, emotional evidence, and subtext that make this RP scene distinct. Output only the memory text.',
    gamestate: DETAIL_PROMPT_HEADER + '\n\n' + DETAIL_REQUIREMENTS + '\n\nAlso preserve exact inventory, resources, stats, rules, cooldowns, quest stages, map locations, interactables, and changes to world state. Output only the memory text.',
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
    summaryLanguage: 'en',
    summaryCustomLanguage: '',
    injectionRole: 1,
    injectionTemplate: '[Summary of earlier events]\n{{summary}}',
    promptRevision: 2,

    summarizerSystemPrompt:
        'You are a precise RP continuity archivist. Preserve concrete details and factual distinctions, including when compressing earlier memories. Output only the memory text; no preamble or commentary.',

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
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
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

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
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
        const stockPrompts = [LEGACY_DEFAULT_USER_PROMPT, LEGACY_PROMPT_PRESETS.narrative, LEGACY_PROMPT_PRESETS.gamestate];
        if (stockPrompts.includes(settings.summarizerUserPrompt)) {
            settings.summarizerUserPrompt = settings.promptPreset === 'gamestate' ? PROMPT_PRESETS.gamestate : PROMPT_PRESETS.narrative;
        }
        if (settings.summarizerSystemPrompt === 'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.') {
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
    await SillyTavern.getContext().saveMetadata();
    // Stable source IDs live on the messages, not just in chat metadata.
    await SillyTavern.getContext().saveChat();
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

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
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

function abortSummarization() {
    summarizationStopRequested = true;
    cancelCatchupDialog?.();
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr, existingSummary = null) {
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

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    currentAbortController = new AbortController();
    if (summarizationStopRequested) currentAbortController.abort();
    const { signal } = currentAbortController;

    let lastError = null;

    try {
        if (s.summarizerWorldInfo) {
            try {
                const worldInfo = await collectSummaryWorldInfo(storyTxt, [contextStr, existingSummary].filter(Boolean).join('\n'));
                prompt = attachSummaryWorldInfo(prompt, worldInfo);
                log('Summary World Info:', worldInfo.length, 'chars');
            } catch (error) {
                console.error(LOG_PREFIX, 'World Info scan failed:', error);
                toastr.warning(`Summary skipped: World Info scan failed (${error.message}). Memory and message context were kept.`, 'Summaryception', { timeOut: TUNING.toastError });
                return '';
            }
        }
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                let timer;
                let onAbort;
                let result;
                const requestController = new AbortController();
                const cancelRequest = () => requestController.abort();
                signal.addEventListener('abort', cancelRequest, { once: true });
                try {
                    result = await Promise.race([
                        sendSummarizerRequest(s, systemPrompt, prompt, { signal: requestController.signal, returnDetails: true }),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => {
                                requestController.abort();
                                reject(new Error('Request timed out after 120s'));
                            }, TUNING.llmRequestTimeout);
                            onAbort = () => reject(new Error('Aborted by user'));
                            signal.addEventListener('abort', onAbort, { once: true });
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', onAbort);
                    signal.removeEventListener('abort', cancelRequest);
                }

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

                let trimmed = (result.text || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                requireModelOutput(trimmed);

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                const summary = await countOnce({ ...result, text: trimmed });
                return signal.aborted ? '' : summary;

            } catch (err) {
                lastError = err;
                if (err instanceof InvalidModelOutputError) {
                    toastr.warning(`Summary rejected: ${err.message}. Memory and message context were kept.`, 'Summaryception', { timeOut: TUNING.toastError });
                    return '';
                }
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: TUNING.toastMedium });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: TUNING.toastError }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
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
        syncContextOverrides(chat);
        await protectBlindZone(chat);
        const plan = await planRawContext(chat, store, settings);
        if (!plan.ready || summarizationStopRequested || isChatGenerating() || SillyTavern.getContext().chat !== chat || getChatStore() !== store) return;
        if (plan.availableTokens > plan.batchBudget * TUNING.backlogMultiplier && !catchupDismissed) {
            const choice = await showCatchupDialog(plan.availableTokens, plan.batchCount);
            if (SillyTavern.getContext().chat !== chat || getChatStore() !== store || summarizationStopRequested) return;
            if (choice === 'skip') {
                const current = await planRawContext(chat, store, getSettings());
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
    syncContextOverrides(chat);
    await protectBlindZone(chat);
    const plan = await planRawContext(chat, store, settings);
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
        const summary = await callSummarizer(passage.text, buildFullContext(0));
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
        archiveL0(store, snippet);
        updateSourceBoundary(store, chat);
        await saveChatStore();
        await applyGhostingAfterSummary(chat, passage.indices);
        await SillyTavern.getContext().saveChat();
        updateInjection();
        if (!await maybePromoteLayer()) return 'saved-promotion-stopped';
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
    const initialPlan = await planRawContext(startingChat, startingStore, s);
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
            const plan = await planRawContext(chat, startingStore, getSettings());
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
    try {
        await rebalanceMemory(draft, getSettings(), callSummarizer, mergedSources);
        if (getChatStore() !== store || SillyTavern.getContext().chat !== chat || JSON.stringify(store) !== before) {
            throw new Error('Chat or memory changed during compression. Result discarded.');
        }
        store.layers = draft.layers;
        store.l0Archive = draft.l0Archive;
        return true;
    } catch (error) {
        toastr.warning(error.message, 'Summaryception', { timeOut: TUNING.toastError });
        return false;
    }
}

async function maybePromoteLayer() {
    const store = getChatStore();
    const before = JSON.stringify(store);
    const ok = await commitBalancedMemory(store, structuredClone(store), before, SillyTavern.getContext().chat);
    if (ok) await saveChatStore();
    return ok;
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

function updateInjection() {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        const settings = getSettings();
        const text = settings.enabled ? assembleSummaryBlock() : '';
        const args = [text, settings.injectionPosition, settings.injectionDepth, settings.injectionScan, settings.injectionRole];
        const signature = JSON.stringify(args);
        if (signature === _lastInjection) return;
        setExtensionPrompt(MODULE_NAME, ...args);
        _lastInjection = signature;
    } catch (error) {
        console.error(LOG_PREFIX, 'Could not update summary injection:', error);
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

const rejectedReplyWarnings = new WeakMap();

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
    syncContextOverrides(SillyTavern.getContext().chat);
    updateInjection();
}

function onGenerationEnded() {
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
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                store.l0Archive = {};
                delete store.skippedMessageIds;
                delete store.legacySourceIds;
                store.summarizedUpTo = -1;
                store.ghostedIndices = [];

                const { chatMetadata } = SillyTavern.getContext();
                chatMetadata[MODULE_NAME] = store;

                await saveChatStore();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
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

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_ghost_user_messages').prop('checked', s.ghostUserMessages);
        $('#sc_ghost_assistant_messages').prop('checked', s.ghostAssistantMessages);
        $('#sc_reapply_ghosting').prop('checked', s.reapplyGhostingOnSummary);
        $('#sc_injection_position').val(s.injectionPosition);
        $('#sc_injection_depth').val(s.injectionDepth).prop('disabled', s.injectionPosition !== 1);
        $('#sc_injection_role').val(s.injectionRole).prop('disabled', s.injectionPosition !== 1);
        $('#sc_injection_scan').prop('checked', s.injectionScan);
        $('#sc_summarizer_world_info').prop('checked', s.summarizerWorldInfo);
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

        updateSnippetBrowser();
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
    if (!snippet) return false;
    const { chat } = SillyTavern.getContext();
    const sources = resolveSnippetSources(snippet, chat);
    if (!sources.known || sources.missing || !sources.text.trim()) {
        toastr.warning('Source messages are missing or were never recorded. Check the sources; a numeric range will not be substituted.', 'Summaryception');
        return false;
    }
    const issue = sources.indices.some(index => !chat[index].is_user && getModelOutputIssue(chat[index].mes, chat[index]));
    if (issue) {
        toastr.warning('A linked assistant message is now empty or a refusal. Summary kept.', 'Summaryception');
        return false;
    }
    const previousText = snippet.text;
    const sourceIds = [...snippet.sourceMessageIds];
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
        const result = await callSummarizer(sources.text, context.join(' '), refine ? previousText : null);
        if (!result) return false;
        if (SillyTavern.getContext().chat !== chat || getChatStore() !== store
            || !store.layers.some(layer => layer?.includes(snippet)) || snippet.text !== previousText
            || JSON.stringify(snippet.sourceMessageIds) !== JSON.stringify(sourceIds)
            || resolveSnippetSources(snippet, chat).text !== sources.text) {
            toastr.warning('Chat, summary or source messages changed during the request. Result discarded.', 'Summaryception');
            return false;
        }
        Object.assign(snippet, result, { sourceStatus: 'exact', timestamp: Date.now(), [refine ? 'refined' : 'regenerated']: true });
        if (layerIndex === 0) archiveL0(store, snippet);
        else preserveSourceRevision(snippet);
        await saveChatStore();
        updateInjection();
        const transferred = await maybePromoteLayer();
        updateInjection();
        updateUI();
        if (transferred) toastr.success(refine ? 'Summary refined' : 'Summary regenerated', 'Summaryception');
        else toastr.warning('Revised summary saved. Layer transfer stopped.', 'Summaryception');
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
                const rangeStr = sources.known ? `Messages: ${formatSourceIndices(sources.indices) || '(none)'}` : 'Source messages unavailable (legacy summary)';
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

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText && newText !== sn.text && await applyManualSummaryEdit(store, sn, layerIdx, newText)) {
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text && await applyManualSummaryEdit(store, sn, layerIdx, newText)) {
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: TUNING.toastShort });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    $('.sc-snippet-redo, .sc-snippet-refine').off('click').on('click', async function () {
        const parent = $(this).closest('.sc-snippet');
        const refine = $(this).hasClass('sc-snippet-refine');
        $(this).prop('disabled', true);
        try {
            await rewriteSnippet(Number(parent.data('layer')), Number(parent.data('idx')), refine);
        } finally {
            $(this).prop('disabled', false);
        }
    });

    $('.sc-snippet-delete').off('click').on('click', async function () {
        const parent = $(this).closest('.sc-snippet');
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
    $(document).on('change', '#sc_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        if (!getSettings().enabled && isSummarizing) abortSummarization();
        saveSettings();
        updateInjection();
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
        });
    }
    for (const [id, key, min, max] of [
        ['#sc_injection_position', 'injectionPosition', -1, 2],
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
            await unghostAllMessages();
        } catch (e) {
            console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
            toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception');
        }

        const store = getChatStore();
        store.layers.length = 0;
        store.l0Archive = {};
        delete store.skippedMessageIds;
        delete store.legacySourceIds;
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];

        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;

        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
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

            const { chat } = SillyTavern.getContext();
            await protectBlindZone(chat);
            const plan = await planRawContext(chat, getChatStore(), s);
            if (summarizationStopRequested) return;
            if (!plan.hasBatch) {
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
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: TUNING.toastLong });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), TUNING.stopButtonCooldown);
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

        for (const key of ['injectionPosition', 'injectionDepth', 'injectionRole', 'injectionScan', 'summarizerWorldInfo', 'ghostUserMessages', 'ghostAssistantMessages', 'reapplyGhostingOnSummary']) {
            s[key] = defaultSettings[key];
        }

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;
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

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

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
    const native = await import('/script.js');
    if (typeof native.isGenerating === 'function') isChatGenerating = native.isGenerating;
    installWorldInfoTracking();

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
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
        console.log(LOG_PREFIX, 'v5.5.4-local.9 loaded. Raw context token budgets and protected blind zone available');
    });
})();
