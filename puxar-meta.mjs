#!/usr/bin/env node
/**
 * puxar-meta.mjs — baixa os resultados da conta de anúncios direto da
 * Marketing API do Meta e grava um JSON que o painel-ads.html lê.
 *
 * Uso:
 *   export META_ACCESS_TOKEN="EAAG..."
 *   export META_AD_ACCOUNT_ID="act_1234567890"
 *   node puxar-meta.mjs --desde 2026-08-01 --ate 2026-08-27
 *
 * Sem dependências: só Node 18 ou mais novo.
 * O token nunca é gravado no arquivo de saída nem impresso na tela.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSOES = ["v23.0", "v22.0", "v21.0", "v20.0"];
const BASE = process.env.META_GRAPH_BASE || "https://graph.facebook.com";

/* ---------------------------------------------------------------- args */
function lerArgs(argv){
  const o = {};
  for (let i = 2; i < argv.length; i++){
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = (argv[i+1] && !argv[i+1].startsWith("--")) ? argv[++i] : "true";
    o[k] = v;
  }
  return o;
}
function lerDotEnv(){
  // procura na pasta atual e ao lado do próprio script
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  for (const alvo of [path.resolve(".env"), path.join(aqui, ".env")]){
    try {
      if (!fs.existsSync(alvo)) continue;
      for (const linha of fs.readFileSync(alvo, "utf8").split(/\r?\n/)){
        const m = linha.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const chave = m[1].toUpperCase();
        if (process.env[chave]) continue;
        process.env[chave] = m[2].replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
      }
      return;
    } catch(e){}
  }
}

/* O `set` do cmd guarda espaços em branco do fim da linha dentro do valor,
   e é fácil colar o token com aspas ou quebra de linha. Limpo os três casos. */
function limpar(v){
  return String(v == null ? "" : v).trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
}
const WIN = process.platform === "win32";
function comoDefinir(nome, exemplo){
  if (WIN){
    return `  No Prompt de Comando (cmd), sem aspas e sem espaço antes do "=":\n` +
           `    set ${nome}=${exemplo}\n\n` +
           `  No PowerShell:\n` +
           `    $env:${nome} = "${exemplo}"\n\n` +
           `  Ou crie um arquivo .env na pasta do projeto com a linha:\n` +
           `    ${nome}=${exemplo}`;
  }
  return `  export ${nome}="${exemplo}"\n\n` +
         `  Ou crie um arquivo .env na pasta do projeto com a linha:\n` +
         `    ${nome}=${exemplo}`;
}
const hoje = () => new Date().toISOString().slice(0,10);
const primeiroDoMes = () => hoje().slice(0,8) + "01";

/* ------------------------------------------------------------- http */
let CHAMADAS = 0;
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function graph(versao, caminho, params, token, tentativa = 0){
  const u = new URL(`${BASE}/${versao}/${caminho}`);
  for (const [k, v] of Object.entries(params || {})){
    if (v == null) continue;
    u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  u.searchParams.set("access_token", token);
  CHAMADAS++;
  let res, texto, corpo;
  try {
    res = await fetch(u, { headers: { "accept": "application/json" } });
    texto = await res.text();
  } catch (e){
    if (tentativa < 4){ await dormir(1500 * Math.pow(2, tentativa)); return graph(versao, caminho, params, token, tentativa+1); }
    throw new Error(`não consegui falar com ${BASE} (${e.message}). Rede, proxy ou firewall bloqueando?`);
  }
  try { corpo = JSON.parse(texto); }
  catch(e){
    if (res.status >= 500 && tentativa < 4){ await dormir(2000 * (tentativa+1)); return graph(versao, caminho, params, token, tentativa+1); }
    throw new Error(`${BASE} respondeu HTTP ${res.status} sem JSON: ${texto.slice(0,120).replace(/\s+/g," ")}`);
  }
  if (corpo && corpo.error){
    const err = corpo.error;
    const limite = [4, 17, 32, 613, 80000, 80004].includes(err.code) || /rate limit|request limit/i.test(err.message || "");
    if (limite && tentativa < 5){
      const espera = 20000 * Math.pow(1.8, tentativa);
      console.error(`   … limite de chamadas do Meta; esperando ${Math.round(espera/1000)}s`);
      await dormir(espera);
      return graph(versao, caminho, params, token, tentativa+1);
    }
    if (err.is_transient && tentativa < 4){ await dormir(3000 * (tentativa+1)); return graph(versao, caminho, params, token, tentativa+1); }
    const e = new Error(err.message || "erro da API do Meta");
    e.meta = err;
    throw e;
  }
  return corpo;
}

async function graphTodas(versao, caminho, params, token, rotulo){
  const linhas = [];
  let corpo = await graph(versao, caminho, params, token);
  let pagina = 1;
  while (true){
    linhas.push(...(corpo.data || []));
    const prox = corpo.paging && corpo.paging.next;
    if (!prox) break;
    pagina++;
    if (pagina % 5 === 0) process.stderr.write(`   … ${rotulo}: ${linhas.length} linhas\r`);
    let r;
    try { r = await fetch(prox); corpo = await r.json(); }
    catch(e){ await dormir(2000); r = await fetch(prox); corpo = await r.json(); }
    CHAMADAS++;
    if (corpo.error) throw Object.assign(new Error(corpo.error.message), { meta: corpo.error });
  }
  return linhas;
}

/* ------------------------------------------------------ normalização */
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
function acoesDe(arr){
  const o = {};
  for (const a of (arr || [])){
    if (!a || !a.action_type) continue;
    o[a.action_type] = (o[a.action_type] || 0) + num(a.value);
  }
  return o;
}
const primeiro = arr => (Array.isArray(arr) && arr[0]) ? num(arr[0].value) : 0;

function normalizar(r){
  const o = {
    d:  r.date_start || null,
    cid: r.campaign_id || null, c: r.campaign_name || "",
    sid: r.adset_id || null,    s: r.adset_name || "",
    aid: r.ad_id || null,       a: r.ad_name || "",
    gasto: num(r.spend),
    impr:  num(r.impressions),
    alc:   num(r.reach),
    cliq:  num(r.clicks),
    lcliq: num(r.inline_link_clicks)
  };
  if (r.publisher_platform) o.pl = r.publisher_platform;
  if (r.platform_position)  o.pp = r.platform_position;
  if (r.impression_device)  o.dv = r.impression_device;
  if (r.device_platform)    o.dv = o.dv || r.device_platform;
  if (r.age)                o.id = r.age;
  if (r.gender)             o.gn = r.gender;
  if (r.region)             o.rg = r.region;
  if (r.country)            o.pa = r.country;
  if (r.hourly_stats_aggregated_by_advertiser_time_zone) o.hr = r.hourly_stats_aggregated_by_advertiser_time_zone;
  const ac = acoesDe(r.actions);
  if (Object.keys(ac).length) o.ac = ac;
  const v25 = primeiro(r.video_p25_watched_actions), v50 = primeiro(r.video_p50_watched_actions),
        v75 = primeiro(r.video_p75_watched_actions), v100 = primeiro(r.video_p100_watched_actions),
        vpl = primeiro(r.video_play_actions), vth = primeiro(r.video_thruplay_watched_actions);
  if (v25 || vpl || vth) o.vd = { play:vpl, p25:v25, p50:v50, p75:v75, p100:v100, thru:vth };
  return o;
}

/* ------------------------------------------------------------- cortes */
const CAMPOS_BASE = "spend,impressions,reach,clicks,inline_link_clicks,actions";
const CAMPOS_VIDEO = "video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_thruplay_watched_actions";

function definirCortes(cfg){
  const janela = { since: cfg.desde, until: cfg.ate };
  return [
    { chave:"diario", rotulo:"série diária por anúncio", essencial:true,
      params:{ level: cfg.nivel, time_increment:1, limit:500,
        fields:`date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,${CAMPOS_BASE},${CAMPOS_VIDEO}`,
        time_range: janela } },
    { chave:"posicionamento", rotulo:"plataforma, posicionamento e dispositivo",
      params:{ level: cfg.nivelCortes, time_increment:1, limit:500,
        breakdowns:"publisher_platform,platform_position,impression_device",
        fields:`date_start,campaign_id,campaign_name,ad_id,ad_name,${CAMPOS_BASE}`,
        time_range: janela } },
    { chave:"criativo_posicionamento", rotulo:"criativo × posicionamento (agregado)",
      params:{ level:"ad", limit:500,
        breakdowns:"publisher_platform,platform_position",
        fields:`campaign_name,ad_id,ad_name,${CAMPOS_BASE}`,
        time_range: janela } },
    { chave:"demografia", rotulo:"idade e gênero",
      params:{ level: cfg.nivelCortes, time_increment:1, limit:500,
        breakdowns:"age,gender",
        fields:`date_start,campaign_id,campaign_name,${CAMPOS_BASE}`,
        time_range: janela } },
    { chave:"regiao", rotulo:"região",
      params:{ level: cfg.nivelCortes, limit:500, breakdowns:"region",
        fields:`campaign_id,campaign_name,${CAMPOS_BASE}`, time_range: janela } },
    { chave:"hora", rotulo:"hora do dia",
      params:{ level: cfg.nivelCortes, limit:500,
        breakdowns:"hourly_stats_aggregated_by_advertiser_time_zone",
        fields:`campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions`,
        time_range: janela } }
  ];
}

/* ---------------------------------------------------------- miniaturas */
async function baixarThumb(url){
  try {
    const r = await fetch(url, { redirect:"follow" });
    if (!r.ok) return null;
    const tipo = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(tipo)) return null;   // veio HTML ou erro, não imagem
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 64 || buf.length > 90000) return null;
    return `data:${tipo};base64,${buf.toString("base64")}`;
  } catch(e){ return null; }
}

async function puxarCriativos(versao, conta, token, comThumbs){
  let ads = [];
  try {
    ads = await graphTodas(versao, `${conta}/ads`, {
      limit: 300,
      fields: "id,name,status,effective_status,created_time,creative{id,thumbnail_url,object_type,title,body}"
    }, token, "criativos");
  } catch(e){
    console.error(`   ! não consegui listar os anúncios (${e.message}) — sigo sem miniaturas`);
    return [];
  }
  const saida = [];
  for (const ad of ads){
    const cr = ad.creative || {};
    const item = {
      aid: ad.id, nome: ad.name || "",
      status: ad.effective_status || ad.status || "",
      tipo: cr.object_type || "",
      titulo: cr.title || "", texto: (cr.body || "").slice(0, 240)
    };
    if (comThumbs && cr.thumbnail_url) item.thumb = await baixarThumb(cr.thumbnail_url);
    saida.push(item);
  }
  return saida;
}

/* ------------------------------------------------- teste de conexão */
const STATUS_CONTA = { 1:"ativa", 2:"desativada", 3:"não paga", 7:"em análise", 8:"pendente", 9:"em período de graça", 100:"fechada", 101:"qualquer" };

async function listarContas(token, versaoPedida){
  let versao = null, eu = null, ultimoErro = null;
  for (const v of (versaoPedida ? [versaoPedida] : VERSOES)){
    try { eu = await graph(v, "me", { fields:"id,name" }, token); versao = v; break; }
    catch(e){
      ultimoErro = e;
      if (/unsupported|version/i.test(e.message)) continue;
      break;
    }
  }
  if (!eu){
    console.error("✗ O token não foi aceito.");
    const c = ultimoErro && ultimoErro.meta && ultimoErro.meta.code;
    if (c === 190) console.error("  Código 190: token expirado ou revogado. Gere outro — veja o README.md.");
    else if (ultimoErro) console.error("  " + ultimoErro.message);
    process.exit(1);
  }
  console.error(`✓ Token válido — autenticado como ${eu.name || eu.id} (Graph ${versao})\n`);

  let contas;
  try {
    contas = await graphTodas(versao, "me/adaccounts", {
      fields: "id,account_id,name,currency,account_status,timezone_name", limit: 200
    }, token, "contas");
  } catch(e){
    console.error("✗ O token não consegue listar contas de anúncios.");
    if (e.meta && (e.meta.code === 200 || e.meta.code === 10 || /permission/i.test(e.message)))
      console.error("  Falta a permissão ads_read. Gere o token de novo marcando ads_read.");
    else console.error("  " + e.message);
    process.exit(1);
  }

  if (!contas.length){
    console.error("✗ O token é válido, mas não enxerga nenhuma conta de anúncios.");
    console.error("  Confira se este usuário tem acesso à conta no Gerenciador — e, se for");
    console.error("  usuário do sistema, se a conta foi atribuída a ele em 'Adicionar ativos'.");
    process.exit(1);
  }

  console.error(`Contas visíveis para este token (${contas.length}):\n`);
  const larg = Math.min(46, Math.max(...contas.map(c => (c.name || "").length), 12));
  for (const c of contas){
    const st = STATUS_CONTA[c.account_status] || ("status " + c.account_status);
    console.error(`  ${(c.name || "(sem nome)").slice(0,larg).padEnd(larg)}  ${String(c.id).padEnd(20)} ${(c.currency||"").padEnd(4)} ${st}`);
  }
  const alvo = contas.find(c => /ituran/i.test(c.name || "")) || contas[0];
  console.error(`\n  Para puxar a conta "${alvo.name || alvo.id}":\n`);
  console.error(`    export META_AD_ACCOUNT_ID="${alvo.id}"`);
  console.error(`    node puxar-meta.mjs --desde ${primeiroDoMes()}\n`);
}

/* --------------------------------------------------------------- main */
async function main(){
  lerDotEnv();
  const args = lerArgs(process.argv);
  if (args.ajuda || args.help){
    console.log(`
puxar-meta.mjs — baixa os resultados da conta de anúncios da API do Meta

  --desde  AAAA-MM-DD   início do período   (padrão: dia 1 do mês corrente)
  --ate    AAAA-MM-DD   fim do período      (padrão: hoje)
  --conta  act_123      id da conta         (ou META_AD_ACCOUNT_ID)
  --saida  arquivo.json onde gravar         (padrão: dados-meta.json)
  --nivel  ad|adset|campaign                (padrão: ad)
  --nivel-cortes  ad|adset|campaign         nível dos recortes (padrão: campaign)
  --sem-thumbs          não baixa as miniaturas dos criativos
  --api    v23.0        versão da Graph API

  --contas              testa o token e lista as contas que ele enxerga
                        (use antes da primeira puxada)

O token vem de META_ACCESS_TOKEN (variável de ambiente ou arquivo .env).
`);
    return;
  }

  const token = limpar(process.env.META_ACCESS_TOKEN);
  const conta0 = limpar(args.conta || process.env.META_AD_ACCOUNT_ID || "");
  if (!token){
    console.error("✗ Falta o token de acesso (META_ACCESS_TOKEN).\n");
    console.error(comoDefinir("META_ACCESS_TOKEN", "EAAG..."));
    console.error("\n  Como gerar o token está no README.md.");
    process.exit(1);
  }

  // testar a conexão não exige id de conta — é justamente para descobrir qual usar
  if (args.contas || args.testar || args.teste){
    await listarContas(token, args.api);
    return;
  }
  if (!conta0){
    console.error("✗ Falta o id da conta de anúncios (META_AD_ACCOUNT_ID).\n");
    console.error("  Rode  node puxar-meta.mjs --contas  para ver as suas e copiar o id.\n");
    console.error(comoDefinir("META_AD_ACCOUNT_ID", "act_1234567890"));
    console.error("\n  Ou passe direto:  node puxar-meta.mjs --conta act_1234567890");
    process.exit(1);
  }
  const so = conta0.replace(/\D/g, "");
  const conta = /^act_\d+$/.test(conta0) ? conta0 : (so ? "act_" + so : conta0);
  if (!/^act_\d+$/.test(conta)){
    console.error(`✗ "${conta0}" não parece um id de conta. Esperado algo como act_1234567890.`);
    console.error("  Rode  node puxar-meta.mjs --contas  para ver as suas.");
    process.exit(1);
  }

  const cfg = {
    desde: args.desde || primeiroDoMes(),
    ate:   args.ate   || hoje(),
    nivel: args.nivel || "ad",
    nivelCortes: args["nivel-cortes"] || "campaign",
    saida: args.saida || "dados-meta.json",
    thumbs: !args["sem-thumbs"]
  };

  // versão da API que a conta aceita
  let versao = args.api || null, contaInfo = null;
  for (const v of (versao ? [versao] : VERSOES)){
    try {
      contaInfo = await graph(v, conta, { fields:"id,name,currency,timezone_name,account_status" }, token);
      versao = v; break;
    } catch(e){
      if (/unsupported|version/i.test(e.message) ) continue;
      console.error(`✗ Não consegui abrir a conta ${conta}: ${e.message}`);
      if (e.meta && e.meta.code === 190) console.error("  O token expirou ou não tem permissão ads_read. Gere outro — veja o README.md.");
      if (e.meta && e.meta.code === 100) console.error("  Confira o id da conta: é o número depois de act_ na URL do Gerenciador.");
      process.exit(1);
    }
  }
  if (!contaInfo){ console.error("✗ Nenhuma versão da Graph API respondeu. Tente --api v22.0"); process.exit(1); }

  console.error(`▸ Conta: ${contaInfo.name || conta} (${contaInfo.currency || "?"}, ${contaInfo.timezone_name || "?"})`);
  console.error(`▸ Período: ${cfg.desde} a ${cfg.ate} · API ${versao} · nível ${cfg.nivel}\n`);

  const cortes = {}, avisos = [];
  for (const corte of definirCortes(cfg)){
    process.stderr.write(`  ${corte.rotulo}… `);
    try {
      const cru = await graphTodas(versao, `${conta}/insights`, corte.params, token, corte.rotulo);
      cortes[corte.chave] = cru.map(normalizar);
      console.error(`${cru.length} linhas`);
    } catch(e){
      console.error(`falhou — ${e.message}`);
      avisos.push(`${corte.rotulo}: ${e.message}`);
      if (corte.essencial){
        console.error("\n✗ O corte principal falhou; sem ele não há relatório. Abortando.");
        process.exit(1);
      }
    }
    await dormir(400);
  }

  // catálogo de tipos de ação, para o painel deixar escolher o que conta como lead
  const totalAcoes = {};
  for (const linha of (cortes.diario || [])){
    for (const [t, v] of Object.entries(linha.ac || {})) totalAcoes[t] = (totalAcoes[t] || 0) + v;
  }
  const PREF = ["onsite_conversion.lead_grouped","lead","offsite_conversion.fb_pixel_lead",
                "leadgen_grouped","onsite_conversion.lead_form","offsite_conversion.fb_pixel_complete_registration",
                "onsite_conversion.messaging_conversation_started_7d","link_click"];
  const disponiveis = Object.entries(totalAcoes).map(([tipo,total]) => ({tipo,total}))
    .sort((a,b) => b.total - a.total);
  const sugerida = PREF.find(t => totalAcoes[t] > 0) || (disponiveis[0] && disponiveis[0].tipo) || null;

  process.stderr.write("  criativos e miniaturas… ");
  const criativos = await puxarCriativos(versao, conta, token, cfg.thumbs);
  console.error(`${criativos.length} anúncios${cfg.thumbs ? ", " + criativos.filter(c=>c.thumb).length + " com miniatura" : ""}`);

  const saida = {
    formato: "painel-ituranmob/1",
    conta: { id: conta, nome: contaInfo.name || "", moeda: contaInfo.currency || "BRL", fuso: contaInfo.timezone_name || "" },
    periodo: { de: cfg.desde, ate: cfg.ate },
    origem: { api: versao, nivel: cfg.nivel, nivel_cortes: cfg.nivelCortes, gerado_em: new Date().toISOString(), chamadas: CHAMADAS },
    acoes: { disponiveis, sugerida },
    avisos,
    cortes,
    criativos
  };

  fs.writeFileSync(cfg.saida, JSON.stringify(saida));
  const mb = (fs.statSync(cfg.saida).size / 1048576).toFixed(2);
  const linhas = Object.values(cortes).reduce((s,v) => s + v.length, 0);
  console.error(`\n✓ ${cfg.saida} — ${linhas} linhas, ${mb} MB, ${CHAMADAS} chamadas à API`);
  if (sugerida) console.error(`  Lead sugerido: "${sugerida}" (${Math.round(totalAcoes[sugerida] || 0)} no período). Dá para trocar no painel.`);
  if (avisos.length) console.error(`  ${avisos.length} corte(s) não vieram — o painel esconde as seções correspondentes.`);
  console.error(`\n  Agora abra painel-ads.html e solte o ${cfg.saida} nele.`);
}

main().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
