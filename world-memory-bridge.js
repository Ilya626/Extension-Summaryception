/** A small public boundary for companion addons; no prompts or settings are replaced. */
export function installWorldMemoryBridge({ getStore, getSettings, isBusy, version,
    sendRequest, sourceId, captureSourceFingerprints, cleanText }) {
    const api = {
        version,
        protocol: 1,
        isBusy,
        snapshot() {
            const ctx = SillyTavern.getContext();
            const store = getStore();
            const live = new Map((store.layers || []).flat().filter(Boolean).map(item => [item.id, item]));
            const archives = { ...(store.l0Archive || {}) };
            for (const item of store.layers[0] || []) archives[item.id] = { ...archives[item.id], ...item };
            const messages = new Map(ctx.chat.map((message, index) => [sourceId(message), { message, index }]));
            const packets = Object.entries(archives).map(([id, saved]) => {
                const item = live.get(id);
                const ids = saved.sourceMessageIds || item?.sourceMessageIds || [];
                const sources = ids.flatMap(source => {
                    const found = messages.get(source);
                    return found ? [{ id: source, index: found.index, name: found.message.name || (found.message.is_user ? 'User' : 'Assistant'),
                        isUser: Boolean(found.message.is_user), text: found.message.mes || '' }] : [];
                });
                const expected = saved.sourceFingerprints || item?.sourceFingerprints;
                const current = captureSourceFingerprints(ctx.chat, ids);
                return { id, text: saved.text || '', sourceMessageIds: ids, sources,
                    stale: Boolean(expected && ids.some(key => expected[key] !== current[key])),
                    sourceStatus: ids.length ? 'linked' : 'summary-only',
                    order: sources.length ? Math.min(...sources.map(source => source.index)) : Number.MAX_SAFE_INTEGER };
            }).sort((a, b) => a.order - b.order);
            return { chatId: ctx.chatId || '', metadata: ctx.chatMetadata, chat: ctx.chat,
                characterName: ctx.characters?.[ctx.characterId]?.name || '', playerName: ctx.name1 || 'User', packets };
        },
        async request(systemPrompt, prompt, options = {}) {
            const settings = { ...getSettings() };
            if (Number(options.responseTokens) > 0) {
                settings.summarizerResponseLength = Number(options.responseTokens);
                settings.openaiMaxTokens = Number(options.responseTokens);
                settings.ollamaMaxTokens = Number(options.responseTokens);
            }
            const result = await sendRequest(settings, systemPrompt, prompt, { ...options, returnDetails: true });
            return { ...result, text: cleanText(result.text || '') };
        },
    };
    globalThis.SummaryceptionAPI = Object.freeze(api);
    return api;
}
