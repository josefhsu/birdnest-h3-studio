(() => {
    const key='colab-h3-settings-preview-v1';
    const defaults={gpu:'L4',highMemory:false,pictures:false,cache:'drive-first',idle:'15',balance:400,runtimeMinutes:0};
    let state={...defaults};
    try {
      const saved=JSON.parse(localStorage.getItem(key)||'{}');
      if(saved&&typeof saved==='object')state={...state,...saved};
      if(!state.idlePolicyVersion&&Number(state.idle)===5)state.idle=defaults.idle;
      state.idlePolicyVersion=2;
    } catch (_) {}
    if(!['L4','G4','A100','H100'].includes(state.gpu)) state.gpu='L4';
    if(!['drive-first','source-first'].includes(state.cache)) state.cache='drive-first';
    if(!['0','5','15','30','60'].includes(String(state.idle)))state.idle=defaults.idle;
    state.balance=Number.isFinite(Number(state.balance))?Math.max(0,Math.min(99999,Number(state.balance))):400;
    state.runtimeMinutes=[0,30,60,90,120,180,240,300,360].includes(Number(state.runtimeMinutes))?Number(state.runtimeMinutes):0;
    state.pictures=state.pictures===true;
    state.highMemory=state.highMemory===true;
    const $=id=>document.getElementById(id);
    function render(){
      document.querySelectorAll('[data-gpu]').forEach(button=>{const yes=button.dataset.gpu===state.gpu;button.classList.toggle('selected',yes);button.setAttribute('aria-pressed',String(yes));});
      $('high-memory-option').hidden=state.gpu!=='A100';
      $('high-memory').setAttribute('aria-checked',String(state.highMemory));
      $('pictures').setAttribute('aria-checked',String(state.pictures));$('cache').value=state.cache;$('idle').value=String(state.idle);$('balance').value=state.balance;$('runtime-minutes').value=state.runtimeMinutes;
      $('summary-gpu').textContent=state.gpu+(state.gpu==='A100'&&state.highMemory?' · 高 RAM':' GPU');$('summary-res').textContent=$('job-resolution').value;$('summary-pictures').textContent=state.pictures?'已啟用':'未啟用';$('summary-cache').textContent=state.cache==='drive-first'?'優先 Drive':'優先原始來源';$('summary-idle').textContent=Number(state.idle)===0?'立即關閉':state.idle+' 分鐘';
      const rate={L4:1.5,G4:11}[state.gpu];
      const estimateMinutes=state.runtimeMinutes||30;
      $('estimate').innerHTML=rate===undefined?'待查':(rate*estimateMinutes/60).toLocaleString('zh-TW',{maximumFractionDigits:2})+' <small>CU</small>';
      $('estimate-note').textContent=rate===undefined?'此 GPU 的費率尚未核實，無法估算；額度由您手動輸入。':`以 ${estimateMinutes} 分鐘、${rate} CU／小時估算。`;
      try{localStorage.setItem(key,JSON.stringify(state));}catch(_){}
    }
    document.querySelectorAll('[data-gpu]').forEach(button=>button.addEventListener('click',()=>{state.gpu=button.dataset.gpu;render();}));
    $('high-memory').addEventListener('click',()=>{state.highMemory=!state.highMemory;render();});
    $('pictures').addEventListener('click',()=>{state.pictures=!state.pictures;render();});
    $('cache').addEventListener('change',e=>{state.cache=e.target.value;render();});
    $('idle').addEventListener('change',e=>{state.idle=e.target.value;render();});
    $('balance').addEventListener('change',e=>{const value=Number(e.target.value);state.balance=Number.isFinite(value)?Math.max(0,Math.min(99999,value)):0;render();});
    $('runtime-minutes').addEventListener('change',e=>{state.runtimeMinutes=Number(e.target.value);render();});
    $('export').addEventListener('click',()=>{
      const exportData={type:'colab-h3-deployment-draft',version:1,created_at:new Date().toISOString(),gpu:state.gpu,high_memory:state.gpu==='A100'&&state.highMemory,enable_image_model:state.pictures,model_source:state.cache,idle_minutes:Number(state.idle),manual_balance_cu:state.balance,runtime_limit_minutes:state.runtimeMinutes,drive_folder:'Colab H3',note:'所選設定；實際 GPU 與 Drive 狀態請查看工作室運算控制台。'};
      const blob=new Blob([JSON.stringify(exportData,null,2)],{type:'application/json;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='colab-h3-settings-draft.json';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    });
    window.songyinSettings={get:()=>({...state})};
    $('job-resolution').addEventListener('change',()=>{$('summary-res').textContent=$('job-resolution').value});
    render();
  })();
