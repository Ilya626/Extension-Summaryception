/** Token budgets and original L0 lineage. Counts are frozen at generation time. */
export const LAYER_COUNT = 5;

export function layerBudgets(settings) {
    if (settings.overrideLayerBudgets) {
        return Array.from({ length: LAYER_COUNT }, (_, i) => Math.max(1, Math.floor(Number(settings.layerTokenBudgets?.[i]) || 1)));
    }
    const total = Math.max(LAYER_COUNT, Math.floor(Number(settings.memoryTokenBudget) || 15500));
    const divisor = Math.max(1.01, Number(settings.layerDivisor) || 2);
    const weights = Array.from({ length: LAYER_COUNT }, (_, i) => divisor ** -i);
    const sum = weights.reduce((a, b) => a + b, 0);
    const budgets = weights.map(w => Math.max(1, Math.floor(total * w / sum)));
    // Largest remainder allocation gives an exact total, including small budgets.
    const order = weights.map((w, i) => ({ i, fraction: total * w / sum % 1 }))
        .sort((a, b) => b.fraction - a.fraction);
    for (let n = total - budgets.reduce((a, b) => a + b, 0), i = 0; i < n; i++) budgets[order[i % LAYER_COUNT].i]++;
    while (budgets.reduce((a, b) => a + b, 0) > total) {
        const largest = budgets.indexOf(Math.max(...budgets));
        budgets[largest]--;
    }
    return budgets;
}

export const layerTokens = layer => (layer || []).reduce((sum, snippet) => sum + (snippet.tokenCount || 0), 0);

export function providerUsage(data) {
    const candidates = [
        ['usage.completion_tokens', data?.usage?.completion_tokens],
        ['usage.output_tokens', data?.usage?.output_tokens],
        ['usageMetadata.candidatesTokenCount', data?.usageMetadata?.candidatesTokenCount],
        ['eval_count', data?.eval_count],
    ];
    const found = candidates.find(([, count]) => Number.isFinite(count) && count >= 0);
    return found ? { tokenCount: found[1], tokenCountSource: found[0], usage: structuredClone(data.usage ?? data.usageMetadata ?? { eval_count: data.eval_count }) } : {};
}

export async function countOnce(snippet) {
    if (Number.isFinite(snippet.tokenCount) && snippet.tokenCount >= 0) return snippet;
    const count = SillyTavern.getContext().getTokenCountAsync;
    const measured = typeof count === 'function' ? await count(snippet.text) : Math.ceil(snippet.text.length / 4);
    snippet.tokenCount = Math.max(1, Number(measured) || 1);
    snippet.tokenCountSource = typeof count === 'function' ? 'estimated: ST tokenizer' : 'estimated: characters / 4';
    return snippet;
}

export function archiveL0(store, snippet) {
    store.l0Archive ??= {};
    const id = snippet.id;
    snippet.l0SourceIds = [id];
    delete snippet.compressionOverrides;
    store.l0Archive[id] = { text: snippet.text, tokenCount: snippet.tokenCount, tokenCountSource: snippet.tokenCountSource,
        ...(snippet.sourceMessageIds ? { sourceMessageIds: [...snippet.sourceMessageIds] } : {}),
        ...(snippet.sourceFingerprints ? { sourceFingerprints: { ...snippet.sourceFingerprints } } : {}),
        ...(snippet.usage ? { usage: structuredClone(snippet.usage) } : {}) };
}

/** A user revision replaces the source text for its own lineage on later transfers. */
export function preserveSourceRevision(snippet) {
    if (snippet.l0SourceIds?.length) {
        snippet.compressionOverrides = [{ l0SourceIds: [...snippet.l0SourceIds], text: snippet.text }];
    }
}

export function pruneArchive(store) {
    const live = new Set(store.layers.flatMap(layer => (layer || []).flatMap(sn => sn.l0SourceIds || [])));
    for (const id of Object.keys(store.l0Archive || {})) if (!live.has(id)) delete store.l0Archive[id];
}

export async function prepareTokenMemory(store) {
    store.l0Archive ??= {};
    for (let i = 0; i < store.layers.length; i++) {
        for (const snippet of store.layers[i] || []) {
            await countOnce(snippet);
            if (!snippet.l0SourceIds?.length) {
                if (i === 0) archiveL0(store, snippet);
                else snippet.originalL0Unavailable = true;
            }
        }
    }
    pruneArchive(store);
}

/** Mutates a caller-owned draft and optionally publishes each completed transition. */
export async function rebalanceMemory(store, settings, summarize, mergeSources, onTransition = null) {
    await prepareTokenMemory(store);
    const budgets = layerBudgets(settings);
    if (store.layers.slice(LAYER_COUNT).some(layer => layer?.length)) throw new Error('Legacy layers beyond L4 must be exported and rebuilt before token migration.');
    for (let i = 0; i < LAYER_COUNT; i++) {
        const layer = store.layers[i] ??= [];
        while (layerTokens(layer) > budgets[i]) {
            if (i === LAYER_COUNT - 1) throw new Error('L4 token budget is full. Increase the memory budget or remove a summary. Existing memory and source messages were kept.');
            const excess = layerTokens(layer) - budgets[i];
            const children = [];
            let moved = 0;
            for (const snippet of layer) {
                children.push(snippet);
                moved += snippet.tokenCount;
                if (moved >= excess) break;
            }
            const ids = [...new Set(children.flatMap(sn => sn.l0SourceIds || []))];
            if (children.some(sn => sn.originalL0Unavailable) || !ids.length || ids.some(id => !store.l0Archive[id])) {
                throw new Error('Original L0 summaries are unavailable for this legacy memory. Export it and regenerate from recorded messages before compression.');
            }
            const originals = ids.map(id => store.l0Archive[id]);
            const originalTokens = originals.reduce((sum, sn) => sum + sn.tokenCount, 0);
            const overrides = children.flatMap(sn => sn.compressionOverrides || []);
            const overrideById = new Map(overrides.flatMap(item => item.l0SourceIds.map(id => [id, item])));
            const emitted = new Set();
            const sourceTexts = ids.flatMap(id => {
                const revision = overrideById.get(id);
                if (!revision) return [store.l0Archive[id].text];
                if (emitted.has(revision)) return [];
                emitted.add(revision);
                return [revision.text];
            });
            const prior = store.layers.slice(i + 1).reverse().flatMap(l => (l || []).map(sn => sn.text)).join('\n\n');
            const result = await summarize(sourceTexts.join('\n\n'), prior, null, sourceTexts);
            if (!result) throw new Error('Layer compression failed. Existing memory and source messages were kept.');
            await countOnce(result);
            layer.splice(0, children.length);
            (store.layers[i + 1] ??= []).push({ ...result, ...mergeSources(children), l0SourceIds: ids,
                originalL0Tokens: originalTokens, ...(overrides.length ? { compressionOverrides: overrides } : {}),
                fromLayer: i, mergedCount: children.length, timestamp: Date.now() });
            await onTransition?.(store);
        }
    }
    pruneArchive(store);
}
