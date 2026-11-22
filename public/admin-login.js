(() => {
  const $=id=>document.getElementById(id);
  const status=$('admin-google-status');
  const form=$('admin-google-form');
  async function send(action,body={}){
    const response=await fetch('/api/colab/'+action,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Google 驗證暫時失敗。');
    return result;
  }
  async function action(button,task){
    button.disabled=true;
    status.textContent='';
    try{await task()}catch(error){status.textContent=error.message}
    finally{button.disabled=false}
  }
  $('admin-google').addEventListener('click',event=>action(event.currentTarget,async()=>{
    const result=await send('auth-start');
    $('admin-google-link').href=result.url;
    form.hidden=false;
    $('admin-google-link').focus();
  }));
  form.addEventListener('submit',event=>{
    event.preventDefault();
    action(event.submitter,async()=>{
      const input=$('admin-google-code');
      const code=input.value.trim();
      input.value='';
      await send('auth-complete',{code});
      window.location.reload();
    });
  });
})();
