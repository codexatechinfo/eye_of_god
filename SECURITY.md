# Política de segurança

Este é um sistema interno, sem exposição pública planejada. Ainda assim, qualquer
vulnerabilidade deve ser tratada com prioridade — os dados envolvidos incluem credenciais
de acesso ao portal da Copel e dados operacionais da empreiteira.

## Como reportar

Não abra uma issue pública para vulnerabilidade. Reporte diretamente ao mantenedor do
repositório (ver `.github/CODEOWNERS`) descrevendo:

- o que foi encontrado e como reproduzir;
- impacto estimado (acesso a dado, execução de código, escalada de privilégio etc.);
- se possível, uma sugestão de correção.

## O que esperar

- Confirmação de recebimento em até 2 dias úteis.
- Correção priorizada conforme severidade; segredo exposto é rotacionado imediatamente
  (ver processo em `/segredos`).

## Escopo

- `BACKEND/` (API, autenticação, scraper)
- `FRONTEND/` (SPA Angular)
- Configuração de CI/CD em `.github/workflows/`
