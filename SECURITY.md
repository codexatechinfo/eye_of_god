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

## Histórico de exposição de segredo

- **2026-08-24** — `BACKEND/.env` (senha do Postgres e credencial do portal Copel) existia
  sem `.gitignore` protegendo o arquivo. **Nunca foi commitado** (confirmado com
  `gitleaks detect --log-opts=--all` sobre todo o histórico do git — nenhum leak
  encontrado), mas ficou exposto em texto puro numa pasta sincronizada (OneDrive) sem
  proteção alguma até a regularização do repositório. `.gitignore` corrigido no mesmo
  ciclo. **Rotação da senha do Postgres e da credencial Copel ainda pendente** — deve ser
  feita pelo responsável direto no painel de cada provedor (não delegável à IA).
- **2026-08-24** — `JWT_SECRET`, usado por `authMiddleware.js` para assinar/validar token,
  não estava definido em nenhum `.env`. Gerado um valor novo (`openssl rand -base64 48`) e
  adicionado ao `BACKEND/.env` local. Como nunca existiu valor anterior em uso, não há
  rotação de sessões ativas a invalidar.
