import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, effect } from '@angular/core';
import * as L from 'leaflet';
import { ColaboradoresService } from '../../../../services/colaboradores.service';

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

  constructor(public colaboradoresService: ColaboradoresService) {
    effect(() => {
      const contagem = this.colaboradoresService.contagemPorRegional();
      this.atualizarMarcadores(contagem);
    });
    effect(() => {
      const regional = this.colaboradoresService.filtroRegional();
      this.aplicarZoomRegional(regional);
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

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.mapa?.remove();
  }
}
