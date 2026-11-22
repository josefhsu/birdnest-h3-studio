// Authoring templates based on MiniMax's H3 prompt-writing references.
const official='https://github.com/MiniMax-AI/MiniMax-H3/blob/main/.agents/skills/h3-prompt-writing/';
export const sources=[
  ['官方 H3 提示 Skill',official+'SKILL.md'],
  ['Ref2VA 多模態參考指南',official+'references/ref-en.txt'],
  ['T2VA / I2VA / FL2VA 提示指南',official+'references/base-en.txt'],
];
export function promptTemplate(kind,mode,seconds){
  if(kind==='image')return 'Describe the framing, subject, visible expression, setting, lighting, and style. For editing, name the image, specify the change, and say which features to preserve.';
  if(kind==='tts')return 'subject_definitions:\n<Subject 1> is an adult speaker with a calm voice.\n\nsummary:\n[voice performance] A short spoken line.\n\nretention_analysis:\nDescribe vocal qualities to preserve.\n\ndetailed_description:\n[Shot 1] <Subject 1> speaks gently: <d>[Mandarin] 請填入原文台詞。</d>\n\noverall_soundscape:\nClear close-mic dialogue.\n\nnon_diegetic_music:\nN/A';
  if(mode==='ref')return 'subject_definitions:\nDescribe each subject and the specific role of any referenced picture, video, or audio.\n\nsummary:\n[reference generation] Describe the scene and its key action.\n\nretention_analysis:\nSpecify which aspects of each reference should be preserved.\n\ndetailed_description:\n[Shot 1] Describe framing, light, motion, and visible reactions. Keep all beats within '+seconds+' seconds.\n\noverall_soundscape:\nDescribe dialogue, ambience, and sound effects.\n\nnon_diegetic_music:\nN/A';
  return 'integrated_multimodal_description:\n'+(mode==='frames'?'Describe what is already visible in the keyframes and how the action connects them. ':'Describe the subject, setting, and opening composition. ')+'[Shot 1] Describe the camera, motion, and visible changes within '+seconds+' seconds.\n\noverall_soundscape:\nDescribe audible events and dialogue.\n\nnon_diegetic_music:\nN/A';
}
