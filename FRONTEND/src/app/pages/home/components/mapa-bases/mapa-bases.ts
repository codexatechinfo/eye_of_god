import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect, signal } from '@angular/core';
import * as L from 'leaflet';
import {
  ColaboradoresService,
  LivroSelecionado,
  normalizarRegional,
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

// Compara ignorando acento/caixa: as opções do filtro vêm sem acento
// ("CAMPO MOURAO") enquanto as bases do mapa têm acento ("CAMPO MOURÃO").
function normalizarParaComparacao(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

@Component({
  selector: 'app-mapa-bases',
  imports: [],
  templateUrl: './mapa-bases.html',
  styleUrl: './mapa-bases.css',
})
export class MapaBases implements AfterViewInit, OnDestroy {
  @ViewChild('mapaEl') mapaEl!: ElementRef<HTMLDivElement>;

  private mapa?: L.Map;
  private marcadores = new Map<string, L.CircleMarker>();
  private resizeObserver?: ResizeObserver;

  // Regional aberta no mapa por clique no circulo (mostra os colaboradores
  // dessa regional). Signal proprio do componente, NAO reaproveita
  // filtroRegional (que e da sidebar): os nomes das bases tem acento
  // ("CAMPO MOURAO") e o filtro da sidebar nao, e se esse clique tambem
  // disparasse buscar() a lista lateral seria filtrada, o que zeraria (via
  // contagemPorRegional, que e computed sobre colaboradores()) os OUTROS
  // circulos do mapa. Fica totalmente desacoplado de proposito.
  regionalMapa = signal<string | null>(null);
  private marcadoresColaboradores = new Map<string, L.Marker>();

  // Rota do livro aberto no painel lateral (linha ligando as UCs na ordem de
  // sequencia). Instancia unica, atualizada via setLatLngs (nunca recriada)
  // porque atuaisLivro/timelineLivro sao atualizados a cada 60s enquanto o
  // painel esta aberto - recriar a cada ciclo causaria flicker.
  private rotaLivro?: L.Polyline;
  private livroComBoundsAplicado: string | null = null;

  constructor(public colaboradoresService: ColaboradoresService) {
    effect(() => {
      const contagem = this.colaboradoresService.contagemPorRegional();
      this.atualizarMarcadores(contagem);
    });
    effect(() => {
      const regional = this.colaboradoresService.filtroRegional();
      this.aplicarZoomRegional(regional);
    });
    effect(() => {
      const regional = this.regionalMapa();
      this.colaboradoresService.localizacoes();
      this.colaboradoresService.colaboradores();
      this.atualizarMarcadoresColaboradores(regional);
    });
    effect(() => {
      const selecionado = this.colaboradoresService.livroSelecionado();
      const atuais = this.colaboradoresService.atuaisLivro();
      this.atualizarRotaLivro(selecionado, atuais);
    });
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

    for (const base of BASES_REGIONAIS) {
      const marcador = L.circleMarker([base.lat, base.lng], {
        radius: 10,
        color: '#2563eb',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.55,
      })
        .addTo(this.mapa)
        .bindTooltip(base.regional, { direction: 'top', offset: [0, -8] });

      marcador.on('click', () => {
        const novoValor = this.regionalMapa() === base.regional ? null : base.regional;
        this.regionalMapa.set(novoValor);
        if (novoValor) {
          this.mapa!.flyTo([base.lat, base.lng], ZOOM_REGIONAL, { duration: 0.8 });
        } else {
          this.mapa!.flyTo(CENTRO_PADRAO, ZOOM_PADRAO, { duration: 0.8 });
        }
      });

      this.marcadores.set(base.regional, marcador);
    }

    this.atualizarMarcadores(this.colaboradoresService.contagemPorRegional());
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

  private atualizarMarcadores(contagem: Map<string, number>): void {
    // A base de dados às vezes guarda o nome da regional sem acento; casa
    // ignorando acento/caixa pra não deixar marcador zerado por causa disso.
    const contagemNormalizada = new Map<string, number>();
    for (const [regional, total] of contagem) {
      contagemNormalizada.set(normalizarParaComparacao(regional), total);
    }

    for (const [regional, marcador] of this.marcadores) {
      const total = contagemNormalizada.get(normalizarParaComparacao(regional)) ?? 0;
      const raio = total > 0 ? 8 + Math.min(Math.sqrt(total) * 3, 22) : 6;

      marcador.setRadius(raio);
      marcador.setStyle({ fillOpacity: total > 0 ? 0.6 : 0.15, opacity: total > 0 ? 1 : 0.35 });
      marcador.setTooltipContent(`${regional}: ${total} colaborador${total === 1 ? '' : 'es'}`);
    }
  }

  // Desenha um marcador por colaborador da regional aberta, na posicao da
  // ultima UC que ele realizou (qualquer dia). Sempre limpa TODOS os
  // marcadores atuais primeiro, mesmo quando a regional continua aberta -
  // trocar direto de uma regional pra outra sem passar por null vazaria
  // camada Leaflet (marcador antigo nunca removido do mapa, so perderia a
  // referencia no Map JS).
  private atualizarMarcadoresColaboradores(regional: string | null): void {
    if (!this.mapa) return;

    for (const marcador of this.marcadoresColaboradores.values()) {
      this.mapa.removeLayer(marcador);
    }
    this.marcadoresColaboradores.clear();

    if (!regional) return;

    const alvo = normalizarParaComparacao(regional);
    const porNome = new Map(this.colaboradoresService.colaboradores().map(c => [c.colaborador, c]));

    for (const loc of this.colaboradoresService.localizacoes()) {
      const colaborador = porNome.get(loc.colaborador);
      if (!colaborador) continue;
      if (normalizarParaComparacao(normalizarRegional(colaborador.base)) !== alvo) continue;

      const lat = Number(loc.latitude);
      const lng = Number(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const ehMoto = colaborador.cargo === 'LEITURISTA MOTOCICLISTA' || colaborador.cargo === 'MONITOR';
      const marcador = L.marker([lat, lng], { icon: ehMoto ? ICONE_MOTO : ICONE_PEDESTRE })
        .addTo(this.mapa)
        .bindTooltip(`${colaborador.colaborador} - ultima leitura em ${loc.data_import} ${loc.hora_import}`, {
          direction: 'top',
          offset: [0, -14],
        });

      marcador.on('click', () => {
        const livroEmExecucao = this.colaboradoresService
          .atividadeDe(colaborador.colaborador)
          ?.livros.find(l => l.situacaoAtual === 'Em Execução');
        if (livroEmExecucao) {
          this.colaboradoresService.abrirLivro(colaborador.colaborador, livroEmExecucao);
        }
      });

      this.marcadoresColaboradores.set(loc.colaborador, marcador);
    }
  }

  // Rota do livro aberto no painel: linha ligando as UCs de atuaisLivro na
  // ordem de sequencia (mesmo criterio de ordenacao usado em
  // livro-detalhe.ts#ucsOrdenadas). So aplica fitBounds na primeira vez que
  // desenha essa rota especifica - nos refreshes automaticos seguintes do
  // mesmo livro (a cada 60s), so atualiza os pontos, sem mexer no zoom/pan
  // que o usuario ja ajustou manualmente.
  private atualizarRotaLivro(selecionado: LivroSelecionado | null, atuais: TimelineUcItem[]): void {
    if (!this.mapa) return;

    if (!selecionado) {
      if (this.rotaLivro) this.mapa.removeLayer(this.rotaLivro);
      this.rotaLivro = undefined;
      this.livroComBoundsAplicado = null;
      return;
    }

    const pontos: L.LatLngTuple[] = [...atuais]
      .filter(item => item.latitude && item.longitude)
      .sort((a, b) => {
        const sa = Number(a.sequencia);
        const sb = Number(b.sequencia);
        const va = Number.isFinite(sa) ? sa : Infinity;
        const vb = Number.isFinite(sb) ? sb : Infinity;
        return va - vb || a.uc.localeCompare(b.uc);
      })
      .map(item => [Number(item.latitude), Number(item.longitude)] as L.LatLngTuple);

    if (this.rotaLivro) {
      this.rotaLivro.setLatLngs(pontos);
    } else if (pontos.length) {
      this.rotaLivro = L.polyline(pontos, { color: '#2563eb', weight: 3, opacity: 0.8 }).addTo(this.mapa);
    }

    if (pontos.length && this.rotaLivro && this.livroComBoundsAplicado !== selecionado.livro.livro) {
      this.mapa.fitBounds(this.rotaLivro.getBounds(), { padding: [40, 40] });
      this.livroComBoundsAplicado = selecionado.livro.livro;
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.mapa?.remove();
  }
}
