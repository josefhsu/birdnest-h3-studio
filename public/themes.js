(()=>{'use strict';
const palettes=[
{id:'night',name:'深海電光',colors:['#101321','#191d30','#20253b','#edf0ff','#a5aec9','#343a54','#a8ebc8','#af9bff','#ff956f','#14291f'],dark:true},
{id:'violet',name:'紫蘇奶油',colors:['#f2eee7','#fffdf8','#e9e2f4','#242039','#71687f','#d9d0e2','#7251c8','#b399e7','#ee784f','#ffffff']},
{id:'cobalt',name:'鈷藍橘紅',colors:['#eeefe8','#fafbf5','#e4e7f2','#202c41','#596477','#ccd1d9','#244ac1','#ff7147','#c4d44b','#ffffff']},
{id:'pink',name:'莓果牛奶',colors:['#f8edf0','#fffbfc','#f0dfe7','#452c3d','#876174','#dec7d2','#a52761','#ee93af','#639b86','#ffffff']},
{id:'citrus',name:'柑橘森林',colors:['#f5efe3','#fffaf0','#e8e7d4','#293e34','#617468','#d3d9c6','#326448','#ff9b4d','#c5c968','#ffffff']},
{id:'yellow',name:'波普檸檬',colors:['#f4f0cf','#fffde8','#eee8bf','#27293a','#6d6c58','#d5d0ab','#332fb1','#ee5548','#d6ba23','#ffffff']},
{id:'paper',name:'印刷紅黑',colors:['#eee8db','#faf5e9','#e7decd','#262323','#766858','#d1c5af','#a92f2b','#42576c','#c09338','#ffffff']},
{id:'mint',name:'薄荷汽水',colors:['#e9f1e9','#f8fff7','#dbebe3','#244340','#617971','#c3d8cf','#276e62','#bca8dd','#ec9767','#ffffff']},
{id:'cyber',name:'賽博糖果',colors:['#151020','#21182f','#2b213d','#f9eafa','#b8a0c5','#473558','#f59bce','#9bcbe8','#d9ed98','#301524'],dark:true},
{id:'gold',name:'午夜鎏金',colors:['#1c1b1a','#282621','#343128','#f4ead3','#b7aa8c','#4c4638','#e4bf78','#a7b29b','#cf8a70','#302412'],dark:true},
{id:'ocean',name:'靛海朱砂',colors:['#eeeee3','#fafaf2','#e0e8e6','#233c4b','#5f747b','#c7d3d3','#255f7d','#799db2','#b54732','#ffffff']},
{id:'ice',name:'極地銀紫',colors:['#0f1920','#192731','#243541','#ebf2f7','#a0b9c7','#39515e','#a8d9e7','#baaef3','#e5bd9a','#19313b'],dark:true}
];
const styles=[{id:'neon',name:'霓虹剪輯室',icon:'◉',palette:'night'},{id:'collage',name:'先鋒拼貼',icon:'↗',palette:'paper'},{id:'dots',name:'波點實驗',icon:'⠿',palette:'yellow'},{id:'woodcut',name:'浮世波形',icon:'≋',palette:'ocean'},{id:'deco',name:'裝飾藝術',icon:'◇',palette:'gold'},{id:'swiss',name:'瑞士編輯',icon:'＋',palette:'cobalt'}];
const vars=['bg','panel','panel2','ink','muted','line','accent','accent2','accent3','onaccent'];
const key='songyin-visual-v1';let state={style:'neon',palette:'night',random:false};
try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved){state={style:styles.some(s=>s.id===saved.style)?saved.style:'neon',palette:palettes.some(p=>p.id===saved.palette)?saved.palette:'night',random:saved.random===true};}}catch{}
function pick(list,current){const candidates=list.filter(x=>x.id!==current);return candidates[Math.floor(Math.random()*candidates.length)];}
if(state.random)state.palette=pick(palettes,state.palette).id;
const $=id=>document.getElementById(id);function apply(announce=false){const p=palettes.find(p=>p.id===state.palette),s=styles.find(s=>s.id===state.style);document.documentElement.dataset.style=s.id;document.documentElement.dataset.palette=p.id;vars.forEach((v,i)=>document.documentElement.style.setProperty('--'+v,p.colors[i]));document.documentElement.style.colorScheme=p.dark?'dark':'light';document.querySelector('meta[name=theme-color]').content=p.colors[0];document.querySelectorAll('[data-style-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.styleChoice===s.id)));document.querySelectorAll('[data-palette-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paletteChoice===p.id)));$('current-look').textContent=s.name+' / '+p.name;$('theme-random-load').checked=state.random;if(announce)$('theme-announcement').textContent='已切換：'+s.name+'，'+p.name;try{localStorage.setItem(key,JSON.stringify(state));}catch{}}
for(const s of styles){const b=document.createElement('button');b.type='button';b.className='style-option';b.dataset.styleChoice=s.id;b.innerHTML='<span aria-hidden="true">'+s.icon+'</span><strong>'+s.name+'</strong>';b.addEventListener('click',()=>{state.style=s.id;state.palette=s.palette;apply(true)});$('style-options').append(b)}
for(const p of palettes){const b=document.createElement('button');b.type='button';b.className='palette-option';b.dataset.paletteChoice=p.id;b.setAttribute('aria-label',p.name+(p.dark?'，深色':'，明亮'));const sw=document.createElement('span');sw.className='swatch';sw.setAttribute('aria-hidden','true');[0,6,7,8].forEach(i=>{const x=document.createElement('i');x.style.background=p.colors[i];sw.append(x)});const n=document.createElement('span');n.textContent=p.name;b.append(sw,n);b.addEventListener('click',()=>{state.palette=p.id;apply(true)});$('palette-options').append(b)}
function toggle(open){$('theme-panel').hidden=!open;$('theme-toggle').setAttribute('aria-expanded',String(open));if(!open)$('theme-toggle').focus();}
$('theme-toggle').addEventListener('click',()=>toggle($('theme-panel').hidden));$('theme-close').addEventListener('click',()=>toggle(false));document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('theme-panel').hidden)toggle(false)});
function shuffle(){const s=pick(styles,state.style);state.style=s.id;state.palette=pick(palettes,state.palette).id;apply(true)}$('theme-shuffle').addEventListener('click',shuffle);$('quick-shuffle').addEventListener('click',shuffle);$('theme-reset').addEventListener('click',()=>{state={style:'neon',palette:'night',random:false};apply(true)});$('theme-random-load').addEventListener('change',e=>{state.random=e.target.checked;apply()});
apply();
})();
