/** Model-output checks shared by chat tracking and all summarizer connections. */
export class InvalidModelOutputError extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'InvalidModelOutputError';
    }
}

export function stripReasoningBlocks(raw) {
    return String(raw ?? '')
        .replace(/<(think|thinking|reasoning|thought|reflect|inner_monologue)>[\s\S]*?(?:<\/\1>|$)/gi, '')
        .replace(/<\|channel>(?:thought|analysis)[\s\S]*?<channel\|>/gi, '')
        .replace(/<output>([\s\S]*?)<\/output>/gi, '$1')
        .trim();
}

export function hasProviderRefusal(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const choice = payload.choices?.[0];
    const message = choice?.message || choice?.delta || payload.message || payload;
    return Boolean(
        message.refusal
        || message.content?.some?.(part => part.type === 'refusal')
        || ['content_filter', 'safety', 'refusal'].includes(choice?.finish_reason || payload.finish_reason)
        || payload.extra?.refusal
        || ['content_filter', 'safety', 'refusal'].includes(payload.extra?.finish_reason)
        || (payload.data && hasProviderRefusal(payload.data))
    );
}

// Pattern families cross-checked against HarmBench and StrongREJECT:
// https://github.com/centerforaisafety/HarmBench/blob/main/baselines/artprompt/jailbreak/safe_eval.py
// https://github.com/dsbowen/strong_reject/blob/main/strong_reject/eval_files/string_matching.txt
// Text matching is heuristic. Require a refusal of the writing/request task,
// rather than any first-person inability inside the story.
function isTextRefusal(opening) {
    const prefix = /^(?:(?:(?:i(?:['’]m| am)\s+)?(?:(?:really|truly|very|so)\s+)?sorry|my apologies|i apologize|i(?:['’]m| am) afraid|unfortunately|извините|извини|извиняюсь|простите|прости|к сожалению|мне жаль)[,!:;.—\s]+|(?:as an? (?:ai|language model|(?:helpful )?assistant)|i(?:['’]m| am) an? (?:ai|language model))[^\n.!?]*?[,\n]\s*)+/i;
    const text = opening.replace(prefix, '').replace(/^(?:but|но)\s+/i, '');
    const firstParagraph = text.split(/\n\s*\n/, 1)[0];
    // An attributed line of dialogue is an event, even if it mentions a task.
    const attributedSpeech = /(?:["”»][,;]?\s*|[,;]\s*(?:[—–-]\s*)?)(?:(?:i|he|she|they|\p{Lu}[\p{L}'’-]*)\s+(?:say|says|said|tell|tells|told|reply|replies|replied|whisper|whispers|whispered|answer|answers|answered)\b|(?:сказал[аи]?|говорю|говорит|ответил[аи]?|прошептал[аи]?|пробормотал[аи]?)(?=\s|[,.!?]))/u;
    if (attributedSpeech.test(firstParagraph)) return false;

    const englishSelf = /^(?:i\s+(?:can(?:not|['’]t)|do not(?: feel comfortable(?: with)?)?|don['’]t(?: feel comfortable(?: with)?)?|won['’]t|will not|will refrain from|would prefer not to|am (?:unable to|not able to|not allowed to|not comfortable(?: with)?)|(?:must|have to|need to)(?=\s+(?:decline|refuse)))|i['’]m\s+(?:unable to|not able to|not allowed to|not comfortable(?: with)?)|i['’]d prefer not to)\s*/i;
    if (englishSelf.test(text)) {
        const task = text.replace(englishSelf, '').split(/[.!?\n]/, 1)[0];
        if (/^(?:help|assist|compl|fulfill?|generat|writ|provid|summari[sz]|process|engag|continu|creat|participat|declin|refus|support|recommend|produc|describ|discuss|respond|answer|offer)\w*\b/i.test(task)
            && /\b(?:request|content|prompt|instruction|roleplay|role-play|scene|scenario|conversation|dialogue|story|summary|material|explicit|sexual|graphic)\b/i.test(task)) return true;
        if (/^(?:(?:help|assist|comply)\s+(?:you\s+)?with\s+(?:this|that)|do\s+(?:this|that))\s*$/i.test(task)) return true;
    }
    const russianSelf = /^(?:я\s+)?(?:не могу|не буду|не в состоянии|вынужден[а]? отказаться)\s+/i;
    if (russianSelf.test(text)) {
        const task = text.replace(russianSelf, '').split(/[.!?\n]/, 1)[0];
        if (/^(?:помо[чг]|помога|выполн|испол|состав|сгенер|генер|суммир|резюмир|обработ|предостав|писать|напис|созда|продолж|участв|описа|описы|поддерж)/i.test(task)
            && /(?:запрос|контент|материал|ролев|ролепле|сцен[уыае]|сценар|истори[юия]|диалог|переписк|резюме|порно|эрот|сексуал|насили)/i.test(task)) return true;
        if (/^(?:помочь\s+(?:вам\s+)?с\s+этим|выполнить\s+это)\s*$/i.test(task)) return true;
    }
    if (/^(?:this|your|that)\s+(?:request|content|prompt)\b[^.!?\n]*(?:violat|against my|not allowed|cannot be fulfilled)/i.test(text)) return true;
    if (/^(?:этот|ваш|данный|такой)\s+(?:запрос|контент|материал)[^.!?\n]*(?:нарушает|противоречит|запрещён|не могу выполнить)/i.test(text)) return true;
    return /^(?:(?:抱歉|对不起|很抱歉|非常抱歉)[，,。\s]*)?(?:但[是，,\s]*)?我(?:无法|不能|不可以)(?:帮助|协助|提供|生成|继续|满足|处理)/u.test(text);
}

export function getModelOutputIssue(text, payload) {
    if (hasProviderRefusal(payload)) return 'the provider reported a refusal or content filter';
    const visible = stripReasoningBlocks(text);
    if (!visible) return 'the model returned an empty response';
    const opening = visible.replace(/^(?:\*{1,2}|#{1,6}\s+|(?:assistant|response|answer):\s*)+/gi, '');
    if (isTextRefusal(opening)) return 'the model returned a refusal';
    return null;
}

export function requireModelOutput(text, payload) {
    const issue = getModelOutputIssue(text, payload);
    if (issue) throw new InvalidModelOutputError(issue);
    return text;
}
