import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, signal } from '@angular/core';
import * as L from 'leaflet';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  LivroAtividade,
  LivroSelecionado,
  mapaPrimeiraUcPorCodigo,
  MunicipioLimite,
  ordenarPorSequencia,
  TimelineUcItem,
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

// Icones do colaborador no mapa - mesmo padrao do resto do app (SVG inline,
// stroke=currentColor via a cor fixada no proprio elemento). Moto para
// motoqueiro/monitor, pessoa a pe para pedestre (pedido explicito do
// usuario). Fundo branco + borda colorida pra ficar legivel sobre qualquer
// camada de tile (ruas/satelite/topografico).
function iconeColaborador(cor: string, caminhoSvg: string): L.DivIcon {
  return L.divIcon({
    html: `
      <div style="width:28px;height:28px;border-radius:9999px;background:#fff;border:2px solid ${cor};display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.35);">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${caminhoSvg}
        </svg>
      </div>
    `,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

const ICONE_MOTO = iconeColaborador(
  '#2563eb',
  '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6h4l2 6.5"/><path d="M9 17.5H5.5L7 12h5l3 5.5H15"/><path d="M7 12l3.5-5.5H14"/>',
);

const ICONE_PEDESTRE = iconeColaborador(
  '#ea580c',
  '<circle cx="12" cy="4" r="2"/><path d="M12 6v6l-3 8"/><path d="M12 12l3 8"/><path d="M9 10 6 12"/><path d="M15 10l3 2"/>',
);

// Mesma paleta das 4 cores da timeline do painel (livro-detalhe.html:
// bg-emerald-400/bg-slate-300/bg-amber-500/bg-red-500), exceto "cinza" —
// slate-300 (#cbd5e1) é claro demais sobre tile de mapa (rua ou satélite) e
// o ponto praticamente some visualmente; usuário confirmou o sintoma com
// print. Trocado por um azul (#3b82f6) que continua reservado (não conflita
// com o azul da rota planejada, #94a3b8 cinza-azulado, nem com os ícones de
// colaborador). A cor da lista lateral (livro-detalhe.html) não muda — lá o
// fundo é branco, slate-300 tem contraste suficiente.
const CORES_PONTO: Record<'verde' | 'cinza' | 'laranja' | 'vermelho', string> = {
  verde: '#34d399',
  cinza: '#3b82f6',
  laranja: '#f59e0b',
  vermelho: '#ef4444',
};

function tooltipDoPonto(item: TimelineUcItem): string {
  const sequencia = item.sequencia ? `#${item.sequencia} · ` : '';
  const endereco = item.endereco ? ` — ${item.endereco}` : '';
  const codigo = item.codigo ? ` · código ${item.codigo}` : ' · pendente';
  return `${sequencia}UC ${item.uc}${endereco}${codigo}`;
}

// Andrew's monotone chain — casco convexo dos pontos válidos do livro
// (camada "Setor planejado"). Não reaproveita o filtro truthy-string
// (item.latitude && item.longitude) usado em pontosLivro/rotaLivro logo
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

  // Rota planejada do livro aberto (linha ligando as UCs na ordem de
  // sequencia) + um ponto colorido por UC (verde/cinza/âmbar/vermelho, mesma
  // regra de corDaUc do painel lateral) + linhas de desvio quando a ordem
  // REAL de execução (timelineLivro, cronológica) pula pra uma UC que não é
  // a próxima da sequencia. Tudo atualizado em cima da instância existente
  // (nunca recriado do zero) porque atuaisLivro/timelineLivro são
  // atualizados a cada 60s enquanto o painel está aberto — recriar a cada
  // ciclo causaria flicker.
  private rotaLivro?: L.Polyline;
  private pontosLivro = new Map<string, L.CircleMarker>();
  private linhasDesvio: L.Polyline[] = [];
  private livroComBoundsAplicado: string | null = null;
  private poligonoSetorPlanejado?: L.Polygon;
  private limitesMunicipaisRenderizados = false;

  // Grupos do painel "CAMADAS" — cada checkbox só liga/desliga o grupo
  // inteiro (mapa.addLayer/removeLayer), nunca decide SE algo é desenhado.
  // Os métodos de atualização (atualizarRotaLivro, atualizarMarcadoresColaboradores)
  // continuam rodando sempre, mesmo com o grupo fora do mapa — colocar um
  // "if (!camadaLigada()) return" ali reintroduziria o flicker/estado
  // obsoleto que a ADR 0021 Adendo 5/6 já resolveu (o grupo voltaria visível
  // com dado velho até o próximo ciclo de 60s). Ver ADR 0022.
  private grupoPontos = L.layerGroup(); // camada 2: pontos coletados
  private grupoSequencia = L.layerGroup(); // camada 7: rota planejada + desvios
  private grupoAgentes = L.layerGroup(); // camada 6: demais agentes
  private grupoSetorPlanejado = L.layerGroup(); // camada 4: casco convexo do livro
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
      const selecionado = this.colaboradoresService.livroSelecionado();
      const atuais = this.colaboradoresService.atuaisLivro();
      const timeline = this.colaboradoresService.timelineLivro();
      this.atualizarRotaLivro(selecionado, atuais, timeline);
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
    effect(() => {
      const ligado = this.camadaLimitesMunicipais();
      this.alternarGrupo(this.grupoLimitesMunicipais, ligado);
      if (ligado) this.colaboradoresService.carregarLimitesMunicipais();
    });
    // Renderiza os polígonos assim que o fetch (sob demanda, acima) chegar —
    // só uma vez (limitesMunicipaisRenderizados), independente de quantas
    // vezes o toggle for ligado/desligado depois.
    effect(() => {
      const dados = this.colaboradoresService.limitesMunicipais();
      if (!dados || this.limitesMunicipaisRenderizados) return;
      this.limitesMunicipaisRenderizados = true;
      this.renderizarLimitesMunicipais(dados);
    });
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
    for (const municipio of municipios) {
      L.geoJSON(municipio.geometry as GeoJSON.Geometry, {
        style: { color: '#0ea5e9', weight: 1, fillOpacity: 0.02 },
      })
        .bindTooltip(municipio.nome)
        .addTo(this.grupoLimitesMunicipais);
    }
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

    // topleft: o painel de detalhe do livro (app-livro-detalhe) cobre o lado
    // direito da tela quando aberto — no canto padrão (topright) o controle
    // ficaria escondido atrás dele.
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

    // Os effects de toggle (constructor) já rodaram antes do mapa existir —
    // reaplica o estado inicial de cada grupo agora que this.mapa está pronto
    // (mesmo motivo do aplicarZoomRegional explícito logo abaixo).
    this.alternarGrupo(this.grupoPontos, this.camadaPontos());
    this.alternarGrupo(this.grupoSequencia, this.camadaSequencia());
    this.alternarGrupo(this.grupoAgentes, this.camadaAgentes());
    this.alternarGrupo(this.grupoSetorPlanejado, this.camadaSetorPlanejado());
    this.alternarGrupo(this.grupoLimitesMunicipais, this.camadaLimitesMunicipais());

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
  private atualizarMarcadoresColaboradores(): void {
    if (!this.mapa) return;

    for (const marcador of this.marcadoresColaboradores.values()) {
      this.grupoAgentes.removeLayer(marcador);
    }
    this.marcadoresColaboradores.clear();

    const porNome = new Map(this.colaboradoresService.colaboradores().map(c => [c.colaborador, c]));

    for (const loc of this.colaboradoresService.localizacoes()) {
      const colaborador = porNome.get(loc.colaborador);
      if (!colaborador) continue;

      const lat = Number(loc.latitude);
      const lng = Number(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const ehMoto = colaborador.cargo === 'LEITURISTA MOTOCICLISTA' || colaborador.cargo === 'MONITOR';
      const marcador = L.marker([lat, lng], { icon: ehMoto ? ICONE_MOTO : ICONE_PEDESTRE })
        .addTo(this.grupoAgentes)
        .bindTooltip(`${colaborador.colaborador} - última leitura em ${loc.data_import} ${loc.hora_import}`, {
          direction: 'top',
          offset: [0, -14],
        });

      // Abre exatamente o livro da UC que posicionou esse marcador (loc.livro)
      // — não "o livro em execução hoje", que podia ser um livro DIFERENTE do
      // que gerou a posição (ou nem existir, se o colaborador não tiver
      // atividade hoje). Se esse livro não aparecer em atividadeHoje (ex.:
      // última execução foi em outro dia), usa um objeto mínimo só com o
      // número do livro — os cards de resumo do painel ficam em branco nesse
      // caso, mas a rota/timeline (que é o que importa aqui) carrega normal,
      // já que dependem só do número do livro (GET /massivas/livro-ucs).
      marcador.on('click', () => {
        const livro: LivroAtividade = this.colaboradoresService
          .atividadeDe(colaborador.colaborador)
          ?.livros.find(l => l.livro === loc.livro) ?? {
          livro: loc.livro,
          etapa: '',
          situacaoAtual: '',
          digitados: 0,
          naoDigitados: 0,
          tipoServico: null,
          diasPrazoRegulatorio: null,
          primeiraVez: '',
          ultimaVez: '',
          ultimaExecucao: null,
          historico: [],
        };
        this.colaboradoresService.abrirLivro(colaborador.colaborador, livro);
      });

      this.marcadoresColaboradores.set(loc.colaborador, marcador);
    }
  }

  // Rota do livro aberto no painel: linha planejada (ordem de sequencia) +
  // um ponto colorido por UC + linhas de desvio quando a ordem real de
  // execução pula a sequencia. Só aplica fitBounds na primeira vez que
  // desenha essa rota específica — nos refreshes automáticos seguintes do
  // mesmo livro (a cada 60s), só atualiza pontos/linhas, sem mexer no
  // zoom/pan que o usuário já ajustou manualmente.
  private atualizarRotaLivro(selecionado: LivroSelecionado | null, atuais: TimelineUcItem[], timeline: TimelineUcItem[]): void {
    if (!this.mapa) return;

    if (!selecionado) {
      if (this.rotaLivro) this.grupoSequencia.removeLayer(this.rotaLivro);
      this.rotaLivro = undefined;
      for (const ponto of this.pontosLivro.values()) this.grupoPontos.removeLayer(ponto);
      this.pontosLivro.clear();
      for (const linha of this.linhasDesvio) this.grupoSequencia.removeLayer(linha);
      this.linhasDesvio = [];
      if (this.poligonoSetorPlanejado) this.grupoSetorPlanejado.removeLayer(this.poligonoSetorPlanejado);
      this.poligonoSetorPlanejado = undefined;
      this.livroComBoundsAplicado = null;
      return;
    }

    const ordenados = ordenarPorSequencia(atuais).filter(item => item.latitude && item.longitude);
    const pontosRota: L.LatLngTuple[] = ordenados.map(item => [Number(item.latitude), Number(item.longitude)]);

    if (this.rotaLivro) {
      this.rotaLivro.setLatLngs(pontosRota);
    } else if (pontosRota.length) {
      this.rotaLivro = L.polyline(pontosRota, { color: '#94a3b8', weight: 2, opacity: 0.7, dashArray: '2 6' }).addTo(
        this.grupoSequencia,
      );
    }

    // Setor planejado (casco convexo de TODAS as instalações do livro, não só
    // as ordenadas/com sequência) — filtro próprio com Number.isFinite, mais
    // estrito que o truthy-string acima (ver comentário de cascoConvexo).
    const pontosParaHull: L.LatLngTuple[] = atuais
      .map((item): L.LatLngTuple => [Number(item.latitude), Number(item.longitude)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    const hull = cascoConvexo(pontosParaHull);
    if (hull.length >= 3) {
      if (this.poligonoSetorPlanejado) {
        this.poligonoSetorPlanejado.setLatLngs(hull);
      } else {
        this.poligonoSetorPlanejado = L.polygon(hull, { color: '#8b5cf6', weight: 2, fillOpacity: 0.08 }).addTo(
          this.grupoSetorPlanejado,
        );
      }
    } else if (this.poligonoSetorPlanejado) {
      this.grupoSetorPlanejado.removeLayer(this.poligonoSetorPlanejado);
      this.poligonoSetorPlanejado = undefined;
    }

    if (pontosRota.length && this.rotaLivro && this.livroComBoundsAplicado !== selecionado.livro.livro) {
      this.mapa.fitBounds(this.rotaLivro.getBounds(), { padding: [40, 40] });
      this.livroComBoundsAplicado = selecionado.livro.livro;
    }

    // Pontos: atualiza em cima da instância existente por UC (posição/cor),
    // cria só as novas, remove as que já não aparecem mais em `ordenados`.
    const indexPorUc = new Map(ordenados.map((item, i) => [item.uc, i]));
    const primeiraUcPorCodigo = mapaPrimeiraUcPorCodigo(timeline);
    const vistos = new Set<string>();

    for (const item of ordenados) {
      vistos.add(item.uc);
      const latLng: L.LatLngTuple = [Number(item.latitude), Number(item.longitude)];
      const cor = CORES_PONTO[corDaUc(item, primeiraUcPorCodigo)];
      const existente = this.pontosLivro.get(item.uc);
      if (existente) {
        existente.setLatLng(latLng);
        existente.setStyle({ fillColor: cor });
        existente.setTooltipContent(tooltipDoPonto(item));
      } else {
        const ponto = L.circleMarker(latLng, { radius: 5, color: '#fff', weight: 1, fillColor: cor, fillOpacity: 0.95 })
          .addTo(this.grupoPontos)
          .bindTooltip(tooltipDoPonto(item), { direction: 'top', offset: [0, -6] });
        // Clicar no ponto foca E expande a UC na timeline do painel (item 3
        // do pedido) — os dois juntos, sem precisar de um segundo clique na
        // lista. O circleMarker é reaproveitado entre refreshes (nunca
        // recriado, ver comentário da classe), então o listener não pode
        // fechar sobre `item.codigo` direto — a UC pode ter sido pendente
        // quando o marcador foi criado e virado realizada depois só com
        // `setStyle` (sem recriar o marcador, sem re-registrar o listener).
        // Busca o estado ATUAL da UC em atuaisLivro() no momento do clique.
        const uc = item.uc;
        ponto.on('click', () => {
          this.colaboradoresService.ucFocada.set(uc);
          this.colaboradoresService.ucExpandida.set(uc);
          const atual = this.colaboradoresService.atuaisLivro().find(a => a.uc === uc);
          if (ehCodigoDeImpedimento(atual?.codigo ?? null)) {
            this.colaboradoresService.carregarRegimeSucessivo(uc);
          }
        });
        this.pontosLivro.set(item.uc, ponto);
      }
    }
    for (const [uc, ponto] of this.pontosLivro) {
      if (!vistos.has(uc)) {
        this.grupoPontos.removeLayer(ponto);
        this.pontosLivro.delete(uc);
      }
    }

    // Desvios: timeline já vem em ordem cronológica (id ASC, ver
    // listarTimelineUcsRealizadasDoLivro) — pra cada par consecutivo de UCs
    // realizadas, se a próxima não é a "próxima da sequencia" da anterior
    // (índice adjacente em `ordenados`), o colaborador pulou a ordem
    // planejada: traça uma linha marcando esse trecho. Recriado inteiro a
    // cada ciclo (não atualizado em cima da instância) — o número de desvios
    // é tipicamente pequeno, não justifica a complexidade de diffar.
    for (const linha of this.linhasDesvio) this.grupoSequencia.removeLayer(linha);
    this.linhasDesvio = [];

    for (let i = 1; i < timeline.length; i++) {
      const anterior = timeline[i - 1];
      const atual = timeline[i];
      if (!anterior.latitude || !anterior.longitude || !atual.latitude || !atual.longitude) continue;

      const indexAnterior = indexPorUc.get(anterior.uc);
      const indexAtual = indexPorUc.get(atual.uc);
      if (indexAnterior === undefined || indexAtual === undefined) continue;
      if (indexAtual === indexAnterior + 1) continue;

      const linha = L.polyline(
        [
          [Number(anterior.latitude), Number(anterior.longitude)],
          [Number(atual.latitude), Number(atual.longitude)],
        ],
        { color: '#dc2626', weight: 2.5, opacity: 0.85, dashArray: '6 4' },
      ).addTo(this.grupoSequencia);
      this.linhasDesvio.push(linha);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.mapa?.remove();
  }
}
