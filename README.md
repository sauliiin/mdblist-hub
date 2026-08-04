# mdblist hub

Site em Angular 22 + TypeScript que mostra suas listas do mdblist em fileiras
horizontais. Ao clicar em um título, abre a página de detalhes com **elenco**,
**notas** e **reviews**.

## Rodando

```bash
npm install     # o .npmrc já desativa bin-links (o disco é exFAT e não aceita symlinks)
npm start       # http://localhost:4200
npm run build   # gera dist/mdblist-hub
```

## Como os dados são montados

Todas as APIs são chamadas direto do navegador — as quatro respondem com
`Access-Control-Allow-Origin: *`, então não há backend nem proxy.

| Fonte | Uso | Arquivo |
| --- | --- | --- |
| **mdblist** | listas, itens e **todas as notas** (IMDb, Rotten Tomatoes, Metacritic, Trakt, Letterboxd, TMDB, Roger Ebert) | `core/mdblist.service.ts` |
| **TMDB** | elenco, backdrop, sinopse, trailer, recomendações e reviews de fallback | `core/tmdb.service.ts` |
| **Trakt** | reviews (endpoint de comentários) | `core/trakt.service.ts` |
| **OMDb** | classificação indicativa, prêmios, bilheteria | `core/omdb.service.ts` |

`core/media-detail.service.ts` junta tudo: o TMDB vem primeiro porque resolve o
IMDb id de que Trakt e OMDb dependem; o resto roda em paralelo e cada fonte
degrada para `null` em vez de derrubar a página.

As chaves ficam em `core/api.config.ts`.

### Estado das chaves (04/08/2026)

- **mdblist** e **TMDB**: funcionando.
- **Trakt**: retorna **403 Forbidden** em todos os endpoints. Foi testada a
  requisição idêntica à do addon `script.showimdb` (mesma chave, mesmos headers,
  `limit=200&sort=likes`, inclusive via `requests` em Python) — mesmo 403, com
  headers de resposta do Rails, ou seja, é rejeição do próprio Trakt: o client id
  está revogado ou suspenso. Basta trocar `API.trakt.clientId` por uma chave
  válida que as reviews do Trakt voltam automaticamente.
- **OMDb**: `Request limit reached!` (cota de 1000/dia estourada). Volta sozinha
  no dia seguinte; enquanto isso as notas vêm do mdblist.

Quando o Trakt falha, a página mostra um aviso e cai para as reviews do TMDB.

### Reviews do Trakt

Replicam `resources/lib/trakt_api.py` do addon:

```
filmes: https://api.trakt.tv/movies/{imdb_id}/comments
séries: https://api.trakt.tv/shows/{imdb_id}/comments
        headers: trakt-api-version: 2, trakt-api-key
        params:  limit=200&sort=likes
```

Filtros iguais aos do addon (máx. 50 reviews, descarta vazias, aceita apenas
usuários com idioma pt/en/es). A única diferença: comentários longos e spoilers
não são descartados — a web recolhe os longos com “Ler tudo” e esconde spoilers
atrás de um clique, o que o skin do Kodi não conseguia fazer.

## Listas exibidas

`core/list-catalog.ts` define as 16 listas mostradas, o rótulo em português de
cada uma e a ordem (alfabética, colação pt-BR). Para incluir outra lista, basta
adicionar uma entrada com o nome exato dela no mdblist.

## Estrutura

```
src/app/
  core/       services, modelos, cache HTTP, normalização de notas
  ui/         media-card, media-row (carrossel), rating-badges
  features/
    home/     hero + fileiras (cada fileira é @defer on viewport)
    detail/   backdrop, notas, sinopse, elenco, reviews, recomendações
```

Detalhes de implementação que valem nota:

- `core/http-cache.interceptor.ts` guarda GETs por 10 min e deduplica
  requisições simultâneas iguais — voltar para a home é instantâneo.
- Cada fileira só busca seus itens quando entra na viewport (`@defer`), e pagina
  de 30 em 30 conforme você rola para o lado (teto de 120 por fileira).
- Os pôsteres do mdblist vêm em `w200`; a URL é reescrita para `w342`
  (`upscalePoster`) para não ficarem borrados.
