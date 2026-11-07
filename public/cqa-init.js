import { createArchiveApi, filterDialogs } from './cqa-api.js';
const request=createArchiveApi({onProgress:job=>{
 const node=document.querySelector('.cqa-toast');
 if(node)node.textContent=(job.currentConversationId?'Проверяется '+job.currentConversationId:'Диалог в очереди')+'. Результат сохраняется на сервере.';
}});
function start(){window.cqaWorkbench=window.CQA.mount(document.getElementById('cqa-root'),{request,filterDialogs});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
