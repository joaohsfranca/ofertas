// Aba "Link": cole o link de um produto da China (Weidian, Taobao, 1688, Goofish; também o link já embrulhado por um agente) e veja
// se o item ainda existe, o preço de hoje e o custo final estimado em cada agente, com o link limpo (sem código de afiliado).
// Os dados vêm de META.links (link_cn.py). No computador do agente o painel fala com o receptor (POST /link); no site publicado o
// pedido vai pela nuvem (Firestore, tipo "link") e o computador do agente responde. Carregado depois do painel.js (usa os globais dele).
let vistaLnk = false;
let lnkOcupado = false;
let lnkAssinatura = "";
let lnkDestaque = null;                              // id do item recém-conferido (rola até ele)
const LNK_CANAL = { weidian: "Weidian", taobao: "Taobao", "1688": "1688", goofish: "Goofish" };
const LNK_ESTADO = {
  "no ar": ["No ar", "ok", "O vendedor mantém o item à venda."],
  esgotado: ["Esgotado", "esgotado", "Sem estoque agora. O vendedor pode repor: vale conferir de novo mais tarde."],
  removido: ["Removido", "removido", "Tirado do ar ou inexistente. O preço abaixo é o último visto."],
  nao_conferi: ["Não consegui conferir", "incerto", "A página não respondeu. Tente de novo em instantes."],
};
const brl2 = (v) => brl.format(v);

// o mesmo reconhecimento de link do link_cn.py (para o site, que só pode mandar "canal:id", no máximo 80 caracteres)
function lnkAnalisar(texto) {
  const urls = String(texto || "").match(/https?:\/\/[^\s<>"'）)】」]+/gi) || [];
  const um = (u, ...nomes) => { for (const n of nomes) { const v = [...u.searchParams].find(([k]) => k.toLowerCase() === n.toLowerCase()); if (v && v[1]) return v[1]; } return null; };
  const ok = (s) => /^\d{6,20}$/.test(s || "");
  const ler = (bruto, fundo) => {
    let u; try { u = new URL(bruto.replace(/[.,;]+$/, "")); } catch (_) { return null; }
    const h = u.hostname.toLowerCase();
    if (!fundo) for (const k of ["url", "goodsUrl", "goods_url", "link", "itemUrl"]) { const i = um(u, k); if (i && /^https?:/i.test(i)) { const r = ler(i, true); if (r) return r; } }
    let m = u.pathname.match(/\/product\/(\d)\/(\d{6,20})/);
    if (m && h.includes("hoobuy")) return { canal: { 0: "1688", 1: "taobao", 2: "weidian" }[m[1]], id: m[2] };
    if (h.includes("weidian.com") || h.includes("koudai.com")) { const i = um(u, "itemID", "itemId", "item_id", "id"); if (ok(i)) return { canal: "weidian", id: i }; }
    if (h.includes("1688.com")) { m = u.pathname.match(/\/offer\/(\d{6,20})/) || u.pathname.match(/(\d{9,20})\.html/); const i = m ? m[1] : um(u, "offerId", "id"); if (ok(i)) return { canal: "1688", id: i }; }
    if (h.includes("goofish.com") || h.includes("xianyu") || h.startsWith("2.taobao.com")) { const i = um(u, "id", "itemId"); if (ok(i)) return { canal: "goofish", id: i }; }
    if (h.includes("taobao.com") || h.includes("tmall.com") || h.includes("tmall.hk")) { const i = um(u, "id", "itemId", "item_id", "num_iid"); if (ok(i)) return { canal: "taobao", id: i }; }
    return null;
  };
  for (const u of urls) { const r = ler(u, false); if (r) return r; }
  return null;
}

function abrirLinks() {
  if (vistaLnk) return;
  vistaLnk = true;
  document.body.classList.add("lnk-aberta");
  fecharFiltros();
  if (D) salvar();                                   // guarda os filtros do mercado de onde saiu
  $("mercado").hidden = true;
  $("comparar").hidden = true;
  $("links").hidden = false;
  document.title = "Ofertas · Link";
  desenharLinks();
}

function sairLinks() {
  if (!vistaLnk) return;
  vistaLnk = false;
  document.body.classList.remove("lnk-aberta");
  $("links").hidden = true;
  $("mercado").hidden = false;
  zerarCampos();
  if (D) restaurar();
  $("v-nota-v").value = val("v-nota");
  aplicarMercadoUI();
  if (D && partes[mercado]) render();
}

const lnkLista = () => ((META && META.links) || []).slice().sort((a, b) => (b.salvo - a.salvo) || String(b.checado_em).localeCompare(String(a.checado_em)));

function lnkCartao(r) {
  const [rot, cls, dica] = LNK_ESTADO[r.estado] || LNK_ESTADO.nao_conferi;
  const fora = r.estado === "removido" || r.estado === "esgotado";
  const hist = (r.historico || []);
  let mudou = "";
  if (hist.length > 1) {
    const a = hist[hist.length - 2], b = hist[hist.length - 1];
    const partesM = [];
    if (a.preco_cny != null && b.preco_cny != null && a.preco_cny !== b.preco_cny) partesM.push(`preço de ¥ ${a.preco_cny.toLocaleString("pt-BR")} para ¥ ${b.preco_cny.toLocaleString("pt-BR")}`);
    if (a.estado !== b.estado) partesM.push(`${(LNK_ESTADO[a.estado] || [a.estado])[0].toLowerCase()} → ${(LNK_ESTADO[b.estado] || [b.estado])[0].toLowerCase()}`);
    if (partesM.length) mudou = `<p class="lk-mudou">Mudou ${idade(b.em)}: ${partesM.join(" e ")}.</p>`;
  }
  const ags = r.custo ? Object.entries(r.custo.agentes) : [];
  const menor = ags.length ? ags.reduce((m, x) => (x[1].pacote < m[1].pacote ? x : m)) : null;
  const linhas = ags.map(([nome, c]) => {
    const href = (r.agentes || {})[nome];
    return `<tr class="${menor && menor[0] === nome ? "melhor" : ""}"><th scope="row">${href ? `<a href="${esc(seguro(href))}" target="_blank" rel="noopener" title="Abre este item no ${esc(nome)}">${esc(nome)} ↗</a>` : esc(nome)}</th><td>${brl2(c.pacote)}</td><td>${brl2(c.avulso)}</td></tr>`;
  }).join("");
  const preco = r.preco_cny != null ? `¥ ${r.preco_cny.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}${r.custo ? ` (${brl2(r.custo.produto_brl)})` : ""}` : "preço indisponível";
  const titulo = r.titulo || r.titulo_en || r.titulo_zh || "Item sem título";
  return `<article class="lk-card${fora ? " fora" : ""}" data-id="${esc(r.id)}">
    <div class="lk-img">${r.imagem ? `<img src="${esc(seguro(r.imagem))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "<i></i>"}</div>
    <div class="lk-corpo">
      <div class="lk-topo"><span class="lk-estado ${cls}" title="${esc(dica)}">${rot}</span><small>${esc(LNK_CANAL[r.canal] || r.canal)} · ${preco}${r.checado_em ? ` · conferido ${idade(r.checado_em)}` : ""}${r.salvo ? " · na sua lista" : ""}</small></div>
      <h3 class="lk-titulo">${esc(titulo)}</h3>
      ${r.replica ? `<p class="lk-aviso erro">Possível réplica: o título cita marca famosa ou termo de réplica. Não é de confiança; confira as fotos e as avaliações.</p>` : ""}
      ${fora ? `<p class="lk-aviso">${esc(r.motivo || dica)}</p>` : ""}
      ${r.aviso ? `<p class="lk-aviso">${esc(r.aviso)}</p>` : ""}
      ${r.sem_link_limpo ? `<p class="lk-aviso">Item do Taobao achado na busca: o Taobao não entrega o endereço direto dele aqui. Abra pelo KakoBuy.</p>` : ""}
      ${mudou}
      ${linhas ? `<table class="lk-tab"><caption>Custo estimado no Brasil, sem imposto (produto + frete na China + frete aéreo)${r.custo ? ` · peso estimado ${r.custo.peso_g} g` : ""}</caption>
        <thead><tr><th scope="col">Abrir no agente</th><th scope="col" title="O frete aéreo é rateado numa compra consolidada de 3 kg">Num pacote de 3 kg</th><th scope="col" title="O item sozinho no pacote">Avulso</th></tr></thead><tbody>${linhas}</tbody></table>` : ""}
      <div class="lk-acoes">
        ${r.sem_link_limpo ? "" : `<a class="botao" href="${esc(seguro(r.url))}" target="_blank" rel="noopener" title="Abre o anúncio na loja de origem (link limpo, sem código de afiliado)">Abrir na loja</a>
        <button type="button" class="botao" data-lk="copiar">Copiar link limpo</button>`}
        <button type="button" class="botao" data-lk="reconferir">Conferir de novo</button>
        ${SOMENTE_LEITURA ? "" : `<button type="button" class="botao" data-lk="${r.salvo ? "desalvar" : "salvar"}">${r.salvo ? "Tirar da lista" : "Guardar na lista"}</button>
        <button type="button" class="botao perigo" data-lk="remover">Apagar</button>`}
      </div>
    </div></article>`;
}

function desenharLinks() {
  const lista = lnkLista();
  lnkAssinatura = JSON.stringify(lista.map((x) => [x.id, x.checado_em, x.salvo]));
  const leitura = SOMENTE_LEITURA && !nuvem();
  $("lk-form").hidden = leitura;
  $("lk-lista").innerHTML = lista.length
    ? lista.map(lnkCartao).join("")
    : `<div class="c3-vazio-geral"><p><b>${leitura ? "Nenhum link conferido ainda." : "Cole o link de um produto da China."}</b></p><p>${leitura ? "Os links são conferidos no computador onde o agente roda e aparecem aqui depois de publicados. Ainda não há nenhum." : "Aceito links da Weidian, do Taobao (e Tmall), da 1688 e do Goofish, e também o link que um agente (KakoBuy, Hoobuy, Superbuy…) gerou. O agente confere se o item ainda existe, mostra o preço de hoje e o custo final em cada agente. Imposto não entra na conta."}</p></div>`;
  if (lnkDestaque) {
    const el = document.querySelector(`.lk-card[data-id="${CSS.escape(lnkDestaque)}"]`);
    if (el) { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); el.classList.add("novo"); }
    lnkDestaque = null;
  }
}

function lnkAviso(texto, o = {}) { aviso(texto, { ...o, chave: "link" }); }

async function lnkPedirLocal(caminho, corpo) {
  const r = await fetch(`${RECEPTOR}${caminho}?${token().slice(1)}`, { method: "POST", body: JSON.stringify(corpo) });
  if (r.status === 403) throw new Error("O buscador local recusou o pedido (chave do painel desatualizada). Recarregue a página.");
  if (r.status === 409) throw new Error("Já estou conferindo outro link. Espere terminar.");
  if (!r.ok) throw new Error(r.status === 400 ? "Pedido inválido." : MSG_RECEPTOR);
  return r.json();
}

async function lnkAcompanharLocal() {
  const ini = Date.now();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1500));
    let s;
    try { s = await (await fetch(RECEPTOR + "/link-status", { cache: "no-store" })).json(); } catch (_) { throw new Error("O buscador local parou de responder."); }
    if (s.estado === "rodando") {
      if (Date.now() - ini > 4 * 60e3) throw new Error("Demorou demais.");
      lnkAviso(s.msg || "Conferindo…");
      continue;
    }
    if (s.estado === "erro") throw new Error(s.msg || "Não deu certo.");
    return s;
  }
}

async function lnkPedirNuvem(termo, rotulo) {
  lnkAviso(`${rotulo}: enviando o pedido…`);
  let id;
  try {
    const r = await fs("POST", "pedidos", { fields: { tipo: fsTxt("link"), termo: fsTxt(termo), em: fsTxt(new Date().toISOString()), estado: fsTxt("novo") } });
    id = r.json.name.split("/").pop();
  } catch (_) { throw new Error("Não consegui enviar o pedido. Confira a internet e tente de novo."); }
  const ini = Date.now();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 5000));
    if (Date.now() - ini > 30 * 60e3) { lnkAviso(`${rotulo}: ainda sem resposta. O pedido continua guardado e roda quando o computador do agente estiver ligado.`, { fechar: true }); return false; }
    let f;
    try { const { status, json } = await fs("GET", `pedidos/${id}`); if (status === 404) return false; f = json.fields || {}; } catch (_) { continue; }
    const est = (f.estado || {}).stringValue, msg = (f.msg || {}).stringValue || "";
    if (est === "erro") throw new Error(msg || "Não deu certo.");
    if (est === "feito") return true;
    lnkAviso(est === "rodando" ? `${rotulo}: ${msg || "conferindo…"}` : `${rotulo}: pedido enviado. Esperando o computador do agente pegar…`);
  }
}

async function lnkEnviar(texto) {
  if (lnkOcupado) { lnkAviso("Já tem um link em andamento. Espere terminar.", { erro: true, fechar: true }); return; }
  texto = (texto || "").trim();
  if (!texto) { lnkAviso("Cole o link do produto na caixa acima.", { erro: true, fechar: true }); $("lk-texto").focus(); return; }
  lnkOcupado = true; $("lk-ok").disabled = true;
  try {
    if (nuvem()) {
      const a = lnkAnalisar(texto);
      if (!a) throw new Error("Não achei um link de produto da Weidian, Taobao, 1688 ou Goofish nesse texto. (Links curtos como tb.cn só funcionam no computador do agente: abra e cole o endereço completo.)");
      lnkDestaque = `${a.canal}:${a.id}`;
      lnkAviso("Link: enviando o pedido…");
      if (await lnkPedirNuvem(`${a.canal}:${a.id}`, "Link")) { lnkAviso("Link conferido. O resultado aparece aqui em 1 a 2 minutos (o site é atualizado em seguida).", { fechar: true }); await atualizar(false); }
    } else {
      lnkAviso("Link: lendo o endereço…");
      await lnkPedirLocal("/link", { texto, salvar: $("lk-salvar").checked });
      const s = await lnkAcompanharLocal();
      lnkDestaque = s.id;
      await atualizar(false);
      lnkAviso("Link conferido.", { fechar: true });
      $("lk-texto").value = "";
    }
    desenharLinks();
  } catch (err) {
    lnkAviso(String(err.message || err), { erro: true, fechar: true });
    if (/desligado|parou de responder/.test(String(err.message))) { estadoReceptor = { ok: false }; atualizarStatus(); }
  } finally { lnkOcupado = false; $("lk-ok").disabled = false; }
}

async function lnkAcao(acao, id) {
  if (acao === "copiar") {
    const r = lnkLista().find((x) => x.id === id);
    if (!r) return;
    try { await navigator.clipboard.writeText(r.url); lnkAviso("Link limpo copiado.", { fechar: true }); }
    catch (_) { window.prompt("Copie o link limpo:", r.url); }
    return;
  }
  if (lnkOcupado) { lnkAviso("Já tem um link em andamento. Espere terminar.", { erro: true, fechar: true }); return; }
  lnkOcupado = true;
  try {
    if (nuvem()) {
      // o site só consegue pedir pela nuvem: reconferir = pedir o mesmo item de novo; apagar/guardar/tirar da lista não existem no site (sem senha)
      if (acao === "reconferir") { lnkDestaque = id; if (await lnkPedirNuvem(id, "Link")) await atualizar(false); }
      else lnkAviso("Apagar, guardar e tirar da lista só funcionam no computador do agente (o site não tem senha, então não pode mexer na sua lista).", { erro: true, fechar: true });
    } else {
      await lnkPedirLocal("/link-acao", { acao, id });
      if (acao === "reconferir") { lnkDestaque = id; await lnkAcompanharLocal(); }
      await atualizar(false);
      if (acao === "reconferir") lnkAviso("Item conferido de novo.", { fechar: true });
    }
    desenharLinks();
  } catch (err) { lnkAviso(String(err.message || err), { erro: true, fechar: true }); }
  finally { lnkOcupado = false; }
}

// botão "Guardar" dos cards da China (painel.js): leva o resultado da busca para a lista desta aba
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-guardar-cn]");
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    const r = await fetch(`${RECEPTOR}/link-guardar?${token().slice(1)}`, { method: "POST", body: JSON.stringify({ uid: b.dataset.guardarCn }) });
    if (r.status === 403) throw new Error("chave do painel desatualizada: recarregue a página");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || MSG_RECEPTOR);
    b.textContent = "Guardado ✓";
    lnkAviso("Guardado na aba Link: lá você acompanha o preço e reconfere quando quiser.", { fechar: true });
    await atualizar(false);
  } catch (err) { b.disabled = false; lnkAviso("Não consegui guardar. " + String(err.message || err), { erro: true, fechar: true }); }
});

$("lk-form").addEventListener("submit", (e) => { e.preventDefault(); lnkEnviar($("lk-texto").value); });
$("lk-lista").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lk]");
  const card = e.target.closest(".lk-card");
  if (!b || !card) return;
  if (b.dataset.lk === "remover" && b.dataset.confirmar !== "1") {   // 1º clique pede confirmação
    b.dataset.confirmar = "1"; b.textContent = "Confirmar: apagar";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.confirmar; b.textContent = "Apagar"; } }, 4000);
    return;
  }
  lnkAcao(b.dataset.lk, card.dataset.id);
});
setInterval(() => { if (vistaLnk && !lnkOcupado && JSON.stringify(lnkLista().map((x) => [x.id, x.checado_em, x.salvo])) !== lnkAssinatura) desenharLinks(); }, 4000);   // o meta.js novo chega a cada minuto
