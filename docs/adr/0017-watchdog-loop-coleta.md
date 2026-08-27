# ADR 0017 — Watchdog para os loops de coleta (node-cron sem retry)

## Contexto

Usuário reportou (print) o header mostrando "Coleta parada" (vermelho) mesmo com a coleta
"rodando normalmente" na sua percepção. Investigado ao vivo, não por suposição:

```
GET /coleta/status
{"coletaAcomp":{"ativo":false,"emAndamento":false,"dentroDaJanela":true}, ...}
```

`dentroDaJanela: true` (dentro do horário 07h–19h) mas `ativo: false` — o frontend estava
reportando fielmente um estado real, não um bug de exibição. Nos logs do processo, a causa
apareceu explícita:

```
[NODE-CRON][WARN] missed execution at Wed Aug 26 2026 07:00:00 GMT-0300! Possible blocking
IO or high CPU user at the same process used by node-cron.
```

## Decisão

### Causa raiz

`ativo` (`coletaJob.js`/`coletaMassivasJob.js`) é uma variável **em memória do processo**
(`loopAtivo`), resetada a cada reinício. Ela só é reativada de duas formas: 1) no boot do
processo, se já estiver dentro da janela (`if (dentroDaJanela()) loopContinuo();`); 2) via
`cron.schedule('0 7 * * *', loopContinuo)`, que dispara uma vez por dia, exatamente às 07h.

O `node-cron` **não tem retry** quando perde o disparo agendado — se o processo estiver
ocupado, reiniciando, ou bloqueado no exato minuto do agendamento, o log emite o warning
acima e segue esperando o *próximo* disparo (amanhã, já que o cron é diário). Nesta sessão,
vários reinícios do `nodemon` (disparados pelas próprias edições de arquivo ao longo do
trabalho) coincidiram com a janela das 07h, fazendo o cron perder o disparo — e sem retry,
a coleta ficou parada até alguém notar e reiniciar manualmente.

Esse não é um problema exclusivo de ambiente de desenvolvimento: em produção, qualquer
reinício do processo perto das 07h (deploy, crash, restart do host) causaria o mesmo
silêncio — coleta parada o dia inteiro sem alarme nenhum, só visível a quem abrir a tela.

### Watchdog

Cada job (`iniciarJobColeta`/`iniciarJobMassivas`) ganhou um `setInterval` de 2 minutos que
checa `dentroDaJanela() && !loopAtivo && !emAndamento` e, se verdadeiro, chama
`loopContinuo()` de novo. `loopContinuo()` já era idempotente (`if (loopAtivo) return`), então
chamar de novo enquanto já está rodando não tem efeito — o watchdog é seguro mesmo se
disparar "à toa". Isso cobre tanto o caso do cron perdido quanto qualquer outro cenário
silencioso (ex.: o bug abaixo, se reaparecer por outro motivo).

### Bug relacionado corrigido de passagem

`executarUmCiclo()` tinha `abrirContextoTenant()` **fora** do `try/catch` — se essa chamada
lançasse (erro transitório de conexão com o banco, por exemplo), a exceção escapava,
propagava pra fora do `while` em `loopContinuo()`, e travava o loop **sem nunca resetar
`loopAtivo`** (só a linha logo após o `while` reseta, e ela não é alcançada quando o loop sai
por exceção). Diferente do sintoma observado agora (`ativo: false`), esse bug produziria o
oposto — `ativo` preso em `true` pra sempre, mesmo sem nada rodando. Corrigido movendo
`abrirContextoTenant()` pra dentro do `try`, com `client` declarado fora pra o `catch` ainda
conseguir fechar o contexto se ele chegou a abrir.

## Consequências

- Resolução imediata: reiniciei o backend manualmente (o boot-check reativou os dois loops
  na hora — confirmado via `/coleta/status` e nos logs, `🔁 Iniciando loop contínuo` pros
  dois jobs, coleta rodando normalmente).
- Watchdog testado indiretamente: o mesmo caminho de código (`loopContinuo()` chamado quando
  `!loopAtivo` e dentro da janela) já foi exercitado pelo boot-check nesta sessão — o
  watchdog só chama a mesma função periodicamente, sem lógica nova a validar separadamente.
  Não dá pra esperar 2 minutos ao vivo pra ver o primeiro disparo do `setInterval` dentro
  desta sessão, mas o comportamento em si (chamar `loopContinuo()` quando deveria estar
  ativo e não está) está confirmado.
- Suíte de isolamento de tenant (12 testes) continua passando — mudança isolada nos dois
  arquivos de job, sem tocar em rota, controller nem schema.

## Adendo — janela de horário (07h-19h) removida a pedido do usuário

Usuário pediu explicitamente para coletar continuamente enquanto a API estiver no ar, sem
pausar às 19h e sem esperar até as 07h do dia seguinte.

Removida a lógica de janela nos dois jobs (`dentroDaJanela()`, `HORA_INICIO`/`HORA_FIM`, o
`cron.schedule('0 7 * * *', ...)` que só existia pra reativar o loop diariamente). Agora
`iniciarJobColeta()`/`iniciarJobMassivas()` chamam `loopContinuo()` direto no boot, e o
`while` interno roda `while (true)` em vez de `while (dentroDaJanela())` — nunca pausa
sozinho. `node-cron` deixou de ser usado nesses dois arquivos (dependência não removida do
`package.json` — não usada em mais nenhum lugar do projeto, mas não vale a pena mexer nisso
fora do escopo pedido).

O watchdog (mecanismo principal desta ADR) continua existindo como rede de segurança — antes
verificava "deveria estar rodando (dentro da janela) mas não está"; agora verifica só "não
está rodando", já que a expectativa passou a ser sempre ativo. `executarUmCiclo()` já engolia
todo erro internamente, então na prática o loop nunca deveria parar sozinho — o watchdog cobre
o cenário residual de o processo Node reiniciar e o boot-check falhar por algum motivo.

Removido também o campo `dentroDaJanela` de `obterStatus()` (não fazia mais sentido existir)
e, no frontend, o estado `'fora-do-horario'` do indicador "Coletando dados" no header —
`verificarStatusColeta()` (`FRONTEND/src/app/pages/home/home.ts`) simplificado para só
`'coletando'`/`'parada'`/`'offline'`, e o template (`home.html`) ajustado para as mesmas 3
classes de cor/texto, sem o cinza de "fora do horário" que nunca mais vai ocorrer.

`npm test` (12 testes) e `ng build --configuration production` continuam passando. Não
validado ao vivo nesta sessão — fica pra próxima execução do usuário.
