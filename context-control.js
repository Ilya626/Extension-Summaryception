/** Native ST message inclusion. sc_* fields record ownership, never filter prompts. */

export function syncContextOverrides(chat) {
    let changed = false;
    for (const message of chat) {
        const previous = message.extra?.sc_context;
        // Do not adopt ST system messages or messages already hidden by the user.
        if (!previous && message.is_system && !message.extra?.sc_ghosted) continue;
        message.extra ??= {};
        const hidden = Boolean(message.is_system);
        if (!previous) {
            message.extra.sc_context = {
                hidden,
                manual: Boolean(message.extra.sc_ghosted && !hidden),
            };
            changed = true;
        } else if (previous.hidden !== hidden) {
            previous.hidden = hidden;
            previous.manual = true;
            delete message.extra.sc_ghosted;
            changed = true;
        }
    }
    return changed;
}

export function recordManualContext(message, hidden) {
    message.extra ??= {};
    message.extra.sc_context = { hidden, manual: true };
    delete message.extra.sc_ghosted;
}

function consecutiveRanges(indices) {
    const ranges = [];
    for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && last[1] === index - 1) last[1] = index;
        else ranges.push([index, index]);
    }
    return ranges;
}

export async function setContextForMessages(chat, indices, hidden, manual = false) {
    const changes = indices.filter(index => chat[index] && Boolean(chat[index].is_system) !== hidden);
    for (const [start, end] of consecutiveRanges(changes)) {
        const context = SillyTavern.getContext();
        if (context.chat !== chat) throw new Error('Chat changed before message context could be updated');
        await context.executeSlashCommandsWithOptions(`/${hidden ? 'hide' : 'unhide'} ${start}-${end}`, { showOutput: false });
        for (let index = start; index <= end; index++) {
            if (Boolean(chat[index].is_system) !== hidden) throw new Error(`ST did not update message ${index}`);
        }
    }
    for (const index of indices) {
        const message = chat[index];
        if (!message) continue;
        if (manual) recordManualContext(message, hidden);
        else {
            message.extra ??= {};
            message.extra.sc_context = { hidden, manual: false };
            if (hidden) message.extra.sc_ghosted = true;
            else delete message.extra.sc_ghosted;
        }
    }
}

// Called only after a new batch has produced a valid summary.
export async function applySummaryContextPolicy(chat, settings, startIndex, endIndex, sourceIndices = null) {
    syncContextOverrides(chat);
    const hide = [];
    const unhide = [];
    const start = settings.reapplyGhostingOnSummary ? 0 : startIndex;
    const selected = sourceIndices && new Set(sourceIndices);
    for (let index = start; index <= endIndex && index < chat.length; index++) {
        if (selected && !selected.has(index)) continue;
        const message = chat[index];
        const state = message.extra?.sc_context;
        if (!state || (state.manual && !settings.reapplyGhostingOnSummary)) continue;
        const shouldHide = message.is_user ? settings.ghostUserMessages : settings.ghostAssistantMessages;
        if (shouldHide) hide.push(index);
        else if (settings.reapplyGhostingOnSummary) unhide.push(index);
    }
    await setContextForMessages(chat, hide, true);
    await setContextForMessages(chat, unhide, false);
}

export async function restoreAutomaticGhosts(chat) {
    syncContextOverrides(chat);
    const owned = chat.flatMap((message, index) =>
        message.extra?.sc_ghosted && !message.extra.sc_context?.manual ? [index] : []);
    await setContextForMessages(chat, owned, false);
}
