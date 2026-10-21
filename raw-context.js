import { collectPassage, pendingSourceIds, sourceId } from './summary-sources.js';

const tokenCache = new WeakMap();
const positive = (value, fallback) => Math.max(1, Math.floor(Number(value) || fallback));

/** One exchange starts with user messages and includes their following assistant replies. */
export function chatExchanges(chat) {
    const groups = [];
    let current = null;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (message.is_system && !message.extra?.sc_context && !message.extra?.sc_ghosted) continue;
        if (!current || (message.is_user && current.hasAssistant)) {
            current = { indices: [], hasAssistant: false };
            groups.push(current);
        }
        current.indices.push(i);
        if (!message.is_user) current.hasAssistant = true;
    }
    return groups;
}

export function blindZoneStart(chat, settings) {
    const groups = chatExchanges(chat);
    const completed = groups.filter(group => group.hasAssistant);
    const count = Math.max(0, Math.floor(Number(settings.blindZoneExchanges) || 0));
    // Unanswered trailing user messages are never pulled into a previous exchange.
    const trailingStart = groups.length && !groups.at(-1).hasAssistant ? groups.at(-1).indices[0] : chat.length;
    return count && completed.length ? completed[Math.max(0, completed.length - count)].indices[0] : trailingStart;
}

async function measure(text, anchor) {
    const ctx = SillyTavern.getContext();
    const model = ctx.getTokenizerModel?.() ?? ctx.mainApi ?? 'default';
    const previous = tokenCache.get(anchor);
    if (previous?.text === text && previous.model === model && previous.tokenizer === ctx.getTokenCountAsync) return previous;
    const count = typeof ctx.getTokenCountAsync === 'function' ? await ctx.getTokenCountAsync(text) : Math.ceil(text.length / 4);
    const result = { text, model, tokenizer: ctx.getTokenCountAsync, tokens: Math.max(1, Number(count) || 1),
        estimated: typeof ctx.getTokenCountAsync !== 'function' };
    tokenCache.set(anchor, result);
    return result;
}

/** Blind exchanges are removed before tokenization, retention and batching. */
export async function planRawContext(chat, store, settings) {
    const covered = pendingSourceIds(store);
    const groups = chatExchanges(chat).filter(group => group.hasAssistant);
    const blindStart = blindZoneStart(chat, settings);
    const eligible = [];
    for (const group of groups) {
        if (group.indices[0] >= blindStart) continue;
        const indices = group.indices.filter(index => !chat[index].is_system && !covered.has(sourceId(chat[index])));
        const passage = collectPassage(chat, indices);
        if (!passage.indices.some(index => !chat[index].is_user)) continue;
        const measured = await measure(passage.text, chat[group.indices[0]]);
        eligible.push({ ...passage, tokens: measured.tokens, estimated: measured.estimated });
    }
    const retainedBudget = positive(settings.retainedContextTokens, 12000);
    const batchBudget = positive(settings.batchContextTokens, 24000);
    let boundary = eligible.length;
    let retainedTokens = 0;
    while (boundary > 0 && retainedTokens < retainedBudget) retainedTokens += eligible[--boundary].tokens;
    const available = eligible.slice(0, boundary);
    const availableTokens = available.reduce((sum, group) => sum + group.tokens, 0);
    const batch = [];
    let batchTokens = 0;
    for (const group of available) {
        if (batch.length && batchTokens + group.tokens > batchBudget) break;
        batch.push(group);
        batchTokens += group.tokens;
        if (batchTokens >= batchBudget) break;
    }
    const passage = collectPassage(chat, batch.flatMap(group => group.indices));
    let batchCount = 0;
    let currentTokens = 0;
    for (const group of available) {
        if (currentTokens && currentTokens + group.tokens > batchBudget) { batchCount++; currentTokens = 0; }
        currentTokens += group.tokens;
        if (currentTokens >= batchBudget) { batchCount++; currentTokens = 0; }
    }
    if (currentTokens) batchCount++;
    return { passage, batchTokens, availableTokens, retainedTokens, batchBudget, retainedBudget,
        batchCount,
        ready: availableTokens >= batchBudget, hasBatch: batch.length > 0,
        availableMessageIds: available.flatMap(group => group.sourceMessageIds),
        blindStart, blindExchanges: groups.filter(group => group.indices[0] >= blindStart).length,
        estimated: eligible.some(group => group.estimated) };
}
