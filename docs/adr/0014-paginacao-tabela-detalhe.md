# ADR 0014 — Paginação na tabela "Detalhe por livro" (Massivas e Monitoramento de Livros)

## Contexto

A tabela "Detalhe por livro", nas duas abas (Massivas e Monitoramento de Livros — mesmo
componente `MassivasView`, ver ADR 0010), renderiza todas as linhas do resultado de uma vez
só, com scroll interno (`max-h-[560px] overflow-y-auto`). Com filtro largo, isso passa de
1.600 linhas renderizadas ao mesmo tempo. Usuário pediu paginação com escolha de quantas
linhas exibir por página, nas duas abas.

## Decisão

Paginação **client-side**, não uma nova consulta ao backend por página. O detalhe inteiro já
vem numa resposta HTTP só (`GET /massivas/detalhe`, sem paginação no backend) — criar
paginação de servidor exigiria mudar o contrato da rota, o cursor/offset, e não traria
ganho real: o volume (milhares de linhas, não milhões) é pequeno o bastante pra recortar no
array já carregado sem impacto perceptível.

`MassivasService` (por-instância, uma por aba — ADR 0010) ganhou dois signals novos:
`paginaAtual`/`itensPorPagina` (padrão 50; opções 25/50/100/200). Ficam no SERVICE, não no
componente, pelo mesmo motivo dos outros filtros: cada aba precisa da própria página,
isolada da outra.

`MassivasView` ganhou `linhasPaginadas()` (recorta `linhasOrdenadas()` pelo intervalo da
página atual), `totalPaginas()`, `paginaEfetiva()` (clamp entre 1 e `totalPaginas()` — se um
filtro reduzir o resultado e a página guardada ficar além do novo total, corrige sozinho em
vez de mostrar tela vazia), `irParaPagina()`/`alterarItensPorPagina()` e
`intervaloExibido()` (texto tipo "51–100 de 1638 registros" no cabeçalho da tabela, que antes
só mostrava o total).

### Resetar a página ao trocar filtro, sem resetar no polling automático

Problema real descoberto ao planejar: a tela já tem `setInterval` de 60s
(`INTERVALO_ATUALIZACAO_MS`) que rebusca os dados sozinho pra manter o painel atualizado
(ADR 0012). Se a página resetasse toda vez que os dados chegam, o usuário navegando na
página 5 seria chutado de volta pra página 1 a cada minuto — pior que não ter paginação.

Resolvido com um parâmetro em `buscarTudo(resetarPagina = true)`: todo ponto que já existia
no código pra reagir a filtro (Regional/Etapa/Livro/Colaborador/Status/Tipo/Prazo/Faixa de
dias — via `ngModelChange` direto ou os métodos `selecionarStatus`/`selecionarPrazo`/
`selecionarFaixa`/`onTipoServicoChange`) chama `buscarTudo()` sem argumento, então continua
resetando a página normalmente sem precisar tocar em cada call site individualmente. Só o
`setInterval` do polling foi ajustado pra chamar `buscarTudo(false)` explicitamente.

### Paginação, não infinite scroll

Optado por paginação clássica (Primeira/Anterior/Página X de Y/Próxima/Última) em vez de
infinite scroll ou virtual scroll — mais simples de implementar sobre o array já ordenado,
e dá ao usuário noção clara de quantos registros existem no total, que é justamente o que a
pergunta original queria resolver (volume grande demais pra rolar numa lista só).

## Consequências

- Testado ao vivo (JWT de teste) nas duas abas: "51–100 de 1638 registros" / "Página 2 de
  33" navegando com Próxima; trocar itens por página de 50 pra 200 recalculou o total de
  páginas (9) e voltou pra página 1; clicar num filtro de status (Pendentes) enquanto na
  página 2 voltou sozinho pra página 1 com o novo total (5 páginas). Aba Massivas com
  paginação independente (1122 registros, 23 páginas com 50/página) — confirmando isolamento
  por instância de `MassivasService`.
- Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando — mudança
  só de FRONTEND, nenhum endpoint novo nem alterado.
