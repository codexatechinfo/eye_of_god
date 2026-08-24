# Contribuindo

## Branches

- `main` é protegida: só recebe merge via Pull Request com CI verde.
- Branches de trabalho: `feat/<descrição-curta>`, `fix/<descrição-curta>`,
  `chore/<descrição-curta>`.

## Commits

Este projeto segue [Conventional Commits](https://www.conventionalcommits.org/pt-br/):

- `feat:` — funcionalidade nova
- `fix:` — correção de bug
- `chore:` — manutenção sem impacto em produção (deps, config, docs)
- `refactor:` — mudança de estrutura sem mudar comportamento
- `test:` — inclusão ou ajuste de testes

O tipo do commit alimenta o `CHANGELOG.md` e decide se a próxima versão sobe em patch,
minor ou major (SemVer).

## Abrindo um Pull Request

1. Rode `npm install` e os testes locais (`BACKEND` e `FRONTEND`) antes de abrir o PR.
2. Preencha o template de PR — em especial a seção "o que este PR não faz".
3. Nunca commitar `.env` ou qualquer credencial — o `gitleaks` roda no pre-commit e no CI e
   bloqueia o push se encontrar segredo.
4. Peça revisão de pelo menos uma pessoa listada em `.github/CODEOWNERS`.
