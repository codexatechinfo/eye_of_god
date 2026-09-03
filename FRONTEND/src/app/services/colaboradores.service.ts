import { Injectable, computed, effect, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

export function normalizarRegional(base: string): string {
  return base
    .replace(/^COPEL\s+/i, '')
    .replace(/\s+(LEITURA|ADM)$/i, '')
    .trim();
}

// Limite de "tempo parado" (Ativo/Sem sincronismo) — mesmo valor usado pelo
// backend (LIMITE_PARADO_MINUTOS, atividadeColaboradoresService.js) e agora
// também pela barra de resumo da aba Massivas/Monitoramento de Livros
// (antes um valor local separado ali, LIMITE_COMUNICACAO_MINUTOS — unificado
// a pedido do usuário).
export const LIMITE_PARADO_MINUTOS = 30;

export function hojeIso(): string {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

export interface Colaborador {
  matricula: string;
  colaborador: string;
  cargo: string;
  base: string;
  admissao: string;
  data_atualizacao: string;
}

export interface ColaboradoresResponse {
  sucesso: boolean;
  total: number;
  colaboradores: Colaborador[];
}

export interface OpcoesFiltroResponse {
  sucesso: boolean;
  cargos: string[];
  regionais: string[];
}

export interface HistoricoLivroItem {
  horaImport: string;
  situacao: string;
  digitados: number;
  naoDigitados: number;
}

export interface LivroAtividade {
  livro: string;
  etapa: string;
  situacaoAtual: string;
  digitados: number;
  naoDigitados: number;
  // null = ainda sem data_recebimento, não dá pra saber se vai virar leitura
  // ou releitura (mesma regra da ADR 0006/0011); 'massiva' = livro vindo das
  // tabelas de massiva (atribuidas_im/em_execucao_im), não de contr_execucao_leitura.
  tipoServico: 'leitura' | 'releitura' | 'massiva' | null;
  // Dias efetivos frente ao prazo regulatório (prazo_reg_livros — ver ADR
  // 0012 Adendo 4). null = livro sem correspondência na planilha (não
  // avaliado) ou de massiva (nunca teve essa correspondência).
  diasPrazoRegulatorio: number | null;
  // UCs com codigo != 000/099 (impedimento real de campo). undefined em
  // livro de massiva (não tem coluna codigo).
  impedimentos?: number;
  primeiraVez: string;
  ultimaVez: string;
  // Último horário em que uma UC realmente virou realizada hoje (digitados
  // aumentou) — diferente de ultimaVez, que é só o último lote importado,
  // mesmo sem nenhuma UC nova. null = nenhuma UC foi realizada hoje neste
  // livro (ou é livro de massiva, sem essa granularidade).
  ultimaExecucao: string | null;
  historico: HistoricoLivroItem[];
}

export interface AtividadeColaborador {
  colaborador: string;
  totalRealizadas: number;
  totalPendentes: number;
  // Soma de impedimentos (codigo != 000/099) de todos os livros do
  // colaborador hoje — 0 pra quem só tem massiva.
  totalImpedimentos: number;
  totalLivros: number;
  totalEmExecucao: number;
  ultimaMudancaHora: string;
  minutosParado: number;
  parado: boolean;
  ativo: boolean;
  semSincronismo: boolean;
  livros: LivroAtividade[];
}

export interface AfastamentoInfo {
  // 'atestado' vem da tabela atestados (tem motivo/INSS); 'licenca' vem de
  // ativos_inativos.situacao ("A2 - DD/MM/YYYY") — RH não registra motivo
  // nem INSS por esse caminho, só o período; 'suspensao' vem da tabela
  // suspensao (planilha), uma linha por dia de falta justificada, não um
  // período com início/fim.
  origem: 'atestado' | 'licenca' | 'suspensao';
  dataAfastamento: string;
  // null = licença com volta_afastamento "INDETERMINADO" — ver
  // motivoAfastamento nesse caso ("Afastado por tempo indeterminado").
  dataRetorno: string | null;
  qtdDiasAfastado: string | null;
  afastadoInss: string | null;
  motivoAfastamento: string | null;
}

export interface AtividadeHojeResponse {
  sucesso: boolean;
  data: string;
  ultimaHoraGeral: string | null;
  colaboradores: AtividadeColaborador[];
  afastamentosHoje: Record<string, AfastamentoInfo>;
}

// % de execução do dia = digitados / (digitados + pendentes). 0 quando não
// há nenhuma atividade registrada ainda (parado, ou sem atividade nenhuma) —
// não é "sem dado", é "0% feito até agora", que é exatamente o que a barra
// deve mostrar.
export function percentualExecucao(atividade: AtividadeColaborador | undefined | null): number {
  if (!atividade) return 0;
  const total = atividade.totalRealizadas + atividade.totalPendentes;
  return total > 0 ? (atividade.totalRealizadas / total) * 100 : 0;
}

// Livro com prazo regulatório extremo (mesmos limiares de destaque da
// tabela de detalhe — ver corPrazoRegulatorio em monitoramento-view.ts):
// >33 dias em QUALQUER status (já estourou o prazo, crítico não importa o
// que esteja acontecendo com o livro) ou <27 dias mas só em livro já "Em
// Execução" (livro sendo trabalhado que ainda nem chegou nos 27 dias
// costuma ser incomum o bastante pra merecer atenção — livro "Pendente"
// com <27 dias é só o normal esperado, não é sinal de nada).
function temLivroCritico(atividade: AtividadeColaborador | undefined): boolean {
  if (!atividade) return false;
  return atividade.livros.some(livro => {
    if (livro.diasPrazoRegulatorio === null) return false;
    if (livro.diasPrazoRegulatorio > 33) return true;
    return livro.diasPrazoRegulatorio < 27 && livro.situacaoAtual === 'Em Execução';
  });
}

// Ordenação master da lista (pedido explícito do usuário, substitui a
// hierarquia anterior baseada só em parado/ativo/semSincronismo):
//   1. Colaborador com pelo menos um livro em prazo regulatório extremo
//      (temLivroCritico) — não importa se está parado/ativo/sem sincronismo.
//   2. Todo mundo com atividade hoje, por percentual de execução ascendente
//      (menor % primeiro) — parado/ativo/semSincronismo tratados como UM só
//      grupo aqui, não mais como tiers separados.
//   3. Sem serviço (nenhuma atividade hoje) — sempre por último.
// categoriaDe()/os 4 toggles continuam funcionando normalmente pra FILTRAR
// a lista — só a ORDEM mudou.
//
// minutosParado NÃO entra mais como desempate: usuário reportou (print) a
// ordem "reiniciando" ao trocar de ativo pra sem sincronismo — causa real,
// confirmada com dado ao vivo: minutosParado de quem está "sem sincronismo"
// passa facilmente de 600 (horas sem sincronizar, por definição da própria
// categoria), e um desempate de escala *1000 não é grande o bastante pra
// evitar que esse valor "vaze" pra cima da diferença real de percentual
// entre duas pessoas de categorias diferentes — ex.: ativo a 13,0% (score
// 87005) aparecendo DEPOIS de alguém sem sincronismo a 13,5% com
// minutosParado=658 (score 87158), quando deveria vir antes por ter menos
// % feito. Critério agora é só percentual, como o usuário pediu.
// Afastado com atividade real hoje (livro atribuído/em execução apesar do
// afastamento cadastrado) é o tier MAIS alto — acima até de livro crítico:
// é uma divergência entre o cadastro (afastado) e o campo (trabalhando),
// digna de atenção imediata, não só mais um caso de destaque por prazo.
function pontuacaoDestaque(
  atividade: AtividadeColaborador | undefined,
  afastamento?: AfastamentoInfo | null,
): number {
  if (!atividade) return -1;
  const criticidade = 100 - percentualExecucao(atividade);
  if (afastamento) return 3_000_000 + criticidade;
  if (temLivroCritico(atividade)) return 2_000_000 + criticidade;
  return criticidade;
}

// As cinco categorias dos toggles. "semServico" é quem não tem nenhum
// registro de atividade hoje E não tem justificativa de ausência — usuário
// pediu pra separar quem está sem serviço "de fato, sem motivo" de quem tem
// atestado/licença/suspensão cobrindo hoje (categoria "afastado" nova);
// antes os dois ficavam misturados em "semServico".
export type CategoriaAtividade = 'parado' | 'semServico' | 'ativo' | 'semSincronismo' | 'afastado';

export const OPCOES_CATEGORIA: { valor: CategoriaAtividade; rotulo: string }[] = [
  { valor: 'parado', rotulo: 'Parado' },
  { valor: 'semServico', rotulo: 'Sem serviço' },
  { valor: 'ativo', rotulo: 'Ativo' },
  { valor: 'semSincronismo', rotulo: 'Sem sincronismo' },
  { valor: 'afastado', rotulo: 'Afastados' },
];

export function categoriaDe(
  atividade: AtividadeColaborador | undefined | null,
  afastamento?: AfastamentoInfo | null,
): CategoriaAtividade {
  if (!atividade) return afastamento ? 'afastado' : 'semServico';
  if (atividade.semSincronismo) return 'semSincronismo';
  if (atividade.parado) return 'parado';
  return 'ativo';
}

// Diferente de categoriaDe() (que escolhe UMA categoria "dona"), aqui a
// pergunta é "esse colaborador entra no filtro X?" — um colaborador com
// afastamento cadastrado que MESMO ASSIM gerou atividade real hoje precisa
// aparecer tanto no filtro Afastados quanto no filtro de atividade
// correspondente (usuário pediu explicitamente pra não esconder esse caso
// atrás de só uma categoria). É a única sobreposição possível: Parado/
// Ativo/Sem sincronismo continuam mutuamente exclusivos entre si (vêm de
// totalRealizadas/minutosParado, nunca dois ao mesmo tempo), e Sem serviço
// exige ausência total (nem atividade, nem afastamento).
export function pertenceCategoria(
  atividade: AtividadeColaborador | undefined | null,
  afastamento: AfastamentoInfo | undefined | null,
  categoria: CategoriaAtividade,
): boolean {
  if (categoria === 'afastado') return !!afastamento;
  if (categoria === 'semServico') return !atividade && !afastamento;
  if (!atividade) return false;
  if (categoria === 'parado') return atividade.parado;
  if (categoria === 'ativo') return atividade.ativo;
  return atividade.semSincronismo; // 'semSincronismo'
}

export interface LivroSelecionado {
  colaboradorNome: string;
  livro: LivroAtividade;
}

// Uma UC realizada, no ponto em que virou realizada — mesmo shape de
// GET /massivas/livro-ucs (campo "timeline"). Ver
// monitoramentoService.js#listarTimelineUcsRealizadasDoLivro.
export interface TimelineUcItem {
  uc: string;
  codigo: string | null;
  equipamento: string | null;
  tipo_especificacao: string | null;
  faturamento: string | null;
  leitura_atual: string | null;
  situacao: string | null;
  colaborador: string | null;
  data_import: string | null;
  hora_import: string | null;
  // Endereço/coordenada da UC (coordenadas_ucs_mineradas, ADR 0021) — null
  // quando a UC não tem correspondência lá (~4% dos casos).
  latitude: string | null;
  longitude: string | null;
  nom_municipio: string | null;
  localidade: string | null;
  endereco: string | null;
  classe_principal: string | null;
  sequencia: string | null;
  etapa: string | null;
  // Deslocamento desde a última UC REALIZADA antes desta, na ordem de rota
  // (sequencia) — não é a ordem cronológica. null quando não há UC
  // realizada anterior (primeira da rota) ou falta coordenada de algum dos
  // dois lados. Só calculado em `atuais`, nunca em `timeline`. Ver
  // monitoramentoService.js#anexarSegmentosDeslocamento.
  intervalo_anterior_segundos: number | null;
  distancia_anterior_metros: number | null;
  velocidade_m_por_min: number | null;
  tipo_intervalo: 'deslocamento' | 'pausa' | null;
}

interface UcsLivroResponse {
  sucesso: boolean;
  livro: string;
  atuais: TimelineUcItem[];
  timeline: TimelineUcItem[];
  distanciaTotalMetros: number;
}

// Última UC que o colaborador realizou, em qualquer dia — usada pra
// posicionar o ícone dele no mapa (aba Trilho). data_import/hora_import
// dizem de QUANDO é essa posição (pode ser antiga, se ele não tiver
// realizado nada recentemente).
export interface LocalizacaoColaborador {
  colaborador: string;
  uc: string;
  livro: string;
  data_import: string;
  hora_import: string;
  latitude: string;
  longitude: string;
}

// N° de meses consecutivos em que uma UC recebeu o MESMO código de
// impedimento (ver monitoramentoService.js#obterRegimeSucessivo). Buscado sob
// demanda, só quando o card da UC é expandido.
export interface RegimeSucessivo {
  uc: string;
  codigoAtual: string | null;
  ciclosConsecutivos: number;
}

interface RegimeSucessivoResponse extends RegimeSucessivo {
  sucesso: boolean;
}

// Jornada do colaborador NO DIA — timeline cronológica de todas as UCs que
// ele realizou, cruzando todos os livros. Ver
// atividadeColaboradoresService.js#obterJornadaColaborador.
// "trabalhado"/"ocioso" não separam execução de deslocamento (adiado, sem
// dado de tempo médio por UC) — o intervalo inteiro entre duas leituras
// vira "trabalhado" (dentro do limite por etapa) ou "ocioso" (acima).
export interface JornadaColaborador {
  colaborador: string;
  data: string;
  semDado: boolean;
  inicio?: string;
  fim?: string;
  trabalhadoSegundos?: number;
  ociosoSegundos?: number;
  distanciaMetros?: number;
  ocupacaoPercentual?: number | null;
  totalRealizadas?: number;
}

interface JornadaResponse extends JornadaColaborador {
  sucesso: boolean;
}

// Contorno de um município (ADR 0022) — geometry já em GeoJSON puro
// ([lng, lat]), pronto pra L.geoJSON() sem reordenar nada.
export interface MunicipioLimite {
  codigo_ibge: string;
  nome: string;
  geometry: { type: 'Polygon'; coordinates: number[][][] };
}

interface LimitesMunicipaisResponse {
  sucesso: boolean;
  municipios: MunicipioLimite[];
}

interface LocalizacoesResponse {
  sucesso: boolean;
  localizacoes: LocalizacaoColaborador[];
}

// Códigos administrativos — não são obstrução de campo (portão fechado, cão
// feroz, medidor com defeito etc.), são categorias de rotina/gestão do
// próprio processo de leitura. Levantados do catálogo real dos dados
// (base_dados_leitura.mensagem) e confirmados com o usuário: 094-leitura
// telemedida (medidor lido remotamente, nem precisou visita), 059-leitura
// fornecida pelo cliente, 037-leitura plurimensal, 027-troca de medidor,
// 054-UC fora de rota, 055/056-cadastrar/descadastrar cão feroz (a AÇÃO
// administrativa, não o cão em si — esse é o 002, que continua impedimento
// real). Ambíguos (098-não confirmado, 030-suspeita de irregularidade,
// 031-casa interligada) ficam do lado de impedimento real, a pedido do
// usuário — ainda pedem atenção de campo, não são rotina.
const CODIGOS_ADMINISTRATIVOS = new Set(['094', '059', '037', '027', '054', '055', '056']);

// "000" = leitura normal, "099" = sem leitura (não é problema de campo),
// códigos administrativos acima também não contam; qualquer outro código
// preenchido é um impedimento real (portão trancado, cão solto, etc.) —
// pedido explícito do usuário pro card "Impedimentos".
export function ehCodigoDeImpedimento(codigo: string | null): boolean {
  return !!codigo && codigo !== '000' && codigo !== '099' && !CODIGOS_ADMINISTRATIVOS.has(codigo);
}

// Qual UC foi a primeira, cronologicamente, a mostrar cada código de
// impedimento no livro — usado só pra decidir "vermelho" (código repetido em
// UC diferente). `timeline` precisa estar em ordem cronológica (mesma ordem
// que já vem de GET /massivas/livro-ucs). Compartilhado entre a timeline do
// painel (livro-detalhe.ts) e os pontos do mapa (mapa-bases.ts) — mesma
// regra de cor nos dois lugares.
export function mapaPrimeiraUcPorCodigo(timeline: TimelineUcItem[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const item of timeline) {
    if (item.codigo && ehCodigoDeImpedimento(item.codigo) && !mapa.has(item.codigo)) {
      mapa.set(item.codigo, item.uc);
    }
  }
  return mapa;
}

// Cor de uma UC: verde = realizada (código normal), cinza = ainda pendente,
// âmbar = impedimento (primeira vez que esse código aparece no livro),
// vermelho = esse código de impedimento já apareceu antes em OUTRA UC do
// mesmo livro (padrão recorrente). Compara sempre o código ATUAL da UC
// (nunca o código antigo dela mesma) contra `primeiraUcPorCodigo`.
export function corDaUc(item: TimelineUcItem, primeiraUcPorCodigo: Map<string, string>): 'verde' | 'cinza' | 'laranja' | 'vermelho' {
  if (!item.codigo) return 'cinza';
  if (!ehCodigoDeImpedimento(item.codigo)) return 'verde';
  const primeiraUc = primeiraUcPorCodigo.get(item.codigo);
  return primeiraUc && primeiraUc !== item.uc ? 'vermelho' : 'laranja';
}

// Ordem de rota (sequencia) usada tanto pela lista lateral (livro-detalhe)
// quanto pelos pontos/linha do mapa (mapa-bases) — uma implementação só.
// `sequencia == null` (UC sem correspondência em coordenadas_ucs_mineradas,
// ~4% dos casos, ver ADR 0021 Adendo 5) tem que ir pro FIM da rota via
// Infinity explícito — checar `== null` ANTES de `Number(...)` é o que
// importa aqui: `Number(null)` é `0` (finito!), então uma versão anterior
// desta função que fazia `Number.isFinite(Number(a.sequencia)) ? ... :
// Infinity` sem esse guard tratava UC sem sequencia como sequencia=0 e
// jogava ela pro INÍCIO da rota — bug real, pego só ao revisar este código
// de novo pra um propósito diferente.
// Formatação compartilhada dos campos de deslocamento — usada tanto na
// timeline do painel de livro (livro-detalhe) quanto na jornada do
// colaborador (lista-colaboradores), pra não ter duas versões divergentes.
export function formatarDistancia(metros: number | null): string {
  if (metros === null) return 'Em breve';
  if (metros < 1000) return `${Math.round(metros)} m`;
  return `${(metros / 1000).toFixed(1)} km`;
}

export function formatarDuracao(segundos: number | null): string {
  if (segundos === null) return '—';
  if (segundos < 60) return `${Math.round(segundos)}s`;
  const minutos = Math.floor(segundos / 60);
  const resto = Math.round(segundos % 60);
  if (minutos < 60) return resto > 0 ? `${minutos}m ${resto}s` : `${minutos}m`;
  const horas = Math.floor(minutos / 60);
  const minutosResto = minutos % 60;
  return minutosResto > 0 ? `${horas}h ${minutosResto}m` : `${horas}h`;
}

export function ordenarPorSequencia<T extends { sequencia: string | null; uc: string }>(itens: T[]): T[] {
  const valor = (seq: string | null): number => {
    if (seq == null) return Infinity;
    const n = Number(seq);
    return Number.isFinite(n) ? n : Infinity;
  };
  return [...itens].sort((a, b) => valor(a.sequencia) - valor(b.sequencia) || a.uc.localeCompare(b.uc));
}

@Injectable({
  providedIn: 'root',
})
export class ColaboradoresService {
  private apiUrl = environment.apiUrl;

  cargos = signal<string[]>([]);
  regionais = signal<string[]>([]);

  colaboradores = signal<Colaborador[]>([]);
  total = signal(0);
  carregando = signal(true);
  erro = signal<string | null>(null);

  filtroColaborador = signal('');
  filtroCargo = signal('');
  filtroRegional = signal('');
  filtroData = signal(hojeIso());

  atividadeHoje = signal<Record<string, AtividadeColaborador>>({});
  afastamentosHoje = signal<Record<string, AfastamentoInfo>>({});
  dataAtividade = signal<string | null>(null);
  carregandoAtividade = signal(true);
  colaboradorSelecionado = signal<string | null>(null);
  filtroCategoria = signal<CategoriaAtividade | ''>('');
  livroSelecionado = signal<LivroSelecionado | null>(null);

  timelineLivro = signal<TimelineUcItem[]>([]);
  atuaisLivro = signal<TimelineUcItem[]>([]);
  distanciaTotalLivro = signal<number | null>(null);
  carregandoTimelineLivro = signal(false);
  erroTimelineLivro = signal<string | null>(null);
  // Sem cache indefinido de propósito: "atuais"/"impedimentos" são estado
  // ATUAL (não histórico), e a coleta roda 24h contínua — cachear pra sempre
  // deixaria o painel congelado no valor de quando foi aberto. Ver abrirLivro.
  private intervaloUcsLivroId?: ReturnType<typeof setInterval>;

  impedimentosLivro = computed(() => this.atuaisLivro().filter(uc => ehCodigoDeImpedimento(uc.codigo)).length);
  // Cards "Realizadas"/"A realizar" do painel do livro (livro-detalhe.html)
  // — direto de atuaisLivro (sempre buscado fresco pro livro aberto), não
  // do LivroAtividade.digitados/naoDigitados vindo de atividadeHoje. Esse
  // último fica 0/0 quando o livro clicado no mapa não está na lista de
  // "atividade hoje" do colaborador (livroSelecionado usa um objeto mínimo
  // nesse caso, ver abrirLivro em mapa-bases.ts) — usuário viu isso
  // acontecer com Impedimentos>0 e Realizadas/A realizar em 0 ao mesmo
  // tempo, incoerente. Mesma fonte que já alimenta impedimentosLivro acima.
  realizadasLivro = computed(() => this.atuaisLivro().filter(uc => uc.codigo).length);
  aRealizarLivro = computed(() => this.atuaisLivro().filter(uc => !uc.codigo).length);

  // Posição de cada colaborador no mapa (última UC realizada, qualquer dia)
  // — buscada uma vez só (não muda a cada minuto como atividadeHoje).
  localizacoes = signal<LocalizacaoColaborador[]>([]);

  // Contorno só dos município(s) que o livro aberto no mapa toca (camada
  // "Limites municipais", ADR 0022) — não a malha inteira do estado.
  // Recalculado sempre que o livro selecionado muda enquanto a camada está
  // ligada (ver mapa-bases.ts). null até a primeira busca.
  limitesMunicipais = signal<MunicipioLimite[] | null>(null);

  // UC com o card de detalhe expandido na timeline (accordion, uma por vez)
  // — signal no service (não local ao componente) porque tanto um clique na
  // lista (livro-detalhe) quanto um clique num ponto do mapa (mapa-bases)
  // precisam setá-la, e os dois são componentes irmãos.
  ucExpandida = signal<string | null>(null);
  // UC que deve ganhar foco visual (scroll até ela) na timeline — setada
  // junto com ucExpandida quando o clique vem do mapa.
  ucFocada = signal<string | null>(null);
  // Mesma ideia de ucFocada, só que pro colaborador na lista da esquerda —
  // setado junto com colaboradorSelecionado só quando o clique vem do ícone
  // do mapa (abrirColaborador), nunca quando o usuário clica direto na
  // lista (senão rolaria pra cima dele mesmo, sem necessidade). Consumido
  // por um effect em lista-colaboradores.ts.
  colaboradorFocado = signal<string | null>(null);
  // Coordenada pra centralizar o mapa — setada pelo botão "Centralizar no
  // mapa" do card de detalhe, consumida por um effect em mapa-bases.ts.
  centralizarEm = signal<{ lat: number; lng: number } | null>(null);
  // Cache simples por UC — evita rebuscar regime sucessivo se o usuário
  // reabrir a mesma UC mais de uma vez na mesma sessão.
  regimeSucessivoPorUc = signal<Map<string, RegimeSucessivo>>(new Map());
  // Jornada do dia por colaborador — recarregada toda vez que o card dele é
  // reaberto (sem polling, não muda minuto a minuto como atividadeHoje).
  jornadaPorColaborador = signal<Map<string, JornadaColaborador>>(new Map());

  // Sempre ordenada por destaque (mais grave primeiro) e, quando um toggle
  // está ativo, filtrada só para quem está naquela categoria.
  colaboradoresOrdenados = computed(() => {
    const atividade = this.atividadeHoje();
    const afastamentos = this.afastamentosHoje();
    const filtro = this.filtroCategoria();
    const lista = [...this.colaboradores()].sort(
      (a, b) =>
        pontuacaoDestaque(atividade[b.colaborador], afastamentos[b.colaborador]) -
        pontuacaoDestaque(atividade[a.colaborador], afastamentos[a.colaborador]),
    );
    if (!filtro) return lista;
    return lista.filter(c => pertenceCategoria(atividade[c.colaborador], afastamentos[c.colaborador], filtro));
  });

  // Quem tem afastamento cadastrado (atestado/licença/suspensão) cobrindo
  // hoje MAS mesmo assim gerou atividade real (livro atribuído/em execução)
  // — divergência entre o cadastro e o campo, tratada como o caso mais
  // crítico da lista (ver pontuacaoDestaque) e disparo do alerta central
  // (ver afastadosVistos/mostrarAlertaAfastado abaixo).
  afastadosComAtividade = computed(() => {
    const atividade = this.atividadeHoje();
    const afastamentos = this.afastamentosHoje();
    return this.colaboradores().filter(c => !!atividade[c.colaborador] && !!afastamentos[c.colaborador]);
  });

  // Controla o alerta central (home.html): só dispara sozinho quando um
  // nome NOVO entra em afastadosComAtividade — fechar o alerta marca todos
  // os nomes atuais como "vistos" e ele fica quieto até aparecer outro nome
  // que ainda não tinha sido visto (não fica reabrindo pros mesmos nomes a
  // cada poll de 60s).
  afastadosVistos = signal<Set<string>>(new Set());
  mostrarAlertaAfastado = signal(false);

  fecharAlertaAfastado(): void {
    const nomesAtuais = this.afastadosComAtividade().map(c => c.colaborador);
    this.afastadosVistos.set(new Set(nomesAtuais));
    this.mostrarAlertaAfastado.set(false);
  }

  // "hoje" enquanto a data selecionada for o dia atual; "em DD/MM/YYYY"
  // quando o usuário navegou pro calendário pra um dia passado — usado nos
  // rótulos "Livros de hoje"/"Nenhuma atividade hoje" da lista lateral.
  rotuloDataAtividade = computed(() => {
    const data = this.dataAtividade();
    if (!data) return 'hoje';
    const [dia, mes, ano] = data.split('/');
    const iso = `${ano}-${mes}-${dia}`;
    return iso === hojeIso() ? 'hoje' : `em ${data}`;
  });

  alternarFiltroCategoria(categoria: CategoriaAtividade): void {
    this.filtroCategoria.set(this.filtroCategoria() === categoria ? '' : categoria);
  }

  private debounceId?: ReturnType<typeof setTimeout>;
  private readonly INTERVALO_ATIVIDADE_MS = 60000;

  constructor(private http: HttpClient) {
    this.carregarOpcoesFiltro();
    this.buscar();
    this.carregarAtividadeHoje();
    this.carregarLocalizacoes();

    // Abre o alerta sozinho (sem precisar de clique) assim que aparece um
    // nome em afastadosComAtividade que ainda não estava em afastadosVistos
    // — dispara de novo no próximo poll de 60s só se for um nome novo.
    effect(() => {
      const nomesAtuais = this.afastadosComAtividade().map(c => c.colaborador);
      if (nomesAtuais.length && nomesAtuais.some(nome => !this.afastadosVistos().has(nome))) {
        this.mostrarAlertaAfastado.set(true);
      }
    });
    // Só repete sozinho enquanto a data selecionada for hoje — consultar
    // um dia passado não tem "chegando dado novo" pra esperar, e ficar
    // refazendo a mesma busca a cada 60s seria trabalho à toa.
    setInterval(() => {
      if (this.filtroData() === hojeIso()) {
        this.carregarAtividadeHoje();
        this.carregarLocalizacoes();
      }
    }, this.INTERVALO_ATIVIDADE_MS);
  }

  carregarOpcoesFiltro(): void {
    this.http.get<OpcoesFiltroResponse>(`${this.apiUrl}/colaboradores/opcoes-filtro`).subscribe({
      next: resposta => {
        this.cargos.set(resposta.cargos);
        this.regionais.set(resposta.regionais);
      },
    });
  }

  buscar(): void {
    this.carregando.set(true);
    this.erro.set(null);

    let params = new HttpParams();
    if (this.filtroColaborador()) params = params.set('colaborador', this.filtroColaborador());
    if (this.filtroCargo()) params = params.set('cargo', this.filtroCargo());
    if (this.filtroRegional()) params = params.set('regional', this.filtroRegional());

    this.http.get<ColaboradoresResponse>(`${this.apiUrl}/colaboradores/ativos`, { params }).subscribe({
      next: resposta => {
        this.colaboradores.set(resposta.colaboradores);
        this.total.set(resposta.total);
        this.carregando.set(false);
      },
      error: () => {
        this.erro.set('Não foi possível carregar os colaboradores.');
        this.carregando.set(false);
      },
    });
  }

  buscarComDebounce(): void {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => this.buscar(), 350);
  }

  limparFiltros(): void {
    this.filtroColaborador.set('');
    this.filtroCargo.set('');
    this.filtroRegional.set('');
    this.filtroData.set(hojeIso());
    this.buscar();
    this.carregarAtividadeHoje();
    this.carregarLocalizacoes();
  }

  // Chamado pelo template quando o usuário troca a data no calendário —
  // recarrega a atividade (Realizados/Impedimentos/cards/lista de livros) E
  // as localizações (marcadores do mapa, ver obterUltimaUcRealizadaPorColaborador)
  // pra refletir o dia selecionado nos dois.
  onFiltroDataChange(data: string): void {
    this.filtroData.set(data);
    this.carregarAtividadeHoje();
    this.carregarLocalizacoes();
  }

  carregarAtividadeHoje(): void {
    this.carregandoAtividade.set(true);
    const params = new HttpParams().set('data', this.filtroData());
    this.http.get<AtividadeHojeResponse>(`${this.apiUrl}/colaboradores/atividade-hoje`, { params }).subscribe({
      next: resposta => {
        const mapa: Record<string, AtividadeColaborador> = {};
        for (const item of resposta.colaboradores) {
          mapa[item.colaborador] = item;
        }
        this.atividadeHoje.set(mapa);
        this.afastamentosHoje.set(resposta.afastamentosHoje ?? {});
        this.dataAtividade.set(resposta.data);
        this.carregandoAtividade.set(false);
      },
      error: () => {
        this.carregandoAtividade.set(false);
      },
    });
  }

  carregarLocalizacoes(): void {
    const params = new HttpParams().set('data', this.filtroData());
    this.http.get<LocalizacoesResponse>(`${this.apiUrl}/colaboradores/localizacoes`, { params }).subscribe({
      next: resposta => this.localizacoes.set(resposta.localizacoes),
      error: () => {},
    });
  }

  // pontos: coordenadas [latitude, longitude] das UCs do livro aberto (o
  // mapa já tem esse dado carregado — mesma fonte do casco convexo). Quem
  // decide QUANDO chamar (evitar refetch pro mesmo livro) é mapa-bases.ts.
  carregarLimitesMunicipaisDoLivro(pontos: number[][]): void {
    this.http.post<LimitesMunicipaisResponse>(`${this.apiUrl}/municipios/limites-por-pontos`, { pontos }).subscribe({
      next: resposta => this.limitesMunicipais.set(resposta.municipios),
      error: () => this.limitesMunicipais.set([]),
    });
  }

  carregarRegimeSucessivo(uc: string): void {
    if (this.regimeSucessivoPorUc().has(uc)) return;
    this.http
      .get<RegimeSucessivoResponse>(`${this.apiUrl}/massivas/uc-regime`, { params: new HttpParams().set('uc', uc) })
      .subscribe({
        next: resposta => {
          const mapa = new Map(this.regimeSucessivoPorUc());
          mapa.set(uc, { uc: resposta.uc, codigoAtual: resposta.codigoAtual, ciclosConsecutivos: resposta.ciclosConsecutivos });
          this.regimeSucessivoPorUc.set(mapa);
        },
        error: () => {},
      });
  }

  atividadeDe(nome: string): AtividadeColaborador | null {
    return this.atividadeHoje()[nome] ?? null;
  }

  afastamentoDe(nome: string): AfastamentoInfo | null {
    return this.afastamentosHoje()[nome] ?? null;
  }

  selecionarColaborador(nome: string): void {
    const abrindo = this.colaboradorSelecionado() !== nome;
    this.colaboradorSelecionado.set(abrindo ? nome : null);
    if (abrindo) this.carregarJornada(nome);
  }

  // Igual selecionarColaborador, mas nunca fecha (não alterna) — usado pelo
  // clique no ícone do colaborador no mapa (mapa-bases.ts), que deve sempre
  // ABRIR o card na lista da esquerda junto com a rota do livro à direita,
  // nunca fechar um card que já estava aberto por engano de um segundo clique.
  abrirColaborador(nome: string): void {
    // Zera antes de setar: signal de string só dispara o effect de scroll
    // quando o VALOR muda — clicar duas vezes seguidas no mesmo ícone do
    // mapa (ex.: usuário rolou a lista pra outro lugar entre os cliques)
    // escreveria o mesmo nome de novo e o effect não reagiria. O null no
    // meio garante duas mudanças reais (null->nome), sempre rola de novo.
    this.colaboradorFocado.set(null);
    if (this.colaboradorSelecionado() !== nome) {
      this.colaboradorSelecionado.set(nome);
      this.carregarJornada(nome);
    }
    this.colaboradorFocado.set(nome);
  }

  // Sem cache (diferente de regimeSucessivoPorUc) — recarrega toda vez que
  // o card é reaberto, já que a jornada de hoje muda ao longo do dia.
  // Segue a mesma data selecionada no calendário da sidebar (filtroData).
  carregarJornada(nome: string): void {
    this.http
      .get<JornadaResponse>(`${this.apiUrl}/colaboradores/jornada`, {
        params: new HttpParams().set('colaborador', nome).set('data', this.filtroData()),
      })
      .subscribe({
        next: resposta => {
          const mapa = new Map(this.jornadaPorColaborador());
          mapa.set(nome, resposta);
          this.jornadaPorColaborador.set(mapa);
        },
        error: () => {},
      });
  }

  abrirLivro(colaboradorNome: string, livro: LivroAtividade): void {
    this.livroSelecionado.set({ colaboradorNome, livro });
    this.buscarUcsLivro(livro.livro, true);

    // Coleta roda 24h contínua — sem isso, "atuais"/"impedimentos" ficavam
    // congelados no valor de quando o painel foi aberto, enquanto o card do
    // colaborador (que soma o mesmo dado) já tinha atualizado no poll de
    // atividade-hoje. Usuário reportou exatamente essa divergência (livro
    // com 1 UC só, card do colaborador e painel do livro mostrando totais
    // de impedimentos diferentes).
    if (this.intervaloUcsLivroId) clearInterval(this.intervaloUcsLivroId);
    this.intervaloUcsLivroId = setInterval(() => this.buscarUcsLivro(livro.livro, false), this.INTERVALO_ATIVIDADE_MS);
  }

  fecharLivro(): void {
    this.livroSelecionado.set(null);
    if (this.intervaloUcsLivroId) {
      clearInterval(this.intervaloUcsLivroId);
      this.intervaloUcsLivroId = undefined;
    }
  }

  // mostrarCarregando: false nas atualizações automáticas em segundo plano
  // (evita apagar a lista e piscar "Carregando..." a cada 60s com o painel
  // já aberto — mesmo cuidado do resetarPagina em MonitoramentoService.buscarTudo).
  private buscarUcsLivro(livro: string, mostrarCarregando: boolean): void {
    this.erroTimelineLivro.set(null);
    if (mostrarCarregando) {
      this.carregandoTimelineLivro.set(true);
      this.timelineLivro.set([]);
      this.atuaisLivro.set([]);
      this.distanciaTotalLivro.set(null);
    }

    this.http
      .get<UcsLivroResponse>(`${this.apiUrl}/massivas/livro-ucs`, {
        params: new HttpParams().set('livro', livro).set('data', this.filtroData()),
      })
      .subscribe({
        next: resposta => {
          this.timelineLivro.set(resposta.timeline);
          this.atuaisLivro.set(resposta.atuais);
          this.distanciaTotalLivro.set(resposta.distanciaTotalMetros);
          this.carregandoTimelineLivro.set(false);
        },
        error: () => {
          this.erroTimelineLivro.set('Não foi possível carregar a timeline do livro.');
          this.carregandoTimelineLivro.set(false);
        },
      });
  }
}
