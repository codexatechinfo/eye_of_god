import { Component, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AtividadeColaborador,
  ColaboradoresService,
  formatarDuracao,
  formatarTempoParado,
  horaParaSegundos,
} from '../../../../services/colaboradores.service';

// Mesmos limiares do protótipo de referência (ANEL_VIVO_MIN/ANEL_MORNO_MIN)
// — decide a cor do anel ao redor do avatar (verde = visto recentemente,
// âmbar = começando a esfriar, cinza = frio) a partir de há quanto tempo o
// aparelho reportou posição pela última vez.
const ANEL_VIVO_MIN = 15;
const ANEL_MORNO_MIN = 60;

@Component({
  selector: 'app-colaborador-cracha',
  imports: [CommonModule],
  templateUrl: './colaborador-cracha.html',
  styleUrl: './colaborador-cracha.css',
})
export class ColaboradorCracha {
  formatarDuracao = formatarDuracao;

  constructor(public colaboradoresService: ColaboradoresService) {}

  nome = computed(() => this.colaboradoresService.colaboradorSelecionado());

  colaborador = computed(() => {
    const nome = this.nome();
    if (!nome) return null;
    return this.colaboradoresService.colaboradores().find(c => c.colaborador === nome) ?? null;
  });

  // "AG" pra "ANDERSON ESTEVES GOMES" — primeira letra do primeiro nome +
  // primeira do último, ignorando partículas curtas (DA/DE/DOS) — mesma
  // regra do protótipo (U.iniciais).
  iniciais(nome: string): string {
    const partes = nome
      .trim()
      .split(/\s+/)
      .filter(parte => parte.length > 2);
    if (!partes.length) return '??';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
  }

  // Posição real (idade) — mesma regra ehMoto já usada em mapa-bases.ts: a
  // moto rastreia via SEGSAT (veículo), o pedestre via Scalefusion (celular).
  private posicaoAtual = computed(() => {
    const c = this.colaborador();
    if (!c) return null;
    const ehMoto = c.cargo === 'LEITURISTA MOTOCICLISTA' || c.cargo === 'MONITOR';
    return ehMoto ? this.colaboradoresService.segsatDe(c.colaborador) : this.colaboradoresService.scalefusionDe(c.colaborador);
  });

  private idadeMinutos = computed(() => {
    const pos = this.posicaoAtual();
    if (!pos?.data_hora_posicao) return null;
    return (Date.now() - new Date(pos.data_hora_posicao).getTime()) / 60000;
  });

  anel = computed((): 'vivo' | 'morno' | 'frio' => {
    const min = this.idadeMinutos();
    if (min === null) return 'frio';
    if (min <= ANEL_VIVO_MIN) return 'vivo';
    if (min <= ANEL_MORNO_MIN) return 'morno';
    return 'frio';
  });

  vistaHa(): string {
    const min = this.idadeMinutos();
    if (min === null) return 'nunca';
    if (min <= 0) return 'agora';
    return formatarTempoParado(Math.round(min));
  }

  atividade = computed((): AtividadeColaborador | null => {
    const nome = this.nome();
    return nome ? this.colaboradoresService.atividadeDe(nome) : null;
  });

  // "Atual" — o ponto no INSTANTE da régua de tempo (mesma lógica de
  // atividadeNoInstante() do protótipo): o último ponto cujo horário é
  // menor ou igual ao instante atual. Como reguaInstante nasce em
  // extremos.fim (o fim do dia até agora, ver effect de inicialização no
  // service), isso equivale a "a última UC realizada" enquanto a régua não
  // foi tocada — e passa a acompanhar o playback assim que o usuário
  // arrasta ou dá play.
  //
  // SEMPRE cai pro último ponto realizado (ignorando o instante) se a busca
  // acima não achar nada — reguaExtremos()/reguaInstante() só existem
  // depois que a jornada carrega (ver service), então logo depois de abrir
  // um colaborador (ou nos poucos instantes até a jornada chegar) o crachá
  // mostrava "nenhuma UC realizada hoje" mesmo com atividade real no dia —
  // usuário reportou com print. Isso garante que a UC mostrada nunca regride
  // pra "nenhuma" só por causa do estado transitório da régua.
  ultimoPonto = computed(() => {
    const nome = this.nome();
    if (!nome) return null;
    const pontos = this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos ?? [];
    const instante = this.colaboradoresService.reguaInstante();
    if (instante !== null) {
      let atual = null as (typeof pontos)[number] | null;
      for (const p of pontos) {
        const s = horaParaSegundos(p.hora_import);
        if (s === null) continue;
        if (s <= instante) atual = p;
        else break;
      }
      if (atual) return atual;
    }
    return [...pontos].reverse().find(p => p.codigo) ?? null;
  });

  ok = computed(() => {
    const a = this.atividade();
    return a ? Math.max(0, a.totalRealizadas - a.totalImpedimentos) : 0;
  });

  private totalServico = computed(() => {
    const a = this.atividade();
    return a ? a.totalRealizadas + a.totalPendentes : 0;
  });

  larguraOk = computed(() => (this.totalServico() ? (this.ok() / this.totalServico()) * 100 : 0));

  larguraImped = computed(() => {
    const a = this.atividade();
    const total = this.totalServico();
    return a && total ? (a.totalImpedimentos / total) * 100 : 0;
  });

  larguraFalta = computed(() => {
    const a = this.atividade();
    const total = this.totalServico();
    if (!total) return 0;
    return a ? (a.totalPendentes / total) * 100 : 0;
  });

  // Projeção "tempo pra fechar o serviço" — regra de 3 a partir do ritmo já
  // observado hoje (tempo trabalhado ÷ realizadas), multiplicado pelo que
  // falta. Só faz sentido com pelo menos 1 realizada e 1 pendente (mesma
  // condição do protótipo).
  //
  // DESLIGADA por pedido explícito do usuário ("põe dois traços por
  // enquanto") — sempre "—" (estado semProjecao no template) até segunda
  // ordem. Conta original comentada logo abaixo pra reativar rápido depois.
  projecaoSegundos = computed((): number | null => {
    return null;
    // const a = this.atividade();
    // const nome = this.nome();
    // const jornada = nome ? this.colaboradoresService.jornadaPorColaborador().get(nome) : null;
    // if (!a || !jornada?.trabalhadoSegundos || !a.totalRealizadas || !a.totalPendentes) return null;
    // return (jornada.trabalhadoSegundos / a.totalRealizadas) * a.totalPendentes;
  });

  contaProjecao = computed(() => {
    const a = this.atividade();
    const nome = this.nome();
    const jornada = nome ? this.colaboradoresService.jornadaPorColaborador().get(nome) : null;
    if (!a || !jornada?.trabalhadoSegundos) return '';
    return `${formatarDuracao(jornada.trabalhadoSegundos)} trabalhados ÷ ${a.totalRealizadas} realizadas × ${a.totalPendentes} que faltam`;
  });
}
