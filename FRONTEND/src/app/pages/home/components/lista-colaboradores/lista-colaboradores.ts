import { Component, ElementRef, QueryList, ViewChildren, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AtividadeColaborador,
  CategoriaAtividade,
  ColaboradoresService,
  formatarTempoParado,
  hojeIso,
  normalizarRegional,
  OPCOES_CATEGORIA,
  percentualExecucao,
} from '../../../../services/colaboradores.service';

type CorBarra = 'verde' | 'amarelo' | 'vermelho';

@Component({
  selector: 'app-lista-colaboradores',
  imports: [CommonModule, FormsModule],
  templateUrl: './lista-colaboradores.html',
  styleUrl: './lista-colaboradores.css',
})
export class ListaColaboradores {
  opcoesCategoria = OPCOES_CATEGORIA;

  // Marcadas com #linhaColaborador no template (uma por colaborador) —
  // usadas pra rolar até o colaborador focado (clique no ícone dele no
  // mapa, ver mapa-bases.ts). Mesmo padrão de #linhaUc em livro-detalhe.ts.
  @ViewChildren('linhaColaborador') private linhas!: QueryList<ElementRef<HTMLElement>>;

  constructor(public colaboradoresService: ColaboradoresService) {
    effect(() => {
      const nome = this.colaboradoresService.colaboradorFocado();
      if (!nome || !this.linhas) return;
      const linha = this.linhas.find(ref => ref.nativeElement.dataset['colaborador'] === nome);
      linha?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  selecionar(nome: string): void {
    this.colaboradoresService.selecionarColaborador(nome);
  }

  // Barra de filtros (busca/data/regional/cargo) — infraestrutura já existia
  // no service (filtroColaborador/filtroCargo/filtroRegional/filtroData,
  // buscar()/buscarComDebounce()/onFiltroDataChange()) mas nunca tinha UI
  // aqui, só os chips de categoria. Ver ADR 0038 Adendo 3.
  aoBuscar(valor: string): void {
    this.colaboradoresService.filtroColaborador.set(valor);
    this.colaboradoresService.buscarComDebounce();
  }

  aoMudarRegional(valor: string): void {
    this.colaboradoresService.filtroRegional.set(valor);
    this.colaboradoresService.buscar();
  }

  aoMudarCargo(valor: string): void {
    this.colaboradoresService.filtroCargo.set(valor);
    this.colaboradoresService.buscar();
  }

  // "ao vivo" — adaptação do conceito do protótipo (lá é "reler a cada 60s
  // sem reenquadrar o mapa"; aqui já pollamos sozinho a cada 60s enquanto
  // filtroData() for hoje, ver INTERVALO_ATIVIDADE_MS): vira um atalho pra
  // voltar pro dia atual (e reativar o polling, que fica pausado num dia
  // passado).
  hojeIso = hojeIso;

  voltarParaHoje(): void {
    this.colaboradoresService.onFiltroDataChange(hojeIso());
  }

  aoMudarData(valor: string): void {
    this.colaboradoresService.onFiltroDataChange(valor || hojeIso());
  }

  // Cards "Último sincronismo" mostram há QUANTO TEMPO o colaborador não
  // sincroniza (pedido explícito do usuário), não mais a hora do relógio —
  // mesma fórmula já usada no toggle Parado/Ativo/Sem sincronismo
  // (LIMITE_PARADO_MINUTOS) e no modal "sem comunicar" de monitoramento-view.
  tempoSemSincronizar(minutos: number | null | undefined): string {
    return minutos == null ? '--' : formatarTempoParado(minutos);
  }

  toggleCategoria(categoria: CategoriaAtividade): void {
    this.colaboradoresService.alternarFiltroCategoria(categoria);
  }

  regionalDe(base: string): string {
    return normalizarRegional(base);
  }

  // Cargo cru de ativos_inativos vira um rótulo mais claro na lista.
  rotuloCargo(cargo: string): string {
    if (cargo === 'LEITURISTA MOTOCICLISTA') return 'Motoqueiro';
    if (cargo === 'LEITURISTA') return 'Pedestre';
    if (cargo === 'MONITOR') return 'Monitor';
    return cargo;
  }

  // Barra de progresso abaixo do nome — mesmo % que agora também ordena a
  // lista (pontuacaoDestaque em colaboradores.service.ts).
  percentual(nome: string): number {
    return percentualExecucao(this.colaboradoresService.atividadeDe(nome));
  }

  corBarra(atividade: AtividadeColaborador | null): CorBarra {
    const pct = percentualExecucao(atividade);
    if (pct >= 70) return 'verde';
    if (pct >= 30) return 'amarelo';
    return 'vermelho';
  }

  // Bateria do aparelho (via Scalefusion, ADR 0033) — mesmos limiares de
  // "crítico"/"atenção" usados em qualquer indicador de bateria comum.
  corBateria(percentual: number | null): string {
    if (percentual == null) return 'text-tenue';
    if (percentual <= 20) return 'text-critico';
    if (percentual <= 50) return 'text-laranja-t';
    return 'text-ok';
  }
}
