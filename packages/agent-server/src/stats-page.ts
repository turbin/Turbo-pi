/**
 * Static stats page (O spec R2): no framework, no build step. Fetches
 * /api/stats/hit-rate and renders tables + text bars. Served at GET /stats.
 */
export const STATS_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>agent-server 经验命中率</title>
<style>
body{font-family:system-ui,monospace;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:18px} h2{font-size:14px;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}
.bar{background:#4a7;white-space:nowrap;color:#fff;padding:0 4px;font-size:12px}
.miss{background:#a55}
select{margin-left:8px}
</style>
</head>
<body>
<h1>agent-server 经验命中率
<select id="w" onchange="load()">
<option value="24">近 24 小时</option>
<option value="72">近 3 天</option>
<option value="168" selected>近 7 天</option>
<option value="720">近 30 天</option>
</select></h1>
<div id="summary">loading...</div>
<h2>按经验类型（命中构成）</h2><table id="kinds"></table>
<h2>按天</h2><table id="daily"></table>
<h2>最近 20 条请求</h2><table id="recent"></table>
<script>
function bar(rate){var n=Math.round(rate*20),s='';for(var i=0;i<n;i++)s+='█';
return '<span class="bar">'+s+'</span> '+(rate*100).toFixed(1)+'%';}
function rows(t,trs){var h='';for(var i=0;i<trs.length;i++){h+='<tr>'+trs[i].map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}
t.innerHTML=h||'<tr><td>（无数据）</td></tr>';}
async function load(){
var wh=document.getElementById('w').value;
var r=await fetch('/api/stats/hit-rate?window_hours='+wh);
var d=await r.json();
document.getElementById('summary').innerHTML='<p>总请求 <b>'+d.total+'</b>，命中 <b>'+d.hits+'</b>，命中率 '+bar(d.hitRate)+'</p>';
rows(document.getElementById('kinds'),d.byKind.map(function(k){return [k.kind,k.cnt]}));
rows(document.getElementById('daily'),d.daily.map(function(x){return [x.day,x.total,x.hits,bar(x.total?x.hits/x.total:0)]}));
rows(document.getElementById('recent'),d.recent.map(function(x){var ids='';
try{var a=JSON.parse(x.retrievedIds||'[]');ids=a.join(', ')}catch(e){}
return [x.ts,x.requestId,x.model,
x.hit?'<b>命中('+x.retrievedCount+')</b><br><small>'+ids+'</small>':'<span class="miss">未命中</span>',
x.finishReason||'',x.latencyMs!=null?x.latencyMs+'ms':'',x.error||'']}));
}
load();
</script>
</body>
</html>
`;
