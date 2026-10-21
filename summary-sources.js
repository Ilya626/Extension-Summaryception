import { getModelOutputIssue } from './output-validation.js';

const newId = () => globalThis.crypto?.randomUUID?.() || `sc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function sourceId(message) {
    message.extra ??= {};
    return message.extra.sc_message_id ??= newId();
}

export function canSummarizeMessage(message) {
    return Boolean(message?.mes?.trim())
        && (!message.is_system || message.extra?.sc_ghosted)
        && (message.is_user || !getModelOutputIssue(message.mes, message));
}

export function snippets(store) {
    return store.layers.flatMap(layer => layer || []);
}

export function ensureSummarySources(store, chat) {
    if (!chat.length) return; // ST can emit CHAT_CHANGED before messages finish loading.
    for (const message of chat) sourceId(message);
    for (const snippet of snippets(store)) {
        snippet.id ??= newId();
        if (snippet.sourceStatus === 'unlinked') continue;
        if (!Array.isArray(snippet.sourceMessageIds) && snippet.turnRange) {
            const [start, end] = snippet.turnRange;
            snippet.sourceMessageIds = chat.slice(start, end + 1).filter(canSummarizeMessage).map(sourceId);
            // Old versions stored only bounds, not the actual submitted set.
            snippet.sourceStatus = 'inferred';
        }
    }
    const unknown = snippets(store).some(snippet => snippet.sourceStatus !== 'unlinked' && !Array.isArray(snippet.sourceMessageIds));
    if (unknown && !Array.isArray(store.legacySourceIds)) {
        store.legacySourceIds = chat.slice(0, Math.max(0, store.summarizedUpTo + 1)).map(sourceId);
    }
    if (!unknown) delete store.legacySourceIds;
}

export function coveredSourceIds(store) {
    return new Set([
        ...snippets(store).flatMap(snippet => snippet.sourceMessageIds || []),
        ...(store.legacySourceIds || []),
    ]);
}

export function pendingSourceIds(store) {
    return new Set([...coveredSourceIds(store), ...(store.skippedMessageIds || [])]);
}

export function updateSourceBoundary(store, chat) {
    const covered = pendingSourceIds(store);
    store.summarizedUpTo = chat.reduce((last, message, index) => covered.has(sourceId(message)) ? index : last, -1);
}

export function collectPassage(chat, indices) {
    const selected = indices.filter(index => canSummarizeMessage(chat[index]));
    return {
        indices: selected,
        sourceMessageIds: selected.map(index => sourceId(chat[index])),
        text: selected.map(index => {
            const message = chat[index];
            return `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes.trim()}`;
        }).join('\n'),
    };
}

export function resolveSnippetSources(snippet, chat) {
    const byId = new Map(chat.map((message, index) => [sourceId(message), { message, index }]));
    const ids = snippet.sourceMessageIds;
    const found = (ids || []).map(id => byId.get(id));
    return {
        known: Array.isArray(ids),
        missing: found.filter(item => !item).length,
        indices: found.filter(Boolean).map(item => item.index),
        // Saved membership, independent of present visibility. Never substitute
        // a neighbour after deletion or re-run a numeric range filter.
        text: found.filter(Boolean).map(({ message }) => `${message.name || (message.is_user ? 'User' : 'Assistant')}: ${message.mes?.trim() || ''}`).join('\n'),
    };
}

export function mergedSources(children) {
    const known = children.every(snippet => Array.isArray(snippet.sourceMessageIds));
    return {
        id: newId(),
        ...(known ? { sourceMessageIds: [...new Set(children.flatMap(snippet => snippet.sourceMessageIds))] } : {}),
        sourceSummaryIds: children.map(snippet => snippet.id),
        sourceStatus: known ? (children.every(snippet => snippet.sourceStatus === 'exact') ? 'exact' : 'inferred')
            : children.some(snippet => snippet.sourceStatus === 'unlinked') ? 'unlinked' : 'inferred',
    };
}

export function newSnippetSources(passage) {
    return { id: newId(), sourceMessageIds: passage.sourceMessageIds, sourceStatus: 'exact' };
}

export function formatSourceIndices(indices) {
    const ranges = [];
    for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && last[1] + 1 === index) last[1] = index;
        else ranges.push([index, index]);
    }
    return ranges.map(([start, end]) => start === end ? String(start) : `${start}–${end}`).join(', ');
}
