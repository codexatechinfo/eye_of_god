import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, signal } from '@angular/core';
import * as L from 'leaflet';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  MunicipioLimite,
  PontoJornada,
} from '../../../../services/colaboradores.service';

// Em telas com escala fracionária (125%/150% no Windows), o posicionamento
// dos tiles via translate3d (GPU) arredonda em sub-pixel e deixa frestas
// brancas entre eles no Chrome. Desativar as transformações 3D faz o
// Leaflet posicionar tudo com top/left em pixel inteiro, sem essa fresta.
(L as unknown as { Browser: { any3d: boolean } }).Browser.any3d = false;

interface BaseRegional {
  regional: string;
  lat: number;
  lng: number;
}

// Usadas só pelo zoom-por-regional disparado pelo filtro da sidebar
// (aplicarZoomRegional) — os círculos que antes marcavam essas bases no
// mapa foram removidos (usuário: "completamente inúteis"), mas o ponto de
// voo de cada regional continua precisando de uma coordenada de referência.
const BASES_REGIONAIS: BaseRegional[] = [
  { regional: 'APUCARANA', lat: -23.55, lng: -51.46 },
  { regional: 'CAMPO MOURÃO', lat: -24.043, lng: -52.378 },
  { regional: 'CASCAVEL', lat: -24.957, lng: -53.459 },
  { regional: 'CORNELIO PROCÓPIO', lat: -23.181, lng: -50.645 },
  { regional: 'FOZ DO IGUAÇÚ', lat: -25.539, lng: -54.582 },
  { regional: 'LONDRINA', lat: -23.31, lng: -51.162 },
  { regional: 'MARINGÁ', lat: -23.42, lng: -51.933 },
  { regional: 'PARANAVAI', lat: -23.078, lng: -52.463 },
  { regional: 'TOLEDO', lat: -24.725, lng: -53.743 },
  { regional: 'UMUARAMA', lat: -23.766, lng: -53.32 },
];

const CENTRO_PADRAO: L.LatLngTuple = [-24.5, -51.8];
const ZOOM_PADRAO = 7;
const ZOOM_REGIONAL = 11;
const ZOOM_FOCO = 17;

// Compara ignorando acento/caixa: as opções do filtro vêm sem acento
// ("CAMPO MOURAO") enquanto as bases do mapa têm acento ("CAMPO MOURÃO").
function normalizarParaComparacao(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .trim();
}

// Icones do colaborador no mapa — SVGs exatos enviados pelo usuário
// (39131.svg pra moto, 304880.svg pro pedestre — traçados via potrace a
// partir das imagens de referência que ele mandou), usados aqui com o MESMO
// path data dos arquivos originais, só trocando fill="#000000" pela cor de
// cada tipo (moto azul, pedestre laranja). Nenhuma forma desenhada à mão
// aqui — as 3 rodadas anteriores (badge, pino, silhueta aproximada por
// primitivas) nunca bateram com a referência real do usuário; isto substitui
// todas elas com fidelidade exata. Ancorado no CENTRO (não tem "ponta" como
// um pino).
function iconeColaborador(svgInterno: string, viewBox: string, largura: number, altura: number): L.DivIcon {
  return L.divIcon({
    html: `
      <svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}" viewBox="${viewBox}" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))">
        ${svgInterno}
      </svg>
    `,
    className: '',
    iconSize: [largura, altura],
    iconAnchor: [largura / 2, altura / 2],
  });
}

// 39131.svg — viewBox e transform (translate/scale) idênticos ao arquivo
// original, só o fill do <g> trocado de #000000 pra azul.
const ICONE_MOTO = iconeColaborador(
  `<g transform="translate(0,1034) scale(0.1,-0.1)" fill="#2563eb" stroke="none">
<path d="M6120 10315 c-502 -106 -822 -361 -943 -750 -26 -85 -52 -213 -45
-220 2 -3 188 26 412 63 224 37 409 66 412 63 8 -8 4 -571 -4 -571 -12 0 -740
-98 -779 -105 l-33 -6 0 -359 c0 -281 3 -360 13 -360 6 0 111 14 232 30 121
16 223 30 226 30 3 0 54 40 113 89 244 203 471 324 708 377 99 23 327 23 428
1 123 -27 209 -56 323 -110 l109 -51 19 24 c34 44 116 213 143 293 43 127 59
253 53 407 -6 153 -22 238 -67 360 -187 509 -466 744 -945 799 -202 23 -253
22 -375 -4z"/>
<path d="M6450 8440 c-92 -19 -187 -53 -265 -93 -28 -14 -583 -428 -1235 -921
-861 -651 -1186 -891 -1188 -878 -1 9 -8 90 -16 180 -7 89 -15 164 -18 167 -3
3 -54 -13 -114 -36 -60 -22 -221 -81 -359 -131 -383 -138 -638 -241 -822 -333
-456 -226 -697 -468 -799 -800 -26 -85 -28 -101 -28 -280 0 -174 2 -200 28
-310 33 -140 91 -302 167 -467 54 -117 54 -117 89 -118 78 -1 322 -21 424 -35
1182 -164 1889 -910 2182 -2302 l17 -83 93 -90 c288 -279 740 -437 1439 -505
325 -31 469 -36 1350 -45 495 -5 940 -12 989 -16 l89 -6 -7 68 c-3 38 -13 123
-21 189 -34 275 -30 697 10 972 140 958 741 1562 1762 1772 289 59 521 81 945
88 l347 6 42 56 c142 190 168 423 68 612 -17 31 -46 73 -64 93 l-33 36 -1026
0 -1026 0 0 23 c0 36 -36 133 -76 206 -52 95 -117 188 -299 431 -88 118 -185
250 -214 293 -30 43 -58 80 -62 83 -4 2 -311 -232 -681 -522 l-673 -526 -1000
3 c-1071 2 -1041 4 -1153 -48 -108 -51 -196 -173 -240 -338 -13 -49 -23 -69
-33 -67 -86 20 -371 160 -506 248 -223 145 -422 350 -523 538 -31 58 -33 67
-20 80 8 8 471 363 1029 790 1012 774 1014 775 1031 753 11 -15 1278 -1776
1304 -1814 2 -2 1349 1006 1363 1020 9 9 -20 54 -129 197 -77 102 -273 365
-436 585 -585 788 -813 1060 -962 1143 -238 133 -509 182 -740 132z"/>
<path d="M1935 4190 c-523 -44 -999 -271 -1357 -649 -420 -442 -628 -1044
-568 -1642 52 -508 268 -953 636 -1309 820 -793 2128 -780 2935 29 432 434
652 1019 609 1623 -49 687 -420 1294 -1010 1654 -360 219 -825 329 -1245 294z
m465 -754 c557 -129 970 -576 1055 -1141 40 -268 -2 -538 -124 -790 -75 -154
-159 -270 -279 -387 -195 -189 -418 -306 -692 -365 -120 -26 -411 -25 -530 1
-374 81 -684 293 -885 604 -256 397 -287 914 -81 1337 202 414 598 702 1051
764 121 17 365 5 485 -23z"/>
<path d="M10414 4174 c-838 -114 -1531 -733 -1743 -1557 -48 -183 -63 -311
-63 -517 0 -345 61 -615 207 -915 444 -916 1473 -1378 2459 -1105 606 168
1116 620 1361 1205 534 1273 -293 2713 -1658 2890 -145 18 -423 18 -563 -1z
m556 -734 c138 -28 204 -51 345 -120 374 -184 641 -532 732 -953 28 -126 25
-440 -5 -563 -115 -485 -452 -855 -914 -1008 -141 -47 -265 -66 -428 -66 -221
0 -404 41 -595 134 -496 242 -798 750 -771 1296 17 351 153 658 401 905 222
222 495 355 811 395 104 13 308 4 424 -20z"/>
</g>`,
  '0 0 1280 1034',
  34,
  27,
);

// 304880.svg — viewBox e transform idênticos ao arquivo original, só o fill
// do <g> trocado de #000000 pra laranja.
const ICONE_PEDESTRE = iconeColaborador(
  `<g transform="translate(0,1280) scale(0.1,-0.1)" fill="#ea580c" stroke="none">
<path d="M4440 12794 c-14 -2 -59 -9 -100 -15 -88 -13 -259 -68 -344 -111
-279 -141 -496 -384 -598 -668 -58 -160 -82 -389 -59 -551 96 -661 721 -1115
1399 -1015 602 89 1042 585 1042 1175 0 641 -524 1165 -1185 1186 -71 2 -141
2 -155 -1z"/>
<path d="M4300 10199 c-157 -26 -310 -76 -458 -152 -122 -62 -2553 -1739
-2605 -1797 -71 -79 -94 -135 -162 -392 -35 -134 -114 -434 -175 -668 -61
-234 -145 -551 -185 -705 -132 -502 -128 -482 -122 -569 19 -290 352 -497 676
-421 108 26 188 71 272 155 97 96 116 138 185 403 30 117 77 298 104 402 27
105 106 408 174 674 69 267 131 490 138 497 24 22 831 574 835 570 2 -2 -188
-725 -422 -1607 -545 -2052 -764 -2878 -825 -3108 -27 -101 -57 -195 -66 -210
-10 -14 -354 -506 -766 -1093 -411 -587 -766 -1095 -787 -1128 -57 -87 -101
-218 -108 -315 -11 -175 56 -344 191 -480 168 -170 370 -249 631 -249 160 0
276 26 398 88 111 57 181 110 256 193 74 83 1704 2417 1811 2593 87 144 50 18
326 1102 l167 658 46 -43 c25 -23 420 -390 877 -814 773 -718 832 -775 842
-815 6 -24 131 -578 277 -1233 147 -655 277 -1215 290 -1246 88 -218 295 -391
550 -460 119 -33 335 -33 460 0 175 45 312 125 425 248 111 121 177 304 167
459 -5 75 -576 2652 -607 2741 -10 30 -31 76 -46 101 -17 30 -418 439 -1108
1130 -704 705 -1080 1089 -1079 1101 3 24 531 2001 542 2026 6 16 29 -17 124
-178 65 -108 170 -286 234 -394 84 -143 132 -213 172 -253 46 -45 217 -149
971 -590 503 -294 944 -546 980 -561 229 -93 478 -53 645 103 187 174 191 434
11 611 -52 52 -182 131 -909 556 l-849 496 -613 1035 c-591 997 -617 1038
-700 1128 -201 214 -474 361 -755 407 -104 16 -339 19 -430 4z"/>
</g>`,
  '0 0 869 1280',
  22,
  32,
);

// Ponto de pausa (>limite por etapa desde o ponto anterior) — mesmo ícone
// de pausa (duas barras) usado no separador de deslocamento da timeline
// lateral, substituindo o CircleMarker colorido normal só nesse caso.
const ICONE_PAUSA = L.divIcon({
  html: `
    <div style="width:14px;height:14px;border-radius:9999px;background:#f59e0b;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(0,0,0,.35);border:1px solid #fff;">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
    </div>
  `,
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

// Ícone do controle "Camadas" — checklist (linhas com quadrado marcável),
// deliberadamente diferente da pilha de quadrados do controle nativo de
// tipos de mapa (mesma classe CSS leaflet-control-layers-toggle, ícone
// diferente) pra dar pra distinguir os dois de relance.
const ICONE_CAMADAS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="4" width="5" height="5" rx="1"/><path d="M12 6.5h9"/>' +
  '<rect x="3" y="15" width="5" height="5" rx="1"/><path d="M12 17.5h9"/>' +
  '</svg>';

// Mesma paleta das 4 cores da timeline do painel (colaborador-detalhe.html:
// bg-emerald-400/bg-slate-300/bg-amber-500/bg-red-500), exceto "cinza" —
// slate-300 (#cbd5e1) é claro demais sobre tile de mapa (rua ou satélite) e
// o ponto praticamente some visualmente; usuário confirmou o sintoma com
// print. Trocado por um azul (#3b82f6) que continua reservado (não conflita
// com as cores dos segmentos da rota, nem com os ícones de colaborador). A
// cor da lista lateral (colaborador-detalhe.html) não muda — lá o fundo é
// branco, slate-300 tem contraste suficiente.
const CORES_PONTO: Record<'verde' | 'cinza' | 'laranja' | 'vermelho', string> = {
  verde: '#34d399',
  cinza: '#3b82f6',
  laranja: '#f59e0b',
  vermelho: '#ef4444',
};

// Cor de cada trecho entre dois pontos cronologicamente consecutivos da
// jornada — prioridade pausa > mudança de livro > mudança de município >
// deslocamento normal (mesma prioridade usada no indicador da timeline
// lateral, ver ColaboradorDetalhe). Cores dedicadas (fúcsia/teal) pra não
// repetir nada já usado nos pontos (verde/azul/laranja/vermelho) nem no
// polígono "Setor planejado" (violeta) — ver ADR.
const COR_SEGMENTO_PAUSA = '#f59e0b';
const COR_SEGMENTO_MUDOU_LIVRO = '#c026d4';
const COR_SEGMENTO_MUDOU_MUNICIPIO = '#0d9488';
const COR_SEGMENTO_NORMAL = '#94a3b8';

function corDoSegmento(item: PontoJornada): string {
  if (item.tipo_intervalo === 'pausa') return COR_SEGMENTO_PAUSA;
  if (item.mudou_livro) return COR_SEGMENTO_MUDOU_LIVRO;
  if (item.mudou_municipio) return COR_SEGMENTO_MUDOU_MUNICIPIO;
  return COR_SEGMENTO_NORMAL;
}

function tooltipDoPonto(item: PontoJornada): string {
  const livro = ` · Livro ${item.livro}`;
  const endereco = item.endereco ? ` — ${item.endereco}` : '';
  const codigo = item.codigo ? ` · código ${item.codigo}` : ' · pendente';
  return `${item.uc}${livro}${endereco}${codigo}`;
}

// Andrew's monotone chain — casco convexo dos pontos válidos do dia
// (camada "Setor planejado"). Não reaproveita o filtro truthy-string
// (item.latitude && item.longitude) usado em pontosJornada/rotaJornada logo
// abaixo: o hull é sensível a qualquer coordenada que vire NaN depois de
// Number(...) (comparação <, > com NaN é sempre false, sem lançar erro —
// corrompe o polígono inteiro em silêncio), por isso quem chama esta função
// já filtra com Number.isFinite antes. Devolve [] se sobrarem menos de 3
// pontos distintos (não dá pra formar polígono).
function cascoConvexo(pontos: L.LatLngTuple[]): L.LatLngTuple[] {
  const unicos = Array.from(new Map(pontos.map(p => [`${p[0]},${p[1]}`, p])).values());
  if (unicos.length < 3) return [];
  unicos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cruz = (o: L.LatLngTuple, a: L.LatLngTuple, b: L.LatLngTuple) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const inferior: L.LatLngTuple[] = [];
  for (const p of unicos) {
    while (inferior.length >= 2 && cruz(inferior[inferior.length - 2], inferior[inferior.length - 1], p) <= 0) {
      inferior.pop();
    }
    inferior.push(p);
  }

  const superior: L.LatLngTuple[] = [];
  for (let i = unicos.length - 1; i >= 0; i--) {
    const p = unicos[i];
    while (superior.length >= 2 && cruz(superior[superior.length - 2], superior[superior.length - 1], p) <= 0) {
      superior.pop();
    }
    superior.push(p);
  }

  inferior.pop();
  superior.pop();
  const hull = inferior.concat(superior);
  return hull.length >= 3 ? hull : [];
}

@Component({
  selector: 'app-mapa-bases',
  imports: [],
  templateUrl: './mapa-bases.html',
  styleUrl: './mapa-bases.css',
})
export class MapaBases implements AfterViewInit, OnDestroy {
  @ViewChild('mapaEl') mapaEl!: ElementRef<HTMLDivElement>;

  private mapa?: L.Map;
  private resizeObserver?: ResizeObserver;

  private marcadoresColaboradores = new Map<string, L.Marker>();

  // Trajetória do DIA do colaborador aberto (cruza todos os livros dele) —
  // um segmento de linha por par de pontos cronologicamente consecutivos
  // (não uma polyline só, porque cada trecho pode ter cor diferente — ver
  // corDoSegmento) + um marcador por UC (CircleMarker colorido normal, ou
  // ícone de pausa quando o intervalo anterior excedeu o limite). Tudo
  // atualizado em cima da instância existente (nunca recriado do zero)
  // porque a jornada é atualizada a cada 60s enquanto o painel está aberto
  // — recriar a cada ciclo causaria flicker.
  private segmentosRota: L.Polyline[] = [];
  private pontosJornada = new Map<string, L.CircleMarker | L.Marker>();
  private colaboradorComBoundsAplicado: string | null = null;
  // Um polígono por LIVRO (não mais um casco convexo do dia inteiro) — se o
  // colaborador tem mais de um livro em execução hoje, cada um ganha o seu
  // próprio "setor planejado" (pedido explícito do usuário). Chave = livro.
  private poligonosSetorPlanejado = new Map<string, L.Polygon>();
  // Última chave (colaborador+data) pra qual "Limites municipais" já buscou
  // dado — evita rebuscar a cada refresh de 60s do mesmo colaborador/dia
  // (ver effect no construtor).
  private limitesMunicipaisChaveAtual: string | null = null;

  // Grupos do painel "CAMADAS" — cada checkbox só liga/desliga o grupo
  // inteiro (mapa.addLayer/removeLayer), nunca decide SE algo é desenhado.
  // Os métodos de atualização (atualizarRotaJornada, atualizarMarcadoresColaboradores)
  // continuam rodando sempre, mesmo com o grupo fora do mapa — colocar um
  // "if (!camadaLigada()) return" ali reintroduziria o flicker/estado
  // obsoleto que a ADR 0021 Adendo 5/6 já resolveu (o grupo voltaria visível
  // com dado velho até o próximo ciclo de 60s). Ver ADR 0022.
  private grupoPontos = L.layerGroup(); // camada 2: pontos coletados
  private grupoSequencia = L.layerGroup(); // camada 7: trajetória do dia
  private grupoAgentes = L.layerGroup(); // camada 6: demais agentes (toggle)
  // Marcador do colaborador dono da jornada aberta no momento — sempre no
  // mapa, nunca controlado pelo toggle "Demais agentes" (usuário: desmarcar
  // só deve sumir com quem NÃO corresponde à rota/ponto selecionado). Fica
  // fora de grupoAgentes de propósito: adicionado diretamente ao mapa em
  // ngAfterViewInit, não entra no painel Camadas.
  private grupoAgenteAtual = L.layerGroup();
  private nomeAgenteEmDestaque: string | null = null;
  private grupoSetorPlanejado = L.layerGroup(); // camada 4: casco convexo por livro
  private grupoLimitesMunicipais = L.layerGroup(); // camada 5: contorno IBGE

  // Ligadas por padrão (preserva o comportamento atual, sempre visível até
  // hoje); as duas camadas novas nascem desligadas (opt-in, ninguém pediu
  // que aparecessem por padrão e "Limites municipais" custa um fetch de 399
  // polígonos). "Rastro executado" e "Paradas e gaps" não têm signal — os
  // checkboxes deles ficam desabilitados no template (funcionalidade futura).
  camadaPontos = signal(true);
  camadaSequencia = signal(true);
  camadaAgentes = signal(true);
  camadaSetorPlanejado = signal(false);
  camadaLimitesMunicipais = signal(false);

  constructor(public colaboradoresService: ColaboradoresService) {
    effect(() => {
      const regional = this.colaboradoresService.filtroRegional();
      this.aplicarZoomRegional(regional);
    });
    effect(() => {
      this.colaboradoresService.localizacoes();
      this.colaboradoresService.colaboradores();
      this.atualizarMarcadoresColaboradores();
    });
    effect(() => {
      const nome = this.colaboradoresService.colaboradorSelecionado();
      const pontos = nome ? this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos ?? [] : [];
      this.atualizarRotaJornada(nome, pontos);
    });
    // Marcador do colaborador da jornada aberta sai de grupoAgentes (toggle)
    // e vai pro grupo sempre-visível — independente do estado de "Demais
    // agentes". Roda em effect próprio (não dentro do de cima) porque é uma
    // preocupação diferente (membership de grupo, não desenho da rota).
    effect(() => {
      this.atualizarAgenteEmDestaque(this.colaboradoresService.colaboradorSelecionado());
    });
    // "Centralizar no mapa" (botão do card de detalhe de UC, item 4) — voa
    // bem de perto (ZOOM_FOCO) num ponto específico, diferente do
    // ZOOM_REGIONAL usado pro clique de colaborador/filtro. Objeto novo a
    // cada clique (mesmo pra repetir a mesma UC) garante que o effect
    // sempre reexecuta, já que signal de objeto compara por referência.
    effect(() => {
      const alvo = this.colaboradoresService.centralizarEm();
      if (!alvo || !this.mapa) return;
      this.mapa.flyTo([alvo.lat, alvo.lng], ZOOM_FOCO, { duration: 0.6 });
    });

    // Painel "CAMADAS": cada effect só decide se o GRUPO está no mapa — a
    // criação/atualização do conteúdo do grupo roda em outro lugar, sempre
    // (ver comentário dos campos grupoX acima).
    effect(() => this.alternarGrupo(this.grupoPontos, this.camadaPontos()));
    effect(() => this.alternarGrupo(this.grupoSequencia, this.camadaSequencia()));
    effect(() => this.alternarGrupo(this.grupoAgentes, this.camadaAgentes()));
    effect(() => this.alternarGrupo(this.grupoSetorPlanejado, this.camadaSetorPlanejado()));
    // "Limites municipais" é por DIA do colaborador aberto (só o(s)
    // município(s) que ele tocou hoje, não a malha inteira do estado — ver
    // ADR 0022 Adendo 2). Só busca de novo quando o colaborador/data muda,
    // não a cada refresh de 60s do mesmo dia (limitesMunicipaisChaveAtual
    // guarda a última chave buscada). A busca em si continua opt-in (só
    // corre com a camada ligada) — isso é sobre evitar rede desnecessária
    // pra quem nunca liga a camada, não tem relação com o "não fazer" dos
    // grupos de pontos/agentes (aqueles têm o dado local sempre pronto;
    // este depende de uma chamada de rede nova).
    effect(() => {
      const ligado = this.camadaLimitesMunicipais();
      this.alternarGrupo(this.grupoLimitesMunicipais, ligado);
      if (!ligado) return;

      const nome = this.colaboradoresService.colaboradorSelecionado();
      if (!nome) {
        this.limitesMunicipaisChaveAtual = null;
        this.grupoLimitesMunicipais.clearLayers();
        return;
      }
      const jornada = this.colaboradoresService.jornadaPorColaborador().get(nome);
      const chave = `${nome}|${jornada?.data ?? ''}`;
      if (chave === this.limitesMunicipaisChaveAtual) return;

      const pontos = this.pontosValidosDoDia(jornada?.pontos ?? []);
      if (!pontos.length) return;
      this.limitesMunicipaisChaveAtual = chave;
      this.colaboradoresService.carregarLimitesMunicipais(pontos.map(([lat, lng]) => [lat, lng]));
    });
    // Redesenha (substitui, não acumula) sempre que o resultado da busca
    // acima chegar — um por colaborador/dia, nunca a malha inteira acumulada.
    effect(() => {
      const dados = this.colaboradoresService.limitesMunicipais();
      if (dados === null) return;
      this.renderizarLimitesMunicipais(dados);
    });
  }

  // Mesmo filtro (Number.isFinite explícito, mais estrito que o
  // truthy-string de pontosJornada/rotaJornada) usado tanto pelo casco
  // convexo quanto pela busca de limites municipais — ver comentário de
  // cascoConvexo sobre por que NaN não pode vazar pra nenhum dos dois.
  private pontosValidosDoDia(pontos: PontoJornada[]): L.LatLngTuple[] {
    return pontos
      .map((item): L.LatLngTuple => [Number(item.latitude), Number(item.longitude)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  }

  // Move o marcador do colaborador em destaque entre grupoAgentes (sujeito
  // ao toggle "Demais agentes") e grupoAgenteAtual (sempre visível). Não
  // recria o marcador — só troca de grupo, então preserva listener de
  // clique/tooltip já anexados.
  private atualizarAgenteEmDestaque(nome: string | null): void {
    if (nome === this.nomeAgenteEmDestaque) return;

    if (this.nomeAgenteEmDestaque) {
      const anterior = this.marcadoresColaboradores.get(this.nomeAgenteEmDestaque);
      if (anterior) {
        this.grupoAgenteAtual.removeLayer(anterior);
        anterior.addTo(this.grupoAgentes);
      }
    }

    if (nome) {
      const atual = this.marcadoresColaboradores.get(nome);
      if (atual) {
        this.grupoAgentes.removeLayer(atual);
        atual.addTo(this.grupoAgenteAtual);
      }
    }

    this.nomeAgenteEmDestaque = nome;
  }

  private alternarGrupo(grupo: L.LayerGroup, ligado: boolean): void {
    if (!this.mapa) return;
    if (ligado) {
      this.mapa.addLayer(grupo);
    } else {
      this.mapa.removeLayer(grupo);
    }
  }

  private renderizarLimitesMunicipais(municipios: MunicipioLimite[]): void {
    this.grupoLimitesMunicipais.clearLayers();
    for (const municipio of municipios) {
      // Linha mais grossa, mais opaca e tracejada — pedido explícito do
      // usuário pra dar mais destaque (antes era 1px sólido, quase some
      // sobre qualquer camada de tile).
      L.geoJSON(municipio.geometry as GeoJSON.Geometry, {
        style: { color: '#0ea5e9', weight: 2.5, opacity: 0.9, fillOpacity: 0.04, dashArray: '8 5' },
      })
        .bindTooltip(municipio.nome)
        .addTo(this.grupoLimitesMunicipais);
    }
  }

  // Controle Leaflet custom (não um painel Angular sobreposto) — só assim
  // ele empilha naturalmente no mesmo canto/ordem do controle de tipos de
  // mapa. DOM montado à mão com L.DomUtil (mesmo padrão que o próprio
  // Leaflet usa internamente pro L.Control.Layers nativo), reaproveitando as
  // classes leaflet-control-layers* do leaflet.css já carregado — não
  // reimplementa o visual, herda ícone/sombra/hover-pra-expandir de graça.
  // Os checkboxes só escrevem nos signals camadaX; quem liga/desliga o
  // grupo de verdade são os effects do construtor (funciona igual não
  // importa se o signal mudou por aqui ou por outro lugar no futuro).
  private criarControleCamadas(mapa: L.Map): void {
    const Controle = L.Control.extend({
      onAdd: () => this.montarDomControleCamadas(),
    });
    new Controle({ position: 'topleft' }).addTo(mapa);
  }

  private montarDomControleCamadas(): HTMLElement {
    const container = L.DomUtil.create('div', 'leaflet-control-layers');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    container.addEventListener('mouseenter', () => container.classList.add('leaflet-control-layers-expanded'));
    container.addEventListener('mouseleave', () => container.classList.remove('leaflet-control-layers-expanded'));

    const toggle = L.DomUtil.create('a', 'leaflet-control-layers-toggle', container) as HTMLAnchorElement;
    toggle.href = '#';
    toggle.title = 'Camadas';
    toggle.setAttribute('role', 'button');
    toggle.addEventListener('click', e => e.preventDefault());
    // Ícone próprio (checklist), não o de pilha de camadas que o controle de
    // tipos de mapa já usa — inline style vence a regra do leaflet.css
    // (leaflet-control-layers-toggle) sem precisar de !important nem de um
    // arquivo de imagem novo no build.
    toggle.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(ICONE_CAMADAS_SVG)}")`;
    toggle.style.backgroundSize = '18px 18px';

    const lista = L.DomUtil.create('div', 'leaflet-control-layers-list', container);
    const overlays = L.DomUtil.create('div', 'leaflet-control-layers-overlays', lista);

    const itemAtivo = (texto: string, sinal: { (): boolean; set: (v: boolean) => void }) => {
      const label = L.DomUtil.create('label', '', overlays) as HTMLLabelElement;
      const input = L.DomUtil.create('input', 'leaflet-control-layers-selector', label) as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = sinal();
      input.addEventListener('change', () => sinal.set(input.checked));
      label.appendChild(document.createTextNode(' ' + texto));
    };

    const itemDesabilitado = (texto: string) => {
      const label = L.DomUtil.create('label', '', overlays) as HTMLLabelElement;
      label.style.opacity = '0.5';
      label.style.cursor = 'not-allowed';
      label.title = 'Ainda não implementado';
      const input = L.DomUtil.create('input', 'leaflet-control-layers-selector', label) as HTMLInputElement;
      input.type = 'checkbox';
      input.disabled = true;
      label.appendChild(document.createTextNode(' ' + texto));
    };

    itemDesabilitado('Rastro executado');
    itemAtivo('Pontos coletados', this.camadaPontos);
    itemDesabilitado('Paradas e gaps');
    itemAtivo('Setor planejado', this.camadaSetorPlanejado);
    itemAtivo('Limites municipais', this.camadaLimitesMunicipais);
    itemAtivo('Demais agentes', this.camadaAgentes);
    itemAtivo('Trajetória do dia', this.camadaSequencia);

    return container;
  }

  ngAfterViewInit(): void {
    this.mapa = L.map(this.mapaEl.nativeElement, {
      center: [-24.5, -51.8],
      zoom: 7,
      scrollWheelZoom: true,
      fadeAnimation: false,
    });

    const ruas = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 18,
    }).addTo(this.mapa);

    // Esri World Imagery — satélite sem precisar de chave de API (diferente
    // do Google Maps). "Satélite c/ rótulos" soma essa camada com os rótulos
    // de referência (estradas/cidades) que a Esri publica separadamente.
    const urlSatelite = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const urlRotulosSatelite =
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

    const satelite = L.tileLayer(urlSatelite, { attribution: 'Tiles © Esri', maxZoom: 19 });

    // Instâncias próprias (não reaproveita "satelite") — cada opção do
    // controle de camadas precisa da sua própria instância de tile, senão
    // trocar entre "Satélite" e "Satélite c/ rótulos" mexe na mesma camada
    // por baixo dos panos.
    const sateliteComRotulos = L.layerGroup([
      L.tileLayer(urlSatelite, { attribution: 'Tiles © Esri', maxZoom: 19 }),
      L.tileLayer(urlRotulosSatelite, { attribution: 'Tiles © Esri', maxZoom: 19 }),
    ]);

    const topografico = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenTopoMap',
      maxZoom: 17,
    });

    // topleft: o painel de detalhe do colaborador (app-colaborador-detalhe)
    // cobre o lado direito da tela quando aberto — no canto padrão
    // (topright) o controle ficaria escondido atrás dele.
    L.control
      .layers(
        {
          Ruas: ruas,
          Satélite: satelite,
          'Satélite c/ rótulos': sateliteComRotulos,
          Topográfico: topografico,
        },
        {},
        { position: 'topleft' },
      )
      .addTo(this.mapa);

    // Painel "Camadas" logo abaixo do controle de tipos de mapa (mesmo
    // canto topleft — Leaflet empilha controles do mesmo canto na ordem em
    // que são adicionados). Mesmo comportamento visual do controle nativo
    // (ícone recolhido, expande no hover): construído com as MESMAS classes
    // CSS do leaflet.css (leaflet-control-layers*), não uma reimplementação
    // — herda o ícone, sombra, borda arredondada etc. de graça.
    this.criarControleCamadas(this.mapa);

    // Os effects de toggle (constructor) já rodaram antes do mapa existir —
    // reaplica o estado inicial de cada grupo agora que this.mapa está pronto
    // (mesmo motivo do aplicarZoomRegional explícito logo abaixo).
    this.alternarGrupo(this.grupoPontos, this.camadaPontos());
    this.alternarGrupo(this.grupoSequencia, this.camadaSequencia());
    this.alternarGrupo(this.grupoAgentes, this.camadaAgentes());
    this.alternarGrupo(this.grupoSetorPlanejado, this.camadaSetorPlanejado());
    this.alternarGrupo(this.grupoLimitesMunicipais, this.camadaLimitesMunicipais());
    // Sempre no mapa — não é uma camada do painel, não tem toggle.
    this.grupoAgenteAtual.addTo(this.mapa);

    this.atualizarMarcadoresColaboradores();
    this.aplicarZoomRegional(this.colaboradoresService.filtroRegional());

    this.resizeObserver = new ResizeObserver(() => this.mapa?.invalidateSize());
    this.resizeObserver.observe(this.mapaEl.nativeElement);

    setTimeout(() => this.mapa?.invalidateSize(), 0);
  }

  private aplicarZoomRegional(regionalFiltro: string): void {
    if (!this.mapa) return;

    if (!regionalFiltro) {
      this.mapa.flyTo(CENTRO_PADRAO, ZOOM_PADRAO, { duration: 0.8 });
      return;
    }

    const base = BASES_REGIONAIS.find(b => normalizarParaComparacao(b.regional) === normalizarParaComparacao(regionalFiltro));
    if (base) {
      this.mapa.flyTo([base.lat, base.lng], ZOOM_REGIONAL, { duration: 0.8 });
    }
  }

  // Um marcador por colaborador com posição conhecida (última UC realizada,
  // qualquer dia) — sem filtro de regional (os círculos que faziam essa
  // seleção foram removidos). Sempre limpa tudo primeiro: mais simples que
  // diffar, e o volume (algumas centenas no máximo) não justifica a
  // complexidade de atualizar em cima da instância existente.
  //
  // Exige atividade NO DIA FILTRADO (atividadeDe, mesmo gate que a lista da
  // esquerda usa pra decidir "Nenhuma atividade registrada hoje") — a
  // posição em si (`localizacoes()`) vem sempre da última UC realizada
  // alguma vez, sem filtro de data (ver obterUltimaUcRealizadaPorColaborador
  // no backend); sem esse gate, um colaborador sem serviço no dia
  // selecionado aparecia no mapa com a rota/posição de um dia qualquer
  // anterior — usuário reportou com print: card da esquerda mostrando "sem
  // atividade hoje" e o mesmo colaborador com rota desenhada no mapa.
  private atualizarMarcadoresColaboradores(): void {
    if (!this.mapa) return;

    for (const marcador of this.marcadoresColaboradores.values()) {
      this.grupoAgentes.removeLayer(marcador);
      this.grupoAgenteAtual.removeLayer(marcador);
    }
    this.marcadoresColaboradores.clear();

    const porNome = new Map(this.colaboradoresService.colaboradores().map(c => [c.colaborador, c]));

    for (const loc of this.colaboradoresService.localizacoes()) {
      const colaborador = porNome.get(loc.colaborador);
      if (!colaborador) continue;
      if (!this.colaboradoresService.atividadeDe(loc.colaborador)) continue;

      const lat = Number(loc.latitude);
      const lng = Number(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const ehMoto = colaborador.cargo === 'LEITURISTA MOTOCICLISTA' || colaborador.cargo === 'MONITOR';
      // Rebuild recria do zero a cada refresh — se este for o colaborador da
      // rota aberta, nasce direto no grupo sempre-visível, senão nomeAgenteEmDestaque
      // ficaria "certo" no campo mas o marcador voltaria pro grupo com toggle
      // até o próximo clique trocar a seleção (ver atualizarAgenteEmDestaque).
      const grupoAlvo = loc.colaborador === this.nomeAgenteEmDestaque ? this.grupoAgenteAtual : this.grupoAgentes;
      const marcador = L.marker([lat, lng], { icon: ehMoto ? ICONE_MOTO : ICONE_PEDESTRE })
        .addTo(grupoAlvo)
        .bindTooltip(`${colaborador.colaborador} - última leitura em ${loc.data_import} ${loc.hora_import}`, {
          direction: 'top',
          // Ícone ancorado no centro (silhueta sem pino) — offset sobe até
          // acima do topo do ícone.
          offset: [0, -16],
        });

      // Abre a timeline do DIA inteiro do colaborador (não mais um livro
      // específico) — mesma reação de clicar nele direto na lista, pedido
      // explícito do usuário.
      marcador.on('click', () => {
        this.colaboradoresService.abrirColaborador(colaborador.colaborador);
      });

      this.marcadoresColaboradores.set(loc.colaborador, marcador);
    }
  }

  // Trajetória do dia do colaborador aberto no painel: um marcador por UC +
  // um segmento de linha entre cada par de pontos
  // cronologicamente consecutivos, colorido pela razão da transição (pausa/
  // mudou de livro/mudou de município/normal — ver corDoSegmento). Só
  // aplica fitBounds na primeira vez que desenha a jornada de um
  // colaborador — nos refreshes automáticos seguintes do mesmo dia (a cada
  // 60s), só atualiza pontos/linhas, sem mexer no zoom/pan que o usuário já
  // ajustou manualmente.
  private atualizarRotaJornada(colaboradorAberto: string | null, pontos: PontoJornada[]): void {
    if (!this.mapa) return;

    if (!colaboradorAberto) {
      for (const linha of this.segmentosRota) this.grupoSequencia.removeLayer(linha);
      this.segmentosRota = [];
      for (const ponto of this.pontosJornada.values()) this.grupoPontos.removeLayer(ponto);
      this.pontosJornada.clear();
      for (const poligono of this.poligonosSetorPlanejado.values()) this.grupoSetorPlanejado.removeLayer(poligono);
      this.poligonosSetorPlanejado.clear();
      this.colaboradorComBoundsAplicado = null;
      return;
    }

    const validos = pontos.filter(item => item.latitude && item.longitude);
    const latLngs: L.LatLngTuple[] = validos.map(item => [Number(item.latitude), Number(item.longitude)]);

    // Segmentos: recriados inteiros a cada ciclo (não atualizados em cima da
    // instância) — diferente dos pontos (que precisam preservar o listener),
    // o número de segmentos é pequeno e cada um pode mudar de cor entre
    // refreshes (ex.: um ponto que virou "pausa" porque o próximo lote ainda
    // não chegou).
    for (const linha of this.segmentosRota) this.grupoSequencia.removeLayer(linha);
    this.segmentosRota = [];
    for (let i = 1; i < validos.length; i++) {
      const anterior = validos[i - 1];
      const atual = validos[i];
      const pontosSegmento: L.LatLngTuple[] = [
        [Number(anterior.latitude), Number(anterior.longitude)],
        [Number(atual.latitude), Number(atual.longitude)],
      ];
      const linha = L.polyline(pontosSegmento, { color: corDoSegmento(atual), weight: 3, opacity: 0.8 }).addTo(
        this.grupoSequencia,
      );
      // Clicar na linha centraliza o mapa na região onde a transição
      // aconteceu — os dois pontos do segmento podem estar bem distantes um
      // do outro (mudança de livro/pausa longa costuma ser exatamente
      // isso), então usa fitBounds nos dois em vez de flyTo num ponto só.
      linha.on('click', () => {
        if (!this.mapa) return;
        this.mapa.fitBounds(L.latLngBounds(pontosSegmento), { padding: [60, 60], maxZoom: ZOOM_FOCO });
      });
      this.segmentosRota.push(linha);
    }

    // Setor planejado: um casco convexo POR LIVRO (não mais um só pro dia
    // inteiro) — se o colaborador tem mais de um livro em execução hoje,
    // cada um aparece com o seu próprio polígono. Mesmo filtro
    // Number.isFinite de pontosValidosDoDia, mas aplicado dentro de cada
    // grupo de livro separadamente (ver comentário de cascoConvexo).
    const pontosPorLivro = new Map<string, PontoJornada[]>();
    for (const item of pontos) {
      const lista = pontosPorLivro.get(item.livro);
      if (lista) lista.push(item);
      else pontosPorLivro.set(item.livro, [item]);
    }
    const livrosVistos = new Set<string>();
    for (const [livro, pontosDoLivro] of pontosPorLivro) {
      const hull = cascoConvexo(this.pontosValidosDoDia(pontosDoLivro));
      if (hull.length < 3) continue;
      livrosVistos.add(livro);
      const existente = this.poligonosSetorPlanejado.get(livro);
      if (existente) {
        existente.setLatLngs(hull);
      } else {
        const poligono = L.polygon(hull, { color: '#8b5cf6', weight: 2, fillOpacity: 0.08 }).addTo(
          this.grupoSetorPlanejado,
        );
        poligono.bindTooltip(`Setor planejado — Livro ${livro}`);
        this.poligonosSetorPlanejado.set(livro, poligono);
      }
    }
    for (const [livro, poligono] of this.poligonosSetorPlanejado) {
      if (!livrosVistos.has(livro)) {
        this.grupoSetorPlanejado.removeLayer(poligono);
        this.poligonosSetorPlanejado.delete(livro);
      }
    }

    if (latLngs.length && this.colaboradorComBoundsAplicado !== colaboradorAberto) {
      this.mapa.fitBounds(L.latLngBounds(latLngs), { padding: [40, 40] });
      this.colaboradorComBoundsAplicado = colaboradorAberto;
    }

    // Pontos: atualiza em cima da instância existente por UC (posição/cor/
    // ícone), cria só as novas, remove as que já não aparecem mais.
    const regimeSucessivoPorUc = this.colaboradoresService.regimeSucessivoPorUc();
    const vistos = new Set<string>();

    for (const item of validos) {
      vistos.add(item.uc);
      const latLng: L.LatLngTuple = [Number(item.latitude), Number(item.longitude)];
      const existente = this.pontosJornada.get(item.uc);
      const ehPausa = item.tipo_intervalo === 'pausa';

      if (existente) {
        existente.setLatLng(latLng);
        if (existente instanceof L.CircleMarker && !ehPausa) {
          existente.setStyle({ fillColor: CORES_PONTO[corDaUc(item, regimeSucessivoPorUc)] });
          existente.setTooltipContent(tooltipDoPonto(item));
        } else if (!(existente instanceof L.CircleMarker) && ehPausa) {
          existente.setTooltipContent(tooltipDoPonto(item));
        } else {
          // Trocou de tipo (virou pausa, ou deixou de ser) — CircleMarker e
          // Marker não convertem um no outro, recria o marcador desse ponto.
          this.grupoPontos.removeLayer(existente);
          this.pontosJornada.delete(item.uc);
        }
      }

      if (!this.pontosJornada.has(item.uc)) {
        const ponto: L.CircleMarker | L.Marker = ehPausa
          ? L.marker(latLng, { icon: ICONE_PAUSA })
          : L.circleMarker(latLng, {
              radius: 5,
              color: '#fff',
              weight: 1,
              fillColor: CORES_PONTO[corDaUc(item, regimeSucessivoPorUc)],
              fillOpacity: 0.95,
            });
        ponto.addTo(this.grupoPontos).bindTooltip(tooltipDoPonto(item), { direction: 'top', offset: [0, -6] });
        // Clicar no ponto foca E expande a UC na timeline do painel (item 3
        // do pedido) — os dois juntos, sem precisar de um segundo clique na
        // lista. O marcador é reaproveitado entre refreshes (nunca recriado
        // a não ser na troca de tipo acima), então o listener não pode
        // fechar sobre `item.codigo` direto — a UC pode ter sido pendente
        // quando o marcador foi criado e virado realizada depois só com
        // `setStyle`. Busca o estado ATUAL da UC na jornada no momento do clique.
        const uc = item.uc;
        const nome = colaboradorAberto;
        ponto.on('click', () => {
          this.colaboradoresService.ucFocada.set(uc);
          this.colaboradoresService.ucExpandida.set(uc);
          const atual = this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos?.find(p => p.uc === uc);
          if (ehCodigoDeImpedimento(atual?.codigo ?? null)) {
            this.colaboradoresService.carregarRegimeSucessivo(uc);
          }
        });
        this.pontosJornada.set(item.uc, ponto);
      }
    }
    for (const [uc, ponto] of this.pontosJornada) {
      if (!vistos.has(uc)) {
        this.grupoPontos.removeLayer(ponto);
        this.pontosJornada.delete(uc);
      }
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.mapa?.remove();
  }
}
