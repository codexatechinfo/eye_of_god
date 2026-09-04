import { Component, ElementRef, HostListener, QueryList, ViewChildren, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  formatarDistancia,
  formatarDuracao,
  mapaPrimeiraUcPorCodigo,
  PontoJornada,
} from '../../../../services/colaboradores.service';

@Component({
  selector: 'app-colaborador-detalhe',
  imports: [CommonModule],
  templateUrl: './colaborador-detalhe.html',
  styleUrl: './colaborador-detalhe.css',
})
export class ColaboradorDetalhe {
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

  // O clique que ABRE o painel (clicar no colaborador, na lista ou no ícone
  // do mapa) já para a propagação ou vem de fora do painel, então nunca
  // chega aqui no mesmo evento — sem isso, abrir um colaborador diferente
  // com o painel já aberto fecharia ele de novo no mesmo clique.
  //
  // Cliques DENTRO do mapa (app-mapa-bases) também não fecham o painel:
  // mesmo cuidado que existia no antigo painel de livro (ver histórico) —
  // um clique no marcador do colaborador que ABRE o painel bolha até
  // `document` no mesmo evento, e como o alvo não está dentro do elemento
  // do painel, fechava de volta imediatamente.
  @HostListener('document:click', ['$event'])
  aoClicarFora(evento: MouseEvent): void {
    if (!this.colaboradoresService.colaboradorSelecionado()) return;
    const alvo = evento.target as Node;
    if (this.elementRef.nativeElement.contains(alvo)) return;
    if (document.querySelector('app-mapa-bases')?.contains(alvo)) return;
    this.fechar();
  }

  // Fecha o painel E o card expandido na lista — os dois são a mesma coisa
  // agora (colaboradorSelecionado controla ambos, pedido explícito do
  // usuário: clicar no colaborador abre os dois juntos).
  fechar(): void {
    this.colaboradoresService.colaboradorSelecionado.set(null);
  }

  nomeAberto = computed(() => this.colaboradoresService.colaboradorSelecionado());

  // Timeline do DIA inteiro do colaborador aberto, cruzando todos os livros
  // — já vem em ordem cronológica do backend (obterJornadaColaborador), não
  // reordenada por sequência de rota como antes.
  pontosOrdenados = computed(() => {
    const nome = this.nomeAberto();
    if (!nome) return [];
    return this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos ?? [];
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
  // mapaPrimeiraUcPorCodigo/corDaUc em colaboradores.service.ts.
  private primeiraUcPorCodigo = computed(() => mapaPrimeiraUcPorCodigo(this.pontosOrdenados()));

  corDoPonto(item: PontoJornada): 'verde' | 'cinza' | 'laranja' | 'vermelho' {
    return corDaUc(item, this.primeiraUcPorCodigo());
  }

  distanciaFormatada(metros: number | null): string {
    return formatarDistancia(metros);
  }

  duracaoFormatada(segundos: number | null): string {
    return formatarDuracao(segundos);
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
    this.colaboradoresService.centralizarEm.set({ lat: Number(item.latitude), lng: Number(item.longitude) });
  }

  linkStreetView(item: PontoJornada): string | null {
    if (!item.latitude || !item.longitude) return null;
    return `https://www.google.com/maps?layer=c&cbll=${item.latitude},${item.longitude}`;
  }
}
