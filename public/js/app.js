let balanceChart = null;
let balanceHistory = [];
let allPrices = {};
let userPositions = {};
let userPortfolio = {};
let prevPrices = {};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function fmt(n,d){if(n==null)return'$0';return'$'+parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:d||2,maximumFractionDigits:d||2})}
function fmtN(n,d){if(n==null)return'0';return parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:d||0,maximumFractionDigits:d||6})}
function fmtX(n){return parseFloat(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8})}

function sendReq(d){db.ref('tradeRequests').push({...d,status:'pending',timestamp:Date.now()})}

// ===== TOP BAR TICKERS =====
const TOP_SYMBOLS = ['BTCUSDT','ETHUSDT','1000PEPEUSDT','WIFUSDT','1000BONKUSDT','1000FLOKIUSDT','MOODENGUSDT','PENGUUSDT','MEMEUSDT','BRETTUSDT','TURBOUSDT','1000CHEEMSUSDT','MEWUSDT','DOGEUSDT'];

function renderTopTickers(prices){
  let h='';
  for(const s of TOP_SYMBOLS){
    const d=prices[s];
    if(!d) continue;
    const cls=d.change24h>=0?'up':'down';
    const sign=d.change24h>=0?'+':'';
    const prev=prevPrices[s];
    let flash='';
    if(prev!==undefined){
      if(d.price>prev)flash=' flash-up';
      else if(d.price<prev)flash=' flash-down';
    }
    prevPrices[s]=d.price;
    h+=`<div class="top-ticker"><span class="sym">${s}</span><span class="price${flash}">${fmt(d.price,4)}</span><span class="ch ${cls}">${sign}${d.change24h.toFixed(2)}%</span></div>`;
  }
  $('#topTickers').innerHTML=h;
}

// ===== TABS =====
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', function(){
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    $('#tab-' + this.dataset.tab).classList.add('active');
    if(balanceChart) balanceChart.resize();
  });
});

// ===== TRADE FORM TOGGLE =====
function toggleTradeForm(){
  const form = $('#tradeForm');
  const chev = $('#tradeChevron');
  const isOpen = form.classList.contains('open');
  if(isOpen){
    form.classList.remove('open');
    form.classList.add('collapse');
    chev.classList.remove('open');
    chev.textContent = '▼';
  } else {
    form.classList.remove('collapse');
    form.classList.add('open');
    chev.classList.add('open');
    chev.textContent = '▲';
  }
}

// ===== FIREBASE LISTENERS =====
function initFB(){
  db.ref('prices').on('value',sn=>{
    const p=sn.val();if(!p)return;
    allPrices=p;
    renderTopTickers(p);
    updateEstimate();
  });

  db.ref('portfolio').on('value',sn=>{
    userPortfolio=sn.val();
    if(userPortfolio) renderPortfolio(userPortfolio);
  });

  db.ref('positions').on('value',sn=>{
    userPositions=sn.val()||{};
    renderPositions(userPositions);
  });

  db.ref('trades').on('value',sn=>{renderHistory(sn.val()||{})});

  db.ref('.info/connected').on('value',sn=>{
    const ok=sn.val()===true;
    $('#connectionStatus').className='status-pill'+(ok?'':' offline');
    $('#statusText').textContent=ok?'Servidor Online':'Desconectado';
  });

  db.ref('config/symbols').once('value',s=>{
    const syms=s.val()||TOP_SYMBOLS;
    $('#tradeSymbol').innerHTML=syms.map(x=>`<option>${x}</option>`).join('');
  });

  db.ref('config').on('value',sn=>{
    const c=sn.val();
    if(c&&c.strategyActive){$('#btnStartStrategy').disabled=true;$('#btnStopStrategy').disabled=false}
    else{$('#btnStartStrategy').disabled=false;$('#btnStopStrategy').disabled=true}
  });

  db.ref('strategyLog').limitToLast(60).on('value',sn=>{renderLog(sn.val())});
}

// ===== PORTFOLIO =====
function renderPortfolio(p){
  const equity = p.equity || p.balance;
  $('#balance').textContent=fmt(equity,2);
  $('#initialBalance').textContent=fmt(p.initialBalance,2);
  const pnlUnrealized = p.unrealizedPnl || 0;
  const signPnl = pnlUnrealized>=0?'+':'';
  const clsPnl = pnlUnrealized>=0?'up':'down';
  const equityPnlPercent = p.equityPnlPercent || 0;
  $('#pnlSummary').innerHTML=`<span class="${clsPnl}">${signPnl}${fmt(Math.abs(pnlUnrealized),2)} (${signPnl}${equityPnlPercent.toFixed(2)}%)</span>`;
  $('#pnlBar').style.width=Math.max(0,Math.min(100,50+equityPnlPercent*2))+'%';
  $('#pnlBar').style.background=equityPnlPercent>=0?'var(--green)':'var(--red)';

  let used=0;
  Object.values(userPositions).forEach(x=>{if(x.status==='OPEN')used+=x.initialMargin;});
  $('#usedMargin').textContent=fmt(used,2);
  $('#availableBalance').textContent=fmt(p.balance,2);
  updateChart(p);
}

// ===== POSITIONS =====
function renderPositions(positions){
  const open=Object.values(positions).filter(p=>p.status==='OPEN');
  $('#posCount').textContent=open.length;
  $('#btnCloseAll').style.display=open.length>0?'inline-block':'none';
  const cont=$('#positionsContainer');
  if(!open.length){cont.innerHTML='<div class="empty">Sin posiciones abiertas</div>';return}

  let h='<div class="pos-grid">';
  for(const p of open){
    const pc=p.unrealizedPnl>=0?'up':'down';
    const ps=p.unrealizedPnl>=0?'+':'';
    const mark=p.markPrice||p.entryPrice;
    h+=`<div class="pos-card">
      <div class="pos-head">
        <span class="pos-sym">${p.symbol}</span>
        <span class="pos-tag">LONG ${p.leverage}x</span>
        <button class="pos-close" onclick="closeTrade('${p.id}')">Cerrar</button>
      </div>
      <div class="pos-details">
        <div class="pos-detail"><span class="lbl">Entrada</span><span class="val">${fmt(p.entryPrice,6)}</span></div>
        <div class="pos-detail"><span class="lbl">Mark</span><span class="val">${fmt(mark,6)}</span></div>
        <div class="pos-detail"><span class="lbl">Invertido</span><span class="val">${fmt(p.initialMargin,2)}</span></div>
        <div class="pos-detail"><span class="lbl">Cantidad</span><span class="val">${fmtN(p.quantity,0)}</span></div>
        <div class="pos-detail"><span class="lbl">P&L</span><span class="val pnl ${pc}">${ps}${fmt(Math.abs(p.unrealizedPnl),4)} (${ps}${p.unrealizedPnlPercent.toFixed(2)}%)</span></div>
        <div class="pos-detail"><span class="lbl">Liquidación</span><span class="val down">${fmt(p.liquidationPrice,6)}</span></div>
      </div>
    </div>`;
  }
  h+='</div>';
  cont.innerHTML=h;
}

// ===== HISTORY =====
function renderHistory(trades){
  const list=Object.values(trades).sort((a,b)=>b.closeTime-a.closeTime).slice(0,50);
  const tb=$('#tradeHistoryBody');
  if(!list.length){tb.innerHTML='<tr><td colspan="6" class="empty">Sin operaciones</td></tr>';return}
  let h='';
  for(const t of list){
    const pc=t.pnl>=0?'pnl-up':'pnl-down';
    const ps=t.pnl>=0?'+':'';
    h+=`<tr>
      <td class="dim">${new Date(t.closeTime).toLocaleString()}</td>
      <td><strong>${t.symbol}</strong></td>
      <td>${fmt(t.entryPrice,6)}</td>
      <td>${fmt(t.exitPrice,6)}</td>
      <td>${fmt(t.initialMargin||0,2)}</td>
      <td class="${pc}">${ps}${fmt(Math.abs(t.pnl),4)}</td>
    </tr>`;
  }
  tb.innerHTML=h;
}

// ===== LOG =====
function renderLog(entries){
  if(!entries||!Object.keys(entries).length){
    $('#logContainer').innerHTML='<div class="empty">Sin actividad. Inicia la estrategia.</div>';return
  }
  const list=Object.values(entries).sort((a,b)=>b.time-a.time);
  $('#logContainer').innerHTML=list.map(e=>
    `<div class="log-row ${e.type||'info'}"><span class="log-time">${e.timeStr||''}</span><span class="log-msg">${e.msg}</span></div>`
  ).join('');
  $('#logContainer').scrollTop=0;
}

// ===== TRADE FORM =====
function adjUsdt(d){const el=$('#tradeUsdt');el.value=Math.max(10,parseInt(el.value||200)+d);updateEstimate()}
function setUsdt(v){$('#tradeUsdt').value=v;$$('.quick-amounts button').forEach(b=>b.classList.toggle('active',parseInt(b.textContent)===v));updateEstimate()}
function adjLev(d){const el=$('#tradeLeverage');el.value=Math.max(1,Math.min(125,parseInt(el.value||10)+d))}

$('#tradeSymbol').addEventListener('change',updateEstimate);
$('#tradeUsdt').addEventListener('input',updateEstimate);
$('#tradeLeverage').addEventListener('input',updateEstimate);

function updateEstimate(){
  const price=allPrices[$('#tradeSymbol').value]?.price;
  const usdt=parseFloat($('#tradeUsdt').value)||0;
  const lev=parseFloat($('#tradeLeverage').value)||1;
  if(price&&usdt>0){
    const qty=usdt/price;
    $('#estMargin').textContent=fmt(usdt/lev,2);
    $('#estQty').textContent=fmtN(qty,0);
  }else{$('#estMargin').textContent='—';$('#estQty').textContent='—'}
}

function openTrade(){
  const p={symbol:$('#tradeSymbol').value,side:'LONG',usdtAmount:parseFloat($('#tradeUsdt').value),leverage:parseFloat($('#tradeLeverage').value)};
  if(!p.usdtAmount||p.usdtAmount<=0){return}
  sendReq({type:'OPEN_MARKET',...p});
}

function closeTrade(id){sendReq({type:'CLOSE_POSITION',positionId:id})}
function closeAllPositions(){sendReq({type:'CLOSE_ALL'})}
function resetSimulator(){if(confirm('¿Reiniciar simulador?'))sendReq({type:'RESET'})}
function toggleStrategy(a){
  if(a==='start'){sendReq({type:'STRATEGY_START'});$('#btnStartStrategy').disabled=true;$('#btnStopStrategy').disabled=false}
  else{sendReq({type:'STRATEGY_STOP'});$('#btnStartStrategy').disabled=false;$('#btnStopStrategy').disabled=true}
}

// ===== CHART =====
function initChart(){
  const c=$('#balanceChart');if(!c||typeof Chart==='undefined')return;
  balanceChart=new Chart(c.getContext('2d'),{
    type:'line',
    data:{labels:[],datasets:[{label:'Balance',data:[],borderColor:'#00c278',backgroundColor:'rgba(0,194,120,0.08)',fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{
        x:{display:false,grid:{display:false}},
        y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{callback:v=>fmt(v,0),color:'#555b6b'}}
      }
    }
  });
}

function updateChart(p){
  if(!balanceChart)return;
  balanceHistory.push({time:new Date().toLocaleTimeString(),balance:p.balance});
  if(balanceHistory.length>100)balanceHistory.shift();
  balanceChart.data.labels=balanceHistory.map(x=>x.time);
  balanceChart.data.datasets[0].data=balanceHistory.map(x=>x.balance);
  balanceChart.update('none');
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded',()=>{
  initChart();
  initFB();
  $$('.quick-amounts button').forEach(b=>b.addEventListener('click',function(){setUsdt(parseInt(this.textContent))}));
  setInterval(()=>{if(balanceChart)balanceChart.update('none')},1000);
});
