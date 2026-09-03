# ADR 0029 — Filtros de colaborador: limite unificado em 30min e categoria "afastado com atividade"

## Contexto

Revisão dos 5 filtros de colaborador da aba Trilho (Parado/Sem serviço/Ativo/Sem
sincronismo/Afastados) contra a regra de negócio esperada apontou duas divergências:

1. `LIMITE_PARADO_MINUTOS` (decide Ativo `< Xmin` vs Sem sincronismo `>= Xmin`) estava em 20min
   desde a primeira versão do arquivo — nunca foi 30min. Existia, à parte, um segundo limite já em
   30min (`LIMITE_COMUNICACAO_MINUTOS`, `monitoramento-view.ts`), usado só na barra de resumo
   "agentes em campo" da aba Massivas/Monitoramento de Livros, mantido deliberadamente separado do
   Trilho por uma sessão anterior ("mudar esse aqui não deve alterar o comportamento já validado
   do Trilho").
2. `categoriaDe()` (`colaboradores.service.ts`) só volta pra "afastado" quando o colaborador não
   tem NENHUMA atividade hoje — se ele tem afastamento cadastrado (atestado/licença/suspensão)
   cobrindo hoje mas mesmo assim gerou leitura/execução real, a atividade sempre vence e ele nunca
   aparece em Afastados. Usuário quer o oposto: esse caso é uma divergência entre cadastro e campo
   que precisa aparecer nos DOIS filtros, subir pro topo da lista, e abrir um alerta.

## Decisão

### Limite único de 30min, compartilhado entre Trilho e resumo de Massivas

`LIMITE_PARADO_MINUTOS` passa a 30 em `atividadeColaboradoresService.js` (backend, fonte da
verdade de `parado`/`ativo`/`semSincronismo`) e ganha o mesmo nome/valor exportado do lado
frontend em `colaboradores.service.ts`. `monitoramento-view.ts` perde sua constante local
`LIMITE_COMUNICACAO_MINUTOS` e passa a importar a mesma constante — revoga de propósito a decisão
anterior de mantê-los separados; usuário confirmou explicitamente que quer unificar mesmo sabendo
disso.

### Categorias deixam de ser 100% mutuamente exclusivas: `pertenceCategoria()`

Nova função `pertenceCategoria(atividade, afastamento, categoria)` em `colaboradores.service.ts`,
ao lado de `categoriaDe()` (que continua existindo, agora só como "categoria dominante" pra quem
precisar de UM rótulo). Diferença: `pertenceCategoria('afastado', ...)` responde `!!afastamento`
sem olhar se há atividade — um colaborador com afastamento cadastrado E atividade real hoje agora
bate `true` tanto em `afastado` quanto no filtro de atividade correspondente (`parado`/`ativo`/
`semSincronismo`). `colaboradoresOrdenados` (o computed que alimenta a lista da aba Trilho) troca
`categoriaDe(...) === filtro` por essa nova função. Única sobreposição possível — Ativo/Parado/Sem
sincronismo continuam mutuamente exclusivos entre si (vêm de `totalRealizadas`/`minutosParado`,
nunca dois ao mesmo tempo) e Sem serviço exige ausência total.

### Destaque máximo + alerta central automático

`pontuacaoDestaque()` ganha um tier acima até de livro crítico: colaborador com afastamento E
atividade pontua `3_000_000 + criticidade` (livro crítico é `2_000_000 + criticidade`), garantindo
topo absoluto da lista sempre que o caso existir.

Novo computed `afastadosComAtividade` + signals `afastadosVistos`/`mostrarAlertaAfastado` +
`effect()` no construtor de `ColaboradoresService`: assim que aparece um nome em
`afastadosComAtividade` que ainda não está em `afastadosVistos`, abre um modal central (não
precisa clique) em `home.html` — fora de qualquer aba, é alerta global, visível não importa qual
aba está aberta. Fechar marca os nomes atuais como vistos (não reabre sozinho pros mesmos nomes,
só se um nome novo entrar depois). Mesmo padrão visual do modal "sem comunicar 30min" já existente
em `monitoramento-view.html`, com cor âmbar de alerta em vez do cinza neutro.

Badge âmbar adicional na linha do colaborador em `lista-colaboradores.html` (mesmo lugar do ícone
azul/roxo já usado só pra "sem serviço com justificativa") pra ficar visível mesmo sem abrir o
alerta ou expandir o card.

## Consequências

- Contagens que dependiam do limite de 20min (qualquer relatório/tela que leia `parado`/`ativo`/
  `semSincronismo`) mudam de valor — mais gente cai em "Ativo" (janela maior) e menos em "Sem
  sincronismo" até o próximo ciclo de 30min sem sincronizar.
- `categoriaDe()` fica "morta" no sentido de não decidir mais o filtro sozinha — continua
  exportada e correta, só não é mais chamada em `colaboradoresOrdenados`. Se não sobrar nenhum uso
  dela depois desta mudança, considerar remover numa limpeza futura.
- Alerta central é por sessão de navegador (estado em signal, não persistido) — reabrir a página
  reseta `afastadosVistos` e o alerta pode disparar de novo pros mesmos nomes já vistos antes do
  reload.

## Verificação

`npm test` no BACKEND (12/12, suíte de isolamento de tenant — não testa esta lógica diretamente,
mudança é só o valor de uma constante). `ng build` no FRONTEND sem erro. Verificação visual (login,
badge, alerta, filtros) ainda pendente — não foi feita nesta sessão por falta de credencial de
teste; usuário vai confirmar do lado dele.
