# ADR 0022 — Painel de camadas do mapa e limite municipal (IBGE)

## Contexto

Usuário enviou um print de um painel "CAMADAS" com 7 checkboxes e pediu que marcar/desmarcar
cada um exiba/oculte a respectiva camada no mapa de bases (aba Trilho). Das 7:

1. **Rastro executado** — GPS do colaborador, ainda não implementado
2. **Pontos coletados** — UCs já executadas (já existia, sem toggle)
3. **Paradas e gaps** — círculo ao redor de UC com parada anormal, ainda não implementado
4. **Setor planejado** — polígono cobrindo toda a região do livro
5. **Limites municipais** — contorno de cada município
6. **Demais agentes** — outros colaboradores no mapa (já existia, sem toggle)
7. **Sequência planejada** — ordem de execução do livro (já existia, sem toggle)

Perguntado sobre o escopo de 4 e 5, o usuário escolheu construir os dois agora (não deixar
desabilitado): "Setor planejado" via casco convexo das UCs do livro, "Limites municipais" via
import real da malha de municípios do IBGE.

## Decisão

### Refactor para `L.layerGroup`

`mapa-bases.ts` desenhava tudo direto em `this.mapa`. Cada camada com toggle ganhou seu próprio
`L.layerGroup()`: `grupoPontos` (2), `grupoSequencia` (7, rota + linhas de desvio),
`grupoAgentes` (6), `grupoSetorPlanejado` (4), `grupoLimitesMunicipais` (5). Um `effect()` por
checkbox só faz `mapa.addLayer(grupo)`/`removeLayer(grupo)` — os métodos que criam/atualizam o
conteúdo (`atualizarRotaLivro`, `atualizarMarcadoresColaboradores`) continuam rodando sempre,
independente do toggle. Importante **não** colocar um `if (!camadaLigada()) return` no topo
desses métodos: isso reintroduziria o flicker/estado obsoleto que os Adendos 5/6 da ADR 0021 já
resolveram (o grupo voltaria visível com dado velho até o próximo ciclo de 60s).

`linhasDesvio` (linhas vermelhas de desvio de sequência) foi para dentro de `grupoSequencia`,
junto com `rotaLivro` — semanticamente é sobre desvio da ordem planejada, não sobre "Paradas e
gaps" (que fica desabilitado).

"Rastro executado" e "Paradas e gaps" não têm signal nem grupo — checkbox renderizado
`disabled` no template, placeholder visual pra funcionalidade futura.

### Setor planejado — casco convexo

Função pura `cascoConvexo()` (Andrew's monotone chain) sobre as coordenadas válidas de
`atuaisLivro()` (todas as instalações do livro, não só as com sequência). Dois cuidados:

- Filtro de coordenada com `Number.isFinite` explícito, **não** reaproveitando o filtro
  truthy-string (`item.latitude && item.longitude`) já usado em `pontosLivro`/`rotaLivro` — uma
  string não-numérica passa no truthy-check e vira `NaN` depois de `Number(...)`; comparação
  `<`/`>` com `NaN` é sempre `false` sem lançar erro, o que corrompe o hull inteiro em silêncio.
- Guarda de caso degenerado: livro com menos de 3 pontos válidos não desenha nada
  (`hull.length < 3`).

Recalculado a cada ciclo (mesmo `effect` que atualiza a rota) — custo desprezível para o volume
de UCs por livro.

### Limites municipais — import real do IBGE

Nova tabela `municipios_limites` (`empresa_id` + RLS + `geometry(Polygon, 4326)` + índice GIST),
mesma policy de `coordenadas_ucs_mineradas` (ADR 0021 Adendo 1), aplicada direto via
`docker exec supabase-db psql` (mesmo caminho de execução do Adendo 2 daquela ADR — este
projeto não tem framework de migration).

Script único `BACKEND/scripts/importarLimitesMunicipais.js`, rodado com
`node scripts/importarLimitesMunicipais.js`:

1. Busca a malha de municípios do Paraná
   (`GET .../malhas/estados/41?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio`,
   399 `Feature` com `properties.codarea`) e a lista de nomes
   (`GET .../localidades/estados/41/municipios`, `id` casa com `codarea`) — confirmado ao vivo:
   as 399 geometrias vêm todas como `Polygon` (nenhum `MultiPolygon` na malha atual do PR).
2. Conecta com uma única conexão/transação (`abrirContextoTenant`, mesmo helper de
   `src/config/db.js` usado pelos jobs) — necessário porque `set_config(..., true)` é local à
   transação; um `Pool` com múltiplas conexões perderia o contexto de RLS no meio do import.
3. `INSERT ... VALUES (..., ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), ...) ON CONFLICT
   (empresa_id, codigo_ibge) DO UPDATE ...` — `ST_SetSRID` é obrigatório: sem ele a geometria
   entra com SRID 0 e o `INSERT` falha contra a coluna `geometry(Polygon, 4326)`. `ON CONFLICT`
   deixa o script idempotente (testado ao vivo: rodar 2x mantém 399 linhas, sem duplicar).
4. `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` por linha (mesmo padrão de `copelImportService.js`) — uma
   geometria inesperada não aborta as outras ~398.
5. Ao final, reporta quantas linhas têm `NOT ST_IsValid(geom)` (a simplificação
   `qualidade=minima` do IBGE pode gerar auto-interseção) — nenhuma na malha atual do PR.

Rodado uma vez, resultado: 399/399 inseridos, 0 falhas, 0 geometrias inválidas.

Endpoint novo `GET /municipios/limites` devolve `codigo_ibge, nome, ST_AsGeoJSON(geom)::json`.
Frontend faz fetch **sob demanda** (só no primeiro toggle da camada, não no carregamento do
mapa — 399 polígonos não vale pagar em todo load), cacheado em memória depois, renderizado com
`L.geoJSON()` direto sobre a resposta — o GeoJSON já vem em `[lng, lat]` nativo, e
`L.geoJSON()` já espera essa ordem, então não inverte manualmente como o resto do arquivo faz
para tuples do Leaflet.

**Trade-off aceito conscientemente**: `municipios_limites` segue o precedente da ADR 0009 ("toda
tabela de negócio tem `empresa_id` e RLS, sem exceção pra tabela de referência"), mas o dado em
si — contorno municipal do IBGE — é idêntico pra qualquer empresa que opere no Paraná, diferente
das 3 tabelas que motivaram a ADR 0009 (que de fato variam por contrato). Consequência prática:
quando uma 2ª empresa existir, alguém precisa rodar o script de novo pra ela (`empresa_id` entra
na chave única do import, então o script roda "uma vez por empresa", não uma vez só pro banco
inteiro); esquecer isso falha em silêncio (mapa sem contorno pra aquela empresa, sem erro).
Optou-se por manter a consistência do padrão do projeto em vez de abrir uma exceção nova de RLS.

## Verificação

- `node --check` em todos os arquivos backend novos/alterados — ok
- Script de import rodado 2x contra o Postgres local: 399 linhas nas duas vezes (idempotente),
  0 geometria inválida
- `npm test` (backend): 12/12 passando
- `municipiosService.listarLimites` chamado direto (fora de HTTP) contra o banco: devolve 399
  municípios, `geometry.type === 'Polygon'`, coordinates em array `[lng, lat]` válido
- `ng build --configuration development` (frontend): build limpo, sem erro de template/tipo
- Verificação visual no browser (marcar/desmarcar os 5 checkboxes ativos, conferir o casco
  convexo e o contorno municipal desenhados) não foi feita nesta sessão — requer login manual do
  usuário na aplicação, que está fora do que a automação pode fazer (não digita senha em nome do
  usuário). Build + testes automatizados + verificação direta do endpoint cobrem a lógica; a
  checagem visual fica pendente pro usuário testar quando abrir a aplicação.

## Adendo 1 — Painel movido pra controle nativo do Leaflet; 3 ajustes de UI; investigação da Jornada

Usuário testou ao vivo e trouxe 4 pontos, com 4 prints:

1. O painel "Camadas" (construído como overlay Angular fixo no canto) deveria ficar **abaixo do
   controle de tipos de mapa**, no mesmo estilo (ícone recolhido, expande no hover). Reescrito
   como um controle Leaflet de verdade (`L.Control.extend`, DOM montado com `L.DomUtil` em
   `mapa-bases.ts#criarControleCamadas`/`montarDomControleCamadas`), reaproveitando literalmente
   as classes CSS `leaflet-control-layers*` do `leaflet.css` já carregado — herda ícone, sombra,
   borda e a troca de classe `leaflet-control-layers-expanded` no hover, sem reimplementar nada
   visualmente. Adicionado ao mapa logo depois do controle de tipos de tile no mesmo canto
   (`topleft`), que empilha naturalmente abaixo dele. Painel Angular antigo removido de
   `mapa-bases.html` (voltou a ser só a `<div #mapaEl>`). Os 5 checkboxes ativos continuam
   escrevendo nos mesmos signals (`camadaPontos` etc.) já ligados aos `effect()` que
   ligam/desligam cada `L.layerGroup` — só a camada de UI mudou, a lógica de toggle não.
2. Tooltip do ponto no mapa tinha o prefixo "UC " redundante (`#sequência · UC 95971211 —
   endereço`) — removido (`tooltipDoPonto`), fica só o número.
3. "Pendente" na timeline do livro (`livro-detalhe.html`, 2 lugares) é só `!item.codigo` — nunca
   foi o `situacao_uc` real do portal, é rótulo sintético pra "ainda não realizada". Renomeado
   pra "A realizar", mesmo rótulo já usado no card de resumo do colaborador
   (`lista-colaboradores.html`), pra não ter dois nomes pro mesmo conceito no app.
4. Usuário perguntou por que um colaborador com 20 UCs realizadas e 9.7km percorridos aparecia
   com "0s trabalhado" na Jornada. Investigado ao vivo contra um colaborador real (REGINALDO
   MACHADO DA SILVA, 31/08/2026): as 21 UCs "realizadas pela primeira vez hoje" caíram em só 3
   `hora_import` distintos — confirma que `hora_import` é o instante do CICLO de raspagem, não
   o instante real da leitura. `calcularSegmento()` (`deslocamentoService.js`) classifica intervalo
   ≤5/15min como "deslocamento" e o resto como "pausa": UCs do mesmo ciclo têm intervalo 0s (soma
   0 ao trabalhado), UCs de ciclos diferentes têm intervalo de horas (sempre vira "pausa"). Não
   existe caso intermediário possível — a granularidade da raspagem (~35-50min por ciclo) é mais
   grossa que o limiar de classificação (5-15min), então "trabalhado" fica estruturalmente perto
   de zero pra qualquer colaborador, não é um caso isolado. Mesma função alimenta os separadores
   de deslocamento/pausa da timeline do livro — o problema não é só da Jornada. Apresentadas 3
   opções de correção (limite relativo ao ciclo de raspagem observado no dia, distribuir o tempo
   do ciclo entre as UCs que caem nele, ou remover a divisão trabalhado/ocioso e mostrar só
   início→fim + km); usuário optou por só registrar o diagnóstico e não mexer agora.

`ng build --configuration development` limpo depois das mudanças de frontend.
