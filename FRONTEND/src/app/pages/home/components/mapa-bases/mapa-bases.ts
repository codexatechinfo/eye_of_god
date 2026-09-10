import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as L from 'leaflet';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  MunicipioLimite,
  PontoGpsHistorico,
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

// Posição via Scalefusion (ADR 0033) só conta como "tempo real" com menos
// que isso de idade — sem esse corte, um aparelho que parou de reportar há
// dias ficaria marcado como tempo real pra sempre (mesma preocupação já
// registrada na especificação da API sobre "idade da última posição").
const LIMITE_POSICAO_REAL_MS = 24 * 60 * 60 * 1000;

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

// 310286.svg — viewBox e transform idênticos ao arquivo original, só o fill
// do <g> trocado de #000000 pra vermelho. Primeira tentativa (#ef4444,
// CORES_TRECHO.vermelho) usuário achou "ainda alaranjado" comparando com um
// pino de referência (círculo vermelho com "+") — trocado pra #dc2626, mais
// saturado/puro, sem a mistura quente do red-500.
const ICONE_PEDESTRE = iconeColaborador(
  `<g transform="translate(0,1280) scale(0.1,-0.1)" fill="#dc2626" stroke="none">
<path d="M3955 12793 c-151 -19 -271 -55 -407 -125 -389 -198 -628 -589 -629
-1028 0 -146 14 -238 57 -368 183 -559 756 -893 1334 -776 540 110 930 587
930 1139 0 371 -171 710 -470 934 -149 111 -334 188 -517 216 -90 14 -225 17
-298 8z"/>
<path d="M920 10933 c0 -4 -743 -2966 -859 -3423 -33 -129 -57 -238 -53 -241
10 -10 1733 -441 1739 -436 7 7 924 3659 920 3663 -6 6 -1747 442 -1747 437z"/>
<path d="M3718 10319 c-529 -56 -969 -456 -1063 -969 -20 -109 -204 -852 -650
-2630 -174 -690 -464 -1847 -646 -2570 -182 -723 -430 -1709 -552 -2190 l-221
-875 -1 -155 c0 -172 8 -217 62 -350 91 -223 273 -404 493 -493 135 -54 180
-62 345 -62 125 0 163 4 230 23 341 97 586 362 656 710 21 102 874 3514 887
3544 4 11 184 -683 467 -1805 253 -1002 471 -1851 486 -1887 64 -159 129 -259
231 -356 111 -106 248 -183 405 -226 113 -31 324 -31 443 0 306 80 551 318
646 627 26 83 28 103 28 255 l0 165 -42 125 c-23 69 -97 341 -163 605 -66 264
-140 557 -164 650 -24 94 -125 494 -225 890 -100 396 -223 887 -275 1090 -52
204 -155 613 -230 910 -75 297 -193 762 -261 1034 -69 271 -124 495 -122 496
2 2 174 -39 383 -91 1618 -401 1537 -383 1675 -364 160 22 267 75 382 191 198
199 243 483 117 739 -33 67 -60 102 -123 165 -113 112 -236 172 -391 189 -33
4 -308 68 -611 143 l-551 136 -151 576 c-108 410 -154 605 -162 677 -45 418
-297 779 -675 967 -134 66 -262 102 -420 117 -121 11 -126 11 -237 -1z"/>
</g>`,
  '0 0 711 1280',
  18,
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

// Último ponto de execução do colaborador aberto (1295315.svg, mesmo padrão
// de fidelidade exata dos Adendos 7/9 de ADR 0030) — passo inicial pra os
// ícones de colaborador no mapa passarem a representar a localização REAL
// dele (próxima etapa do projeto), começando pelo ponto mais recente da
// jornada do dia. Cor DINÂMICA (não fixa como moto/pedestre): usa a mesma
// cor do ponto na timeline (corDaUc — verde/cinza/laranja/vermelho, ver
// CORES_PONTO), então precisa construir o ícone sob demanda em vez de uma
// constante única — cacheado por cor (só 4 cores possíveis) pra não recriar
// o mesmo L.divIcon a cada refresh de 60s.
const ICONES_ULTIMO_PONTO = new Map<string, L.DivIcon>();
function iconeUltimoPonto(cor: string): L.DivIcon {
  let icone = ICONES_ULTIMO_PONTO.get(cor);
  if (!icone) {
    icone = iconeColaborador(
      `<g transform="translate(0,1240) scale(0.1,-0.1)" fill="${cor}" stroke="none">
<path d="M2391 10315 c-171 -55 -286 -249 -251 -421 34 -162 146 -272 313
-305 151 -31 320 59 393 207 26 53 29 69 29 159 0 93 -2 105 -32 166 -39 79
-102 140 -181 177 -69 32 -199 41 -271 17z"/>
<path d="M2425 9544 c-64 -33 -102 -88 -141 -204 -18 -53 -19 -175 -22 -3662
l-2 -3608 97 0 c54 0 162 -3 241 -7 l142 -6 1 1009 c1 901 9 1434 19 1204 4
-110 5 -118 29 -203 32 -117 70 -160 107 -123 8 9 19 16 23 16 4 0 29 21 55
46 103 98 244 185 382 234 81 28 245 70 419 106 11 2 34 7 50 11 17 4 32 7 35
8 3 1 25 5 50 9 70 13 397 90 595 141 99 25 190 48 201 50 12 3 51 14 85 24
56 17 101 29 134 36 23 6 133 38 170 50 45 14 155 47 170 51 87 20 753 249
895 308 36 15 72 29 80 31 14 3 211 82 423 169 97 39 278 118 372 162 33 15
63 28 66 28 13 2 496 230 764 361 205 101 649 330 825 427 36 19 121 66 190
103 659 359 886 499 1015 630 120 122 101 171 -81 208 -12 2 -30 0 -40 -6 -13
-6 -16 -6 -9 0 6 6 208 131 450 278 242 147 446 273 454 280 10 10 11 20 2 47
l-11 34 -198 -23 c-419 -48 -897 -87 -1427 -115 -302 -16 -1345 -16 -1635 0
-1252 68 -2218 228 -3044 503 -666 222 -1164 496 -1535 845 l-81 76 0 92 c0
174 -57 320 -145 371 -49 29 -124 33 -170 9z"/>
</g>`,
      '0 0 1280 1240',
      30,
      29,
    );
    ICONES_ULTIMO_PONTO.set(cor, icone);
  }
  return icone;
}

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

// Mesmo critério de corDoSegmento — usado pra decidir se o segmento vai pra
// grupoSequencia (normal, cinza) ou grupoParadasGaps (pausa/mudou de
// livro/mudou de município), pra que o checkbox "Paradas e gaps" consiga
// esconder só esses indicadores especiais sem afetar a linha de trajeto normal.
function ehSegmentoEspecial(item: PontoJornada): boolean {
  return item.tipo_intervalo === 'pausa' || !!item.mudou_livro || !!item.mudou_municipio;
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
  imports: [CommonModule],
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
  // corDoSegmento) + um marcador por UC (CircleMarker colorido normal, ícone
  // de pausa quando o intervalo anterior excedeu o limite, ou o ícone de
  // "último ponto" — iconeUltimoPonto — só no ponto mais recente do dia).
  // Tudo atualizado em cima da instância existente (nunca recriado do zero)
  // porque a jornada é atualizada a cada 60s enquanto o painel está aberto —
  // recriar a cada ciclo causaria flicker. `tipo` guardado junto pra
  // detectar troca de tipo entre refreshes (ex.: deixou de ser o último
  // ponto porque uma UC mais nova chegou) — CircleMarker/Marker sozinhos não
  // bastam pra distinguir "pausa" de "último ponto", os dois são L.Marker.
  private segmentosRota: L.Polyline[] = [];
  // Segmentos "especiais" (pausa/mudou de livro/mudou de município) — mesma
  // lógica de segmentosRota, mas moram em grupoParadasGaps em vez de
  // grupoSequencia (ver ehSegmentoEspecial).
  private segmentosParadasGaps: L.Polyline[] = [];
  private pontosJornada = new Map<string, { marcador: L.CircleMarker | L.Marker; tipo: 'normal' | 'pausa' | 'ultimo' }>();
  private colaboradorComBoundsAplicado: string | null = null;
  // Um polígono por LIVRO (não mais um casco convexo do dia inteiro) — se o
  // colaborador tem mais de um livro em execução hoje, cada um ganha o seu
  // próprio "setor planejado" (pedido explícito do usuário). Chave = livro.
  private poligonosSetorPlanejado = new Map<string, L.Polygon>();
  // Última chave (colaborador+data) pra qual "Limites municipais" já buscou
  // dado — evita rebuscar a cada refresh de 60s do mesmo colaborador/dia
  // (ver effect no construtor).
  private limitesMunicipaisChaveAtual: string | null = null;
  // Anel piscando sobre o ponto centralizado (botão "Centralizar no mapa" do
  // card de detalhe, pedido explícito do usuário — "assim eu consigo
  // identificar melhor"). Marcador temporário próprio em vez de mexer no
  // estilo do marcador real (pontosJornada) — funciona igual pra
  // CircleMarker e pra L.Marker (ícone de pausa), sem precisar saber qual é.
  private anelPiscando?: { anel: L.CircleMarker; intervalo: ReturnType<typeof setInterval>; timeoutFinal: ReturnType<typeof setTimeout> };

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
  private grupoRastroGps = L.layerGroup(); // camada 1: rastro GPS real do dia
  // "Paradas e gaps" — pausas (ícone de pausa no lugar da bolinha normal) e
  // transições de livro/município (segmento fúcsia/teal em vez do cinza
  // normal) moram AQUI, não mais dentro de grupoPontos/grupoSequencia.
  // Usuário reportou: desmarcar "Trajetória do dia" também sumia com esses
  // indicadores especiais, sem jeito de controlar só eles — o checkbox
  // "Paradas e gaps" já existia no painel (desabilitado, funcionalidade
  // futura) exatamente pra isso.
  private grupoParadasGaps = L.layerGroup(); // camada 3: pausas e transições

  // Ligadas por padrão (preserva o comportamento atual, sempre visível até
  // hoje); as camadas opt-in nascem desligadas (ninguém pediu que
  // aparecessem por padrão, e tanto "Limites municipais" quanto "Rastro
  // executado" custam uma busca extra — polígonos IBGE e histórico de GPS,
  // respectivamente).
  camadaPontos = signal(true);
  camadaSequencia = signal(true);
  camadaAgentes = signal(true);
  camadaSetorPlanejado = signal(false);
  camadaLimitesMunicipais = signal(false);
  camadaRastroGps = signal(false);
  camadaParadasGaps = signal(true);
  // Última chave (colaborador+data+fonte) pra qual "Rastro executado" já
  // buscou — mesmo raciocínio de limitesMunicipaisChaveAtual, evita
  // rebuscar a cada refresh de 60s do mesmo colaborador/dia.
  private rastroGpsChaveAtual: string | null = null;
  private polilinhaRastroGps: L.Polyline | null = null;

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
      this.piscarPonto(alvo.lat, alvo.lng);
    });

    // Painel "CAMADAS": cada effect só decide se o GRUPO está no mapa — a
    // criação/atualização do conteúdo do grupo roda em outro lugar, sempre
    // (ver comentário dos campos grupoX acima).
    effect(() => this.alternarGrupo(this.grupoPontos, this.camadaPontos()));
    effect(() => this.alternarGrupo(this.grupoSequencia, this.camadaSequencia()));
    effect(() => this.alternarGrupo(this.grupoAgentes, this.camadaAgentes()));
    effect(() => this.alternarGrupo(this.grupoSetorPlanejado, this.camadaSetorPlanejado()));
    effect(() => this.alternarGrupo(this.grupoParadasGaps, this.camadaParadasGaps()));
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

    // "Rastro executado" — trajeto GPS REAL do dia (Scalefusion pro
    // pedestre, SEGSAT pro motoqueiro), diferente de "Trajetória do dia"
    // (que conecta só os pontos de UC lida — inferido da execução, não GPS
    // contínuo). Usuário pediu as duas camadas independentes, pra marcar e
    // desmarcar cada uma. Mesmo padrão de "Limites municipais" acima: busca
    // opt-in (só com a camada ligada), por colaborador+data+fonte
    // (rastroGpsChaveAtual evita rebuscar a cada refresh de 60s).
    effect(() => {
      const ligado = this.camadaRastroGps();
      this.alternarGrupo(this.grupoRastroGps, ligado);
      if (!ligado) return;

      const nome = this.colaboradoresService.colaboradorSelecionado();
      if (!nome) {
        this.rastroGpsChaveAtual = null;
        this.grupoRastroGps.clearLayers();
        this.polilinhaRastroGps = null;
        return;
      }
      // Mesma regra ehMoto de atualizarMarcadoresColaboradores/verNoMapa —
      // decide qual fonte de GPS pedir (a moto rastreia via SEGSAT, o
      // celular via Scalefusion).
      const colaborador = this.colaboradoresService.colaboradores().find(c => c.colaborador === nome);
      const ehMoto = colaborador?.cargo === 'LEITURISTA MOTOCICLISTA' || colaborador?.cargo === 'MONITOR';
      const fonte = ehMoto ? 'segsat' : 'scalefusion';
      const chave = `${nome}|${this.colaboradoresService.filtroData()}|${fonte}`;
      if (chave === this.rastroGpsChaveAtual) return;

      this.rastroGpsChaveAtual = chave;
      this.colaboradoresService.carregarGpsHistorico(nome, fonte);
    });
    // Redesenha (substitui, não acumula) sempre que o resultado da busca
    // acima chegar, ou o refresh de 60s trouxer pontos novos pro mesmo
    // colaborador/dia.
    effect(() => {
      const nome = this.colaboradoresService.colaboradorSelecionado();
      if (!nome) return;
      const pontos = this.colaboradoresService.gpsHistoricoPorColaborador().get(nome);
      if (pontos === undefined) return;
      const fonte = this.colaboradoresService.gpsHistoricoFontePorColaborador().get(nome) ?? null;
      this.renderizarRastroGps(pontos, fonte);
    });
  }

  // Usado tanto pelo casco convexo ("Setor planejado") quanto pela busca de
  // limites municipais. Filtro truthy ANTES do Number() é obrigatório, não
  // cosmético: usuário reportou o polígono de "Setor planejado" esticando
  // até o oceano, saindo do Paraná até o Espírito Santo — causa era UC sem
  // coordenada minerada (LEFT JOIN em coordenadas_ucs_mineradas, ver
  // obterJornadaColaborador), que chega aqui como `latitude`/`longitude`
  // `null`. `Number(null)` é `0` (finito!), não `NaN` — sem o filtro
  // truthy, esse ponto fantasma em (lat_real, 0) ou (0, lng_real) entrava
  // no casco convexo e esticava o polígono até a longitude/latitude 0, bem
  // longe do Paraná. `Number.isFinite` sozinho nunca pegava isso (só
  // protege contra `Number(undefined)` = `NaN`, não contra `null` = `0`).
  private pontosValidosDoDia(pontos: PontoJornada[]): L.LatLngTuple[] {
    return pontos
      .filter(item => item.latitude && item.longitude)
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

  // Rastro GPS real do dia. Primeira versão usava linha tracejada fina
  // (dashArray '2 6', opacity 0.55) pra ficar discreta — usuário reportou
  // "não estou vendo nada" depois de ligar a camada. Causa: pontos de GPS
  // consecutivos costumam estar bem próximos um do outro (segmento curto),
  // e um dashArray precisa de comprimento de traço suficiente pra sequer
  // desenhar um tracinho — testado ao vivo com uma trilha real (Leaflet,
  // sem tile de mapa, só pra isolar a linha): o tracejado fica cheio de
  // buracos, quase invisível; a mesma trilha em linha SÓLIDA fica nítida.
  // Trocado pra sólida, mais escura e mais grossa — ainda mais discreta que
  // "Trajetória do dia" (weight 3, cores vivas por tipo de transição, ver
  // atualizarRotaJornada), mas agora realmente visível.
  private renderizarRastroGps(pontos: PontoGpsHistorico[], fonte: 'segsat' | 'scalefusion' | null): void {
    this.grupoRastroGps.clearLayers();
    this.polilinhaRastroGps = null;
    // Ordena por horário antes de desenhar — a API SEGSAT não documenta
    // garantia de ordem cronológica na resposta (achado ao investigar
    // searchUnitPositionHistory, ver ADR 0034 Adendo 3), e sem essa garantia
    // um ponto fora de ordem vira um segmento absurdo cruzando o mapa
    // inteiro em vez de seguir o trajeto real.
    const validos = pontos
      .filter(p => p.latitude && p.longitude)
      .slice()
      .sort((a, b) => new Date(a.data_hora_posicao).getTime() - new Date(b.data_hora_posicao).getTime());
    if (validos.length < 2) return;
    const latLngs: L.LatLngTuple[] = validos.map(p => [Number(p.latitude), Number(p.longitude)]);
    // Preto/quase-preto — cor deliberadamente FORA da paleta já usada por
    // qualquer outra camada (verde/azul dos pontos, âmbar/magenta/teal dos
    // segmentos de pausa/transição, roxo do setor planejado). O pane
    // dedicado (garante desenhar por cima) já resolveu o "não aparece";
    // usuário confirmou visível e pediu tracejado e mais discreto — peso e
    // opacidade reduzidos, `dashArray` com traços longos (não os '2 6'
    // curtos testados antes, que somem em segmentos curtos entre pontos
    // próximos — ver Adendo 4 da ADR 0034).
    this.polilinhaRastroGps = L.polyline(latLngs, {
      pane: 'paneRastroGps',
      color: '#0f172a',
      weight: 2.5,
      opacity: 0.65,
      dashArray: '8 6',
    })
      // Backend pode devolver Scalefusion mesmo pra quem pediu SEGSAT
      // (fallback pra motoqueiro sem veículo mapeado, ver gpsHistorico em
      // colaboradoresController.js) — tooltip indica a fonte real, pra não
      // sugerir precisão de rastreador veicular num trajeto que na verdade
      // veio do celular do colaborador.
      .bindTooltip(
        fonte === 'scalefusion'
          ? 'Rastro GPS real do dia (celular — sem veículo mapeado na SEGSAT)'
          : 'Rastro GPS real do dia',
      )
      .addTo(this.grupoRastroGps);
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

    itemAtivo('Rastro GPS', this.camadaRastroGps);
    itemAtivo('Pontos coletados', this.camadaPontos);
    itemAtivo('Paradas e gaps', this.camadaParadasGaps);
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

    // Pane dedicado, acima do overlayPane padrão (zIndex 400) onde vivem
    // "Pontos coletados"/"Paradas e gaps"/"Setor planejado"/"Trajetória do
    // dia" — sem isso, o rastro fica sujeito à ordem em que cada grupo foi
    // ligado (não a ordem visual desejada) e um dia com muitas UCs numa
    // área pequena (grade densa de pontos) cobre a linha por completo.
    // Usuário reportou "continua sem exibir" mesmo com dado real confirmado
    // no banco — o pane garante que o rastro sempre desenha por cima,
    // independente da ordem das outras camadas.
    this.mapa.createPane('paneRastroGps');
    this.mapa.getPane('paneRastroGps')!.style.zIndex = '450';

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
    this.alternarGrupo(this.grupoRastroGps, this.camadaRastroGps());
    this.alternarGrupo(this.grupoParadasGaps, this.camadaParadasGaps());
    // Sempre no mapa — não é uma camada do painel, não tem toggle.
    this.grupoAgenteAtual.addTo(this.mapa);

    this.atualizarMarcadoresColaboradores();
    this.aplicarZoomRegional(this.colaboradoresService.filtroRegional());

    this.resizeObserver = new ResizeObserver(() => this.mapa?.invalidateSize());
    this.resizeObserver.observe(this.mapaEl.nativeElement);

    setTimeout(() => this.mapa?.invalidateSize(), 0);
  }

  // Anel azul piscando por ~2,4s (4 piscadas) sobre a coordenada centralizada
  // — não depende de achar o marcador real (funciona mesmo se o ponto ainda
  // não estiver desenhado na camada certa), então cobre igual pontos de
  // jornada, agentes ou qualquer outra coisa que um dia chame centralizarEm.
  // Cor azul (não usada em nenhuma cor de ponto/segmento existente) pra não
  // se confundir com verde/âmbar/vermelho do próprio ponto.
  private piscarPonto(lat: number, lng: number): void {
    if (!this.mapa) return;
    if (this.anelPiscando) {
      clearInterval(this.anelPiscando.intervalo);
      clearTimeout(this.anelPiscando.timeoutFinal);
      this.mapa.removeLayer(this.anelPiscando.anel);
    }

    const anel = L.circleMarker([lat, lng], {
      radius: 12,
      color: '#2563eb',
      weight: 3,
      fill: false,
      opacity: 1,
    }).addTo(this.mapa);

    let visivel = true;
    const intervalo = setInterval(() => {
      visivel = !visivel;
      anel.setStyle({ opacity: visivel ? 1 : 0 });
    }, 300);
    const timeoutFinal = setTimeout(() => {
      clearInterval(intervalo);
      this.mapa?.removeLayer(anel);
      this.anelPiscando = undefined;
    }, 2400);

    this.anelPiscando = { anel, intervalo, timeoutFinal };
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

  // Um marcador por colaborador com posição conhecida — tempo real
  // (Scalefusion pro pedestre, SEGSAT pro motoqueiro) quando existe e está
  // fresca, senão última UC realizada — sem filtro de regional (os círculos
  // que faziam essa seleção foram removidos). Sempre limpa tudo primeiro:
  // mais simples que diffar, e o volume (algumas centenas no máximo) não
  // justifica a complexidade de atualizar em cima da instância existente.
  //
  // O gate de "atividade hoje" (atividadeDe) só vale pro caminho de posição
  // por LEITURA — posição real prova sozinha que o colaborador está em
  // campo agora, não precisa desse gate (ver dentro da função pra detalhe de
  // cada caminho).
  private atualizarMarcadoresColaboradores(): void {
    if (!this.mapa) return;

    for (const marcador of this.marcadoresColaboradores.values()) {
      this.grupoAgentes.removeLayer(marcador);
      this.grupoAgenteAtual.removeLayer(marcador);
    }
    this.marcadoresColaboradores.clear();

    const porNome = new Map(this.colaboradoresService.colaboradores().map(c => [c.colaborador, c]));
    const localizacaoPorNome = new Map(this.colaboradoresService.localizacoes().map(l => [l.colaborador, l]));
    const scalefusionPorNome = this.colaboradoresService.scalefusionPorColaborador();
    const segsatPorNome = this.colaboradoresService.segsatPorColaborador();
    // União das três fontes — um colaborador pode ter posição real sem nunca
    // ter uma UC realizada ainda (contratado recente), e vice-versa (sem
    // correspondência no Scalefusion/SEGSAT ainda, ver ADR 0033/0034).
    const nomesVistos = new Set([...localizacaoPorNome.keys(), ...scalefusionPorNome.keys(), ...segsatPorNome.keys()]);

    for (const nome of nomesVistos) {
      const colaborador = porNome.get(nome);
      if (!colaborador) continue;

      const ehMoto = colaborador.cargo === 'LEITURISTA MOTOCICLISTA' || colaborador.cargo === 'MONITOR';
      // Posição REAL: Scalefusion (celular) pro pedestre, SEGSAT (a própria
      // moto) pro motoqueiro — ADR 0033/0034. "Válida" exige menos de 24h de
      // idade nos dois casos — sem esse corte, um aparelho parado de
      // reportar há dias ficaria marcado como "tempo real" pra sempre (mesma
      // preocupação já registrada na especificação da API).
      const posicaoReal = ehMoto ? segsatPorNome.get(nome) : scalefusionPorNome.get(nome);
      const idadePosicaoReal = posicaoReal?.data_hora_posicao ? Date.now() - new Date(posicaoReal.data_hora_posicao).getTime() : null;
      const posicaoRealValida =
        !!posicaoReal?.latitude && !!posicaoReal?.longitude && idadePosicaoReal !== null && idadePosicaoReal < LIMITE_POSICAO_REAL_MS;

      let lat: number;
      let lng: number;
      let tooltip: string;
      if (posicaoRealValida) {
        // Posição real NÃO passa pelo gate de "atividade hoje" — o próprio
        // GPS fresco (< 24h) já prova que o colaborador está em campo agora,
        // independente de ele já ter registrado alguma leitura hoje. Bug
        // real reportado pelo usuário: pedestres com posição Scalefusion
        // válida sumiam do mapa só porque ainda não tinham lido nenhuma UC
        // hoje (gate pensado só pra rota por leitura, ver comentário abaixo)
        // — mesma regra vale pro motoqueiro com posição SEGSAT.
        lat = Number(posicaoReal!.latitude);
        lng = Number(posicaoReal!.longitude);
        const hora = new Date(posicaoReal!.data_hora_posicao!).toLocaleTimeString('pt-BR');
        tooltip = `${nome} - localização em tempo real (${hora})`;
      } else {
        // Sem posição real válida: cai pra última UC realizada, que só faz
        // sentido mostrar se o colaborador teve atividade HOJE (mesmo gate
        // que a lista da esquerda usa pra decidir "Nenhuma atividade
        // registrada hoje") — a posição em si (`localizacoes()`) já é
        // escopada por hoje no backend, mas o COLABORADOR aparecer aqui
        // ainda depende de atividadeHoje ter processado ele (ex.: livro sem
        // nenhum ciclo de coleta ainda hoje). Sem esse gate, um colaborador
        // sem serviço hoje reapareceria com a rota de um dia qualquer
        // anterior — usuário já reportou esse bug antes com print.
        if (!this.colaboradoresService.atividadeDe(nome)) continue;
        const loc = localizacaoPorNome.get(nome);
        if (!loc) continue;
        lat = Number(loc.latitude);
        lng = Number(loc.longitude);
        tooltip = `${nome} - última leitura em ${loc.data_import} ${loc.hora_import}`;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      // Rebuild recria do zero a cada refresh — se este for o colaborador da
      // rota aberta, nasce direto no grupo sempre-visível, senão nomeAgenteEmDestaque
      // ficaria "certo" no campo mas o marcador voltaria pro grupo com toggle
      // até o próximo clique trocar a seleção (ver atualizarAgenteEmDestaque).
      const grupoAlvo = nome === this.nomeAgenteEmDestaque ? this.grupoAgenteAtual : this.grupoAgentes;
      const marcador = L.marker([lat, lng], { icon: ehMoto ? ICONE_MOTO : ICONE_PEDESTRE })
        .addTo(grupoAlvo)
        .bindTooltip(tooltip, {
          direction: 'top',
          // Ícone ancorado no centro (silhueta sem pino) — offset sobe até
          // acima do topo do ícone.
          offset: [0, -16],
        });

      // Abre a timeline do DIA inteiro do colaborador (não mais um livro
      // específico) — mesma reação de clicar nele direto na lista, pedido
      // explícito do usuário.
      marcador.on('click', () => {
        this.colaboradoresService.abrirColaborador(nome);
      });

      this.marcadoresColaboradores.set(nome, marcador);
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
  // "Pausa" mora em grupoParadasGaps (some junto com os segmentos especiais
  // quando o checkbox é desmarcado); "normal"/"ultimo" continuam em
  // grupoPontos.
  private grupoDoTipoPonto(tipo: 'normal' | 'pausa' | 'ultimo'): L.LayerGroup {
    return tipo === 'pausa' ? this.grupoParadasGaps : this.grupoPontos;
  }

  private atualizarRotaJornada(colaboradorAberto: string | null, pontos: PontoJornada[]): void {
    if (!this.mapa) return;

    if (!colaboradorAberto) {
      for (const linha of this.segmentosRota) this.grupoSequencia.removeLayer(linha);
      this.segmentosRota = [];
      for (const linha of this.segmentosParadasGaps) this.grupoParadasGaps.removeLayer(linha);
      this.segmentosParadasGaps = [];
      for (const { marcador, tipo } of this.pontosJornada.values()) this.grupoDoTipoPonto(tipo).removeLayer(marcador);
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
    for (const linha of this.segmentosParadasGaps) this.grupoParadasGaps.removeLayer(linha);
    this.segmentosParadasGaps = [];
    for (let i = 1; i < validos.length; i++) {
      const anterior = validos[i - 1];
      const atual = validos[i];
      // Sem código = ainda não realizado (ver corDaUc) — não desenha linha
      // de deslocamento envolvendo um ponto pendente. A ordem deles vem da
      // sequência PLANEJADA da rota, não de quando aconteceram (não
      // aconteceram ainda), então uma linha ali sugeriria um trajeto real
      // que não existe (o backend já não calcula intervalo/velocidade nesse
      // caso — ver mudou_livro/segmento em obterJornadaColaborador).
      if (!anterior.codigo || !atual.codigo) continue;
      const pontosSegmento: L.LatLngTuple[] = [
        [Number(anterior.latitude), Number(anterior.longitude)],
        [Number(atual.latitude), Number(atual.longitude)],
      ];
      // Segmento especial (pausa/mudou de livro/mudou de município) vai pra
      // grupoParadasGaps; segmento normal continua em grupoSequencia — é o
      // que permite o checkbox "Paradas e gaps" esconder só os especiais.
      const especial = ehSegmentoEspecial(atual);
      const grupoDoSegmento = especial ? this.grupoParadasGaps : this.grupoSequencia;
      const linha = L.polyline(pontosSegmento, { color: corDoSegmento(atual), weight: 3, opacity: 0.8 }).addTo(
        grupoDoSegmento,
      );
      // Clicar na linha centraliza o mapa na região onde a transição
      // aconteceu — os dois pontos do segmento podem estar bem distantes um
      // do outro (mudança de livro/pausa longa costuma ser exatamente
      // isso), então usa fitBounds nos dois em vez de flyTo num ponto só.
      linha.on('click', () => {
        if (!this.mapa) return;
        this.mapa.fitBounds(L.latLngBounds(pontosSegmento), { padding: [60, 60], maxZoom: ZOOM_FOCO });
      });
      if (especial) this.segmentosParadasGaps.push(linha);
      else this.segmentosRota.push(linha);
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
    // Último ponto REALIZADO cronologicamente (validos preserva a ordem de
    // `pontos`, que já vem ASC do backend) ganha o ícone de "localização
    // real" — pedido explícito do usuário, primeiro passo pros ícones do
    // mapa passarem a refletir onde o colaborador está agora, não só o
    // histórico. Não pode ser simplesmente o último item do array: `pontos`
    // agora termina com as UCs AINDA NÃO realizadas (ver
    // obterJornadaColaborador), que viriam depois na lista mas não são "onde
    // ele está" — sem código = pendente (ver corDaUc), busca de trás pra
    // frente até achar o último com código.
    const ucUltimoPonto = [...validos].reverse().find(item => item.codigo)?.uc ?? null;

    for (const item of validos) {
      vistos.add(item.uc);
      const latLng: L.LatLngTuple = [Number(item.latitude), Number(item.longitude)];
      const existente = this.pontosJornada.get(item.uc);
      const cor = CORES_PONTO[corDaUc(item, regimeSucessivoPorUc)];
      // Último ponto tem prioridade sobre "pausa" — o usuário quer sempre
      // ver onde o colaborador está agora, mesmo que o intervalo até ali
      // tenha passado do limite.
      const tipo: 'normal' | 'pausa' | 'ultimo' = item.uc === ucUltimoPonto ? 'ultimo' : item.tipo_intervalo === 'pausa' ? 'pausa' : 'normal';

      if (existente) {
        existente.marcador.setLatLng(latLng);
        if (existente.tipo === tipo) {
          if (tipo === 'normal' && existente.marcador instanceof L.CircleMarker) {
            existente.marcador.setStyle({ fillColor: cor });
          } else if (tipo === 'ultimo' && existente.marcador instanceof L.Marker) {
            existente.marcador.setIcon(iconeUltimoPonto(cor));
          }
          existente.marcador.setTooltipContent(tooltipDoPonto(item));
        } else {
          // Trocou de tipo (virou pausa, deixou de ser o último ponto, etc.)
          // — CircleMarker e Marker não convertem um no outro, recria.
          // Remove do grupo de ORIGEM (tipo antigo) — "pausa" mora em
          // grupoParadasGaps, os demais em grupoPontos.
          this.grupoDoTipoPonto(existente.tipo).removeLayer(existente.marcador);
          this.pontosJornada.delete(item.uc);
        }
      }

      if (!this.pontosJornada.has(item.uc)) {
        const marcador: L.CircleMarker | L.Marker =
          tipo === 'ultimo'
            ? L.marker(latLng, { icon: iconeUltimoPonto(cor) })
            : tipo === 'pausa'
              ? L.marker(latLng, { icon: ICONE_PAUSA })
              : L.circleMarker(latLng, {
                  radius: 5,
                  color: '#fff',
                  weight: 1,
                  fillColor: cor,
                  fillOpacity: 0.95,
                });
        marcador
          .addTo(this.grupoDoTipoPonto(tipo))
          .bindTooltip(tooltipDoPonto(item), { direction: 'top', offset: [0, -6] });
        // Clicar no ponto foca E expande a UC na timeline do painel (item 3
        // do pedido) — os dois juntos, sem precisar de um segundo clique na
        // lista. O marcador é reaproveitado entre refreshes (nunca recriado
        // a não ser na troca de tipo acima), então o listener não pode
        // fechar sobre `item.codigo` direto — a UC pode ter sido pendente
        // quando o marcador foi criado e virado realizada depois só com
        // `setStyle`. Busca o estado ATUAL da UC na jornada no momento do clique.
        const uc = item.uc;
        const nome = colaboradorAberto;
        marcador.on('click', () => {
          this.colaboradoresService.ucFocada.set(uc);
          this.colaboradoresService.ucExpandida.set(uc);
          const atual = this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos?.find(p => p.uc === uc);
          if (ehCodigoDeImpedimento(atual?.codigo ?? null)) {
            this.colaboradoresService.carregarRegimeSucessivo(uc);
          }
        });
        this.pontosJornada.set(item.uc, { marcador, tipo });
      }
    }
    for (const [uc, { marcador, tipo }] of this.pontosJornada) {
      if (!vistos.has(uc)) {
        this.grupoDoTipoPonto(tipo).removeLayer(marcador);
        this.pontosJornada.delete(uc);
      }
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    if (this.anelPiscando) {
      clearInterval(this.anelPiscando.intervalo);
      clearTimeout(this.anelPiscando.timeoutFinal);
    }
    this.mapa?.remove();
  }
}
