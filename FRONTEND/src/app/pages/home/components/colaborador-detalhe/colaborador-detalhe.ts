import { Component, ElementRef, HostListener, Input, QueryList, ViewChildren, computed, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  formatarDistancia,
  formatarDuracao,
  formatarTempoParado,
  LIMITE_PARADO_MINUTOS,
  normalizarRegional,
  PontoJornada,
} from '../../../../services/colaboradores.service';

@Component({
  selector: 'app-colaborador-detalhe',
  imports: [CommonModule],
  templateUrl: './colaborador-detalhe.html',
  styleUrl: './colaborador-detalhe.css',
})
export class ColaboradorDetalhe {
  // 'painel' (padrão, aba Trilho): desliza da borda direita, sem cobrir a
  // tela — o mapa continua visível ao lado. 'modal' (aba Monitoramento
  // Colaborador, sem mapa por perto pra "encostar"): centralizado com
  // fundo escurecido, mesmo padrão visual dos outros modais do app
  // ("Histórico do livro" etc. em monitoramento-view.html). Conteúdo
  // (header + timeline) é o MESMO nos dois — só a moldura muda, ver
  // colaborador-detalhe.html.
  @Input() variante: 'painel' | 'modal' = 'painel';

  // Marcadas com #linhaUc no template (uma por UC da timeline) — usadas
  // pra rolar até a UC focada (clique num ponto do mapa, ver mapa-bases.ts).
  @ViewChildren('linhaUc') private linhas!: QueryList<ElementRef<HTMLElement>>;

  constructor(
    public colaboradoresService: ColaboradoresService,
    private elementRef: ElementRef<HTMLElement>,
  ) {
    effect(() => {
      const uc = this.colaboradoresService.ucFocada();
      if (!uc || !this.linhas) return;
      const linha = this.linhas.find(ref => ref.nativeElement.dataset['uc'] === uc);
      linha?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Posição do mousedown mais recente em qualquer lugar do documento — usada
  // por aoClicarFora pra distinguir um clique de dispensa genuíno de um
  // clique nativo que o Leaflet dispara ao SOLTAR o mouse depois de
  // arrastar (pan) o mapa. Sem essa checagem, mover o mapa fechava o painel
  // sozinho (usuário reportou: "quando vou movimentar o mapa some a
  // execução do colaborador").
  private posicaoMousedown: { x: number; y: number } | null = null;

  @HostListener('document:mousedown', ['$event'])
  aoPressionar(evento: MouseEvent): void {
    this.posicaoMousedown = { x: evento.clientX, y: evento.clientY };
  }

  // Cliques DENTRO do mapa (app-mapa-bases), da lista lateral
  // (app-lista-colaboradores) ou da tabela da aba Monitoramento Colaborador
  // (app-monitoramento-colaborador-view) não fecham o painel — um clique
  // que ABRE o painel (ou troca pra outro colaborador) bolha até
  // `document` no mesmo evento, e como o alvo não está dentro do elemento
  // do painel, fechava de volta imediatamente (bug real: clicar num
  // colaborador "não fazia nada" — abria e fechava no mesmo clique; já
  // resolvido uma vez pro mapa/lista, reapareceu igual quando a aba
  // Monitoramento Colaborador passou a abrir este painel também).
  @HostListener('document:click', ['$event'])
  aoClicarFora(evento: MouseEvent): void {
    if (!this.colaboradoresService.colaboradorSelecionado()) return;
    const alvo = evento.target as Node;
    if (this.elementRef.nativeElement.contains(alvo)) return;
    if (document.querySelector('app-mapa-bases')?.contains(alvo)) return;
    if (document.querySelector('app-lista-colaboradores')?.contains(alvo)) return;
    if (document.querySelector('app-monitoramento-colaborador-view')?.contains(alvo)) return;
    // Arrastar o mapa (pan) solta o botão longe de onde apertou, e esse
    // "solta" vira um evento click nativo no fim do arraste — trata como
    // arraste (não fecha) sempre que o clique acaba a mais de 5px de onde
    // começou. Limiar pequeno o bastante pra não perder um clique de
    // dispensa genuíno com leve tremor da mão.
    const LIMIAR_ARRASTO_PX = 5;
    if (this.posicaoMousedown) {
      const dx = evento.clientX - this.posicaoMousedown.x;
      const dy = evento.clientY - this.posicaoMousedown.y;
      if (Math.hypot(dx, dy) > LIMIAR_ARRASTO_PX) return;
    }
    this.fechar();
  }

  // Fecha o painel E o card expandido na lista — os dois são a mesma coisa
  // agora (colaboradorSelecionado controla ambos, pedido explícito do
  // usuário: clicar no colaborador abre os dois juntos).
  fechar(): void {
    this.colaboradoresService.colaboradorSelecionado.set(null);
  }

  nomeAberto = computed(() => this.colaboradoresService.colaboradorSelecionado());

  // Regional/cargo/bateria no cabeçalho — pedido do usuário ("aqui também
  // deve indicar") depois de ver o modal só com nome e faltando esse
  // contexto que já aparecia no card da lista lateral. `colaboradores()`
  // (cargo/base) e `scalefusionDe()` (bateria) já são a mesma fonte usada
  // em lista-colaboradores.html — mesmos rótulos/cores, sem duplicar regra.
  colaboradorAtivo(nome: string) {
    return this.colaboradoresService.colaboradores().find(c => c.colaborador === nome);
  }

  regionalDe(base: string): string {
    return normalizarRegional(base);
  }

  rotuloCargo(cargo: string): string {
    if (cargo === 'LEITURISTA MOTOCICLISTA') return 'Motoqueiro';
    if (cargo === 'LEITURISTA') return 'Pedestre';
    if (cargo === 'MONITOR') return 'Monitor';
    return cargo;
  }

  corBateria(percentual: number | null): string {
    if (percentual == null) return 'text-tenue';
    if (percentual <= 20) return 'text-critico';
    if (percentual <= 50) return 'text-laranja-t';
    return 'text-ok';
  }

  // Timeline do DIA inteiro do colaborador aberto, cruzando todos os livros
  // — já vem em ordem cronológica do backend (obterJornadaColaborador), não
  // reordenada por sequência de rota como antes.
  pontosOrdenados = computed(() => {
    const nome = this.nomeAberto();
    if (!nome) return [];
    return this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos ?? [];
  });

  // Os 3 KPIs "Realizadas"/"A realizar"/"Impedimentos" funcionam como
  // filtro da timeline abaixo deles — pedido explícito do usuário. Clicar
  // de novo no mesmo filtro limpa (mesmo padrão de toggleCategoria em
  // lista-colaboradores.ts). "Realizadas" mostra TODAS as UCs com código
  // preenchido (inclusive impedimentos — mesma definição de
  // totalRealizadas no service, impedimento é um subconjunto, não exclui).
  filtroTimeline = signal<'realizadas' | 'a_realizar' | 'impedimentos' | ''>('');

  toggleFiltroTimeline(valor: 'realizadas' | 'a_realizar' | 'impedimentos'): void {
    this.filtroTimeline.set(this.filtroTimeline() === valor ? '' : valor);
  }

  pontosFiltrados = computed(() => {
    const filtro = this.filtroTimeline();
    const pontos = this.pontosOrdenados();
    if (!filtro) return pontos;
    if (filtro === 'a_realizar') return pontos.filter(p => !p.codigo);
    if (filtro === 'impedimentos') return pontos.filter(p => !!p.codigo && this.ehImpedimento(p.codigo));
    return pontos.filter(p => !!p.codigo); // 'realizadas'
  });

  // undefined = ainda não chegou a primeira resposta de /colaboradores/jornada
  // pro colaborador aberto (carregando); definido = já respondeu (mesmo que
  // sem pontos).
  jornadaCarregada = computed(() => {
    const nome = this.nomeAberto();
    if (!nome) return true;
    return this.colaboradoresService.jornadaPorColaborador().has(nome);
  });

  // Mesma regra de cor usada nos pontos do mapa (mapa-bases.ts) — ver
  // corDaUc em colaboradores.service.ts.
  corDoPonto(item: PontoJornada): 'verde' | 'cinza' | 'laranja' | 'vermelho' {
    return corDaUc(item, this.colaboradoresService.regimeSucessivoPorUc());
  }

  // Cor do cartão "f-seg" da timeline (protótipo) — reaproveita corDaUc
  // (mesma fonte de verdade do mapa) mas acrescenta um caso que só existe
  // aqui: pausa (>limite por etapa) vira crítico, mesmo numa leitura
  // normal, pra destacar o tempo parado — pedido explícito da rodada 2 do
  // restyle (ver ADR 0038 Adendo 2).
  corSegmento(item: PontoJornada): 'neutro' | 'ok' | 'alerta' | 'critico' {
    const cor = this.corDoPonto(item);
    if (cor === 'cinza') return 'neutro';
    if (item.tipo_intervalo === 'pausa') return 'critico';
    if (cor === 'vermelho') return 'critico';
    if (cor === 'laranja') return 'alerta';
    return 'ok';
  }

  distanciaFormatada(metros: number | null): string {
    return formatarDistancia(metros);
  }

  duracaoFormatada(segundos: number | null): string {
    return formatarDuracao(segundos);
  }

  // Card "Leituras/min" ficava "Em breve" — cálculo anterior tinha sido
  // descartado por medir pelo tempo TOTAL visto (incluindo pausas), o que
  // distorcia o ritmo real. `trabalhadoSegundos` (já calculado pra "Km
  // percorrido"/ocupação) exclui pausas — dividir por ele em vez do tempo
  // total resolve a distorção original. null enquanto não há tempo
  // trabalhado ainda (evita 0/0 ou Infinity no primeiro ponto do dia).
  leiturasPorMinuto(nome: string): number | null {
    const jornada = this.colaboradoresService.jornadaPorColaborador().get(nome);
    if (!jornada?.trabalhadoSegundos || !jornada.totalRealizadas) return null;
    return (jornada.totalRealizadas / jornada.trabalhadoSegundos) * 60;
  }

  // Card "Improdutivo" ficava "Em breve" — a métrica originalmente pensada
  // (tempo de execução vs. deslocamento, separados) segue sem dado pra
  // calcular. `ociosoSegundos` (soma dos intervalos que já viram "pausa" na
  // timeline — ver tipo_intervalo/corDoSegmento) já existe e é exatamente
  // "tempo parado além do normal entre leituras", que é o que "Improdutivo"
  // quer dizer na prática.
  improdutivoSegundos(nome: string): number | null {
    return this.colaboradoresService.jornadaPorColaborador().get(nome)?.ociosoSegundos ?? null;
  }

  // Card "Sem sincronizar há" mostra há QUANTO TEMPO o colaborador não
  // sincroniza (pedido explícito do usuário), não mais a hora do relógio.
  tempoSemSincronizar(minutos: number | null | undefined): string {
    return minutos == null ? '--' : formatarTempoParado(minutos);
  }

  // Card "Sem sincronizar há" vira vermelho passando do mesmo limite que já
  // decide o toggle Ativo/Sem sincronismo (LIMITE_PARADO_MINUTOS).
  semSincronizarCritico(minutos: number | null | undefined): boolean {
    return minutos != null && minutos >= LIMITE_PARADO_MINUTOS;
  }

  ehImpedimento(codigo: string | null): boolean {
    return ehCodigoDeImpedimento(codigo);
  }

  // Accordion: clicar numa UC expande o card de detalhe dela (endereço,
  // deslocamento, regime sucessivo etc.) — só uma expandida por vez. Se for
  // ABRIR (não fechar) e a UC tiver código de impedimento, já dispara a
  // busca do regime sucessivo (sob demanda, não em lote pra toda a lista).
  toggleExpandir(item: PontoJornada): void {
    const abrindo = this.colaboradoresService.ucExpandida() !== item.uc;
    this.colaboradoresService.ucExpandida.set(abrindo ? item.uc : null);
    if (abrindo && ehCodigoDeImpedimento(item.codigo)) {
      this.colaboradoresService.carregarRegimeSucessivo(item.uc);
    }
  }

  centralizarNoMapa(item: PontoJornada): void {
    if (!item.latitude || !item.longitude) return;
    this.colaboradoresService.centralizarEm.set({ lat: Number(item.latitude), lng: Number(item.longitude), uc: item.uc });
  }

  linkStreetView(item: PontoJornada): string | null {
    if (!item.latitude || !item.longitude) return null;
    return `https://www.google.com/maps?layer=c&cbll=${item.latitude},${item.longitude}`;
  }
}
