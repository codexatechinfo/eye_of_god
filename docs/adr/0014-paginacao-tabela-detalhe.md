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

## Adendo — campo livre (até 250) no lugar do select de opções fixas

Usuário apontou que faltava a opção de escolher livremente quantas linhas por página, com
teto de 250 — a decisão original só tinha um `<select>` com 4 opções fixas (25/50/100/200),
sem chegar a 250 e sem aceitar qualquer outro valor.

Trocado por um `<input type="number" min="1" max="250">` que aceita qualquer valor digitado,
mais os mesmos atalhos rápidos como botões ao lado (25/50/100/250, agora com 250 no lugar de
200). `alterarItensPorPagina()` valida e limita: número inválido ou ≤ 0 mantém o valor atual
inalterado; número válido é limitado (`Math.min`) a `MAX_ITENS_POR_PAGINA = 250`.

Bug pego no teste ao vivo: quando o valor digitado era rejeitado (ex.: `0` com 250 já
selecionado), o `[value]` do Angular só se atualiza quando o **signal** muda — como `0` não
mudava o signal (o método mantinha 250), o campo ficava mostrando `0` na tela mesmo a tabela
continuando correta com 250 linhas, uma divergência visual entre o campo e o resultado real.
Corrigido passando o próprio `<input>` pro método (`alterarItensPorPagina(valor, elemento)`)
e setando `elemento.value` diretamente com o valor final — garante que o campo sempre
reflete o valor válido de verdade, independente do signal ter mudado ou não.

Testado ao vivo: digitar `137` mostrou "1–137 de 1638 registros"; digitar `9999` foi
limitado a 250 ("1–250 de 1638 registros", campo também corrigido pra "250"); digitar `0`
manteve 250 linhas na tabela E corrigiu o campo de volta pra "250" imediatamente (antes da
correção, ficava mostrando "0"). Suíte de isolamento de tenant (12 testes) e build do
Angular continuam passando.

## Consequências

- Testado ao vivo (JWT de teste) nas duas abas: "51–100 de 1638 registros" / "Página 2 de
  33" navegando com Próxima; trocar itens por página de 50 pra 200 recalculou o total de
  páginas (9) e voltou pra página 1; clicar num filtro de status (Pendentes) enquanto na
  página 2 voltou sozinho pra página 1 com o novo total (5 páginas). Aba Massivas com
  paginação independente (1122 registros, 23 páginas com 50/página) — confirmando isolamento
  por instância de `MassivasService`.
- Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando — mudança
  só de FRONTEND, nenhum endpoint novo nem alterado.
