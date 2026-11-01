export class AdminError extends Error {
  constructor(message,{status=0,code='',uncertain=false}={}){super(message);this.status=status;this.code=code;this.uncertain=uncertain}
}
export class AdminApi {
  constructor(fetcher=globalThis.fetch.bind(globalThis),{timeout=20000}={}){this.fetcher=fetcher;this.timeout=timeout;this.csrf='';this.authenticated=false;this.mustChangePassword=false;this.revision='';this.blocked=false;this.writing=false}
  clear(){this.csrf='';this.authenticated=false;this.mustChangePassword=false;this.revision='';this.blocked=false}
  async request(path,{method='GET',body}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeout)
    try{
      const headers={Accept:'application/json'}
      if(method!=='GET'){headers['Content-Type']='application/json';if(path!=='/api/login')headers['X-CSRF-Token']=this.csrf}
      const response=await this.fetcher(path,{method,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})})
      let data
      try{data=await response.json()}catch{throw new AdminError('配置服务返回了无法识别的响应，请重新加载核对。',{uncertain:method!=='GET'})}
      if(!response.ok){
        if(response.status===401)this.clear()
        throw new AdminError(typeof data.error==='string'?data.error:'请求失败，请检查输入后重试。',{status:response.status,code:data.code||''})
      }
      return data
    }catch(error){
      if(error instanceof AdminError)throw error
      throw new AdminError(method==='GET'?'无法读取配置服务，请检查连接后重试。':'请求结果尚未确认，请先重新加载核对，不要重复提交。',{uncertain:method!=='GET'})
    }finally{clearTimeout(timer)}
  }
  async session(){const data=await this.request('/api/session');this.authenticated=data.authenticated===true;this.csrf=data.csrf||'';this.mustChangePassword=data.mustChangePassword===true;return data}
  async login(password){const data=await this.request('/api/login',{method:'POST',body:{password}});this.authenticated=data.authenticated===true;this.csrf=data.csrf||'';this.mustChangePassword=data.mustChangePassword===true;return data}
  async logout(){try{return await this.request('/api/logout',{method:'POST',body:{}})}finally{this.clear()}}
  async password(currentPassword,newPassword){const data=await this.request('/api/password',{method:'POST',body:{currentPassword,newPassword}});this.clear();return data}
  async config(){const data=await this.request('/api/config');this.revision=data.revision;this.blocked=false;return data}
  async update(path,payload){
    if(this.blocked)throw new AdminError('请先重新加载配置并核对，再进行保存。',{code:'RELOAD_REQUIRED'})
    if(this.writing)throw new AdminError('正在保存，请等待本次操作完成。',{code:'SAVE_IN_PROGRESS'})
    this.writing=true
    try{const data=await this.request(path,{method:'POST',body:{revision:this.revision,...payload}});this.revision=data.revision;return data}
    catch(error){if(error.status===409||error.uncertain)this.blocked=true;throw error}
    finally{this.writing=false}
  }
}
const bool=(key,label,help='')=>({key,label,type:'boolean',help})
const integer=(key,label,min,max,help='')=>({key,label,type:'integer',min,max,help})
const text=(key,label,help='',wide=false)=>({key,label,type:'text',help,wide,maxLength:2000})
const ids=(key,label,help='')=>({key,label,type:'ids',help:help||'每行一个 QQ 或群号，也可用逗号分隔。最多 5000 项。',wide:true})
const select=(key,label,options,help='')=>({key,label,type:'select',options,help})
export const GROUP_SECTIONS=[
  {title:'基础与群内功能',description:'统计、撤回和点赞仍受本群总开关控制。',fields:[bool('enabled','启用本群','默认关闭；开启后插件才接管普通群功能。'),bool('statistics','发言统计与排行榜'),bool('recall','消息撤回'),bool('likes','QQ 点赞','裸发“赞我”；账号每日最多 10 次调用，每次 10 赞。'),integer('rankLimit','排行显示人数',1,50),integer('recallLimit','批量撤回最多条数',1,50),integer('recallWindowMinutes','批量撤回窗口（分钟）',1,120)]},
  {title:'欢迎与离群通知',fields:[bool('welcomeEnabled','入群欢迎'),bool('leaveEnabled','离群通知'),text('welcomeMessage','欢迎内容','支持 {userId}、{groupId}、{name}。',true),text('leaveMessage','离群内容','支持 {userId}、{groupId}、{name}。',true)]},
  {title:'成员入群审核',description:'问题提示只用于审核通知，不修改 QQ 平台的问题。',fields:[select('joinMode','处理方式',[['off','不接管'],['manual','人工审核'],['answer','按答案审核'],['accept','自动同意'],['reject','自动拒绝']]),bool('exactMatch','答案精确匹配','关闭时包含匹配；两种方式均忽略英文大小写。'),integer('minLevel','最低 QQ 等级',0,200,'0 表示不检查；无法可靠取得等级时转人工。'),text('question','问题提示','最多 2000 字符。',true),{key:'answers',label:'可接受答案',type:'answers',help:'每行一个答案，最多 100 项，每项最多 200 字符。',wide:true},ids('blackUsers','本群成员黑名单'),ids('whiteUsers','本群成员白名单')]},
  {title:'每日新闻推送',description:'新闻接口与 Key 在“新闻来源”中配置；停机错过推送不补发。',fields:[bool('dailyEnabled','启用每日推送'),{key:'dailyTime',label:'推送时间',type:'time',help:'按全局时区，每天执行一次。'}]}
]
export const GLOBAL_SECTIONS=[
  {title:'时区与审核通知',fields:[{...text('timezone','插件时区','例如 Asia/Shanghai；影响日期、点赞额度与所有定时任务。'),maxLength:100},ids('managementGroups','审核管理群'),ids('notifyUsers','额外私聊通知 / 审核用户')]},
  {title:'机器人邀请策略',fields:[select('inviteMode','默认邀请处理',[['off','不接管'],['manual','人工审核'],['accept','自动同意'],['reject','自动拒绝']]),bool('allowInviterConfirm','允许原邀请人自行确认'),bool('allowAdminInvite','管理员邀请免审'),bool('notifyInviter','通知邀请人'),integer('requestExpireMinutes','待审有效期（分钟）',1,60),integer('maxPendingRequests','实例共用待审上限',1,100)]},
  {title:'群黑白名单',description:'邀请审核先检查黑名单；自动退群先判断豁免，二者优先级不同。',fields:[ids('blackGroups','群黑名单'),ids('whiteGroups','群白名单')]},
  {title:'自动退群',description:'指机器人自己退出群，不是踢成员；默认关闭。',fields:[bool('autoQuitEnabled','启用自动退群'),integer('minGroupMember','最低群人数',1,10000),{key:'autoQuitTime',label:'每日巡检时间',type:'time'},text('autoQuitMessage','退群前提示','支持 {memberCount}、{minMember}、{groupIds}。',true)]}
]
export function validId(value,{wildcard=false}={}){
  const id=String(value??'').trim()
  if(wildcard&&id==='*')return id
  if(!/^[1-9]\d{3,15}$/.test(id)||!Number.isSafeInteger(Number(id)))throw new AdminError('请填写有效的数字 QQ / 群号。')
  return id
}
export function parseList(value,{answers=false}={}){
  const items=String(value??'').split(answers?/\r?\n/:/[\s,，;；]+/).map(item=>item.trim()).filter(Boolean)
  if(items.length>(answers?100:5000))throw new AdminError(answers?'答案最多 100 项。':'名单最多 5000 项。')
  if(answers){if(items.some(item=>item.length>200))throw new AdminError('每个答案最多 200 字符。');return [...new Set(items)]}
  return [...new Set(items.map(item=>validId(item)))]
}
export function fieldValue(field,value){
  if(field.type==='boolean')return value===true
  if(field.type==='integer'){const number=Number(value);if(String(value).trim()===''||!Number.isInteger(number)||number<field.min||number>field.max)throw new AdminError(field.label+' 必须是 '+field.min+'～'+field.max+' 之间的整数。');return number}
  if(field.type==='ids'||field.type==='answers')return parseList(value,{answers:field.type==='answers'})
  const output=String(value??'')
  if(field.type==='time'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(output))throw new AdminError(field.label+' 请使用 HH:mm 时间。')
  if(field.maxLength&&output.length>field.maxLength)throw new AdminError(field.label+' 内容过长。')
  if(field.key==='timezone'){try{new Intl.DateTimeFormat('zh-CN',{timeZone:output})}catch{throw new AdminError('时区无效，请填写例如 Asia/Shanghai。')}}
  return output
}
export function newsPayload({botId,groupId,url,authType='none',authName='',keyAction='keep',key=''}){
  botId=validId(botId);groupId=validId(groupId);url=String(url).trim();authName=String(authName).trim()
  let parsed
  try{parsed=new URL(url)}catch{throw new AdminError('请填写有效的 HTTP(S) 新闻 API 地址。')}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||url.length>8192||/[\r\n\u0000]/.test(url))throw new AdminError('新闻 API 必须是没有用户名密码的 HTTP(S) 地址。')
  if(!['none','bearer','header','query'].includes(authType))throw new AdminError('请选择有效鉴权方式。')
  if(['none','bearer'].includes(authType))authName=''
  if(authType==='header'&&!/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(authName))throw new AdminError('请填写合法的请求头名称。')
  if(authType==='query'&&!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(authName))throw new AdminError('请填写合法的查询参数名称。')
  if(!['keep','replace','clear'].includes(keyAction))throw new AdminError('请选择保留、替换或清空 Key。')
  const patch={url,authType,authName,keyAction}
  if(keyAction==='replace'){if(typeof key!=='string'||!key.trim()||key.length>8192||/[\r\n\u0000]/.test(key))throw new AdminError('请输入有效的新 Key，不要包含换行。');patch.key=key}
  return {botId,groupId,patch}
}

export function createAdminApp(doc=globalThis.document,api=new AdminApi()){
  const byId=id=>doc.getElementById(id)
  const state={config:null,groupKey:'',newsBinding:'',view:'groups',busy:false,pendingRemove:null}
  const pair=(bot,group)=>String(bot)+':'+String(group)
  const fields=sections=>sections.flatMap(section=>section.fields)
  const make=(tag,className,textValue)=>{const element=doc.createElement(tag);if(className)element.className=className;if(textValue!==undefined)element.textContent=String(textValue);return element}
  function notify(message,kind=''){const node=byId('notice');node.textContent=message;node.className='notice'+(kind?' '+kind:'');node.hidden=false}
  function clearSecrets(){for(const id of ['loginPassword','currentPassword','newPassword','confirmPassword','newsKey'])byId(id).value=''}
  function showLogin(){
    state.config=null;state.groupKey='';state.newsBinding='';state.pendingRemove=null;clearSecrets()
    for(const id of ['addGroupDialog','removeDialog'])if(byId(id).open)byId(id).close()
    for(const id of ['groupFields','globalFields','groupPicker','newsPicker','botSuggestions'])byId(id).replaceChildren()
    for(const id of ['newsBot','newsGroup','newsUrl','newsAuthName'])byId(id).value=''
    byId('appView').hidden=true;byId('loginView').hidden=false;byId('loginPassword').focus()
  }
  function selectedGroup(){return state.config?.groups.find(group=>pair(group.botId,group.groupId)===state.groupKey)}
  function updateControls(){
    for(const element of doc.querySelectorAll('[data-disable-busy]'))element.disabled=state.busy
    for(const button of doc.querySelectorAll('.write-action'))button.disabled=state.busy||api.blocked
    for(const button of doc.querySelectorAll('[data-view]'))button.disabled=state.busy||(api.mustChangePassword&&button.dataset.view!=='password')
    byId('reloadButton').disabled=byId('conflictReload').disabled=state.busy||api.mustChangePassword
    byId('removeGroupButton').disabled=state.busy||api.blocked||!selectedGroup()
    byId('newsKey').disabled=state.busy||byId('keyAction').value!=='replace'
    byId('newsAuthName').disabled=state.busy||['none','bearer'].includes(byId('newsAuthType').value)
    byId('newsKey').required=byId('keyAction').value==='replace'
    byId('newsAuthName').required=['header','query'].includes(byId('newsAuthType').value)
    const current=state.config?.newsSources.some(source=>source.botId===byId('newsBot').value&&source.groupId===byId('newsGroup').value)
    byId('removeNewsButton').disabled=state.busy||api.blocked||!current
    byId('conflictBanner').hidden=!api.blocked
  }
  function showView(view){
    if(api.mustChangePassword)view='password'
    state.view=view
    for(const name of ['groups','news','global','password'])byId(name+'View').hidden=name!==view
    for(const button of doc.querySelectorAll('[data-view]'))button.classList.toggle('active',button.dataset.view===view)
    byId('pageTitle').textContent=({groups:'本群设置',news:'新闻来源',global:'全局设置',password:'账号安全'})[view]
    byId('passwordTitle').textContent=api.mustChangePassword?'首次登录：请先修改初始密码':'修改管理密码'
    byId('passwordHint').textContent=api.mustChangePassword?'初始密码不能用于配置管理。请设置至少 12 个字符的新密码，再重新登录。':'修改后所有管理会话退出，请使用新密码重新登录。'
    byId('masterNotice').hidden=api.mustChangePassword
    updateControls()
  }
  function renderFields(target,sections,values,prefix,allowed){
    target.replaceChildren()
    for(const section of sections){
      const available=section.fields.filter(field=>!allowed||allowed.has(field.key))
      if(!available.length)continue
      const card=make('section','card'),heading=make('div','card-heading'),intro=make('div')
      intro.append(make('h3','',section.title));if(section.description)intro.append(make('p','',section.description));heading.append(intro);card.append(heading)
      const grid=make('div','field-grid')
      for(const field of available){
        const controlId=prefix+'-'+field.key
        const wrapper=make('div',field.type==='boolean'?'toggle-field':'field'+(field.wide?' wide':''))
        const label=make('label','',field.label);label.htmlFor=controlId
        let input
        if(field.type==='select'){input=make('select');for(const [value,title] of field.options){const option=make('option','',title);option.value=value;input.append(option)}}
        else if(['ids','answers'].includes(field.type)||(field.type==='text'&&field.wide))input=make('textarea')
        else {input=make('input');input.type=field.type==='boolean'?'checkbox':field.type==='integer'?'number':field.type==='time'?'time':'text'}
        input.id=controlId;input.name=field.key;input.setAttribute('data-disable-busy','');input.autocomplete='off'
        if(field.type==='boolean')input.checked=values[field.key]===true
        else input.value=Array.isArray(values[field.key])?values[field.key].join('\n'):String(values[field.key]??'')
        if(field.min!==undefined){input.min=String(field.min);input.max=String(field.max)}
        if(field.maxLength)input.maxLength=field.maxLength
        if(field.type==='integer'||field.type==='time'||field.key==='timezone')input.required=true
        if(field.type==='boolean'){wrapper.append(input);const copy=make('div','toggle-copy');copy.append(label);if(field.help)copy.append(make('p','field-help',field.help));wrapper.append(copy)}
        else {wrapper.append(label,input);if(field.help)wrapper.append(make('p','field-help',field.help))}
        grid.append(wrapper)
      }
      card.append(grid);target.append(card)
    }
  }
  function readFields(sections,prefix){
    const patch={}
    for(const field of fields(sections)){const input=byId(prefix+'-'+field.key);if(input)patch[field.key]=fieldValue(field,field.type==='boolean'?input.checked:input.value)}
    if(patch.joinMode==='answer'&&!patch.answers?.length)throw new AdminError('按答案审核至少需要填写一个答案。')
    return patch
  }
  function renderGroups(){
    const picker=byId('groupPicker');picker.replaceChildren()
    for(const group of state.config.groups){const option=make('option','',(group.botId==='*'?'全部机器人（通配）':group.botId)+' · 群 '+group.groupId);option.value=pair(group.botId,group.groupId);picker.append(option)}
    picker.value=state.groupKey
    const group=selectedGroup();byId('groupsEmpty').hidden=!!group;byId('groupForm').hidden=!group;picker.disabled=!group
    if(group)renderFields(byId('groupFields'),GROUP_SECTIONS,group,'group',new Set([...(state.config.schema?.groupFields||fields(GROUP_SECTIONS).map(field=>field.key)),'enabled']))
  }
  function syncNewsScope({announce=false}={}){
    const botId=byId('newsBot').value.trim(),groupId=byId('newsGroup').value.trim(),binding=pair(botId,groupId)
    if(state.newsBinding===binding)return
    const source=state.config.newsSources.find(source=>source.botId===botId&&source.groupId===groupId)
    state.newsBinding=binding
    byId('newsUrl').value=source?.url||'';byId('newsAuthType').value=source?.authType||'none';byId('newsAuthName').value=source?.authName||''
    byId('keyAction').value='keep';byId('newsKey').value=''
    byId('keyStatus').textContent=source?.hasKey?'已保存 Key · 原文不回传':'未配置 Key'
    byId('newsScopeHint').textContent=source?'已加载此机器人与群的完整来源，请核对后编辑。':'当前对象没有来源，接口和鉴权已清空；不会继承其他群的 Key。'
    if(announce)notify('配置对象已改变，已加载对应来源或清空新对象。请核对后再次保存。','error')
    updateControls()
  }
  function fillNews(botId,groupId){
    byId('newsBot').value=botId||state.config.availableBots?.[0]||'';byId('newsGroup').value=groupId||''
    state.newsBinding='';syncNewsScope()
  }
  function renderNews(){
    const picker=byId('newsPicker'),entries=new Map();picker.replaceChildren()
    const fresh=make('option','','新增来源 / 手填机器人与群号');fresh.value='';picker.append(fresh)
    for(const source of state.config.newsSources)entries.set(pair(source.botId,source.groupId),source)
    for(const group of state.config.groups)if(group.botId!=='*'&&!entries.has(pair(group.botId,group.groupId)))entries.set(pair(group.botId,group.groupId),group)
    for(const [key,entry]of entries){const option=make('option','',entry.botId+' · 群 '+entry.groupId);option.value=key;picker.append(option)}
    const group=selectedGroup(),key=group?.botId!=='*'&&group?pair(group.botId,group.groupId):''
    picker.value=entries.has(key)?key:''
    fillNews(group?.botId==='*'?'':group?.botId||'',group?.groupId||'')
  }
  function adopt(config){
    state.config=config
    if(!config.groups.some(group=>pair(group.botId,group.groupId)===state.groupKey))state.groupKey=config.groups.length?pair(config.groups[0].botId,config.groups[0].groupId):''
    byId('mastersStatus').textContent=config.readonly?.mastersConfigured?'插件主人已配置 · 仅可在本地文件维护':'尚未配置插件主人 · 请手动填写 masters'
    const suggestions=byId('botSuggestions');suggestions.replaceChildren()
    for(const bot of config.availableBots||[]){const option=make('option');option.value=String(bot);suggestions.append(option)}
    renderGroups();renderFields(byId('globalFields'),GLOBAL_SECTIONS,config.global,'global',new Set(config.schema?.globalFields||fields(GLOBAL_SECTIONS).map(field=>field.key)));renderNews();updateControls()
  }
  async function busy(fn){
    if(state.busy)return
    state.busy=true;updateControls()
    try{return await fn()}catch(error){
      if(error.status===401){showLogin();notify('登录已失效，请重新登录。','error')}
      else{
        if(error.code==='PASSWORD_CHANGE_REQUIRED'){api.mustChangePassword=true;showView('password')}
        if(api.blocked)byId('conflictMessage').textContent=error.uncertain?'上次保存结果尚未确认。请重新加载并核对当前值，再继续编辑。':'配置已被其他操作修改。请重新加载当前值后再保存，本页面不会自动覆盖。'
        notify(error.message||'操作未完成，请检查后重试。','error')
      }
    }finally{state.busy=false;updateControls()}
  }
  async function load(){const config=await api.config();adopt(config);showView(state.view)}
  async function save(path,payload,success){
    const config=await api.update(path,payload)
    adopt(config);notify(success,'success')
  }
  for(const button of doc.querySelectorAll('[data-view]'))button.addEventListener('click',()=>showView(button.dataset.view))
  byId('loginForm').addEventListener('submit',event=>{event.preventDefault();const password=byId('loginPassword').value;byId('loginPassword').value='';busy(async()=>{await api.login(password);byId('loginView').hidden=true;byId('appView').hidden=false;if(api.mustChangePassword)showView('password');else {state.view='groups';await load()}})})
  byId('logoutButton').addEventListener('click',()=>busy(async()=>{try{await api.logout()}finally{showLogin()}}))
  for(const id of ['reloadButton','conflictReload'])byId(id).addEventListener('click',()=>busy(async()=>{await load();notify('已重新加载，请核对当前配置。','success')}))
  byId('groupPicker').addEventListener('change',()=>{state.groupKey=byId('groupPicker').value;renderGroups();renderNews();updateControls()})
  byId('groupForm').addEventListener('submit',event=>{event.preventDefault();busy(async()=>{const group=selectedGroup();if(!group)throw new AdminError('请先选择群配置。');await save('/api/config/group',{botId:group.botId,groupId:group.groupId,patch:readFields(GROUP_SECTIONS,'group')},'本群设置已保存，立即生效。')})})
  byId('globalForm').addEventListener('submit',event=>{event.preventDefault();busy(()=>save('/api/config/global',{patch:readFields(GLOBAL_SECTIONS,'global')},'全局设置已保存。'))})
  byId('newsPicker').addEventListener('change',()=>{const value=byId('newsPicker').value;const [bot,group]=value?value.split(':'):['',''];fillNews(bot,group)})
  for(const id of ['newsAuthType','keyAction'])byId(id).addEventListener('change',()=>{if(byId('keyAction').value!=='replace')byId('newsKey').value='';if(['none','bearer'].includes(byId('newsAuthType').value))byId('newsAuthName').value='';updateControls()})
  for(const id of ['newsBot','newsGroup'])for(const event of ['input','change'])byId(id).addEventListener(event,()=>syncNewsScope())
  byId('newsForm').addEventListener('submit',event=>{event.preventDefault();busy(async()=>{try{
    const binding=pair(byId('newsBot').value.trim(),byId('newsGroup').value.trim())
    if(binding!==state.newsBinding){syncNewsScope({announce:true});throw new AdminError('配置对象已改变，已重新加载完整来源。请核对接口与鉴权后再保存。')}
    const payload=newsPayload({botId:byId('newsBot').value,groupId:byId('newsGroup').value,url:byId('newsUrl').value,authType:byId('newsAuthType').value,authName:byId('newsAuthName').value,keyAction:byId('keyAction').value,key:byId('newsKey').value})
    await save('/api/config/news',payload,'新闻来源已保存；手动查询与定时推送将使用同一来源。');byId('newsPicker').value=pair(payload.botId,payload.groupId);fillNews(payload.botId,payload.groupId)
  }finally{byId('newsKey').value=''}})})
  byId('addGroupButton').addEventListener('click',()=>{byId('addBot').value=state.config.availableBots?.[0]||'';byId('addGroup').value='';byId('addGroupDialog').showModal()})
  byId('cancelAddGroup').addEventListener('click',()=>byId('addGroupDialog').close())
  byId('addGroupForm').addEventListener('submit',event=>{event.preventDefault();busy(async()=>{const botId=validId(byId('addBot').value,{wildcard:true}),groupId=validId(byId('addGroup').value);if(state.config.groups.some(group=>group.botId===botId&&group.groupId===groupId))throw new AdminError('这个机器人与群的配置已存在，请在列表中选择。');state.groupKey=pair(botId,groupId);await save('/api/config/group',{botId,groupId,patch:{enabled:false}},'群配置已添加，默认关闭。');byId('addGroupDialog').close()})})
  function confirmRemove(kind,botId,groupId){state.pendingRemove={kind,botId,groupId};byId('removeTitle').textContent=kind==='group'?'移除群配置？':'移除新闻来源？';byId('removeDescription').textContent='机器人 '+botId+' · 群 '+groupId+(kind==='group'?'。这也会移除该精确对象的新闻来源；通配规则可能仍然生效。':'。移除后该群无法获取新闻，推送开关不因此自动改变。');byId('removeDialog').showModal()}
  byId('removeGroupButton').addEventListener('click',()=>{const group=selectedGroup();if(group)confirmRemove('group',group.botId,group.groupId)})
  byId('removeNewsButton').addEventListener('click',()=>confirmRemove('news',validId(byId('newsBot').value),validId(byId('newsGroup').value)))
  byId('cancelRemove').addEventListener('click',()=>byId('removeDialog').close())
  byId('confirmRemove').addEventListener('click',()=>busy(async()=>{const item=state.pendingRemove;if(!item)return;await save('/api/config/'+item.kind+'/remove',{botId:item.botId,groupId:item.groupId},'配置已移除。');state.pendingRemove=null;byId('removeDialog').close()}))
  byId('passwordForm').addEventListener('submit',event=>{event.preventDefault();busy(async()=>{try{const current=byId('currentPassword').value,next=byId('newPassword').value;if(next.length<12)throw new AdminError('新密码至少需要 12 个字符。');if(next!==byId('confirmPassword').value)throw new AdminError('两次新密码不一致，请重新输入。');await api.password(current,next);showLogin();notify('密码已修改，所有旧会话已退出。请使用新密码登录。','success')}finally{for(const id of ['currentPassword','newPassword','confirmPassword'])byId(id).value=''}})})
  return {api,start:()=>busy(async()=>{await api.session();if(!api.authenticated){showLogin();return}byId('loginView').hidden=true;byId('appView').hidden=false;if(api.mustChangePassword)showView('password');else await load()})}
}
if(typeof document!=='undefined')createAdminApp().start()
