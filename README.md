# mdblist hub

Um front-end em Angular para as suas listas do [mdblist](https://mdblist.com):
todas as listas em fileiras horizontais e, ao clicar num título, uma página com
elenco, notas de todos os agregadores, reviews e biografias vindas da Wikipedia.

Você entra com a chave da API da sua própria conta do mdblist, e o site mostra
as **suas** listas.

Roda inteiramente no navegador — não há backend, banco de dados nem build de
servidor. As quatro APIs usadas respondem com `Access-Control-Allow-Origin: *`.

**Demo:** [mdblisthub.netlify.app](https://mdblisthub.netlify.app/)

**Stack:** Angular 22 (standalone, zoneless, signals), TypeScript, SCSS.

---

## Rodando

```bash
npm install
npm start       # http://localhost:4200
npm run build   # gera dist/mdblist-hub
```

Use `npm start` para o uso normal: os botões de watchlist/coleção/assistido
dependem do proxy declarado em `proxy.config.json`, que só existe no dev server
(o porquê está em [Escrita no mdblist](#escrita-no-mdblist)).

O `.npmrc` do projeto traz `bin-links=false`, necessário em sistemas de arquivos
sem suporte a symlinks (exFAT, por exemplo). Por isso os scripts do
`package.json` chamam o Angular CLI pelo caminho (`node node_modules/@angular/cli/bin/ng.js`)
em vez de depender do atalho `ng` — funciona com ou sem symlinks, inclusive no CI.

### Configuração

A chave do mdblist **não fica no código**: cada visitante entra com a sua na
tela de login. As do TMDB e do OMDb, que são do app e não do usuário, ficam em
[`src/app/core/api.config.ts`](src/app/core/api.config.ts).

Esse mesmo arquivo tem a constante `OWNER_USERNAME`, que decide qual das duas
visões a home mostra (veja [Login e as duas visões](#login-e-as-duas-visões)).
As listas curadas, seus nomes em português e a ordem estão em
[`src/app/core/list-catalog.ts`](src/app/core/list-catalog.ts) — para incluir
outra lista, basta adicionar uma entrada com o nome exato dela no mdblist.

---

## Funcionalidades

### Login e as duas visões

A primeira tela pede a chave da API do mdblist (ela está em
[mdblist.com/preferences](https://mdblist.com/preferences/), na seção *API
Key*). A chave é validada contra `GET /user` e guardada em `localStorage` — só
no navegador, sem passar por servidor nenhum. Um guard de rota
(`core/auth.guard.ts`) segura o app até essa checagem terminar, e leva de volta
para a página que você tentou abrir depois de entrar.

O `GET /user` também devolve o username, e é ele que escolhe a visão:

| Quem entrou | O que a home mostra |
| --- | --- |
| A conta em `OWNER_USERNAME` | As listas curadas: só as catalogadas, com nome em português, em ordem alfabética |
| Qualquer outra conta | **Todas** as listas dela, com o nome original, em ordem alfabética |

Ou seja, a exclusão de listas do `list-catalog.ts` vale só para o dono do site;
para as outras pessoas nada é escondido nem renomeado. O link "Minhas listas no
mdblist" e as ações de watchlist/coleção/assistido seguem sempre a conta que
está logada, e "Sair" limpa a chave e o cache HTTP.

### Home

- **Destaque** sorteado entre as suas listas, com botão para re-sortear.
- **Fileiras** — uma por lista, carregadas só quando entram na tela (`@defer`),
  paginando de 30 em 30 conforme você rola para o lado.
- **Busca por texto e por tema** — procura no catálogo completo do TMDB, por
  título e, ao mesmo tempo, pela tag de palavra-chave do TMDB (`zombie`,
  `time travel`, `female assassin`...). Isso traz títulos que nunca mencionam a
  palavra mas são tematicamente marcados com ela — buscar “zombie” encontra
  também “Guerra Mundial Z”, por exemplo. As tags são só em inglês, então um
  termo em português só entra nessa busca temática se coincidir com uma tag
  (nomes de título em português continuam funcionando normalmente).
- **Filtro por gênero** — procura **dentro das suas listas**, não no TMDB: varre
  todas as listas catalogadas e casa com as tags de gênero do próprio mdblist.
  Com um gênero ativo, o texto digitado vira um filtro de título dentro dele.
- **Porque você assistiu** — fileiras de recomendações do TMDB semeadas por
  títulos sorteados entre os últimos 45 vistos (lista `Last Watched`), excluindo
  o que já foi assistido. Um botão re-sorteia as sementes.

### Página do título

Backdrop, notas em anéis de progresso, sinopse, elenco, reviews, recomendações,
trailer e ficha técnica. Além disso:

- **Elenco clicável** — abre a biografia do ator vinda da Wikipedia, com data de
  nascimento, idade, local e os trabalhos mais conhecidos.
- **Ações do mdblist** — adicionar à watchlist, à coleção e marcar como
  assistido, com o estado atual já refletido no botão.

As tiras horizontais (elenco, e "mais conhecido por" no perfil do ator) têm
setas de navegação com uma leve animação de "pulinho" para indicar que dá pra
rolar — mesmo componente (`ui/scroll-track`) usado nas fileiras da home.

## Mobile

O layout é fluido (unidades `clamp()`/`min()`/`vw`, grades que se reorganizam
sozinhas) e recebeu uma checagem dedicada em viewport de celular: busca e
filtros empilham em colunas de largura cheia, a página do título reflui para
uma coluna, e a ficha técnica desce para depois do conteúdo principal.

---

## Como os dados são montados

| Fonte | Uso | Arquivo |
| --- | --- | --- |
| **mdblist** | listas, itens, todas as notas (IMDb, Rotten Tomatoes, Metacritic, Trakt, Letterboxd, TMDB, Roger Ebert), reviews espelhadas, watchlist/coleção/assistidos | `core/mdblist.service.ts`, `core/library.service.ts` |
| **TMDB** | elenco, backdrop, sinopse, trailer, busca, gêneros, recomendações e reviews | `core/tmdb.service.ts` |
| **Wikipedia / Wikidata** | biografia dos atores | `core/wikipedia.service.ts` |
| **OMDb** | classificação indicativa, prêmios, bilheteria | `core/omdb.service.ts` |

`core/media-detail.service.ts` junta tudo: o TMDB vem primeiro porque resolve o
IMDb id de que o OMDb depende; o resto roda em paralelo e cada fonte degrada
para `null` em vez de derrubar a página.

### Reviews

Vêm mescladas: primeiro as do TMDB, depois as que o mdblist espelha,
deduplicadas por autor + início do texto. Cada review mostra sua origem.

O mdblist espelha reviews de outras plataformas em
`GET /tmdb/{type}/{id}?append_to_response=review`, onde `provider_id: 1` é Trakt
e `2` é TMDB. É assim que as reviews do Trakt aparecem sem nenhuma chamada
direta à API do Trakt.

### Biografias (Wikipedia)

```
TMDB person id → Wikidata (haswbstatement:P4985=<id>) → Q-id
               → wbgetentities (sitelinks + claims)
               → intro do artigo (prop=extracts&exintro)
```

Todas as chamadas levam `origin=*`, que é o que libera CORS anônimo. O artigo em
português é preferido; abaixo de 200 caracteres ele é tratado como esboço e a
versão em inglês entra no lugar, com o idioma indicado ao lado do rótulo.

### Escrita no mdblist

```
POST /watchlist/items/add     |  /watchlist/items/remove
POST /sync/collection         |  /sync/collection/remove
POST /sync/watched            |  /sync/watched/remove
corpo: {"movies":[{"imdb":"tt..."}]}   (ou {"tmdb": 123}, ou "shows")
```

Essas chamadas **não funcionam direto do navegador**: um POST com corpo JSON
dispara preflight CORS e o mdblist responde `405` no `OPTIONS`; form-encoded ele
até aceita, mas interpreta errado. Por isso as escritas passam pelo proxy do dev
server (`proxy.config.json`, prefixo `/mdblist-api`). As leituras são GET comum e
não precisam de proxy.

Se for servir o `dist/` em outro lugar, replique essa regra de proxy no servidor
(nginx, Caddy, etc.) — sem ela, as três ações de biblioteca não gravam.

---

## Publicando

O site é estático, então qualquer host de arquivos serve. A única diferença
entre as opções é o proxy: **sem ele, tudo funciona menos os três botões de
biblioteca** (watchlist, coleção e assistido), que passam a mostrar um aviso.

### GitHub Pages — sem proxy

Já existe um workflow em `.github/workflows/deploy.yml`. Depois de enviar o
repositório, vá em **Settings → Pages → Source** e escolha **GitHub Actions**.
Cada push na `main` publica em `https://<usuario>.github.io/<repo>/`.

O workflow já cuida de dois detalhes: o `--base-href` apontando para a subpasta
do repositório e a cópia do `index.html` para `404.html`, sem a qual abrir um
link direto (`/title/movie/278`) devolveria erro.

### Cloudflare Pages ou Netlify — com proxy, tudo funciona

Ambos são gratuitos, publicam a partir do mesmo repositório do GitHub e
respeitam o arquivo `public/_redirects`, que já contém a regra de proxy. É a
opção recomendada se você quiser os botões de biblioteca funcionando.

Configuração em qualquer um dos dois:

| Campo | Valor |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist/mdblist-hub/browser` |

Não é preciso `--base-href` aqui, porque o site fica na raiz do domínio.

### Aviso sobre as chaves

O site publicado é uma página que roda no navegador de quem acessa: as chaves
que estão no `api.config.ts` (TMDB e OMDb) vão junto no JavaScript e ficam
legíveis por qualquer visitante — isso vale mesmo com o repositório privado.

A do mdblist não: ela é digitada na tela de login e fica no `localStorage` de
cada visitante. Como ela permite **escrever** na conta (watchlist, coleção,
histórico), é por isso que ela não é embutida no bundle.

---

## Limitações conhecidas

- **Trakt** — a API não é chamada diretamente. A chave usada pelos addons de
  Kodi que inspiraram este projeto retorna `403` em todos os endpoints (client id
  revogado), e a rota `/{tipo}/tmdb/{id}/comments` nem existe na API do Trakt
  (responde `405`). As reviews chegam espelhadas pelo mdblist, como descrito
  acima. Para voltar a usar o Trakt direto, é preciso um client id válido e um
  proxy — a API do Trakt também não responde ao preflight.
- **OMDb** — o plano gratuito tem cota de 1000 requisições por dia. Estourada a
  cota, a página apenas omite os campos que vêm dele (classificação indicativa,
  prêmios, bilheteria), sem exibir erro. As notas não dependem do OMDb.
- **Escrita sem proxy** — ver acima.

---

## Estrutura

```
src/app/
  core/       services, modelos, cache HTTP, normalização de notas, sessão
  ui/         media-card, media-row (carrossel), rating-badges, person-modal
  features/
    login/    chave da API do mdblist
    home/     destaque + fileiras + busca/gênero + "porque você assistiu"
    detail/   backdrop, notas, sinopse, elenco, reviews, recomendações
```

Detalhes de implementação que valem nota:

- `core/http-cache.interceptor.ts` guarda respostas GET por 10 minutos e
  deduplica requisições simultâneas idênticas — por isso o filtro de gênero, que
  varre todas as listas, só paga a rede na primeira vez.
- Os pôsteres do mdblist vêm em `w200`; a URL é reescrita para `w342`
  (`upscalePoster`) para não ficarem borrados em telas retina.
- Cada fileira só busca seus itens quando entra na viewport, com teto de 120
  itens por fileira para não construir milhares de nós no DOM.

---

## Créditos

Dados de [mdblist](https://mdblist.com), [TMDB](https://www.themoviedb.org),
[Trakt](https://trakt.tv), [OMDb](https://www.omdbapi.com) e
[Wikipedia](https://www.wikipedia.org).

Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.

## Licença

[MIT](LICENSE).
