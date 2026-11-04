const params = new URLSearchParams(location.search);
const delay = Number(params.get('delay') || 35);
const legacy = params.get('api') === 'legacy';
const count = Number(params.get('count') || 337);
if (params.has('seed')) localStorage.setItem('STDOMWindow','1');
let token = 1;
let initializing = true;
let active = 0;
const listeners = new Map();
const ctx = {
  chat: [], powerUserSettings: { chat_truncation: 20 },
  event_types: Object.fromEntries(['CHAT_CHANGED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED',
    'MESSAGE_DELETED','MESSAGE_UPDATED','MESSAGE_SWIPED','MORE_MESSAGES_LOADED'].map(name => [name,name])),
  eventSource: {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    async emit(name,...args) { for (const fn of [...(listeners.get(name)||[])]) await fn(...args); },
  },
  saveSettingsDebounced() { window.stats.settingSaves++; },
  saveChat() { throw Error('扩展不应保存或修改测试聊天'); },
};
function makeMessages(size) {
  return Array.from({length:size},(_,id)=>Object.freeze({
    mes: params.get('raw') === 'html' ? `<html><body>${token}:${id}</body></html>` : `<scene data-id="${id}">场景 ${token}:${id}</scene>`,
    name:'测试角色',is_user:false,swipe_id:0,extra:Object.freeze({token}),
  }));
}
function widget(id) {
  return `<!doctype html><html><head><style>body{margin:0;padding:12px;color:#18233d;background:#b6dddf;font:16px system-ui}.card{border:1px solid #577c80;padding:10px}</style></head><body><div class="card">前端已渲染 · ${token}:${id}</div></body></html>`;
}
function format(id, node) {
  node.replaceChildren();
  const p=document.createElement('p'); p.textContent=`测试楼层 ${token}:${id}`;
  const pre=document.createElement('pre'); const code=document.createElement('code');
  code.className='language-html'; code.textContent=widget(id); pre.append(code);
  node.append(p,pre);
}
ctx.addOneMessage=(message,opts={})=>{
  const id=opts.forceId ?? ctx.chat.indexOf(message);
  if (window.failMountId === id) { window.failMountId=null; throw Error('fixture mount failure'); }
  const el=document.createElement('div'); el.className='mes'; el.setAttribute('mesid',id);
  const text=document.createElement('div'); text.className='mes_text'; el.append(text);format(id,text);
  const root=document.querySelector('#chat');
  const before=typeof opts.insertBefore==='number'&&(!legacy||opts.insertBefore)?root.querySelector(`.mes[mesid="${opts.insertBefore}"]`):null;
  const after=typeof opts.insertAfter==='number'&&(!legacy||opts.insertAfter)?root.querySelector(`.mes[mesid="${opts.insertAfter}"]`):null;
  if(before)before.before(el);else if(after)after.after(el);else root.append(el);
  root.querySelectorAll('.last_mes').forEach(e=>e.classList.remove('last_mes'));root.querySelector('.mes:last-child')?.classList.add('last_mes');
  return legacy?undefined:$(el);
};
ctx.printMessages=()=>{
  const root=document.querySelector('#chat');root.replaceChildren();
  const size=ctx.powerUserSettings.chat_truncation||ctx.chat.length;
  if(ctx.chat.length>size){const more=document.createElement('button');more.id='show_more_messages';more.textContent='显示更多历史';root.append(more);}
  for(let id=Math.max(0,ctx.chat.length-size);id<ctx.chat.length;id++)ctx.addOneMessage(ctx.chat[id],{forceId:id});
  root.scrollTop=root.scrollHeight;
};
window.stats={calls:[],maxConcurrent:0,settingSaves:0};
window.SillyTavern={getContext:()=>ctx};
window.TavernHelper={async refreshOneMessage(id,$mes){
  const node=$mes?.[0]||document.querySelector(`#chat>.mes[mesid="${id}"]`);
  const targetToken=token;
  const tracked=!initializing;
  if(tracked){active++;window.stats.maxConcurrent=Math.max(window.stats.maxConcurrent,active);window.stats.calls.push({id,token:targetToken});}
  try{
    if(tracked)await new Promise(r=>setTimeout(r,delay));
    if(window.failRefreshId===id)throw new TypeError('fixture refresh failure');
    if(!node?.isConnected||targetToken!==token)return;
    const text=node.querySelector('.mes_text');format(id,text);
    const frame=document.createElement('iframe');frame.title=`前端 ${targetToken}:${id}`;frame.dataset.id=id;frame.dataset.token=targetToken;frame.srcdoc=widget(id);
    text.append(frame);text.querySelector('pre').style.display='none';
    await ctx.eventSource.emit(ctx.event_types.CHARACTER_MESSAGE_RENDERED,id);
  }finally{if(tracked)active--;}
}};
window.fixture={
  ctx,
  async switchChat(size){
    token++;ctx.chat=makeMessages(size);initializing=true;ctx.printMessages();
    await Promise.all([...document.querySelectorAll('#chat>.mes')].map(el=>window.TavernHelper.refreshOneMessage(Number(el.getAttribute('mesid')))));
    initializing=false;await ctx.eventSource.emit(ctx.event_types.CHAT_CHANGED,String(token));
  },
  async appendMessage(){
    const id=ctx.chat.length;ctx.chat.push(Object.freeze({mes:`<scene>${token}:${id}</scene>`,name:'测试角色',is_user:false,swipe_id:0,extra:Object.freeze({token})}));
    ctx.addOneMessage(ctx.chat[id],{forceId:id});initializing=true;await window.TavernHelper.refreshOneMessage(id);initializing=false;return id;
  },
  async scrollUp(steps=20){
    const root=document.querySelector('#chat');
    for(let i=0;i<steps;i++){
      const top=root.querySelector('.dom-window-top');
      if(!top)break;
      root.scrollTop=Math.max(0,top.offsetHeight-70);root.dispatchEvent(new Event('scroll'));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    }
  },
  async scrollDown(steps=20){
    const root=document.querySelector('#chat');
    for(let i=0;i<steps;i++){
      const bottom=root.querySelector('.dom-window-bottom');
      if(!bottom)break;
      root.scrollTop=Math.max(0,root.scrollHeight-bottom.offsetHeight-root.clientHeight+70);root.dispatchEvent(new Event('scroll'));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    }
  },
};
ctx.chat=makeMessages(count);ctx.printMessages();
await Promise.all([...document.querySelectorAll('#chat>.mes')].map(el=>window.TavernHelper.refreshOneMessage(Number(el.getAttribute('mesid')))));
initializing=false;window.stats.calls=[];window.stats.maxConcurrent=0;
window.fixture.entryModule = await import('/extension/index.js?variant='+params.get('variant'));
window.fixtureReady=true;
