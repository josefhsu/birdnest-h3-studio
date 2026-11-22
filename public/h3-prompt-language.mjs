import { Converter } from './vendor/opencc-1.4.2.mjs';

const han = /\p{Script=Han}/u;
const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const chineseLanguage = /^(?:zh(?:-[a-z]+)*|yue|cmn|chinese|mandarin(?: chinese)?|cantonese|taiwanese(?: hokkien| mandarin)?|hokkien|中文|國語|国语|普通話|普通话|華語|华语|粵語|粤语|廣東話|广东话|台語|臺語|台语|閩南語|闽南语)$/iu;
const bodyHeaders = /(?:^|\n)\s*(?:subject_definitions|summary|retention_analysis|(?:integrated_multimodal_|detailed_)description|overall_soundscape|non_diegetic_music)\s*:/i;
const voiceDirection = /^\s*(?:[（(].*?[）)]\s*$|(?:聲線|声线|聲音(?:設計)?|声音(?:设计)?|音色|語氣|语气|情緒|情绪|語速|语速|說話速度|说话速度|聲音描述|声音描述|[Vv]oice|[Tt]one|[Ss]peed)\s*[:：])/u;
const speechCue = /(?:台詞|臺詞|台词|對白|对白|對話|对话|旁白|口白|說(?:道|著)?|说(?:道|着)?|回答|回應|回应|喊(?:道|著|着)?|問(?:道)?|问(?:道)?|低語|低语|呢喃|喃喃|唱(?:道|出)?|吼(?:道)?|唸(?:道)?|念(?:道)?|\b(?:dialogue|narration|says?|said|speaks?|asks?|replies|responds?|whispers?|shouts?|sings?)\b)[^。！？；:：\n"'「『“]{0,24}[:：,，\s]*$/iu;
const directSpeech = /^([^。！？；:：\n]{0,64}(?:(?:台詞|臺詞|台词|對白|对白|旁白|口白|說(?:道)?|说(?:道)?|回答|回應|回应|喊(?:道)?|問(?:道)?|问(?:道)?|低語|低语|唱(?:道)?)\s*)[:：])[ \t]*(.+)$/u;
const directSpeaker = /^(\s*(?:[-*]\s*)?(?:[男女](?:主角|配角|角色|孩|人)|角色\s*[A-Z0-9]*)(?:\s*[（(][^）)]+[）)])?\s*[:：])[ \t]*(.+)$/u;
const directVisibleText = /^(\s*(?:招牌(?:上)?[寫写][著着]|看板(?:上)?[寫写][著着]|[螢屏]幕[顯显]示|[畫画]面文字|[圖图]中文字)\s*[:：])[ \t]*(.+)$/u;
const visibleText = /(?:招牌|標牌|标牌|看板|告示|螢幕|屏幕|字幕|標題|标题|字樣|字样|寫[著着有]|写[著着有]|顯示|显示|\b(?:sign|caption|title|screen|reads|text|logo|subtitle)\b)[^。！？；\n"'「『“]{0,32}$/iu;
const nameCue = /^\s*(?:[-*]\s*)?(?:[A-Za-z][A-Za-z .'-]{0,22}|(?:[男女][主配角色生士人]|角色\s*[\p{Script=Han}A-Z0-9]*|[\p{Script=Han}]{2,4})(?:[（(][^）)]+[）)])?)\s*[:：]\s*$/u;
// Keep official and site-specific references, explicit dialogue, visible-text tags and literal quotes intact.
const tokens = /<d\b[^>]*>[\s\S]*?<\/d\s*>|<(text|ocr|caption)\b[^>]*>[\s\S]*?<\/\1\s*>|「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|[@#](?:圖片|图片|Image|Picture|影片|视频|Video|音訊|音频|Audio|Subject)\s*(?:\(\s*\d+\s*\)|\d+)|<\/?[A-Za-z][^<>\n]*>|\[(?:Shot|S\d)[^\]\n]*\]|\b\d{1,2}:\d{2}(?:\.\d+)?\b/giu;
let traditional;
let simplified;

const convertTraditional = text => !han.test(text) || kana.test(text) ? text : (traditional ||= Converter({ from: 'cn', to: 'tw' }))(text);
const convertSimplified = text => !han.test(text) || kana.test(text) ? text : (simplified ||= Converter({ from: 'tw', to: 'cn' }))(text);

function dialogue(text, convert) {
  const tag = /^<d\b[^>]*>/i.exec(text)?.[0] || '';
  const endTag = tag ? /<\/d\s*>$/i.exec(text)?.[0] || '' : '';
  const speech = text.slice(tag.length, endTag ? -endTag.length : undefined);
  const marker = /^\s*\[([^\]\n]+)\]/u.exec(speech);
  if (marker && !chineseLanguage.test(marker[1].trim())) return text;
  const start = marker?.[0] || '';
  return tag + start + convert(speech.slice(start.length)) + endTag;
}

function* spans(text, kind) {
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const value = match[0];
    const start = match.index;
    if (start > offset) yield ['body', text.slice(offset, start)];
    offset = start + value.length;
    let type = 'literal';
    if (/^<d\b/i.test(value)) {
      type = 'speech';
    } else if (/^[「『“"]/u.test(value)) {
      const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
      const after = text.slice(offset).split('\n', 1)[0];
      const alone = /^\s*(?:[-*]\s*)?$/u.test(before) && /^\s*[。.!?！？]?\s*$/u.test(after);
      if (kind !== 'image' && !visibleText.test(before) &&
          (kind === 'tts' || speechCue.test(before) || nameCue.test(before) || alone)) {
        type = 'speech';
      } else if (!visibleText.test(before) && kind !== 'image' && !alone) {
        type = 'body';
      }
    }
    yield [type, value];
  }
  if (offset < text.length) yield ['body', text.slice(offset)];
}

export function traditionalPrompt(text, kind) {
  if (typeof text !== 'string' || !han.test(text)) return text;
  return Array.from(spans(text, kind), ([type, value]) =>
    type === 'speech' ? dialogue(value, convertTraditional) :
      type === 'body' ? convertTraditional(value) : value).join('');
}

export function planModelPrompt(text, kind) {
  const parts = [];
  const plainTts = kind === 'tts' && !bodyHeaders.test(text) && !/<d\b/i.test(text);
  function emit(value) {
    if (!value) return;
    if (typeof value === 'string' && typeof parts.at(-1) === 'string') parts[parts.length - 1] += value;
    else parts.push(value);
  }
  function describe(value) {
    if (!han.test(value) || kana.test(value)) {
      emit(value);
      return;
    }
    const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    const colon = /[:：]$/u.test(core);
    emit(leading);
    emit({ translate: convertSimplified(colon ? core.slice(0, -1) : core) });
    emit((colon ? ':' : '') + trailing);
  }
  for (const [type, value] of spans(text, kind)) {
    if (type === 'speech') emit(dialogue(value, convertSimplified));
    else if (type === 'literal') emit(value);
    else for (const line of value.split(/(\r?\n)/)) {
      if (!han.test(line)) {
        emit(line);
        continue;
      }
      const displayed = directVisibleText.exec(line);
      const spoken = kind !== 'image' && !visibleText.test(line.split(/[:：]/, 1)[0]) &&
        (directSpeech.exec(line) || directSpeaker.exec(line));
      if (displayed) {
        describe(displayed[1]);
        emit(' ' + displayed[2]);
      } else if (spoken) {
        describe(spoken[1]);
        emit(' ' + convertSimplified(spoken[2]));
      } else if (plainTts && !voiceDirection.test(line) && !speechCue.test(line)) {
        emit(convertSimplified(line));
      } else {
        describe(line);
      }
    }
  }
  const translation = parts.some(part => typeof part !== 'string') ? parts : undefined;
  return {
    prompt: parts.map(part => typeof part === 'string' ? part : part.translate).join(''),
    ...(translation ? { prompt_translation: translation } : {}),
  };
}
