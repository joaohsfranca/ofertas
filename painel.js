// Painel de ofertas. O coletor (ofertas.py) grava, a cada coleta:
//   meta.js         pequeno: horário, buscas salvas, estado dos agentes, versão de cada parte e o token do receptor
//   ofertas-br.js   ofertas ativas do Brasil · ofertas-cn.js  da China · ofertas-py.js  do Paraguai · ofertas-exp.js  expiradas (só se pedir)
// O painel relê o meta.js a cada minuto e só baixa a parte cuja versão mudou (antes eram 6,5 MB a cada 5 min).
// Filtros: cada grupo (categoria, marca, loja…) aceita VÁRIAS escolhas (OU dentro do grupo, E entre grupos).
// base() = o que define o universo (status, período, busca, "minhas buscas"); aplicar() = os demais grupos.
// A contagem de cada opção ignora o próprio grupo (faceta), então dá para somar escolhas sem zerar a lista.
const $ = (id) => document.getElementById(id);
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const rel = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
// formatadores criados uma vez: toLocaleString() cria um novo a cada chamada e era o que mais pesava ao montar cartões
const fmtInt = new Intl.NumberFormat("pt-BR");
const fmtData = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CHAVE = "ofertas.filtros.v5";
const CHAVE_ANTIGA = "ofertas.filtros.v4";
const CHAVE_VISITA = "ofertas.visita.v1";
const RECEPTOR = "http://127.0.0.1:8766";
// Site publicado (https ou outro endereço que não seja este computador): só leitura. O receptor, o banco e os Chromes logados ficam no
// computador do agente; daqui não dá para buscar nem comparar. "?leitura=1" liga o mesmo modo para testar localmente.
const SOMENTE_LEITURA = new URLSearchParams(location.search).has("leitura") || !(location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(location.hostname));
if (SOMENTE_LEITURA) document.body.classList.add("leitura");
const PASSO = 60;                                    // cartões por vez; mais aparecem ao rolar
const MAX_OPCOES = 6;                                // opções visíveis por grupo antes de "Ver todos"
const NOME_FONTE = { "Busca profunda": "Busca nas lojas" };
const nomeFonte = (f) => NOME_FONTE[f] || f;
const GRUPOS = [
  { k: "wish", titulo: "Minhas buscas", campo: "wishlist" },
  { k: "seg", titulo: "Categoria", campo: "segmento" },
  { k: "marca", titulo: "Marca", campo: "marca" },
  { k: "loja", titulo: "Loja", campo: "loja" },
  { k: "pub", titulo: "Público", campo: "publico" },
  { k: "fonte", titulo: "Fonte", campo: "fonte", nome: nomeFonte },
];
const PERSISTE = ["v-pmin", "v-pmax", "v-nota", "v-periodo", "v-ordem", "v-agrupar", "v-promo", "v-menor", "v-conf", "v-cupons", "v-exp"];
const PADRAO = { "v-nota": "0", "v-agrupar": true };
// China ordena pelo custo total (produto + frete estimado): é a comparação que importa entre AliExpress, 1688 e Taobao
const ORDEM_PADRAO = { br: "score", cn: "preco", py: "preco" };
const padrao = (id) => (id === "v-ordem" ? ORDEM_PADRAO[mercado] : PADRAO[id]);
const ABERTO_PADRAO = new Set(["wish", "seg"]);
const LOJAS_BUSCA = [["Amazon", "Amazon"], ["Magazine Luiza", "Magalu"], ["Mercado Livre", "Mercado Livre"], ["Shopee", "Shopee"], ["Shein", "Shein"], ["Kabum", "Kabum"]];
const FONTES_PYTHON = ["Pelando", "Promobit", "Kabum"];   // o que o receptor busca sozinho, sem a extensão do Chrome
const DURACAO_BUSCA = 4 * 60e3;
const LOJAS_CN = [["1688", "1688"], ["Taobao", "Taobao"]];   // AliExpress desligado (config.json > china.fontes_cn)
const DURACAO_CN = 150e3;                          // AliExpress em segundos; KakoBuy abre o Chrome dedicado e leva ~30 a 60 s
const CHAVE_MERCADO = "ofertas.mercado.v1";
const lerMercado = () => { try { const m = localStorage.getItem(CHAVE_MERCADO); return m === "cn" || m === "py" ? m : "br"; } catch (_) { return "br"; } };
let mercado = lerMercado();
const chaveEstado = (base = CHAVE) => (mercado === "br" ? base : `${base}.${mercado}`);   // filtros guardados separados por mercado
const doMercado = (o) => o.mercado === mercado;
// China e Paraguai são catálogo (o que as buscas trouxeram), não feed de ofertas do dia: sem período, cupons nem expiradas
const catalogo = () => mercado !== "br";
const NOME_MERCADO = { cn: "na China", py: "no Paraguai" };
// aba "Comparar": Brasil × Paraguai × China para um produto (o resultado vem pronto do receptor em META.comparativos)
const NOME_M = { br: "Brasil", py: "Paraguai", cn: "China" };
let vistaCmp = false;                                // true = aba Comparar aberta (o painel de ofertas fica escondido)
let cmpSel = null;                                   // termo da comparação à mostra
let cmpTimer = null;                                 // acompanha a comparação em andamento
let cmpAssinatura = "";                              // para só redesenhar quando algo mudou

let META = null;                                     // conteúdo do meta.js
let D = null;                                        // META + ofertas das partes já carregadas
const partes = {};                                   // "br" | "cn" | "exp" -> lista preparada
const versaoParte = {};
const F = Object.fromEntries(GRUPOS.map((g) => [g.k, new Set()]));
let vista = "grade";
let limite = PASSO;
let ultimaLista = [];                                // a lista do último desenho (para "carregar mais" sem refazer tudo)
let soNovas = false;                                 // filtro "novas desde a última visita"
let estadoReceptor = null;                           // resposta do GET /estado: receptor no ar, extensão viva, buscas em curso
const abertos = new Set();                           // grupos de "iguais" abertos (sobrevivem ao redesenho)
const estadoGrupo = new Map();                       // grupos do filtro abertos/fechados pelo usuário
const verTodos = new Set();                          // grupos com a lista completa à mostra
const buscaFacet = {};                               // texto digitado na busca dentro de cada grupo
let acoesChips = [];

const semAcento = (t) => (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const quando = (o) => o.tq;
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const val = (id) => { const e = $(id); return e.type === "checkbox" ? e.checked : e.value; };
const descVal = () => document.querySelector('input[name="desc"]:checked').value;
const setDesc = (v) => { const r = document.querySelector(`input[name="desc"][value="${v}"]`); if (r) r.checked = true; };
const atrasa = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const plural = (n, um, varios) => (n === 1 ? um : varios);
// só deixa passar link http(s): dado coletado não pode trazer "javascript:" para dentro de um href
const seguro = (u) => { try { return /^https?:$/.test(new URL(u, location.href).protocol) ? u : "#"; } catch (_) { return "#"; } };
const lojaChave = (l) => (l === "Magalu" ? "Magazine Luiza" : l);   // o coletor grava a mesma loja com dois nomes
const token = () => "&t=" + encodeURIComponent((META && META.token) || "");
const COMUNIDADE = new Set(["Pelando", "Promobit"]);

function idade(iso) {
  if (!iso) return "";
  const min = Math.round((new Date(iso) - Date.now()) / 60000);
  if (min > -60) return rel.format(min, "minute");
  if (min > -1440) return rel.format(Math.round(min / 60), "hour");
  return rel.format(Math.round(min / 1440), "day");
}
const horasTxt = (h) => (h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`);

// última visita: "novas" = chegaram depois da visita anterior (uma visita = abrir o painel com mais de 30 min de intervalo)
const visita = (() => {
  let v = { anterior: 0, atual: 0 };
  try { v = { ...v, ...JSON.parse(localStorage.getItem(CHAVE_VISITA) || "{}") }; } catch (_) {}
  const agora = Date.now();
  if (v.atual && agora - v.atual > 30 * 60e3) v.anterior = v.atual;
  v.atual = agora;
  try { localStorage.setItem(CHAVE_VISITA, JSON.stringify(v)); } catch (_) {}
  return v;
})();
const ehNova = (o) => visita.anterior && o.tp > visita.anterior;

// prepara uma parte recém-carregada: campos vazios não vêm no arquivo (padrões aqui) e o texto de busca é normalizado UMA vez
function preparar(lista) {
  for (const o of lista) {
    for (const k of ["publicado_em", "primeiro_visto", "ultimo_visto"]) if (typeof o[k] === "number") o[k] *= 1000;   // vêm em segundos
    o.score = o.score || 0;
    o.mercado = o.mercado || "br";
    o.bt = semAcento(`${o.titulo} ${o.loja || ""} ${o.marca || ""}`);
    o.tq = new Date(o.publicado_em || o.primeiro_visto).getTime() || 0;
    o.tp = new Date(o.primeiro_visto).getTime() || 0;
    // China: 1688/Taobao comparam pelo total estimado (produto + frete); o preço do produto fica em preco_produto
    if (o.total && o.extras != null && o.preco_produto == null) { o.preco_produto = o.preco; o.preco = o.total; }
  }
  return lista;
}

// ---------- estado ----------
function salvar() {
  const v = { F: {}, c: {}, vista };
  GRUPOS.forEach((g) => (v.F[g.k] = [...F[g.k]]));
  PERSISTE.forEach((id) => (v.c[id] = val(id)));
  v.c.desc = descVal();
  try { localStorage.setItem(chaveEstado(), JSON.stringify(v)); } catch (_) {}
}
function restaurar() {
  $("v-periodo").value = String(D.horas_padrao || 48);
  $("v-ordem").value = padrao("v-ordem");
  let v = null;
  try { v = JSON.parse(localStorage.getItem(chaveEstado())); } catch (_) {}
  if (!v) {   // 1ª vez nesta versão: aproveita os filtros da anterior, menos a ordem da China (o padrão mudou para custo total)
    try { v = JSON.parse(localStorage.getItem(chaveEstado(CHAVE_ANTIGA))); } catch (_) {}
    if (v && v.c && mercado === "cn") { delete v.c["v-ordem"]; delete v.c["v-exp"]; }   // "expiradas" não tem controle na China
  }
  if (!v) return;
  GRUPOS.forEach((g) => (F[g.k] = new Set((v.F && v.F[g.k]) || [])));
  PERSISTE.forEach((id) => {
    if (!v.c || !(id in v.c)) return;
    const e = $(id);
    if (e.type === "checkbox") e.checked = v.c[id]; else e.value = v.c[id];
  });
  if (v.c && v.c.desc) setDesc(v.c.desc);
  vista = v.vista === "lista" ? "lista" : "grade";
  ["v-periodo", "v-ordem"].forEach((id) => {  // valor salvo que não existe mais nas opções volta ao padrão
    const e = $(id);
    if (![...e.options].some((o) => o.value === e.value)) e.value = id === "v-ordem" ? padrao(id) : String(D.horas_padrao || 48);
  });
}
function zerarCampos() {
  GRUPOS.forEach((g) => F[g.k].clear());
  PERSISTE.forEach((id) => {
    const e = $(id);
    if (e.type === "checkbox") e.checked = !!padrao(id); else e.value = padrao(id) ?? "";
  });
  $("v-periodo").value = String((D && D.horas_padrao) || 48);
  $("v-nota-v").value = val("v-nota");
  $("q").value = "";
  soNovas = false;
  setDesc("0");
}
function limpar() { zerarCampos(); mudou(); }

// troca Brasil <-> China: guarda os filtros de quem sai, carrega os de quem entra
function trocarMercado(m) {
  if (m === mercado) return;
  fecharFiltros();
  if (D) salvar();
  mercado = m;
  try { localStorage.setItem(CHAVE_MERCADO, m); } catch (_) {}
  zerarCampos();
  if (D) restaurar();
  $("v-nota-v").value = val("v-nota");
  aplicarMercadoUI();
  limite = PASSO;
  if (!D) return;
  if (!partes[m]) { carregando(); atualizar(false); } else { render(); anunciar(); }
}
// o que muda de aparência com o mercado: texto da busca, controles que só fazem sentido no Brasil
function aplicarMercadoUI() {
  if (vistaCmp) {
    $("q").placeholder = "Produto para comparar nos 3 mercados: jbl flip 6, tênis asics, moletom…";
    $("b-lojas").textContent = "Comparar 3 mercados";
    $("b-ampla").hidden = true;
    document.title = "Ofertas · Comparar";
    return;
  }
  const cat = catalogo();
  $("q").placeholder = { cn: "Buscar na China: moletom, camiseta, tênis…", py: "Buscar no Paraguai: iphone 16, perfume, playstation 5…" }[mercado] || "Filtrar ou buscar: tênis asics, iphone 17…";
  $("b-lojas").textContent = cat ? `Buscar ${NOME_MERCADO[mercado]}` : "Buscar nas lojas";
  $("b-ampla").hidden = cat;
  document.body.classList.toggle("cn", mercado === "cn");
  const periodo = document.querySelector('details[data-g="periodo"]');
  if (periodo) periodo.hidden = cat;                                 // catálogo não tem "ofertas das últimas horas"
  ["v-cupons", "v-exp"].forEach((id) => { const l = $(id).closest("label"); if (l) l.hidden = cat; });
  document.title = { cn: "Ofertas · China", py: "Ofertas · Paraguai" }[mercado] || "Ofertas";
}
// toda mudança feita pelo usuário: volta ao começo da lista, grava, redesenha e avisa o leitor de tela (com atraso)
function mudou() { limite = PASSO; salvar(); render(); anunciar(); }
const mudouAtrasado = atrasa(mudou, 150);
const anunciar = atrasa(() => { $("anuncio").textContent = $("contagem").textContent; }, 700);

// ---------- filtros ----------
function base(exceto) {
  const termos = semAcento($("q").value).split(/\s+/).filter(Boolean);
  const horas = Number(val("v-periodo"));
  const cn = mercado === "cn", cat = catalogo();
  // em "Minhas buscas", em "novas" e no catálogo (China, Paraguai) o período não corta
  const lim = cat || soNovas || F.wish.size || exceto === "wish" || !horas ? 0 : Date.now() - horas * 3600e3;
  const exp = !cat && val("v-exp"), cupons = val("v-cupons"), promo = val("v-promo");   // controle oculto no catálogo: nunca filtra lá
  return D.ofertas.filter((o) => {
    if (!doMercado(o)) return false;
    if (!exp && o.status !== "active") return false;
    if (!cupons && o.tipo === "cupom") return false;
    if (promo && o.tipo === "produto") return false;  // "produto" = busca nas lojas a preço normal
    if (lim && o.tq < lim) return false;
    if (soNovas && !ehNova(o)) return false;
    if (exceto !== "wish" && F.wish.size && !F.wish.has(o.wishlist)) return false;
    if (termos.length && !termos.every((b) => o.bt.includes(b))) return false;
    return true;
  });
}

function aplicar(lista, exceto) {
  const pmin = Number(val("v-pmin")) || 0, pmax = Number(val("v-pmax")) || 0;
  const desc = Number(descVal()), nota = Number(val("v-nota"));
  const menor = val("v-menor"), conf = val("v-conf");
  const grupos = GRUPOS.filter((g) => g.k !== "wish" && g.k !== exceto && F[g.k].size);
  return lista.filter((o) => {
    for (const g of grupos) if (!F[g.k].has(o[g.campo])) return false;
    if (pmin && !(o.preco >= pmin)) return false;
    if (pmax && !(o.preco <= pmax)) return false;
    if (desc && !((o.desconto || 0) >= desc)) return false;
    if (o.score < nota) return false;
    if (menor && !o.menor_preco) return false;
    if (conf && o.loja_tipo !== "confiavel") return false;
    return true;
  });
}

function contar(lista, campo) {
  const m = new Map();
  lista.forEach((o) => o[campo] && m.set(o[campo], (m.get(o[campo]) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"));
}

const suspeita = (o) => ((o.alertas || []).length || o.replica ? 1 : 0);   // suspeita de réplica não esconde: marca, desce na ordem e não vira "melhor oferta"
const TXT_REPLICA = "Possível réplica ou marca famosa (o título tem termo de réplica ou o nome de uma marca copiada). Não é de confiança: confira o anúncio, as avaliações e o vendedor antes de comprar.";
const motivosSuspeita = (o) => [...(o.alertas || []), ...(o.replica ? [TXT_REPLICA] : [])];
// quem fica na frente de um grupo: ativa, sem suspeita de preço, mais barata, maior nota
const cmpRep = (a, b) => (b.status === "active") - (a.status === "active") || suspeita(a) - suspeita(b) || (a.preco ?? Infinity) - (b.preco ?? Infinity) || b.score - a.score;

// mesmo produto anunciado várias vezes (lojas/preços diferentes) vira um cartão só, com o mais barato na frente.
// O cartão mostra a nota DELE (não a maior do grupo). Preço mais de 2,5x acima do menor da faixa = outro produto com o
// mesmo nome (ex.: camiseta e tênis da mesma marca): vira outro cartão.
function agrupar(lista) {
  if (!val("v-agrupar")) return lista.map((o) => ({ ...o, iguais: [] }));
  const g = new Map();
  lista.forEach((o) => { const k = o.chave || o.uid; (g.get(k) || g.set(k, []).get(k)).push(o); });
  const saida = [];
  for (const itens of g.values()) {
    if (itens.length === 1) { saida.push({ ...itens[0], iguais: [] }); continue; }
    const faixas = [];
    itens.filter((x) => x.preco).sort((a, b) => a.preco - b.preco).forEach((x) => {
      const f = faixas[faixas.length - 1];
      if (f && x.preco <= f[0].preco * 2.5) f.push(x); else faixas.push([x]);
    });
    const semPreco = itens.filter((x) => !x.preco);
    if (semPreco.length) { if (faixas.length) faixas[0].push(...semPreco); else faixas.push(semPreco); }
    for (const f of faixas) {
      f.sort(cmpRep);
      const [rep, ...resto] = f;
      saida.push({ ...rep, iguais: resto });
    }
  }
  return saida;
}

function ordenar(lista) {
  const cmp = {
    score: (a, b) => b.score - a.score || b.tq - a.tq,
    recente: (a, b) => b.tq - a.tq,
    desconto: (a, b) => (b.desconto ?? -1) - (a.desconto ?? -1),
    preco: (a, b) => suspeita(a) - suspeita(b) || (a.preco ?? Infinity) - (b.preco ?? Infinity),
  }[val("v-ordem")] || ((a, b) => b.score - a.score);
  return lista.sort(cmp);
}

// ---------- filtros: desenho dos grupos ----------
const grupoAberto = (k) => (estadoGrupo.has(k) ? estadoGrupo.get(k) : ABERTO_PADRAO.has(k));

function htmlGrupo(g, pares) {
  const sel = F[g.k];
  const nome = g.nome || ((v) => v);
  const nSel = sel.size ? `<span class="n-sel">${sel.size}</span>` : "";
  let corpo;
  if (!pares.length) {
    corpo = `<p class="vazio-facet">${g.k === "wish" ? "Faça uma busca nas lojas e ela aparece aqui." : "Nada para filtrar com a seleção atual."}</p>`;
  } else {
    const ord = g.k === "wish" ? pares : [...pares.filter((p) => sel.has(p[0])), ...pares.filter((p) => !sel.has(p[0]))];  // marcadas primeiro
    const lim = Math.max(MAX_OPCOES, sel.size);
    const todos = verTodos.has(g.k);
    const busca = ord.length > 10 ? `<input class="opc-busca" type="search" placeholder="Buscar ${g.titulo.toLowerCase()}" aria-label="Buscar em ${esc(g.titulo)}" data-fb="${g.k}" data-fk="fb:${g.k}" value="${esc(buscaFacet[g.k] || "")}">` : "";
    const itens = ord.map(([v, n], i) => {
      const on = sel.has(v);
      return `<li class="${i >= lim ? "extra" : ""}" data-t="${esc(semAcento(nome(v)))}"><label><input type="checkbox" data-g="${g.k}" data-v="${esc(v)}" data-fk="${g.k}:${esc(v)}"${on ? " checked" : ""}${n === 0 && !on ? " disabled" : ""}><span class="rot">${esc(nome(v))}</span><span class="qtd">${n}</span></label></li>`;
    }).join("");
    corpo = `${busca}<ul class="opc${todos ? " todos" : ""}" data-ul="${g.k}">${itens}</ul>${
      ord.length > lim ? `<button type="button" class="link" data-vt="${g.k}" data-fk="vt:${g.k}">${todos ? "Ver menos" : `Ver todos (${ord.length})`}</button>` : ""}`;
  }
  return `<details class="grupo" data-g="${g.k}"${grupoAberto(g.k) ? " open" : ""}><summary>${g.titulo}${nSel}</summary>${corpo}</details>`;
}

function aplicarBuscaFacet() {
  document.querySelectorAll("ul.opc[data-ul]").forEach((ul) => {
    const t = semAcento(buscaFacet[ul.dataset.ul] || "").trim();
    ul.classList.toggle("buscando", !!t);
    ul.querySelectorAll("li").forEach((li) => li.classList.toggle("oculta", !!t && !li.dataset.t.includes(t)));
  });
}

function desenharFacetas(b) {
  const foco = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.fk;
  GRUPOS.forEach((g) => {
    let pares;
    if (g.k === "wish") {  // produtos distintos de cada busca salva, respeitando os demais filtros (como nos outros grupos)
      const resto = aplicar(base("wish"), "wish");
      const por = new Map();
      resto.forEach((o) => { if (o.wishlist) (por.get(o.wishlist) || por.set(o.wishlist, new Set()).get(o.wishlist)).add(o.chave || o.uid); });
      pares = (({ cn: D.wishlist_cn, py: D.wishlist_py }[mercado] || (mercado === "br" ? D.wishlist : [])) || []).map((t) => [t, por.has(t) ? por.get(t).size : 0]);
    } else {
      pares = contar(aplicar(b, g.k), g.campo);
    }
    F[g.k].forEach((v) => { if (!pares.some((p) => p[0] === v)) pares.push([v, 0]); });
    $("g-" + g.k).innerHTML = pares.length || g.k === "wish" || F[g.k].size ? htmlGrupo(g, pares) : "";
  });
  aplicarBuscaFacet();
  if (foco) { const e = document.querySelector(`[data-fk="${CSS.escape(foco)}"]`); if (e) e.focus({ preventScroll: true }); }
}

// ---------- filtros ativos (removíveis) ----------
function filtrosAtivos() {
  const l = [];
  if (soNovas) l.push({ t: "Novas desde a última visita", rm: () => { soNovas = false; } });
  GRUPOS.forEach((g) => F[g.k].forEach((v) => l.push({ t: `${g.titulo}: ${(g.nome || ((x) => x))(v)}`, rm: () => F[g.k].delete(v) })));
  const pmin = val("v-pmin"), pmax = val("v-pmax");
  if (pmin || pmax) l.push({ t: pmin && pmax ? `Preço: ${brl.format(pmin)} a ${brl.format(pmax)}` : pmin ? `Preço: a partir de ${brl.format(pmin)}` : `Preço: até ${brl.format(pmax)}`, rm: () => { $("v-pmin").value = ""; $("v-pmax").value = ""; } });
  if (descVal() !== "0") l.push({ t: `Desconto: ${descVal()}% ou mais`, rm: () => setDesc("0") });
  if (val("v-nota") !== "0") l.push({ t: `Nota: ${val("v-nota")} ou mais`, rm: () => { $("v-nota").value = "0"; $("v-nota-v").value = "0"; } });
  const padraoPer = String(D.horas_padrao || 48);
  if (mercado === "br" && val("v-periodo") !== padraoPer) l.push({ t: `Período: ${$("v-periodo").selectedOptions[0].text.toLowerCase()}`, rm: () => { $("v-periodo").value = padraoPer; } });
  [["v-promo", "Só promoções"], ["v-menor", "Só menor preço visto"], ["v-conf", "Só lojas confiáveis"], ["v-cupons", "Com cupons"], ["v-exp", "Com expiradas"]]
    .forEach(([id, t]) => { if (val(id)) l.push({ t, rm: () => { $(id).checked = false; } }); });
  if (!val("v-agrupar")) l.push({ t: "Sem agrupar iguais", rm: () => { $("v-agrupar").checked = true; } });
  return l;
}

function desenharAtivos() {
  acoesChips = filtrosAtivos();
  const box = $("ativos");
  box.hidden = !acoesChips.length;
  box.innerHTML = acoesChips.map((c, i) => `<button type="button" class="fchip" data-i="${i}" aria-label="Remover filtro: ${esc(c.t)}">${esc(c.t)}<i aria-hidden="true">×</i></button>`).join("")
    + (acoesChips.length > 1 ? `<button type="button" class="link" data-i="todos">Limpar tudo</button>` : "");
  const n = $("n-filtros");
  n.hidden = !acoesChips.length;
  n.textContent = acoesChips.length;
}

// ---------- cartões ----------
// o coletor usa o campo "cupom" também para observações ("envio nacional", "vendido por X · preço no Pix").
// Só código de verdade ganha o rótulo "Cupom" (uma palavra, com número ou toda em maiúsculas).
const ehCodigo = (t) => /^[A-Za-z0-9_-]{4,}$/.test(t) && (/\d/.test(t) || t === t.toUpperCase());
function itemCupom(o) {
  const t = (o.cupom || "").replace(/[\s·]+$/, "").trim();
  if (!t) return "";
  return ehCodigo(t) ? `<span>Cupom <b>${esc(t)}</b></span>` : `<span>${esc(t)}</span>`;
}

function precoHtml(v) {
  const [inteiro, cent] = v.toFixed(2).split(".");
  return `<span class="preco"><span class="sr">${brl.format(v)}</span><span class="rs" aria-hidden="true">R$</span><span class="int" aria-hidden="true">${fmtInt.format(Number(inteiro))}</span><span class="cent" aria-hidden="true">,${cent}</span></span>`;
}

// selo de desconto: verde = confirmado (histórico de preço ou comunidade); âmbar = só a loja diz
function seloDesconto(o) {
  if (!o.desconto) return "";
  const hist = o.desconto_origem === "histórico";
  const conferido = hist || COMUNIDADE.has(o.fonte);
  const titulo = hist ? "Contra a mediana do histórico de preços" : conferido ? "Desconto anunciado, conferido pela comunidade" : "Desconto anunciado pela loja, sem confirmação no histórico de preços";
  return `<span class="desc ${hist ? "hist" : conferido ? "" : "anunc"}" title="${titulo}">-${Math.round(o.desconto)}%${hist ? " real" : ""}<span class="sr">${conferido ? "" : " (anunciado pela loja)"}</span></span>`;
}

function linhaIgual(x) {
  const p = x.preco ? brl.format(x.preco) : "cupom";
  return `<li><span>${esc(x.loja)}${x.status !== "active" ? " (expirada)" : ""}${suspeita(x) ? ` <span title="${esc(motivosSuspeita(x).join(" · "))}">${(x.alertas || []).length ? "⚠ confirme" : "⚠ possível réplica"}</span>` : ""}</span><a href="${esc(seguro(x.link))}" target="_blank" rel="noopener" aria-label="${p} na ${esc(x.loja)} (abre em nova aba)">${p}</a></li>`;
}

function tempoTitulo(o) {
  const desde = o.primeiro_visto ? `no app desde ${fmtData.format(o.primeiro_visto)}` : "";
  if (COMUNIDADE.has(o.fonte)) return `Postada ${idade(o.publicado_em || o.primeiro_visto)} · ${desde}`;
  return `Preço lido ${idade(o.ultimo_visto || o.primeiro_visto)} · ${desde}`;
}

function cartao(o) {
  const nivel = o.score >= 60 ? "n-alta" : o.score >= 35 ? "n-media" : "n-baixa";
  const cn = o.mercado === "cn";
  const etq = [];
  if (o.menor_preco) etq.push(`<span class="tag" title="Menor preço já visto para este produto nos últimos 90 dias">Menor preço</span>`);
  if (o.suspeito) etq.push(`<span class="tag alerta" title="O preço 'de' está acima do que foi praticado nos últimos 90 dias">Desconto inflado</span>`);
  if ((o.alertas || []).length) etq.push(`<span class="tag alerta" title="${esc(o.alertas.join(" · "))}">Confirme o preço</span>`);
  if (o.replica) etq.push(`<span class="tag alerta" title="${esc(TXT_REPLICA)}">Possível réplica · não é de confiança</span>`);
  if (o.tipo === "cupom") etq.push(`<span class="tag cinza">Cupom</span>`);
  if (o.status !== "active") etq.push(`<span class="tag cinza">Expirada</span>`);
  if (o.marca_cn) etq.push(`<span class="tag" title="Marca chinesa registrada">Marca chinesa</span>`);
  const rotulo = esc(o.titulo);
  const aria = `aria-label="Ver oferta: ${rotulo} (abre em nova aba)"`;
  const foto = o.imagem
    ? `<a class="foto" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(seguro(o.imagem))}" alt="" onload="this.parentNode.classList.add('ok')" onerror="this.parentNode.classList.add('sem');this.remove()"></a>`
    : `<a class="foto sem" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"></a>`;
  // China: 1688/Taobao mostram o total com frete; AliExpress, o preço anunciado. O selo diz qual é qual.
  // Paraguai: o preço da loja é em dólar à vista; o R$ grande é a conversão do Compras Paraguai
  const py = o.mercado === "py";
  const base_ = cn ? (o.preco_produto != null ? `<span class="pt" title="Produto + frete aéreo e frete interno estimados. Sem imposto.">com frete</span>` : `<span class="pt cinza" title="Preço anunciado pelo AliExpress (pode haver imposto na compra)">anunciado</span>`)
    : py && o.cupom ? `<span class="pt cinza" title="Preço da loja em dólar, à vista. Em reais pelo câmbio do Compras Paraguai. Sem imposto.">${esc(o.cupom)}</span>` : "";
  const preco = o.preco
    ? `<div class="preco-linha">${precoHtml(o.preco)}${seloDesconto(o)}</div>${o.preco_antigo || base_ ? `<div class="preco-de">${o.preco_antigo && !cn ? `<s><span class="sr">de </span>${brl.format(o.preco_antigo)}</s>` : ""}${base_}</div>` : ""}`
    : `<div class="preco-linha">${seloDesconto(o) || `<span class="preco"><span class="int">Cupom</span></span>`}</div>`;
  const lojaTit = { confiavel: "Loja confiável", marketplace: "Marketplace: confira o vendedor", desconhecida: "Loja fora da lista: confira antes" }[o.loja_tipo] || "";
  const nota = Number.isFinite(o.avaliacao) && o.avaliacao > 0 && o.avaliacao <= 5 ? `<span>★ ${o.avaliacao.toFixed(1).replace(".", ",")}${o.n_avaliacoes ? ` (${fmtInt.format(Number(o.n_avaliacoes))})` : ""}</span>` : "";
  const fonteTxt = esc(nomeFonte(o.fonte));
  const quandoPost = COMUNIDADE.has(o.fonte) ? ` · ${idade(o.publicado_em || o.primeiro_visto)}` : "";
  const social = o.temperatura != null ? `<span>${fonteTxt} ${esc(Number(o.temperatura))}°${quandoPost}</span>` : o.curtidas > 0 ? `<span>${fonteTxt} · ${esc(Number(o.curtidas))} curtidas${quandoPost}</span>` : COMUNIDADE.has(o.fonte) ? `<span>${fonteTxt}${quandoPost}</span>` : "";
  const velho = o.horas_sem_conferir ? `<span class="pt medio" title="${esc(tempoTitulo(o))}. Pode ter mudado: confira na loja.">preço de ${horasTxt(o.horas_sem_conferir)} atrás</span>` : "";
  const fi = D.frete_info || {};
  const custo = o.preco_produto != null ? `<span class="custo" title="Estimativa: peso ${o.peso_g} g pelo tipo de peça, frete aéreo para o Brasil rateado num pacote de ${fi.pacote_kg || 3} kg e frete interno na China. Imposto não incluso. Fonte do frete: ${esc(fi.fonte || "")}">Produto ${brl.format(o.preco_produto)} + frete ≈ ${brl.format(o.extras)}</span>` : "";
  // pesquisa ampla: selo de confiança da loja (idade do domínio, CNPJ, preço fora da curva) + de onde veio o preço
  let conf = null;
  try { conf = o.confianca ? JSON.parse(o.confianca) : null; } catch (e) { /* selo ilegível: some */ }
  let selo = "";
  if (conf) {
    const trusted = o.loja_tipo === "confiavel";
    const cls = trusted || conf.nivel === "boa" ? "bom" : conf.nivel === "atencao" ? "alerta" : "cinza";
    const txt = trusted ? "Loja aprovada" : { boa: "Loja com bons sinais", media: "Sinais medianos", atencao: "Atenção: confira bem", desconhecida: "Loja não verificada" }[conf.nivel] || "Loja não verificada";
    const sinais = esc((conf.sinais || []).join(" · "));
    selo = `<div class="selo"><span class="tag ${cls}" title="${sinais}">${txt}</span><span class="sinais">${esc(conf.verificado ? "preço conferido na loja" : "preço do Google Shopping")}</span>`
      + (conf.ra ? `<a href="${esc(seguro(conf.ra))}" target="_blank" rel="noopener">Reclame Aqui</a>` : "")
      + (trusted ? "" : `<button type="button" class="link" data-confiar="${esc(o.loja)}" title="Passa a tratar ${esc(o.loja)} como loja confiável">Confiar nesta loja</button>`) + `</div>`;
    if (conf.nivel === "atencao" && conf.sinais && conf.sinais.length) etq.push(`<span class="tag alerta" title="${sinais}">Confira a loja</span>`);
  }
  const sec = [velho, custo, py ? "" : itemCupom(o), nota, social].filter(Boolean).join("");
  const nIg = o.iguais.length;
  let comparar = "";
  if (nIg) {
    const menor = Math.min(...o.iguais.filter((x) => x.preco && !suspeita(x)).map((x) => x.preco));   // "a partir de" ignora preço suspeito
    const k = o.chave || o.uid;
    comparar = `<details class="comparar" data-k="${esc(k)}"${abertos.has(k) ? " open" : ""}><summary>+${nIg} ${plural(nIg, "oferta igual", "ofertas iguais")}${Number.isFinite(menor) ? ` · ${menor < o.preco ? "a partir de" : "outras a partir de"} ${brl.format(menor)}` : ""}</summary><ul>${o.iguais.map(linhaIgual).join("")}</ul></details>`;
  }
  return `<article class="card ${o.status !== "active" ? "exp" : ""}">
    <div class="fotobox">${foto}
      ${etq.length ? `<div class="etq">${etq.join("")}</div>` : ""}
      <span class="nota ${nivel}" title="Nota de 0 a 100: comunidade, desconto confirmado, loja, histórico de preço e se o preço é recente"><span class="sr">Nota </span>${o.score}<span class="sr"> de 100</span></span>
    </div>
    <div class="corpo">
      <div class="origem" title="${esc(tempoTitulo(o))}"><span class="loja ${esc(o.loja_tipo)}" title="${lojaTit}">${esc(o.loja || "?")}<span class="sr"> (${lojaTit})</span></span>${o.marca && o.marca !== o.loja ? `<span class="marca-p">${esc(o.marca)}</span>` : ""}</div>
      <a class="titulo" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" tabindex="-1">${rotulo}</a>
      <div class="preco-bloco">${preco}</div>
      ${sec ? `<div class="sec">${sec}</div>` : ""}
      ${selo}
      ${comparar}
    </div>
    <div class="acoes">
      <a class="cta" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" ${aria}>Ver oferta</a>
      ${o.link_loja ? `<a class="cta sec-cta" href="${esc(seguro(o.link_loja))}" target="_blank" rel="noopener" aria-label="Ir à loja ${esc(o.loja || "")} (abre em nova aba)">Loja</a>` : ""}
      ${cn && !SOMENTE_LEITURA && String(o.uid).startsWith("kako:") ? `<button type="button" class="cta sec-cta" data-guardar-cn="${esc(o.uid)}" title="Guarda este produto na aba Link, com histórico de preço e reconferência">Guardar</button>` : ""}
    </div>
  </article>`;
}

// ---------- abertura: destaques e comparação por loja ----------
function mini(o, extra) {
  const img = o.imagem ? `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(seguro(o.imagem))}" alt="" onerror="this.remove()">` : "";
  return `<a class="mini" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" aria-label="${esc(o.titulo)}: ${o.preco ? brl.format(o.preco) : "cupom"} na ${esc(o.loja || "")} (abre em nova aba)">
    <span class="mini-foto">${img}</span>
    <span class="mini-preco">${o.preco ? brl.format(o.preco) : "Cupom"}</span>
    <span class="mini-tit">${esc(o.titulo)}</span>
    <span class="mini-info">${esc(o.loja || "")}${extra ? ` · ${extra}` : ""}</span></a>`;
}

const calor = (o) => (o.temperatura != null ? o.temperatura / 300 : (o.curtidas || 0) / 25);
// só no Brasil, sem filtro nem busca: o que está quente agora na comunidade e o que chegou das buscas salvas desde a última visita
function desenharDestaques(b) {
  const box = $("destaques");
  const mostrar = mercado === "br" && !acoesChips.length && !$("q").value.trim();
  if (!mostrar) { box.hidden = true; box.innerHTML = ""; return; }
  const seis = Date.now() - 6 * 3600e3;
  const quentes = b.filter((o) => COMUNIDADE.has(o.fonte) && o.tq >= seis && o.tipo !== "cupom" && !suspeita(o)).sort((x, y) => calor(y) - calor(x));
  const novas = b.filter((o) => o.wishlist && ehNova(o) && !suspeita(o)).sort((x, y) => y.score - x.score);
  let h = "";
  if (quentes.length) h += `<section class="faixa" aria-labelledby="fx-q"><div class="faixa-topo"><h2 id="fx-q">Quentes agora <small>Pelando e Promobit, últimas 6 h</small></h2><button type="button" class="link" data-acao="quentes">Ver ${quentes.length}</button></div>
    <div class="faixa-lista">${quentes.slice(0, 12).map((o) => mini(o, o.temperatura != null ? `${o.temperatura}°` : o.curtidas ? `${o.curtidas} curtidas` : "")).join("")}</div></section>`;
  if (novas.length) h += `<section class="faixa" aria-labelledby="fx-n"><div class="faixa-topo"><h2 id="fx-n">Novas nas suas buscas <small>desde ${fmtData.format(visita.anterior)}</small></h2><button type="button" class="link" data-acao="novas">Ver ${novas.length}</button></div>
    <div class="faixa-lista">${novas.slice(0, 12).map((o) => mini(o, esc(o.wishlist))).join("")}</div></section>`;
  box.hidden = !h;
  box.innerHTML = h;
}

// uma busca salva escolhida: menor preço em cada loja, lado a lado (na China mostra se o preço tem frete ou é o anunciado)
function desenharComparativo(lista) {
  const box = $("comparativo");
  if (F.wish.size !== 1) { box.hidden = true; box.innerHTML = ""; return; }
  let validos = lista.filter((o) => o.preco && o.status === "active" && !suspeita(o) && o.tipo !== "cupom");
  // "iphone 17" também traz capinha e película: compara só a categoria que domina a busca (se nenhuma foi escolhida)
  // e descarta preço abaixo de 35% da mediana (acessório que escapou da categoria, isca)
  let seg = "";
  if (!F.seg.size && validos.length) { seg = contar(validos, "segmento")[0][0]; validos = validos.filter((o) => o.segmento === seg); }
  const precos = validos.map((o) => o.preco).sort((a, b) => a - b);
  const med = precos.length ? precos[Math.floor(precos.length / 2)] : 0;
  const melhor = new Map();
  validos.forEach((o) => {
    if (o.preco < 0.35 * med) return;
    const k = semAcento(lojaChave(o.loja)).replace(/[^a-z0-9]/g, "");   // "KaBuM!" = "Kabum", "Aliexpress" = "AliExpress"
    if (!melhor.has(k) || o.preco < melhor.get(k).preco) melhor.set(k, o);
  });
  if (melhor.size < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const itens = [...melhor.values()].sort((a, b) => a.preco - b.preco).slice(0, 10);
  const cn = mercado === "cn", py = mercado === "py";
  box.hidden = false;
  box.innerHTML = `<h2>Menor preço por loja <small>${esc([...F.wish][0])}${seg ? ` · ${esc(seg)}` : ""}${cn ? " · 1688/Taobao com frete estimado, sem imposto" : py ? " · à vista, sem imposto" : ""}</small></h2><div class="cmp-lista">${itens.map((o, i) => {
    const obs = cn ? (o.preco_produto != null ? "com frete" : "anunciado") : py ? (o.cupom || "").replace(" à vista", "") : o.horas_sem_conferir ? `de ${horasTxt(o.horas_sem_conferir)} atrás` : "";
    return `<a class="cmp${i === 0 ? " melhor" : ""}" href="${esc(seguro(o.link))}" target="_blank" rel="noopener" title="${esc(o.titulo)}"><span class="cmp-loja">${esc(lojaChave(o.loja) === "Magazine Luiza" ? "Magalu" : o.loja)}</span><b>${brl.format(o.preco)}</b>${obs ? `<span class="cmp-obs">${obs}</span>` : ""}</a>`;
  }).join("")}</div>`;
}

function carregando() {
  $("grade").setAttribute("aria-busy", "true");
  $("grade").innerHTML = `<div class="vazio"><p>Carregando ofertas…</p></div>`;
}

function render() {
  if (!D) return;
  if (vistaCmp) { desenharComparar(); return; }
  if (!partes[mercado]) { carregando(); return; }
  const b = base();
  desenharFacetas(b);
  desenharAtivos();
  desenharDestaques(b);

  const filtrada = aplicar(b);
  desenharComparativo(filtrada);
  const lista = ordenar(agrupar(filtrada));
  ultimaLista = lista;
  const total = lista.length;
  const grade = $("grade");
  grade.classList.toggle("lista", vista === "lista");
  $("vista-grade").setAttribute("aria-pressed", String(vista === "grade"));
  $("vista-lista").setAttribute("aria-pressed", String(vista === "lista"));
  if (total) {
    grade.innerHTML = lista.slice(0, limite).map(cartao).join("");
  } else {
    const q = $("q").value.trim();
    const vazioCat = { cn: "Ainda não há produtos da China. Digite o que você quer (ex.: moletom, tênis) e clique em Buscar na China.",
      py: "Ainda não há produtos do Paraguai. Digite o que você quer (ex.: iphone 16, perfume, playstation 5) e clique em Buscar no Paraguai." }[mercado];
    grade.innerHTML = `<div class="vazio"><p>${acoesChips.length || q ? "Nenhum produto com esses filtros." : vazioCat || "Ainda não há ofertas por aqui."}</p><div class="botoes">${
      acoesChips.length || q ? `<button type="button" class="botao" id="vazio-limpar">Limpar filtros</button>` : ""}${
      q ? `<button type="button" class="botao primario" id="vazio-buscar">Buscar “${esc(q)}” ${NOME_MERCADO[mercado] || "nas lojas"}</button>` : ""}</div></div>`;
  }
  grade.removeAttribute("aria-busy");
  atualizarMais();
  $("ver-resultados").textContent = total ? `Ver ${fmtInt.format(total)} ${plural(total, "produto", "produtos")}` : "Nenhum produto";
  atualizarStatus();
  atualizarCnInfo();
}

function atualizarMais() {
  const total = ultimaLista.length;
  const mais = $("mais-itens");
  mais.hidden = total <= limite;
  if (total > limite) mais.textContent = `Mostrar mais ${Math.min(PASSO, total - limite)} (faltam ${fmtInt.format(total - limite)})`;
  $("contagem").innerHTML = `${fmtInt.format(total)} ${plural(total, "produto", "produtos")}${total > limite ? `<small> · mostrando ${limite}</small>` : ""}`;
}
// "carregar mais": acrescenta só os cartões novos (não refaz filtros nem a grade)
function maisItens() {
  if (limite >= ultimaLista.length) return;
  const de = limite;
  limite += PASSO;
  $("grade").insertAdjacentHTML("beforeend", ultimaLista.slice(de, limite).map(cartao).join(""));
  atualizarMais();
}
const sentinela = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) maisItens(); }, { rootMargin: "900px 0px" });
sentinela.observe($("mais-itens"));

// faixa da aba China: estado do agente, do frete e das réplicas em chips; a explicação fica em "Como o preço é feito"
function atualizarCnInfo() {
  atualizarPyInfo();
  const box = $("cn-info");
  box.hidden = mercado !== "cn";
  if (mercado !== "cn") return;
  const ocultas = (partes.cn || []).filter((o) => o.replica).length;
  const ponto = (ok) => `<i class="pto ${ok ? "ok" : "av"}" aria-hidden="true"></i>`;
  const chips = [];
  const k = D.kakobuy_status, h = D.hoobuy_status, f = D.frete_check;
  if (k) chips.push(`<span class="chip" title="${esc(k.ok ? `Última busca: ${k.termo} (${k.n} itens) ${idade(k.em)}` : k.msg)}">${ponto(k.ok)}KakoBuy ${k.ok ? "respondendo" : "falhou na última busca"}</span>`);
  if ((D.fontes_cn || []).includes("hoobuy") && h) chips.push(`<span class="chip" title="${esc(h.ok ? `Última busca: ${h.termo}` : h.msg)}">${ponto(h.ok)}Hoobuy ${h.ok ? "respondendo" : "falhou"}</span>`);
  if (!f) chips.push(`<span class="chip">${ponto(false)}Frete ainda não conferido</span>`);
  else if (!f.ok) chips.push(`<span class="chip" title="${esc(f.msg)}">${ponto(false)}Frete: leitura falhou, usando a última tabela</span>`);
  else if (f.alerta) chips.push(`<span class="chip">${ponto(false)}Frete do ${esc(f.agente)} mudou até ${f.desvio_max_pct}% ${idade(f.em)} (já aplicado)</span>`);
  else chips.push(`<span class="chip">${ponto(true)}Frete do ${esc(f.agente)} conferido ${idade(f.em)}</span>`);
  const fora = (D.agentes || []).filter((a) => !a.ok).map((a) => a.nome);
  if (fora.length) chips.push(`<span class="chip">${ponto(false)}Fora do ar: ${esc(fora.join(", "))}</span>`);
  if (ocultas) chips.push(`<span class="chip" title="Termos de réplica ou marca famosa no título. Aparecem na lista, marcados e mais abaixo.">${ocultas} ${plural(ocultas, "item marcado", "itens marcados")} como possível réplica</span>`);
  $("cn-chips").innerHTML = chips.join("");
}

// faixa da aba Paraguai: estado da última busca no Compras Paraguai e a cota de isenção
function atualizarPyInfo() {
  const box = $("py-info");
  box.hidden = mercado !== "py";
  if (mercado !== "py") return;
  const s = D.py_status, i = D.py_info || {};
  const ponto = (ok) => `<i class="pto ${ok ? "ok" : "av"}" aria-hidden="true"></i>`;
  const chips = [];
  if (s) chips.push(`<span class="chip" title="${esc(s.ok ? `Última busca: ${s.termo} (${s.n} ofertas) ${idade(s.em)}` : s.msg)}">${ponto(s.ok)}Compras Paraguai ${s.ok ? `lido ${idade(s.em)}` : "falhou na última busca"}</span>`);
  if (i.cota_usd) chips.push(`<span class="chip" title="Entrando por terra, por pessoa e por mês. Acima da cota paga ${i.imposto_excedente_pct || 50}% sobre o excedente. Não entra na conta do preço.">Cota sem imposto: US$ ${fmtInt.format(i.cota_usd)} por pessoa</span>`);
  $("py-chips").innerHTML = chips.join("");
}

// status do topo: quando o coletor rodou + o que está desligado (receptor, extensão) + canário de preços
function atualizarStatus() {
  if (!D) return;
  const p = [`Atualizado ${idade(D.gerado_em)}`];
  if (estadoReceptor && !estadoReceptor.ok) p.push(`<span class="pt ruim" title="Sem ele, Buscar nas lojas, Pesquisa ampla e Confiar não funcionam. Para ligar: dois cliques em ligar-buscador.cmd na pasta ofertas-agent.">Buscador local desligado</span>`);
  else if (mercado === "br" && estadoReceptor && !extensaoViva()) p.push(`<span class="pt medio" title="Amazon, Magalu, Mercado Livre, Shopee e Shein só são buscadas com a extensão ligada no Chrome. Os preços delas no painel são da última busca.">Extensão do Chrome desligada</span>`);
  const sd = (D.saude || []).map((x) => x.fonte.split(" / ").pop()).join(", ");
  if (sd) p.push(`<span class="pt ruim" title="Muitos preços suspeitos: o leitor dessa loja pode ter quebrado">⚠ preços suspeitos em: ${esc(sd)}</span>`);
  const t = p.join(" ");
  $("status").innerHTML = t;
  $("status2").innerHTML = t;
}

// ---------- dados ----------
const precisa = () => [...new Set([mercado, ...(mercado === "br" && val("v-exp") ? ["exp"] : []), ...Object.values(buscas).filter((b) => !b.fim).map((b) => b.mercado)])];

function script(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = `${src}?t=${Date.now()}`;
    s.onload = () => { s.remove(); ok(); };
    s.onerror = () => { s.remove(); erro(new Error(src)); };
    document.body.appendChild(s);
  });
}

function falhaDados() {
  if (!D) {
    $("grade").removeAttribute("aria-busy");
    $("grade").innerHTML = `<div class="vazio"><p>Não consegui carregar as ofertas.</p><p>O coletor pode estar parado. Tente recarregar.</p><div class="botoes"><button type="button" class="botao primario" id="recarregar">Tentar recarregar</button></div></div>`;
  } else {
    $("status").textContent = "Sem atualização agora";
    $("status2").textContent = "Sem atualização agora";
  }
}

let emCurso = null;
// lê o meta.js e baixa só as partes que faltam ou mudaram; redesenha só se algo mudou
function atualizar(primeira) {
  if (emCurso) return emCurso.then(() => (primeira ? undefined : atualizar(false)));
  emCurso = (async () => {
    try { await script("meta.js"); } catch (_) { falhaDados(); return; }
    const novo = window.META;
    if (!novo) { falhaDados(); return; }
    META = novo;
    if (nuvem()) { document.body.classList.add("nuvem"); await lerOcultas(); }   // o que o site apagou antes de desenhar
    let mudouParte = false;
    for (const k of precisa()) {
      const v = (META.versoes || {})[k];
      if (partes[k] && versaoParte[k] === v) continue;
      const nome = "OFERTAS_" + k.toUpperCase();
      try { await script(`ofertas-${k}.js`); } catch (_) { if (k === mercado && !partes[k]) { falhaDados(); return; } continue; }
      partes[k] = preparar(window[nome] || []);
      window[nome] = undefined;
      versaoParte[k] = v;
      mudouParte = true;
    }
    const primeiraVez = !D;
    D = montarD();
    if (primeiraVez) { restaurar(); $("v-nota-v").value = val("v-nota"); }
    const trocouBusca = verificarBusca();
    if (primeiraVez || mudouParte || trocouBusca) render(); else { atualizarStatus(); atualizarCnInfo(); if (vistaCmp) desenharComparar(); }  // dados iguais: preserva rolagem e "iguais" abertos
  })();
  return emCurso.finally(() => { emCurso = null; });
}

// receptor local: está no ar? a extensão do Chrome pediu trabalho há pouco (ela consulta a fila a cada minuto)?
async function lerEstado() {
  if (SOMENTE_LEITURA) return;   // sem receptor aqui: nada de pedir ao 127.0.0.1 de quem está vendo (o Chrome até pergunta por permissão)
  try {
    const r = await fetch(RECEPTOR + "/estado", { cache: "no-store" });
    estadoReceptor = { ok: r.ok, ...(r.ok ? await r.json() : {}) };
  } catch (_) { estadoReceptor = { ok: false }; }
  atualizarStatus();
}
const extensaoViva = () => !!(estadoReceptor && estadoReceptor.ok && estadoReceptor.extensao_em && Date.now() - new Date(estadoReceptor.extensao_em).getTime() < 3 * 60e3);

// ---------- site online: apagar buscas e fazer pedidos pela nuvem (Firestore) ----------
// O site não fala com o computador do agente: grava no Firestore (REST + chave web, pública por desenho; as regras do banco limitam o que
// cabe lá) e o computador lê, executa e republica o site. Sem PIN por enquanto (decisão do João, pendente). Apagar é imediato: a busca some
// da tela na hora, com o computador ligado ou não; o computador apaga de verdade depois. Pesquisa ampla, buscar e comparar precisam do
// computador ligado (Chrome logado, chave do Serper e banco ficam lá): o pedido fica guardado e roda quando ele estiver no ar.
const nuvem = () => (SOMENTE_LEITURA && META && META.nuvem) || null;
async function fs(metodo, caminho, corpo, extra = "") {
  const n = nuvem();
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${n.projeto}/databases/(default)/documents/${caminho}?key=${n.chave}${extra}`,
    { method: metodo, cache: "no-store", ...(corpo ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) } : {}) });
  if (r.status === 409 || r.status === 404) return { status: r.status, json: {} };   // já existe / já não existe: serve do mesmo jeito
  if (!r.ok) throw new Error(r.status);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const fsTxt = (s) => ({ stringValue: String(s) });
const fsId = (k) => btoa(unescape(encodeURIComponent(k))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]));   // id do documento a partir da chave da busca
const chaveDe = (t) => semAcento(t).trim();

let ocultas = new Set();   // buscas que o site já escondeu (chave = termo sem acento)
function montarD() {       // META + ofertas das partes, sem o que foi apagado pelo site
  const base = { ...META, ofertas: [].concat(...Object.values(partes)) };
  if (!ocultas.size) return base;
  return { ...base, ofertas: base.ofertas.filter((o) => !(o.wishlist && ocultas.has(chaveDe(o.wishlist)))) };
}
function refiltrar() {
  if (!META) return;
  F.wish = new Set([...F.wish].filter((t) => !ocultas.has(chaveDe(t))));
  if (D) { D = montarD(); if (partes[mercado]) render(); if (vistaCmp) desenharComparar(); }
  if (dlg.open) desenharBuscas();
}
async function lerOcultas() {
  if (!nuvem()) return;
  try {
    const { json } = await fs("GET", "ocultas", null, "&pageSize=300");
    const novas = new Set(((json && json.documents) || []).map((d) => chaveDe(((d.fields || {}).termo || {}).stringValue || "")).filter(Boolean));
    if (novas.size === ocultas.size && [...novas].every((k) => ocultas.has(k))) return;
    ocultas = novas;
    refiltrar();
  } catch (_) { /* sem rede: continua escondendo o que já escondia */ }
}
setInterval(lerOcultas, 30e3);

const pedidosAtivos = new Map();   // tipo -> {id, termo}: pedidos de tipos diferentes (China e Paraguai, por exemplo) andam juntos; o mesmo tipo espera o anterior
async function pedirNuvem(tipo, termo, rotulo) {
  const av = (texto, o = {}) => aviso(texto, { ...o, chave: tipo });   // uma linha de aviso por tipo de pedido
  if (pedidosAtivos.has(tipo)) { av(`Já tem um pedido igual em andamento (${pedidosAtivos.get(tipo).termo}). Espere ele terminar ou faça outro tipo de busca.`, { erro: true, fechar: true }); return; }
  av(`${rotulo} "${termo}": enviando o pedido…`);
  let id;
  try {
    const k = chaveDe(termo);
    if (ocultas.has(k)) { await fs("DELETE", `ocultas/${fsId(k)}`); ocultas.delete(k); refiltrar(); }   // pedir de novo traz a busca de volta
    const r = await fs("POST", "pedidos", { fields: { tipo: fsTxt(tipo), termo: fsTxt(termo), em: fsTxt(new Date().toISOString()), estado: fsTxt("novo") } });
    id = r.json.name.split("/").pop();
  } catch (_) { av("Não consegui enviar o pedido. Confira a internet e tente de novo.", { erro: true, retry: true, fechar: true }); return; }
  $("q").value = "";
  pedidosAtivos.set(tipo, { id, termo });
  const ini = Date.now();
  const fim = () => { clearInterval(t); pedidosAtivos.delete(tipo); };
  const t = setInterval(async () => {
    try {
      if (Date.now() - ini > 30 * 60e3) { fim(); av(`${rotulo} "${termo}": ainda sem resposta. O pedido continua guardado e roda quando o computador do agente estiver ligado.`, { fechar: true }); return; }
      const { status, json } = await fs("GET", `pedidos/${id}`);
      if (status === 404) { fim(); av(`${rotulo} "${termo}": o pedido saiu da fila.`, { fechar: true }); return; }
      const f = json.fields || {}, est = (f.estado || {}).stringValue, msg = (f.msg || {}).stringValue || "";
      if (est === "novo") { av(`${rotulo} "${termo}": pedido enviado.${Date.now() - ini > 2 * 60e3 ? " O computador do agente parece desligado: o pedido fica guardado e roda quando ele ligar." : " Esperando o computador do agente pegar…"}`); return; }
      if (est === "rodando") { av(`${rotulo} "${termo}": ${msg || "rodando…"}`); return; }
      fim();
      if (est === "erro") { av(`${rotulo} "${termo}" não deu certo: ${msg}`, { erro: true, fechar: true }); return; }
      av(`${rotulo} "${termo}" concluída${msg ? ` (${msg})` : ""}. Os resultados aparecem aqui em 1 a 2 minutos.`, { fechar: true });
      $("q").value = termo; mudou();
      await atualizar(false);
    } catch (_) { /* a rede oscilou: tenta de novo na próxima volta */ }
  }, 5e3);
}

// ---------- eventos ----------
$("q").addEventListener("input", () => mudouAtrasado());
["v-pmin", "v-pmax", "v-nota"].forEach((id) => $(id).addEventListener("input", () => {
  if (id === "v-nota") $("v-nota-v").value = val("v-nota");
  mudouAtrasado();
}));
["v-periodo", "v-ordem", "v-agrupar", "v-promo", "v-menor", "v-conf", "v-cupons"].forEach((id) => $(id).addEventListener("change", mudou));
$("v-exp").addEventListener("change", () => { mudou(); if (val("v-exp") && !partes.exp) atualizar(false); });   // expiradas só baixam quando pedidas
document.querySelectorAll('input[name="desc"]').forEach((r) => r.addEventListener("change", mudou));

const filtros = $("filtros");
filtros.addEventListener("change", (e) => {  // marcar/desmarcar uma opção de grupo (várias podem ficar marcadas)
  const c = e.target;
  if (!c.dataset || !c.dataset.g) return;
  const conj = F[c.dataset.g];
  if (c.checked) conj.add(c.dataset.v); else conj.delete(c.dataset.v);
  mudou();
});
filtros.addEventListener("click", (e) => {
  const vt = e.target.closest("[data-vt]");
  if (!vt) return;
  const k = vt.dataset.vt;
  if (verTodos.has(k)) verTodos.delete(k); else verTodos.add(k);
  desenharFacetas(base());
});
filtros.addEventListener("input", (e) => {
  if (!e.target.dataset || !e.target.dataset.fb) return;
  buscaFacet[e.target.dataset.fb] = e.target.value;
  aplicarBuscaFacet();
});
filtros.addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.matches && d.matches("details.grupo")) estadoGrupo.set(d.dataset.g, d.open);
}, true);
$("limpar").onclick = limpar;

$("ativos").addEventListener("click", (e) => {
  const b = e.target.closest("[data-i]");
  if (!b) return;
  if (b.dataset.i === "todos") { limpar(); return; }
  acoesChips[Number(b.dataset.i)].rm();
  mudou();
});
$("destaques").addEventListener("click", (e) => {
  const b = e.target.closest("[data-acao]");
  if (!b) return;
  if (b.dataset.acao === "novas") { soNovas = true; $("v-ordem").value = "score"; }
  else { F.fonte = new Set(["Pelando", "Promobit"]); $("v-periodo").value = "6"; $("v-ordem").value = "recente"; }
  mudou();
  $("contagem-p").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
$("vista-grade").onclick = () => { vista = "grade"; salvar(); render(); };
$("vista-lista").onclick = () => { vista = "lista"; salvar(); render(); };
$("mais-itens").onclick = maisItens;
$("grade").addEventListener("click", (e) => {
  if (e.target.id === "vazio-limpar") limpar();
  if (e.target.id === "vazio-buscar") enviarBusca($("q").value.trim().toLowerCase());
  if (e.target.id === "recarregar") { carregando(); atualizar(true); }
});
$("grade").addEventListener("toggle", (e) => {  // lembra quais grupos de "iguais" estão abertos
  const d = e.target;
  if (!d.matches || !d.matches("details[data-k]")) return;
  if (d.open) abertos.add(d.dataset.k); else abertos.delete(d.dataset.k);
}, true);

// filtros no celular: folha por cima da lista (o resto fica inerte enquanto estiver aberta)
const celular = matchMedia("(max-width: 900px)");
const fundoInerte = () => [$("topo"), document.querySelector(".conteudo"), $("b-msg"), $("cn-info"), $("py-info")];   // tudo que não é a folha
filtros.addEventListener("keydown", (e) => {  // Tab fica preso dentro da folha enquanto ela está aberta
  if (e.key !== "Tab" || !document.body.classList.contains("filtros-abertos")) return;
  const alvos = [...filtros.querySelectorAll("button, input, select, summary")].filter((x) => !x.disabled && x.offsetParent !== null);
  if (!alvos.length) return;
  const primeiro = alvos[0], ultimo = alvos[alvos.length - 1];
  if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
});
function abrirFiltros() {
  document.body.classList.add("filtros-abertos");
  $("fundo-filtros").hidden = false;
  $("abrir-filtros").setAttribute("aria-expanded", "true");
  filtros.setAttribute("role", "dialog");
  filtros.setAttribute("aria-modal", "true");
  fundoInerte().forEach((e) => (e.inert = true));
  $("fechar-filtros").focus();
}
function fecharFiltros() {
  if (!document.body.classList.contains("filtros-abertos")) return;
  document.body.classList.remove("filtros-abertos");
  $("fundo-filtros").hidden = true;
  $("abrir-filtros").setAttribute("aria-expanded", "false");
  filtros.removeAttribute("role"); filtros.removeAttribute("aria-modal");
  fundoInerte().forEach((e) => (e.inert = false));
  if (celular.matches) $("abrir-filtros").focus();
}
$("abrir-filtros").onclick = abrirFiltros;
$("fechar-filtros").onclick = fecharFiltros;
$("ver-resultados").onclick = fecharFiltros;
$("fundo-filtros").onclick = fecharFiltros;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharFiltros(); });
celular.addEventListener("change", () => { if (!celular.matches) fecharFiltros(); });

// abas: padrão completo (setas, Home/End, tabindex rotativo, painel associado)
const abas = [...document.querySelectorAll(".aba")];
// as duas abas controlam o MESMO painel (#mercado): trocar de aba troca o mercado filtrado, não a tela
function marcarAba(b) {
  abas.forEach((x) => {
    const on = x === b;
    x.setAttribute("aria-selected", String(on));
    x.tabIndex = on ? 0 : -1;
  });
  $({ cmp: "comparar", lnk: "links" }[b.dataset.aba] || "mercado").setAttribute("aria-labelledby", b.id);
}
function ativarAba(b, foco) {
  marcarAba(b);
  const a = b.dataset.aba;
  if (a === "lnk") { sairComparar(); abrirLinks(); }   // abrirLinks/sairLinks ficam em links.js
  else { sairLinks(); if (a === "cmp") abrirComparar(); else { sairComparar(); trocarMercado(a); } }
  if (foco) b.focus();
}
abas.forEach((b, i) => {
  b.addEventListener("click", () => ativarAba(b));
  b.addEventListener("keydown", (e) => {
    const passo = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (passo) { e.preventDefault(); ativarAba(abas[(i + passo + abas.length) % abas.length], true); }
    else if (e.key === "Home") { e.preventDefault(); ativarAba(abas[0], true); }
    else if (e.key === "End") { e.preventDefault(); ativarAba(abas[abas.length - 1], true); }
  });
});

marcarAba(abas.find((x) => x.dataset.aba === mercado) || abas[0]);
aplicarMercadoUI();
atualizar(true);
lerEstado();
setInterval(() => atualizar(false), 60e3);          // meta.js é pequeno: conferir a cada minuto custa quase nada
setInterval(lerEstado, 60e3);

// ---------- busca nas lojas ----------
// O receptor local põe o termo na fila da extensão do Chrome (que abre as lojas logadas) e já roda Pelando/Promobit/Kabum.
// Com a extensão desligada, o painel avisa na hora e acompanha só o que o receptor busca sozinho.
// O resultado entra como "Minha busca". O painel deixa um resumo final com o que chegou, por loja.
const buscas = {};      // mercado -> { termo, inicio, selecionado, fim, mercado, soPython, timer }: uma busca por mercado, China e Paraguai podem rodar juntas
let ultimoTermo = "";

// Uma linha de aviso por tarefa (chave): buscas em paralelo, pesquisa ampla e comparação não apagam o andamento umas das outras.
// Sem chave vai para "geral". O ✕ fecha as linhas já concluídas (com ✕) e deixa as que ainda estão rodando.
const msgs = new Map();
function desenharAviso() {
  const l = [...msgs.values()], m = $("b-msg");
  m.hidden = !l.length;
  m.classList.toggle("erro", l.some((x) => x.erro));
  $("b-txt").textContent = l.map((x) => x.texto).join("\n");
  $("b-retry").hidden = !l.some((x) => x.retry);
  $("b-fechar").hidden = !l.some((x) => x.fechar);
}
function aviso(texto, { erro = false, retry = false, fechar = false, chave = "geral" } = {}) {
  msgs.set(chave, { texto, erro, retry, fechar });
  desenharAviso();
}
const MSG_RECEPTOR = "O buscador local está desligado. Para ligar, dê dois cliques em “ligar-buscador.cmd” na pasta ofertas-agent e tente de novo.";
const SEM_EXTENSAO = "Amazon, Magalu, Mercado Livre, Shopee e Shein ficaram de fora porque a extensão do Chrome está desligada.";

function verificarBusca() {  // devolve true quando alguma busca passou a mostrar resultados (pede redesenho)
  let redesenha = false;
  for (const b of Object.values(buscas)) if (verificarUma(b)) redesenha = true;
  return redesenha;
}

function verificarUma(busca) {   // uma busca por mercado: cada uma tem o seu timer e a sua linha de aviso
  const av = (texto, o = {}) => aviso(texto, { ...o, chave: busca.mercado });
  if (!busca || busca.fim) return false;
  const jaSel = busca.selecionado;
  const t = busca.termo;
  const cn = busca.mercado === "cn", py = busca.mercado === "py";
  // só conta o que foi visto depois do início desta busca (senão resultado de rodada antiga passa por novo)
  const desde = busca.inicio - 60e3;
  const itens = D.ofertas.filter((o) => o.mercado === busca.mercado && o.wishlist === t && o.status === "active" && new Date(o.ultimo_visto || o.primeiro_visto).getTime() >= desde);
  // resumo por loja (extensão/China) ou por fonte (só o que o receptor busca sozinho; Paraguai = uma fonte só)
  const grupos = cn ? LOJAS_CN : py ? [["Compras Paraguai", "Compras Paraguai"]] : busca.soPython ? FONTES_PYTHON.map((f) => [f, f]) : LOJAS_BUSCA;
  const chaveItem = busca.soPython || py ? (o) => o.fonte : (o) => lojaChave(o.loja);
  const por = new Map(grupos.map(([k]) => [k, 0]));
  itens.forEach((o) => { const l = chaveItem(o); if (por.has(l)) por.set(l, por.get(l) + 1); });
  const nomes = new Map(grupos);
  const chegaram = [...por].filter(([, n]) => n > 0).map(([k, n]) => `${nomes.get(k)} ${n}`);
  const faltam = [...por].filter(([, n]) => n === 0).map(([k]) => nomes.get(k));
  // só mostra a busca quando já há algo dela, e só se o João ainda estiver na aba (mercado) em que buscou
  if (itens.length && !busca.selecionado && mercado === busca.mercado) { busca.selecionado = true; F.wish = new Set([t]); salvar(); }
  // fim da parte do receptor (Python): ele registra no /estado quando terminou cada termo
  const fimPy = estadoReceptor && estadoReceptor.buscas && estadoReceptor.buscas[`${busca.mercado}:${t}`];
  const pyAcabou = fimPy && new Date(fimPy).getTime() >= busca.inicio - 5e3 && new Date(D.gerado_em).getTime() >= new Date(fimPy).getTime() - 1e3;
  // China: o servidor grava o estado do KakoBuy (ok ou motivo do erro) ao terminar; é o sinal de que a busca acabou
  const hs = D.hoobuy_status, ks = D.kakobuy_status;
  const fresco = (s) => cn && s && s.termo === t && new Date(s.em).getTime() >= busca.inicio - 60e3;
  const usaHoobuy = (D.fontes_cn || []).includes("hoobuy");
  const agenteFresco = fresco(ks) && (!usaHoobuy || fresco(hs));
  const limite_ = cn ? DURACAO_CN : busca.soPython || py ? 90e3 : DURACAO_BUSCA;
  const acabou = Date.now() - busca.inicio >= limite_ || (cn ? !!agenteFresco : busca.soPython || py ? !!pyAcabou : !faltam.length);
  if (!acabou) {
    const espera = cn || py ? "Leva alguns segundos." : busca.soPython ? `Buscando em Pelando, Promobit e Kabum. ${SEM_EXTENSAO}` : "Leva de 1 a 3 minutos e o Chrome precisa estar aberto.";
    av(`Buscando "${t}"… ${itens.length ? `${itens.length} ofertas até agora (${chegaram.join(" · ")}).` : "ainda sem resultados."} ${espera}`);
    return busca.selecionado && !jaSel;
  }
  busca.fim = true; clearInterval(busca.timer);
  const falhas = [];
  if (cn) {
    if (usaHoobuy) { if (!fresco(hs)) falhas.push("O Hoobuy (1688) não respondeu a tempo."); else if (!hs.ok) falhas.push(`O Hoobuy (1688) não respondeu: ${hs.msg}.`); }
    if (!fresco(ks)) falhas.push("O KakoBuy (Taobao e 1688) não respondeu a tempo."); else if (!ks.ok) falhas.push(`O KakoBuy (Taobao e 1688) não respondeu: ${ks.msg}.`);
  }
  const falhaCn = falhas.length ? " " + falhas.join(" ") : "";
  if (py) {
    const ps = D.py_status;
    const falhou = ps && ps.termo === t && !ps.ok && new Date(ps.em).getTime() >= busca.inicio - 60e3;
    const nProd = new Set(itens.map((o) => o.chave || o.uid)).size;
    if (falhou) av(`O Compras Paraguai não respondeu para "${t}": ${ps.msg}`, { erro: true, retry: true, fechar: true });
    else if (!itens.length) av(`Nada encontrado no Paraguai para "${t}". Tente o nome do produto como a loja escreve (ex.: "iphone 16 128gb", "ps5").`, { erro: true, retry: true, fechar: true });
    else av(`Busca "${t}" concluída: ${itens.length} ofertas de ${nProd} ${plural(nProd, "produto", "produtos")}, em ${new Set(itens.map((o) => o.loja)).size} lojas.`, { fechar: true });
  } else if (cn && !itens.length) av(`Nada chegou para "${t}". Tente outra palavra ou tente de novo.${falhaCn}`, { erro: true, retry: true, fechar: true });
  else if (cn) av(`Busca "${t}" concluída: ${itens.length} produtos (${chegaram.join(" · ")}).${falhaCn}`, { erro: !!falhaCn, retry: !!falhaCn, fechar: true });
  else if (busca.soPython) av(`Busca "${t}" concluída: ${itens.length ? `${itens.length} ofertas (${chegaram.join(" · ")})` : "nenhuma oferta em Pelando, Promobit e Kabum"}. ${SEM_EXTENSAO}`, { erro: !itens.length, fechar: true });
  else if (!itens.length) av(`Nenhuma oferta chegou para "${t}". Confira se o Chrome está aberto com a extensão e tente de novo.`, { erro: true, retry: true, fechar: true });
  else {
    const faltaExt = faltam.filter((n) => n !== "Kabum");  // Kabum é direto e só vende eletrônicos: sem resultado é normal, não é login/captcha
    av(`Busca "${t}" concluída: ${itens.length} ofertas (${chegaram.join(" · ")}).${faltam.length ? ` Sem resultado de: ${faltam.join(", ")}.` : ""}${faltaExt.length ? " Loja sem retorno no Chrome costuma pedir login ou captcha." : ""}`, { retry: !!faltaExt.length, fechar: true });
  }
  return busca.selecionado && !jaSel;
}

async function enviarBusca(termo) {
  if (!termo) { aviso("Digite o que você quer buscar nas lojas.", { erro: true, fechar: true }); $("q").focus(); return; }
  ultimoTermo = termo;
  const mBusca = mercado;                    // a aba pode mudar enquanto a busca roda
  if (nuvem()) { await pedirNuvem(["cn", "py"].includes(mBusca) ? `buscar-${mBusca}` : "buscar", termo, "Busca"); return; }   // site online: o pedido vai pela nuvem
  aviso(`Enviando a busca "${termo}"…`, { chave: mBusca });
  let j = {};
  try {
    const r = await fetch(`${RECEPTOR}/buscar?termo=${encodeURIComponent(termo)}${mBusca !== "br" ? `&mercado=${mBusca}` : ""}${token()}`, { method: "POST" });
    if (r.status === 403) { aviso("O buscador local recusou o pedido (chave do painel desatualizada). Recarregue a página e tente de novo.", { erro: true, fechar: true, chave: mBusca }); return; }
    if (!r.ok) throw new Error(r.status);
    j = await r.json().catch(() => ({}));
  } catch (err) {
    estadoReceptor = { ok: false }; atualizarStatus();
    aviso(MSG_RECEPTOR, { erro: true, retry: true, fechar: true, chave: mBusca });
    return;
  }
  $("q").value = "";
  soNovas = false;
  mudou();
  clearInterval((buscas[mBusca] || {}).timer);   // buscar de novo no mesmo mercado troca a anterior; outro mercado segue rodando junto
  const busca = buscas[mBusca] = { termo, inicio: Date.now(), selecionado: false, fim: false, mercado: mBusca, soPython: mBusca === "br" && j.extensao === false };
  aviso(`Buscando "${termo}"… ${mBusca !== "br" ? "Leva alguns segundos." : busca.soPython ? `Buscando em Pelando, Promobit e Kabum. ${SEM_EXTENSAO}` : "Leva de 1 a 3 minutos e o Chrome precisa estar aberto."}`, { chave: mBusca });
  busca.timer = setInterval(async () => { await lerEstado(); atualizar(false); }, mBusca !== "br" || busca.soPython ? 3e3 : 15e3);
}

$("busca").addEventListener("submit", (e) => {  // Enter ou "Buscar nas lojas": o filtro ao digitar já age sozinho
  e.preventDefault();
  if (SOMENTE_LEITURA && !nuvem()) return;   // site sem nuvem configurada: a caixa só filtra (o filtro age ao digitar)
  if (vistaCmp) enviarComparacao($("q").value.trim().toLowerCase()); else enviarBusca($("q").value.trim().toLowerCase());
});
// Pesquisa ampla: Google Shopping + páginas de lojas pequenas + selo de confiança (pesquisa.py, ~1 min)
let ampla = null;
async function pesquisaAmpla() {
  const av = (texto, o = {}) => aviso(texto, { ...o, chave: "ampla" });
  const termo = $("q").value.trim().toLowerCase();
  if (!termo) { av("Digite o produto (ex.: tênis mizuno wave rider 27) e clique em Pesquisa ampla.", { erro: true, fechar: true }); $("q").focus(); return; }
  if (nuvem()) { await pedirNuvem("pesquisar", termo, "Pesquisa ampla"); return; }
  if (ampla) return;
  av(`Pesquisa ampla "${termo}": enviando…`);
  try {
    const r = await fetch(`${RECEPTOR}/pesquisar?termo=${encodeURIComponent(termo)}${token()}`, { method: "POST" });
    if (r.status === 409) { av("Já tem uma pesquisa ampla rodando. Espere ela terminar.", { erro: true, fechar: true }); return; }
    if (r.status === 403) { av("O buscador local recusou o pedido (chave do painel desatualizada). Recarregue a página e tente de novo.", { erro: true, fechar: true }); return; }
    if (!r.ok) throw new Error(r.status);
  } catch (err) {
    av(MSG_RECEPTOR, { erro: true, fechar: true });
    return;
  }
  $("b-ampla").disabled = true;
  ampla = setInterval(async () => {
    try {
      const s = await (await fetch(RECEPTOR + "/pesquisa-status")).json();
      if (s.estado === "rodando") { av(`Pesquisa ampla "${s.termo}": ${s.msg}`); return; }
      clearInterval(ampla); ampla = null; $("b-ampla").disabled = false;
      if (s.estado === "erro") { av(`A pesquisa ampla falhou: ${s.msg}`, { erro: true, fechar: true }); return; }
      const m = s.resumo || {};
      av(`Pesquisa ampla "${s.termo}" concluída: ${m.gravados || 0} ofertas em ${m.lojas || 0} lojas (${m.paginas_lidas || 0} com preço conferido na loja)`
        + (m.bloqueadas && m.bloqueadas.length ? `. Lojas que bloquearam a leitura, só com preço do Google: ${m.bloqueadas.join(", ")}` : "") + ".", { fechar: true });
      $("q").value = s.termo; mudou();
      await atualizar(false);
    } catch (err) { clearInterval(ampla); ampla = null; $("b-ampla").disabled = false; av("Perdi o contato com o buscador local.", { erro: true, fechar: true }); }
  }, 2000);
}
$("b-ampla").onclick = pesquisaAmpla;
document.addEventListener("click", async (e) => {   // "Confiar nesta loja": passa a valer como confiável nas próximas buscas
  const b = e.target.closest("button[data-confiar]");
  if (!b) return;
  b.disabled = true;
  try {
    const r = await fetch(`${RECEPTOR}/confiar?loja=${encodeURIComponent(b.dataset.confiar)}${token()}`, { method: "POST" });
    if (!r.ok) throw new Error(r.status);
    aviso(`${b.dataset.confiar} agora é uma loja confiável.`, { fechar: true });
    await atualizar(false);
  } catch (err) { b.disabled = false; aviso("Não consegui salvar. " + MSG_RECEPTOR, { erro: true, fechar: true }); }
});
$("b-retry").onclick = () => { if (ultimoTermo) enviarBusca(ultimoTermo); };
$("b-fechar").onclick = () => { for (const [k, v] of [...msgs]) if (v.fechar) msgs.delete(k); desenharAviso(); };

// ---------- aba Comparar: Brasil × Paraguai × China ----------
function abrirComparar() {
  if (vistaCmp) return;
  document.body.classList.add("cmp-aberta");
  fecharFiltros();
  if (D) salvar();                                   // guarda os filtros do mercado de onde saiu
  vistaCmp = true;
  $("mercado").hidden = true;
  $("comparar").hidden = false;
  $("q").value = "";
  aplicarMercadoUI();
  desenharComparar();
}

function sairComparar() {
  if (!vistaCmp) return;
  document.body.classList.remove("cmp-aberta");
  vistaCmp = false;
  $("comparar").hidden = true;
  $("mercado").hidden = false;
  zerarCampos();
  if (D) restaurar();
  $("v-nota-v").value = val("v-nota");
  aplicarMercadoUI();
  if (D && partes[mercado]) render();
}

function desenharComparar() {
  const corpo = $("cmp-corpo");
  const todos = Object.values((META && META.comparativos) || {}).filter((x) => !ocultas.has(chaveDe(x.termo))).sort((a, b) => new Date(b.em) - new Date(a.em));
  cmpAssinatura = JSON.stringify(todos.map((x) => [x.termo, x.em]));
  if (!todos.length) {
    corpo.innerHTML = `<div class="c3-vazio-geral"><p><b>Compare um produto nos 3 mercados.</b></p><p>${SOMENTE_LEITURA && !nuvem() ?"As comparações são pedidas no computador onde o agente roda e aparecem aqui depois de publicadas. Ainda não há nenhuma." : "Digite o produto na caixa acima (ex.: jbl flip 6, tênis asics, moletom) e clique em “Comparar 3 mercados”. O agente busca no Brasil, no Paraguai e na China ao mesmo tempo e mostra o menor preço de cada um. Leva cerca de 1 minuto."}</p></div>`;
    return;
  }
  const r = todos.find((x) => x.termo === cmpSel) || todos[0];
  cmpSel = r.termo;
  const M = r.mercados || {};
  const pct = (v) => `${Math.abs(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
  const st = r.status || {};
  const stPy = st.py && st.py.termo === r.termo && !st.py.ok ? st.py : null;
  const stKb = st.kakobuy && st.kakobuy.termo === r.termo && !st.kakobuy.ok ? st.kakobuy : null;
  const cota = (META && META.py_info && META.py_info.cota_usd) || 500;
  let parcial = false;

  const coluna = (m) => {
    const d = M[m] || {};
    const vence = r.mais_barato === m;
    const avisos = [];
    const erroBusca = typeof (r.buscas || {})[m] === "string" && r.buscas[m].startsWith("erro") ? r.buscas[m] : "";
    if (erroBusca) { avisos.push([`A busca falhou (${erroBusca.replace(/^erro: /, "")}).`, true]); parcial = true; }
    if (m === "py" && stPy) { avisos.push([`O Compras Paraguai não respondeu: ${stPy.msg}`, true]); parcial = true; }
    if (m === "cn" && stKb) { avisos.push([`O KakoBuy (Taobao e 1688) não respondeu: ${stKb.msg}.`, true]); parcial = true; }
    if (m === "br" && r.br_sem_marketplaces) { avisos.push(["Amazon, Magalu, Mercado Livre, Shopee e Shein não entraram (extensão do Chrome desligada ou sem busca recente). O Brasil pode estar mais barato do que aparece.", false]); parcial = true; }
    let h = `<article class="c3-col${vence ? " melhor" : ""}${d.marca_famosa ? " fora" : ""}"><h3>${NOME_M[m]}${vence ? `<span class="c3-selo">Mais barato</span>` : ""}</h3>`;
    if (!d.n) {
      h += `<p class="c3-vazio">Nenhuma oferta encontrada para este produto.</p>`;
    } else {
      const mn = d.menor;
      h += `<div class="c3-preco">${brl.format(mn.preco)}</div>`;
      if (m !== "br" && d.vs_br_pct != null) h += `<div class="c3-vs ${d.vs_br_pct <= 0 ? "barato" : "caro"}">${pct(d.vs_br_pct)} ${d.vs_br_pct <= 0 ? "mais barato" : "mais caro"} que o Brasil</div>`;
      h += `<a class="c3-item" href="${esc(seguro(mn.link))}" target="_blank" rel="noopener">${mn.imagem ? `<img src="${esc(seguro(mn.imagem))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "<i></i>"}<span>${esc(mn.titulo)}<small>${esc(lojaChave(mn.loja))}</small></span></a>`;
      h += `<p class="c3-meta">${d.n} ${plural(d.n, "oferta", "ofertas")} · ${d.lojas} ${plural(d.lojas, "loja", "lojas")} · mediana ${brl.format(d.mediana)}${mn.usd ? ` · US$ ${mn.usd.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} à vista` : ""}</p>`;
      if (m === "br" && mn.horas) avisos.push([`Preço conferido há ${horasTxt(mn.horas)}.`, false]);
      if (m === "py") avisos.push(mn.imposto_est ? [`Acima da cota de US$ ${cota} por pessoa: imposto estimado ≈ ${brl.format(mn.imposto_est)} (não entra na comparação).`, false] : []);
      if (m === "cn") {
        if (d.marca_famosa) { avisos.push([`Marca famosa (${d.marca_famosa}): na China costuma ser réplica. Fora da disputa pelo menor preço.`, true]); }
        else avisos.push([mn.com_frete ? "Total com frete aéreo estimado, sem imposto." : "Preço anunciado; pode ter imposto na compra.", false]);
        if (mn.replica) avisos.push(["Todos os resultados têm suspeita de réplica ou não são de confiança: o menor preço fica fora da disputa. Confira o anúncio antes de comprar.", true]);
        else if (d.replicas) avisos.push([`${d.replicas} ${plural(d.replicas, "resultado marcado", "resultados marcados")} como possível réplica (aparecem depois dos demais, não entram no menor preço).`, false]);
      }
      const outros = (d.top || []).slice(1);
      if (outros.length) h += `<ul class="c3-top">${outros.map((o) => `<li><a href="${esc(seguro(o.link))}" target="_blank" rel="noopener" title="${esc(o.titulo)}">${esc(lojaChave(o.loja))}</a><b>${brl.format(o.preco)}</b></li>`).join("")}</ul>`;
    }
    h += avisos.filter((a) => a.length).map(([t, erro]) => `<p class="c3-aviso${erro ? " erro" : ""}">${esc(t)}</p>`).join("");
    if (d.n) h += `<button type="button" class="botao c3-ir" data-ir="${m}">Ver as ${d.n} ${plural(d.n, "oferta", "ofertas")}</button>`;
    return h + "</article>";
  };
  const colunas = ["br", "py", "cn"].map(coluna).join("");

  // veredito: quem tem o menor preço e quanto os outros ficam acima dele
  let ver;
  const venc = r.mais_barato;
  if (venc) {
    const base_ = M[venc].menor.preco;
    const outros = ["br", "py", "cn"].filter((m) => m !== venc && M[m] && M[m].n && !M[m].marca_famosa)
      .map((m) => `${NOME_M[m]} ${brl.format(M[m].menor.preco)} (+${pct(100 * (M[m].menor.preco / base_ - 1))})`);
    ver = `<b>${NOME_M[venc]}</b> tem o menor preço: ${brl.format(base_)}${outros.length ? `. ${outros.join(" · ")}` : ""}.${parcial ? " <b>Resultado parcial</b>: veja os avisos abaixo." : ""}`;
  } else ver = "Nenhum mercado trouxe ofertas para este produto. Tente o nome como a loja escreve (ex.: “iphone 16 128gb”).";

  corpo.innerHTML = `<div class="c3">
    <div class="c3-topo"><h2>${esc(r.termo)}</h2><small>comparado ${idade(r.em)}${r.segmento ? ` · categoria ${esc(r.segmento)}` : ""}</small>
      <div class="c3-acoes"><button type="button" class="botao" data-acao-cmp="buscar" title="Busca de novo nos 3 mercados">Buscar de novo</button>
      <button type="button" class="botao" data-gerenciar title="Ver, manter e apagar as buscas salvas">Minhas buscas</button>
      <button type="button" class="botao" data-acao-cmp="recalcular" title="Refaz a conta com o que já foi buscado (depois de uma Pesquisa ampla na aba Brasil, por exemplo)">Refazer a conta</button></div></div>
    ${todos.length > 1 ? `<div class="c3-hist" role="group" aria-label="Comparações anteriores">${todos.map((x) => `<button type="button" data-termo="${esc(x.termo)}" aria-pressed="${x.termo === r.termo}">${esc(x.termo)}</button>`).join("")}</div>` : ""}
    <p class="c3-veredito${parcial ? " incerto" : ""}">${ver}</p>
    <div class="c3-grade">${colunas}</div>
    <p class="c3-rodape">Compara o <b>menor preço</b> que cada mercado devolveu; confira o título, pode ser outra cor, memória ou versão. Paraguai é à vista, em reais pelo câmbio do Compras Paraguai. China é o AliExpress anunciado ou 1688/Taobao com frete estimado. Imposto não entra na ordem.</p>
  </div>`;
}

$("cmp-corpo").addEventListener("click", (e) => {
  const hist = e.target.closest("[data-termo]");
  if (hist) { cmpSel = hist.dataset.termo; desenharComparar(); return; }
  const ir = e.target.closest("[data-ir]");
  if (ir) { irParaMercado(ir.dataset.ir, cmpSel); return; }
  const ac = e.target.closest("[data-acao-cmp]");
  if (ac && cmpSel) enviarComparacao(cmpSel, ac.dataset.acaoCmp === "recalcular");
});

// "Ver as N ofertas": abre a aba do mercado já filtrada pelo produto
function irParaMercado(m, termo) {
  const aba = abas.find((x) => x.dataset.aba === m);
  if (!aba) return;
  ativarAba(aba, true);
  if (m === "cn") { F.wish = new Set([termo]); salvar(); mudou(); }
  else { $("q").value = termo; mudou(); }
}

async function enviarComparacao(termo, recalcular = false) {
  const av = (texto, o = {}) => aviso(texto, { ...o, chave: "cmp" });
  if (!termo) { av("Digite o produto que você quer comparar (ex.: jbl flip 6).", { erro: true, fechar: true }); $("q").focus(); return; }
  if (nuvem()) { await pedirNuvem("comparar", termo, "Comparação"); return; }
  if (cmpTimer) { av("Já tem uma comparação rodando. Espere ela terminar.", { erro: true, fechar: true }); return; }
  av(recalcular ? `Refazendo a conta de "${termo}"…` : `Comparando "${termo}" nos 3 mercados…`);
  try {
    const r = await fetch(`${RECEPTOR}/comparar?termo=${encodeURIComponent(termo)}${recalcular ? "&recalcular=1" : ""}${token()}`, { method: "POST" });
    if (r.status === 409) { av("Já tem uma comparação rodando. Espere ela terminar.", { erro: true, fechar: true }); return; }
    if (r.status === 403) { av("O buscador local recusou o pedido (chave do painel desatualizada). Recarregue a página e tente de novo.", { erro: true, fechar: true }); return; }
    if (!r.ok) throw new Error(r.status);
  } catch (err) {
    estadoReceptor = { ok: false }; atualizarStatus();
    av(MSG_RECEPTOR, { erro: true, retry: true, fechar: true });
    return;
  }
  $("q").value = "";
  const ini = Date.now();
  const fim = async (s) => {
    clearInterval(cmpTimer); cmpTimer = null;
    if (s.estado !== "pronto") { av(`A comparação falhou: ${s.msg || "o buscador local não respondeu"}`, { erro: true, fechar: true }); return; }
    cmpSel = s.termo;
    await atualizar(false);
    desenharComparar();
    av(`Comparação de "${s.termo}" pronta.`, { fechar: true });
  };
  cmpTimer = setInterval(async () => {
    try {
      const s = await (await fetch(RECEPTOR + "/comparar-status", { cache: "no-store" })).json();
      if (s.estado === "rodando") {
        if (Date.now() - ini > 8 * 60e3) { await fim({ estado: "erro", msg: "demorou demais" }); return; }
        av(`Comparando "${s.termo}": ${s.msg}`);
        return;
      }
      await fim(s);
    } catch (_) { await fim({ estado: "erro", msg: "o buscador local parou de responder" }); }
  }, 3e3);
}

// ---------- Minhas buscas: escolher o que manter e o que apagar ----------
const dlg = $("d-buscas");
let marcadas = new Set();                            // chaves (termo sem acento) marcadas para apagar
let apagando = false;                                // 1º clique em "Apagar" pede confirmação; o 2º apaga
const chaveBusca = (t) => semAcento(t).trim();

function buscasSalvas() { return ((META && META.buscas_salvas) || []).filter((b) => !ocultas.has(chaveDe(b.termo))); }

function desenharBuscas() {
  const q = semAcento($("g-q").value).trim();
  const todas = buscasSalvas();
  const vistas = todas.filter((b) => !q || semAcento(b.termo).includes(q));
  $("g-lista").innerHTML = vistas.length ? vistas.map((b) => {
    const k = chaveBusca(b.termo);
    const partes_ = [["Brasil", b.br], ["Paraguai", b.py], ["China", b.cn]].filter(([, n]) => n > 0).map(([m, n]) => `${m} ${n.toLocaleString("pt-BR")}`);
    return `<li class="${marcadas.has(k) ? "marcada" : ""}"><label><input type="checkbox" data-k="${esc(k)}" ${marcadas.has(k) ? "checked" : ""}><span class="g-termo">${esc(b.termo)}</span><span class="g-n">${partes_.length ? partes_.join(" · ") : "sem ofertas agora"}</span></label></li>`;
  }).join("") : `<li><p class="ajuda" style="padding:12px">${todas.length ? "Nenhuma busca com esse nome." : "Você ainda não tem buscas salvas."}</p></li>`;
  const sel = todas.filter((b) => marcadas.has(chaveBusca(b.termo)));
  const ofs = sel.reduce((s, b) => s + b.br + b.cn + b.py, 0);
  const btn = $("g-apagar");
  btn.disabled = !sel.length;
  btn.textContent = !sel.length ? "Apagar" : apagando ? `Confirmar: apagar ${sel.length} ${plural(sel.length, "busca", "buscas")}` : `Apagar ${sel.length} ${plural(sel.length, "busca", "buscas")}`;
  $("g-resumo").textContent = sel.length ? `${sel.length} de ${todas.length} marcadas · cerca de ${ofs.toLocaleString("pt-BR")} ofertas saem${apagando ? ". Clique de novo para confirmar." : "."}` : `${todas.length} ${plural(todas.length, "busca salva", "buscas salvas")}`;
}

function abrirGerenciar() {
  marcadas = new Set(); apagando = false; $("g-q").value = "";
  desenharBuscas();
  if (!dlg.open) dlg.showModal();
}

document.addEventListener("click", (e) => { if (e.target.closest("[data-gerenciar]")) abrirGerenciar(); });
$("g-lista").addEventListener("change", (e) => {
  const k = e.target.dataset && e.target.dataset.k;
  if (k === undefined) return;
  if (e.target.checked) marcadas.add(k); else marcadas.delete(k);
  apagando = false; desenharBuscas();
});
$("g-q").addEventListener("input", desenharBuscas);
const visiveis = () => buscasSalvas().filter((b) => { const q = semAcento($("g-q").value).trim(); return !q || semAcento(b.termo).includes(q); }).map((b) => chaveBusca(b.termo));
$("g-todas").onclick = () => { visiveis().forEach((k) => marcadas.add(k)); apagando = false; desenharBuscas(); };
$("g-nenhuma").onclick = () => { visiveis().forEach((k) => marcadas.delete(k)); apagando = false; desenharBuscas(); };
$("g-inverter").onclick = () => { visiveis().forEach((k) => (marcadas.has(k) ? marcadas.delete(k) : marcadas.add(k))); apagando = false; desenharBuscas(); };
$("g-x").onclick = $("g-fechar").onclick = () => dlg.close();
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // clique no fundo escuro fecha

$("g-apagar").onclick = async () => {
  const sel = buscasSalvas().filter((b) => marcadas.has(chaveBusca(b.termo)));
  if (!sel.length) return;
  if (!apagando) { apagando = true; desenharBuscas(); return; }
  $("g-apagar").disabled = true;
  $("g-resumo").textContent = "Apagando…";
  if (nuvem()) {   // site online: marca no Firestore e esconde na hora; o computador do agente apaga do banco quando estiver ligado
    try {
      for (let i = 0; i < sel.length; i += 8) {
        await Promise.all(sel.slice(i, i + 8).map((b) => fs("POST", "ocultas", { fields: { termo: fsTxt(b.termo), em: fsTxt(new Date().toISOString()) } }, `&documentId=${fsId(chaveBusca(b.termo))}`)));
      }
    } catch (_) {
      apagando = false; desenharBuscas();
      $("g-resumo").textContent = "Não consegui apagar. Confira a internet e tente de novo.";
      return;
    }
    sel.forEach((b) => ocultas.add(chaveBusca(b.termo)));
    marcadas = new Set(); apagando = false;
    refiltrar();
    dlg.close();
    aviso(`${sel.length} ${plural(sel.length, "busca apagada", "buscas apagadas")}: ${plural(sel.length, "saiu", "saíram")} do site agora. O computador do agente apaga de vez do banco quando estiver ligado.`, { fechar: true });
    return;
  }
  try {
    const r = await fetch(`${RECEPTOR}/apagar-buscas?${token().slice(1)}`, { method: "POST", body: JSON.stringify({ termos: sel.map((b) => b.termo) }) });
    if (r.status === 403) throw new Error("chave do painel desatualizada: recarregue a página");
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const apagadas = new Set(sel.map((b) => chaveBusca(b.termo)));
    F.wish = new Set([...F.wish].filter((t) => !apagadas.has(chaveBusca(t))));
    salvar();
    marcadas = new Set(); apagando = false;
    await atualizar(false);
    if (vistaCmp) desenharComparar();
    desenharBuscas();
    dlg.close();
    aviso(`Apagadas ${j.buscas} ${plural(j.buscas, "busca", "buscas")} e ${j.ofertas.toLocaleString("pt-BR")} ${plural(j.ofertas, "oferta", "ofertas")}. O site de leitura é atualizado em instantes.`, { fechar: true });
  } catch (err) {
    apagando = false; desenharBuscas();
    $("g-resumo").textContent = String(err.message || err).startsWith("chave") ? err.message : "Não consegui apagar. O buscador local está ligado? (ligar-buscador.cmd)";
  }
};