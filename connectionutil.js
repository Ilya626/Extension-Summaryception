/**
 * Summaryception Connection Utility
 *
 * Routes summarization requests through one of four backends:
 *   - default:  SillyTavern's generateRaw() (active connection)
 *   - profile:  ST Connection Profile via ConnectionManagerRequestService
 *   - ollama:   Ollama instance (via ST CORS proxy to avoid browser CORS issues)
 *   - openai:   OpenAI-compatible endpoint (via ST CORS proxy, streaming supported)
 *
 * CORS Note: Ollama and OpenAI modes route through ST's /cors/ proxy endpoint
 * to avoid browser CORS restrictions. Requires enableCorsProxy: true in config.yaml
 * OR the target server must have permissive CORS headers.
 *
 * AGPL-3.0
 */

import { hasProviderRefusal, InvalidModelOutputError, requireModelOutput } from './output-validation.js';
import { providerUsage } from './token-memory.js';

const MODULE_NAME = '[Summaryception][Connection]';

// ═══════════════════════════════════════════════════════════════════════
//  LLM_DEFAULTS — Centralised connection-side constants.
//  Tweak sampling parameters and limits here instead of inside functions.
// ═══════════════════════════════════════════════════════════════════════

const LLM_DEFAULTS = Object.freeze({
    ollamaTemperature:    0.3,    // Lower = more deterministic summaries
    openaiTemperature:    0.8,    // Slightly creative for narrative flow
    testMaxTokens:        100,    // Small ceiling for the "Test Connection" probe
    testPreviewLength:    100,    // Characters of response shown in test result toast
});

// ─── Custom Error Class ──────────────────────────────────────────────

/**
 * Error class for connection errors with explicit retryable flag.
 * The retry logic in callSummarizer checks for this to avoid
 * burning through retries on errors that will never succeed
 * (e.g. missing config, auth failures, deleted profiles).
 */
class ConnectionError extends Error {
    constructor(message, { retryable = false, status = null } = {}) {
        super(message);
        this.name = 'ConnectionError';
        this.retryable = retryable;
        this.status = status;
    }
}

export { ConnectionError };

// ─── CORS Proxy Helper ───────────────────────────────────────────────

/**
 * Wrap a URL through SillyTavern's CORS proxy if needed.
 * @param {string} url - The target URL
 * @param {boolean} useProxy - Whether to attempt proxying
 * @returns {string} - The (possibly proxied) URL
 */
function proxiedUrl(url, useProxy = true) {
    if (!useProxy) return url;
    return `/proxy/${url}`;
}

/**
 * Get standard request headers including ST's CSRF token if available.
 * Required when routing through ST's /cors/ proxy.
 * @returns {object}
 */
function getProxyHeaders() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (e) { /* fallback */ }
    return { 'Content-Type': 'application/json' };
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Send a summarization request using the configured connection.
 * @param {object} settings - The extension settings containing connection config
 * @param {string} systemPrompt - The system prompt
 * @param {string} userPrompt - The user prompt
 * @returns {Promise<string>} - The generated response text
 * @throws {ConnectionError|Error} - If the request fails
 */
export async function sendSummarizerRequest(settings, systemPrompt, userPrompt, { signal, returnDetails = false } = {}) {
    const source = settings.connectionSource || 'default';
    let result;
    switch (source) {
        case 'profile':
            result = await sendViaProfile(settings.connectionProfileId, systemPrompt, userPrompt, settings.summarizerResponseLength, signal);
            break;
        case 'ollama':
            result = await sendViaOllama(settings.ollamaUrl, settings.ollamaModel, systemPrompt, userPrompt, signal);
            break;
        case 'openai':
            result = await sendViaOpenAI(settings.openaiUrl, settings.openaiKey, settings.openaiModel, systemPrompt, userPrompt, settings.openaiMaxTokens, signal);
            break;
        case 'default':
        default:
            result = await sendViaDefault(systemPrompt, userPrompt, settings.summarizerResponseLength, signal);
    }
    const details = typeof result === 'string' ? { text: result } : result;
    requireModelOutput(details.text);
    return returnDetails ? details : details.text;
}

// ─── Mode 1: Default (generateRaw) ──────────────────────────────────

/**
 * Uses ST's built-in generateRaw(), which routes through the active connection.
 */
async function sendViaDefault(systemPrompt, userPrompt, responseLength, signal) {
    const { generateRaw, generateRawData, extractMessageFromData, eventSource, event_types } = SillyTavern.getContext();
    signal?.throwIfAborted();
    const onAbort = () => {
        if (event_types?.GENERATION_STOPPED) void eventSource.emit(event_types.GENERATION_STOPPED);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        if (typeof generateRawData === 'function' && typeof extractMessageFromData === 'function') {
            const data = await generateRawData({ systemPrompt, prompt: userPrompt,
                ...(responseLength > 0 ? { responseLength: Number(responseLength) } : {}) });
            const { cleanUpMessage } = await import('/script.js');
            const text = cleanUpMessage({ getMessage: extractMessageFromData(data), isImpersonate: false, isContinue: false,
                displayIncompleteSentences: true, includeUserPromptBias: false, trimNames: true, trimWrongNames: true });
            return { text: requireModelOutput(text, data), ...providerUsage(data) };
        }

        if (!generateRaw) {
            throw new ConnectionError(
                'generateRaw is not available in the current SillyTavern context.',
                { retryable: false }
            );
        }

        // ST refactored generateRaw from positional args to an object param
        // in PR #4277 (July 2025). We need to support both signatures.
        //
        // New (July 2025+): generateRaw({ prompt, systemPrompt, responseLength })
        // Old (pre-July 2025): generateRaw(prompt, systemPrompt)
        //
        // Detection: the new signature destructures an object, so if we check
        // the function's length (expected positional params), 0 or 1 means
        // object-style, 2+ means positional-style.

        let result;

        if (generateRaw.length <= 1) {
            // Modern ST: object-based params
            const options = {
                systemPrompt: systemPrompt,
                prompt: userPrompt,
            };

            if (responseLength && responseLength > 0) {
                options.responseLength = responseLength;
            }

            result = await generateRaw(options);
        } else {
            // Legacy ST: positional args — generateRaw(prompt, systemPrompt)
            // Note: legacy signature does not support responseLength override
            console.warn(
                '[Summaryception] Detected legacy generateRaw (positional args). ' +
                'Consider updating SillyTavern to July 2025+ for full feature support.'
            );
            result = await generateRaw(userPrompt, systemPrompt);
        }

        if (typeof result !== 'string') {
            throw new InvalidModelOutputError('generateRaw returned an empty or invalid response');
        }

        return result;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Mirror ST TextCompletionService's output cleanup using the selected instruct preset. */
async function cleanProfileText(text, profile) {
    const ctx = SillyTavern.getContext();
    const preset = profile?.instruct && ctx.getPresetManager?.('instruct')?.getCompletionPresetByName(profile.instruct);
    if (!preset) return text;
    const { getInstructStoppingSequences } = await import('/scripts/instruct-mode.js');
    text = text.replace(/[^\S\r\n]+$/gm, '');
    for (const stop of getInstructStoppingSequences({ customInstruct: preset, useStopStrings: false })) {
        for (let size = stop.length; size > 0; size--) {
            if (text.endsWith(stop.slice(0, size))) { text = text.slice(0, -size); break; }
        }
    }
    for (const sequence of [preset.stop_sequence, preset.input_sequence]) {
        if (sequence?.trim() && text.includes(sequence)) text = text.slice(0, text.indexOf(sequence));
    }
    for (const sequences of [preset.output_sequence, preset.last_output_sequence]) {
        for (const line of (sequences || '').split('\n').filter(line => line.trim())) text = text.replaceAll(line, '');
    }
    return text;
}

// ─── Mode 2: Connection Profile ──────────────────────────────────────

/** Call ST's profile service without changing the active connection or its preset. */
async function sendViaProfile(profileId, systemPrompt, userPrompt, responseLength, signal) {
    if (!profileId) throw new ConnectionError('Select a Connection Profile in Summaryception settings.');
    const ctx = SillyTavern.getContext();
    const service = ctx.ConnectionManagerRequestService;
    if (typeof service?.sendRequest !== 'function') {
        throw new ConnectionError('SillyTavern Connection Manager is unavailable. Enable it or update ST.');
    }
    const profile = service.getProfile?.(profileId);
    if (typeof service.getProfile === 'function' && !profile) {
        throw new ConnectionError('The selected Connection Profile no longer exists.', { status: 404 });
    }
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    try {
        // Native signature: profileId, messages, maxTokens, options.
        // undefined inherits the profile preset; native preset/instruct defaults stay on.
        const raw = await service.sendRequest(profileId, messages,
            responseLength > 0 ? Number(responseLength) : undefined, { signal, extractData: false });
        if (hasProviderRefusal(raw)) throw new InvalidModelOutputError('the provider reported a refusal or content filter');
        const data = raw?.data ?? raw;
        const api = profile && service.validateProfile?.(profile)?.selected;
        let result = typeof data === 'string' ? data
            : (Array.isArray(data?.content) ? data.content.filter(part => part.type === 'text').map(part => part.text).join('') : data?.content)
                ?? data?.message?.content ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text
                ?? data?.response ?? data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
        if (api && typeof ctx.extractMessageFromData === 'function') result = ctx.extractMessageFromData(data, api);
        if (Array.isArray(result)) result = result.filter(part => !part.type || part.type === 'text').map(part => part.text || '').join('');
        if (typeof result !== 'string') throw new InvalidModelOutputError('Connection Profile returned no summary text');
        if (api === 'textgenerationwebui') result = await cleanProfileText(result, profile);
        return { text: requireModelOutput(result, raw), ...providerUsage(raw), ...providerUsage(data) };
    } catch (error) {
        if (error instanceof ConnectionError || error instanceof InvalidModelOutputError || signal?.aborted) throw error;
        // ST wraps provider errors in Error.cause. Preserve the actual diagnosis.
        const messages = [];
        let status = null;
        for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
            if (cause.message && !messages.includes(cause.message)) messages.push(cause.message);
            status ??= cause.status ?? cause.response?.status ?? null;
        }
        const message = messages.join(': ') || String(error);
        const code = message.match(/\b(400|401|403|404|408|409|422|429|5\d\d)\b/);
        status ??= code ? Number(code[1]) : /unauthorized|invalid api key|authentication failed/i.test(message) ? 401 : null;
        throw new ConnectionError(`Connection Profile request failed: ${message}`, {
            status, retryable: status === null || status === 408 || status === 429 || status >= 500,
        });
    }
}

// ─── Mode 3: Ollama (Local) ─────────────────────────────────────────

/**
 * Send a request to a local Ollama instance using /api/chat.
 * Routes through ST's CORS proxy to avoid browser CORS restrictions.
 */
async function sendViaOllama(url, model, systemPrompt, userPrompt, signal) {
    signal?.throwIfAborted();
    if (!url) {
        throw new ConnectionError(
            'Ollama URL is not configured. Please set it in Summaryception settings.',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            'Ollama model is not selected. Please select one in Summaryception settings.',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/chat`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            signal,
            method: 'POST',
            headers: {
                ...getProxyHeaders(),
                               'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
                options: {
                    temperature: LLM_DEFAULTS.ollamaTemperature,
                },
            }),
        });
    } catch (proxyError) {
        if (signal?.aborted) throw proxyError;
        console.warn(`${MODULE_NAME} CORS proxy failed, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                signal,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                    options: { temperature: LLM_DEFAULTS.ollamaTemperature },
                }),
            });
        } catch (directError) {
            if (signal?.aborted) throw directError;
            throw new ConnectionError(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `CORS proxy error: ${proxyError.message}. Direct error: ${directError.message}. ` +
                `Make sure enableCorsProxy is set to true in config.yaml, or set OLLAMA_ORIGINS=* on your Ollama instance.`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new ConnectionError(
            `Ollama request failed (${response.status}): ${errorText}`,
                                  { retryable: response.status >= 500, status: response.status }
        );
    }

    const data = await response.json();

    return { text: requireModelOutput(data?.message?.content ?? '', data), ...providerUsage(data) };
}

/**
 * Fetch available models from an Ollama instance.
 * @param {string} url - The Ollama base URL
 * @returns {Promise<Array<{name: string, size: number, modified_at: string}>>}
 */
export async function fetchOllamaModels(url) {
    if (!url) {
        throw new Error('Ollama URL is not configured.');
    }

    const baseUrl = url.replace(/\/+$/, '');
    const targetUrl = `${baseUrl}/api/tags`;

    let response;
    try {
        response = await fetch(proxiedUrl(targetUrl), {
            method: 'GET',
            headers: getProxyHeaders(),
        });
    } catch (proxyError) {
        console.warn(`${MODULE_NAME} CORS proxy failed for model list, trying direct:`, proxyError.message);
        try {
            response = await fetch(targetUrl, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (directError) {
            throw new Error(
                `Failed to connect to Ollama at ${baseUrl}. ` +
                `Enable the CORS proxy in config.yaml (enableCorsProxy: true) or set OLLAMA_ORIGINS=* on your Ollama instance. ` +
                `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Failed to fetch Ollama models (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (!data?.models || !Array.isArray(data.models)) {
        throw new Error('Unexpected response format from Ollama /api/tags.');
    }

    return data.models;
}

// ─── Mode 4: OpenAI Compatible (Streaming) ──────────────────────────

/**
 * Send a request to any OpenAI-compatible endpoint using streaming.
 * Streaming avoids the non-streaming token ceiling (4096 on many providers)
 * and allows reasoning models to complete their full thinking + output.
 *
 * Routes through ST's CORS proxy for local endpoints.
 * Cloud endpoints skip the proxy since they have CORS headers.
 */
async function sendViaOpenAI(url, apiKey, model, systemPrompt, userPrompt, maxTokens, signal) {
    signal?.throwIfAborted();
    if (!url) {
        throw new ConnectionError(
            'OpenAI Compatible URL is not configured. Please set it in Summaryception settings.',
            { retryable: false }
        );
    }
    if (!model) {
        throw new ConnectionError(
            'OpenAI Compatible model name is not set. Please enter one in Summaryception settings.',
            { retryable: false }
        );
    }

    const baseUrl = url.replace(/\/+$/, '');

    // Build the endpoint URL
    let endpoint = baseUrl;
    if (!endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/v1')) {
            endpoint += '/chat/completions';
        } else if (!endpoint.includes('/chat/completions')) {
            endpoint += '/v1/chat/completions';
        }
    }


    // Decide whether to use CORS proxy
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/i.test(endpoint);

    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Use maxTokens from settings, default to 0 (no limit / provider default)
    const tokenLimit = maxTokens && maxTokens > 0 ? maxTokens : undefined;

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: LLM_DEFAULTS.openaiTemperature,
        stream: true,
        stream_options: { include_usage: true },
    };

    // Only include max_tokens if explicitly set
    if (tokenLimit) {
        requestBody.max_tokens = tokenLimit;
    }

    const body = JSON.stringify(requestBody);

    let response;
    if (isLocal) {
        try {
            response = await fetch(proxiedUrl(endpoint), {
                signal,
                method: 'POST',
                headers: { ...getProxyHeaders(), ...headers },
                                   body: body,
            });
        } catch (proxyError) {
            if (signal?.aborted) throw proxyError;
            console.warn(`${MODULE_NAME} CORS proxy failed for OpenAI endpoint, trying direct:`, proxyError.message);
            try {
                response = await fetch(endpoint, {
                    signal,
                    method: 'POST',
                    headers: headers,
                    body: body,
                });
            } catch (directError) {
                if (signal?.aborted) throw directError;
                throw new ConnectionError(
                    `Failed to connect to ${baseUrl}. ` +
                    `Enable the CORS proxy in config.yaml (enableCorsProxy: true). ` +
                    `Proxy error: ${proxyError.message}. Direct error: ${directError.message}`,
                    { retryable: true }
                );
            }
        }
    } else {
        try {
            response = await fetch(endpoint, {
                signal,
                method: 'POST',
                headers: headers,
                body: body,
            });
        } catch (directError) {
            if (signal?.aborted) throw directError;
            throw new ConnectionError(
                `Failed to connect to ${baseUrl}: ${directError.message}`,
                { retryable: true }
            );
        }
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        if (response.status === 401) {
            throw new ConnectionError(
                'OpenAI Compatible endpoint returned 401 Unauthorized. Check your API key.',
                { retryable: false, status: 401 }
            );
        }
        if (response.status === 403) {
            throw new ConnectionError(
                `OpenAI Compatible endpoint returned 403 Forbidden: ${errorText}`,
                { retryable: false, status: 403 }
            );
        }
        throw new ConnectionError(
            `OpenAI Compatible request failed (${response.status}): ${errorText}`,
                                  { retryable: response.status >= 500 || response.status === 429, status: response.status }
        );
    }

    // ─── Stream reading ──────────────────────────────────────────
    // Read SSE chunks and assemble the full response content.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let usage = {};
    let completed = false;
    let buffer = '';

    function readLine(line) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { completed = true; return; }
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }
        if (parsed.usage) usage = providerUsage(parsed);
        if (parsed.choices?.[0]?.finish_reason) completed = true;
        if (hasProviderRefusal(parsed)) {
            throw new InvalidModelOutputError('the provider reported a refusal or content filter');
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') fullContent += delta;
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE lines
            const lines = buffer.split('\n');
            // Keep the last potentially incomplete line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                readLine(line);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) readLine(buffer);
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }

    if (!completed) throw new ConnectionError('OpenAI stream ended before generation completed. Summary not saved.', { retryable: true });
    return { text: requireModelOutput(fullContent), ...usage };
}

/**
 * Test the connection to an OpenAI-compatible endpoint.
 * @param {string} url
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testOpenAIConnection(url, apiKey, model) {
    try {
        const result = await sendViaOpenAI(
            url,
            apiKey,
            model || 'test',
            'You are a test assistant.',
            'Respond with exactly: CONNECTION_OK',
            LLM_DEFAULTS.testMaxTokens
        );
        return {
            success: true,
            message: `Connection successful! Response: "${result.text.substring(0, LLM_DEFAULTS.testPreviewLength)}"`,
        };
    } catch (error) {
        return {
            success: false,
            message: `Connection failed: ${error.message}`,
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Show live ST profiles and track native create/update/delete events.
 * @param {HTMLSelectElement} selectElement - The dropdown to populate
 * @param {string} currentValue - The currently selected profile ID
 * @returns {boolean} - Whether population succeeded
 */
export function populateProfileDropdown(selectElement, currentValue, onChange = () => {}) {
    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;
    if (!service || !context.extensionSettings.connectionManager) return false;
    const render = selectedId => {
        const profiles = context.extensionSettings.connectionManager.profiles || [];
        selectElement.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '-- Select a Profile --';
        selectElement.appendChild(placeholder);
        for (const profile of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
            if (service.isProfileSupported && !service.isProfileSupported(profile)) continue;
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name;
            selectElement.appendChild(option);
        }
        selectElement.value = selectedId || '';
    };
    render(currentValue);
    selectElement.addEventListener('change', () => onChange(selectElement.value));
    const events = context.eventTypes || context.event_types;
    const refresh = () => render(selectElement.value);
    context.eventSource.on(events.CONNECTION_PROFILE_CREATED, refresh);
    context.eventSource.on(events.CONNECTION_PROFILE_UPDATED, (oldProfile, newProfile) => {
        const previous = selectElement.value;
        render(previous === oldProfile.id ? newProfile.id : previous);
        if (selectElement.value !== previous) onChange(selectElement.value);
    });
    context.eventSource.on(events.CONNECTION_PROFILE_DELETED, profile => {
        const selected = selectElement.value === profile.id;
        render(selected ? '' : selectElement.value);
        if (selected) onChange('');
    });
    return true;
}

/**
 * Get a human-readable name for the current connection source.
 * @param {object} settings
 * @returns {string}
 */
export function getConnectionDisplayName(settings) {
    switch (settings.connectionSource) {
        case 'default':
            return 'Default (Main API)';
        case 'profile':
            return `Profile: ${settings.connectionProfileId || '(none)'}`;
        case 'ollama':
            return `Ollama: ${settings.ollamaModel || '(no model)'}`;
        case 'openai':
            return `OpenAI: ${settings.openaiModel || '(no model)'}`;
        default:
            return 'Default (Main API)';
    }
}
