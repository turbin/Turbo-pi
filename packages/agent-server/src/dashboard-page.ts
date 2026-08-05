/**
 * Web monitor dashboard (2026-08-05): single static page, no framework, no
 * build step — same style as stats-page.ts. Three panels fed by JSON APIs:
 * trajectory-cache hit rate (/api/stats/hit-rate), link/chain status
 * (/api/status/chain), and the trace-log tail (/api/logs). Auto-refreshes
 * every 5s. Served at GET /dashboard; gated by the web switch
 * (AGENT_SERVER_WEB=off).
 */
export const DASHBOARD_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>agent-server 监控面板</title>
<style>
body{font-family:system-ui,monospace;max-width:1080px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:18px} h2{font-size:14px;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.ok{color:#2a6;font-weight:bold} .down{color:#a55;font-weight:bold}
.bar{background:#4a7;white-space:nowrap;color:#fff;padding:0 4px;font-size:12px}
#logs{background:#111;color:#bbb;font-size:12px;padding:8px;height:320px;overflow-y:auto;
white-space:pre-wrap;word-break:break-all}
.small{color:#777;font-size:12px}
a{color:#246}
</style>
</head>
<body>
<h1>agent-server 监控面板 <span class="small" id="ts"></span></h1>
<p class="small">数据接口：<a href="/api/stats/hit-rate">hit-rate</a> ·
<a href="/api/status/chain">chain</a> · <a href="/api/logs">logs</a> ·
详细命中率页：<a href="/stats">/stats</a></p>

<h2>链路状态</h2>
<table id="chain"><tr><td>loading...</td></tr></table>

<h2>轨迹缓存命中率（近 7 天）</h2>
<div id="hit">loading...</div>

<h2>日志（最近 100 行）</h2>
<div id="logs">loading...</div>

<script>
function bar(rate){var n=Math.round(rate*20),s='';for(var i=0;i<n;i++)s+='█';
return '<span class="bar">'+s+'</span> '+(rate*100).toFixed(1)+'%';}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
function svc(name,d){
if(!d)return '<tr><td>'+name+'</td><td class="down">未知</td><td></td></tr>';
var st=d.ok?'<span class="ok">UP</span>':'<span class="down">DOWN</span>';
var extra='';
if(d.status)extra+='http '+d.status+' ';
if(d.latencyMs!=null)extra+=d.latencyMs+'ms ';
if(d.models)extra+=esc(d.models.join(', '));
if(d.error)extra+=esc(d.error);
return '<tr><td>'+name+'</td><td>'+st+'</td><td>'+extra+'</td></tr>';}
async function loadChain(){
try{
var d=await (await fetch('/api/status/chain')).json();
var h='<tr><th>服务</th><th>状态</th><th>详情</th></tr>';
h+=svc('agent-server (self)',d.self);
h+=svc('agent-gateway :8787',d.gateway);
h+=svc('omlx :8000',d.omlx);
if(d.evolution){
h+='<tr><td>evolution checkpoint</td><td class="ok">'+esc(d.evolution.id)+'</td><td>'+
esc(d.evolution.epoch)+' · metric='+d.evolution.metric+'</td></tr>';
}else{
h+='<tr><td>evolution checkpoint</td><td class="down">never_run</td><td></td></tr>';}
document.getElementById('chain').innerHTML=h;
}catch(e){document.getElementById('chain').innerHTML='<tr><td class="down">chain 加载失败</td></tr>';}}
async function loadHit(){
try{
var d=await (await fetch('/api/stats/hit-rate?window_hours=168')).json();
document.getElementById('hit').innerHTML=
'<p>总请求 <b>'+d.total+'</b>，命中 <b>'+d.hits+'</b>，命中率 '+bar(d.hitRate)+'</p>';
}catch(e){document.getElementById('hit').innerHTML='<p class="down">hit-rate 加载失败</p>';}}
async function loadLogs(){
try{
var d=await (await fetch('/api/logs?lines=100')).json();
var el=document.getElementById('logs');
el.textContent=d.lines.length?d.lines.join('\\n'):'（暂无日志）';
el.scrollTop=el.scrollHeight;
}catch(e){document.getElementById('logs').textContent='日志加载失败';}}
async function load(){
document.getElementById('ts').textContent=new Date().toLocaleString();
await Promise.all([loadChain(),loadHit(),loadLogs()]);}
load();setInterval(load,5000);
</script>
</body>
</html>
`;
