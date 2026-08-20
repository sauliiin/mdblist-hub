# OmniStream

A versão web do OmniStream — o mesmo projeto dos apps de TV e celular, agora
no navegador. Um front-end em Angular para as suas listas do
[mdblist](https://mdblist.com): todas as listas em fileiras horizontais e, ao
clicar num título, uma página com elenco, notas de todos os agregadores,
reviews e biografias vindas da Wikipedia.

Você entra com a chave da API da sua própria conta do mdblist, e o site mostra
as **suas** listas.

Roda inteiramente no navegador — não há backend, banco de dados nem build de
servidor. As APIs de leitura respondem com `Access-Control-Allow-Origin: *`; as
duas exceções (escrita no mdblist e o Trakt inteiro) passam por proxies
same-origin declarados em `proxy.config.json`, `vercel.json` e `worker.js`.

**Site:** [openstream.com.br](https://openstream.com.br/)

**Stack:** Angular 22 (standalone, zoneless, signals), TypeScript, SCSS.

---

## Rodando

```bash
npm install
npm start       # http://localhost:4200
npm run build   # gera dist/mdblist-hub
```

Use `npm start` para o uso normal: os botões de watchlist/coleção/assistido e
tudo que fala com o Trakt dependem dos proxies declarados em
`proxy.config.json`, que só existem no dev server (o porquê está em
[Escrita no mdblist](#escrita-no-mdblist)).

O `.npmrc` do projeto traz `bin-links=false`, necessário em sistemas de arquivos
sem suporte a symlinks (exFAT, por exemplo). Por isso os scripts do
`package.json` chamam o Angular CLI pelo caminho (`node node_modules/@angular/cli/bin/ng.js`)
em vez de depender do atalho `ng` — funciona com ou sem symlinks, inclusive no CI.

### Configuração

A chave do mdblist **não fica no código**: cada visitante entra com a sua na
tela de login. As do TMDB e do OMDb, que são do app e não do usuário, ficam em
[`src/app/core/api.config.ts`](src/app/core/api.config.ts).

---

## Funcionalidades

### Login e a home de cada um

A primeira tela pede a chave da API do mdblist (ela está em
[mdblist.com/preferences](https://mdblist.com/preferences/), na seção *API
Key*). A chave é validada contra `GET /user` e guardada em `localStorage` — só
no navegador, sem passar por servidor nenhum. Um guard de rota
(`core/auth.guard.ts`) segura o app até essa checagem terminar, e leva de volta
para a página que você tentou abrir depois de entrar.

A home mostra **todas** as listas da conta que entrou, com o nome original, em
ordem alfabética (`core/list-catalog.ts#alphabetical`) — o site não é mais
pré-curado para nenhuma conta específica. Cada visitante tem suas próprias
ferramentas para chegar na home que quiser: o modo de edição (botão na home)
deixa renomear, ocultar e reordenar as próprias listas, guardado por
`core/list-prefs.service.ts` e aplicado por cima da lista alfabética
(`core/list-catalog.ts#applyPrefs`). Uma vez com conta Google vinculada (veja
[Preferências sincronizadas por conta Google](#preferências-sincronizadas-por-conta-google)),
essas mesmas preferências acompanham a conta entre aparelhos — o celular, a TV
e o navegador convergem para a mesma curadoria.

O link "Minhas listas no mdblist" e as ações de watchlist/coleção/assistido
seguem sempre a conta que está logada, e "Sair" limpa a chave e o cache HTTP.

### Home

- **Destaque** sorteado entre as suas listas, com botão para re-sortear.
- **Fileiras** — uma por lista, carregadas só quando entram na tela (`@defer`),
  com **30 títulos** cada. Ao chegar ao fim da fileira há um card
  **"+ Carregar mais"** que busca os próximos 30. É deliberadamente um pedido
  explícito e não carregamento automático ao rolar: cada card a mais é um
  pôster a baixar e decodificar, mais nós no DOM, e mais um candidato que a
  navegação por controle remoto precisa avaliar a cada tecla.
- **Continuar assistindo** — logo abaixo do destaque, alimentada por
  `GET /sync/playback` do mdblist (veja [Scrobble](#scrobble-e-continuar-assistindo)).
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
- **Ações da biblioteca** — adicionar à watchlist, à coleção e marcar como
  assistido, com o estado atual já refletido no botão. Vale para o mdblist ou
  para o Trakt, conforme a fonte escolhida em `/addons`.
- **Resetar progresso** — remove o ponto salvo no mdblist/Trakt diretamente na
  ficha sempre que o título aparece em “Continuar assistindo”.
- **Episódios** — séries ganham a fileira de episódios que os apps de TV e
  celular já tinham: seletor de temporada, still de cada episódio, sinopse,
  duração, a **data de exibição** ("sex., 18/12/2026" em português, "Fri, Dec
  18, 2026" em inglês) e um **✓ nos que já foram assistidos**, com o contador
  "✓ 4/10" ao lado do título da seção. Episódio ainda não exibido tem a data
  destacada; clicar em qualquer um abre o player já naquele episódio.

As tiras horizontais (elenco, e "mais conhecido por" no perfil do ator) têm
setas de navegação com uma leve animação de "pulinho" para indicar que dá pra
rolar — mesmo componente (`ui/scroll-track`) usado nas fileiras da home.

### Addons e player

O hub fala o **protocolo de addon do Stremio**, que é só HTTP + JSON e responde
com `Access-Control-Allow-Origin: *` — então roda direto do navegador, como as
outras quatro APIs. Nenhum addon vem embutido: a lista é colada pelo visitante em
`/addons` e fica em `localStorage`, junto da chave do mdblist.

Como `localStorage` é por navegador **e por origem**, a mesma pessoa no celular —
ou no site publicado em vez do dev server — começaria com a lista vazia. Para
isso a página de Addons tem **login da conta Stremio**: `api.strem.io` também
libera CORS, então o app lê a coleção da conta (`addonCollectionGet`) e importa
tudo já configurado, chave de debrid inclusa. A senha vai direto para a API do
Stremio e não é guardada; o que fica salvo é o `authKey` devolvido por ela.

O botão **Assistir** na ficha abre `/watch/:type/:id`, que consulta o recurso
`stream` de cada addon instalado — pelo IMDb ID no caso de filme, e por
`imdb:temporada:episódio` no de série, com seletor de temporada/episódio vindo do
TMDB. A escolha de episódio vai para a URL (`?season=2&episode=5`), então o link
é compartilhável.

As fontes HTTPS diretas entram numa corrida com até **16 probes simultâneos**.
Cada probe tem 16 segundos para produzir frames; o primeiro que chega a
`playing` assume o player visível e todos os demais são cancelados. Quando um
probe falha ou revela um clipe de remoção, a vaga é imediatamente preenchida
pelo próximo link, sem serializar toda a lista atrás de um CDN lento.

### Scrobble e continuar assistindo

O mdblist tem uma API de scrobble dedicada (documentada em
`api.mdblist.com/schema/`), e o player fala com ela: `start` ao dar play e a
cada 60s de reprodução, `pause` ao pausar, `stop` ao terminar, ao sair da página
e ao fechar a aba. Acima de 80% o próprio mdblist marca o título como assistido.

Como a sessão vive no mdblist e não aqui, um filme pausado no celular reaparece
no desktop. `GET /sync/playback` alimenta a fileira **Continuar assistindo** na
home, e o player retoma sozinho do ponto guardado.

Duas coisas valem nota:

- **O corpo segue o JSON aninhado da API**: filmes usam `movie.ids`; episódios
  usam `show.ids`, `show.season.number` e `show.season.episode.number`. Como o
  mdblist responde `405` ao preflight de um POST JSON direto, as escritas passam
  pelo proxy same-origin `/mdblist-api`.
- **Fechar a aba** nunca chega ao `ngOnDestroy`, então o `stop` desse caso sai
  por `navigator.sendBeacon` para o mesmo proxy, preservando o corpo JSON.

O `/sync/playback` devolve `progress_at_update`, `updated_at_ts` e `runtime`
justamente para o cliente projetar o ponto atual de uma sessão ainda rodando;
`toResumeItem` faz essa conta e congela o valor quando a sessão está pausada.

### Trakt como fonte da biblioteca

Watchlist, coleção, assistidos e o ponto de reprodução podem vir do **Trakt** em
vez do mdblist — a mesma opção que os apps de TV e celular oferecem, e a mesma
credencial (a do addon `plugin.video.pov` do Kodi; criar um registro novo no
Trakt hoje exige VIP).

A conexão é o **device flow**: `/addons` pede um código ao Trakt, mostra o código
na tela e fica perguntando de tempos em tempos se já foi aprovado. Você digita o
código em `auth.trakt.tv/activate` — no mesmo navegador ou no celular — e a
conexão se fecha sozinha. Conectar **já troca a fonte para o Trakt**: passar por
um device flow é o pedido de usar o Trakt, e perguntar de novo depois seria
perguntar duas vezes. O par de tokens fica no `localStorage`, e o access token
(sete dias de validade) é renovado sozinho na primeira resposta `401`.

O que muda com o Trakt selecionado:

| | mdblist | Trakt |
| --- | --- | --- |
| Watchlist / coleção | `/watchlist/items`, `/sync/collection` | `sync/watchlist/{tipo}`, `sync/collection/{tipo}` |
| Assistidos | `/sync/watched` (episódios em lista plana) | `sync/watched/shows` (episódios aninhados por temporada) |
| Marcar como assistido | `POST /sync/watched` | `POST sync/history` — no Trakt "assistido" é o histórico, não um balde |
| Continuar assistindo | `GET /sync/playback` | `sync/playback/movies` + `/episodes`, duas chamadas juntadas aqui |
| Remover da fileira | `scrobble/clear` pelo título | `DELETE sync/playback/{id}`, pelo id da sessão |

Duas diferenças de formato valem nota. O Trakt não tem nada parecido com o
`unified=true` do mdblist, então toda leitura são **duas chamadas** (filmes e
séries) juntadas localmente. E as leituras paginadas do Trakt devolvem **dez
itens** por padrão quando não se pede outra coisa — não "tudo" —, então cada uma
pede 100 por página e caminha até uma página vir curta.

O que **não** muda: as fileiras da home continuam sendo as listas do mdblist, que
são o motivo de o site existir. A chave do mdblist segue obrigatória para entrar.

### Sincronizar addons entre aparelhos

A página de Addons guarda a lista no **Realtime Database**, pela interface REST
e não pelo SDK do Firebase — duas chamadas num caminho só é tudo que isso
precisa, `HttpClient` já fala HTTP e o endpoint libera CORS, então o recurso
entrou sem nenhuma dependência nova.

O caminho é `mdblist-hub/addons/{sha256("mdblist-hub:" + chave do mdblist)}`.
Chavear pela chave da API e não pelo id da conta faz do próprio caminho um
segredo: saber seu usuário do mdblist não permite montá-lo.

Semântica: **último a escrever vence**. Toda alteração local sobe sozinha
(agrupada por 1,5s), e **Baixar** substitui a lista local pela guardada — de
propósito, porque merge só sabe somar, e uma remoção feita em outro aparelho
nunca chegaria. Ligar o sync é a única operação que une as duas listas, para
não descartar o que já existia neste navegador.

#### Regras do banco — necessário

Hoje o banco responde leitura **e** escrita sem autenticação, e os filhos são
enumeráveis: um `GET /mdblist-hub/addons.json?shallow=true` lista todos os
tokens, o que anula o segredo do caminho. Como a URL configurada de um addon de
torrent **contém sua chave de debrid**, isso importa. Estas regras preservam os
nós já existentes e fecham a enumeração do novo:

```json
{
  "rules": {
    "config":      { ".read": true, ".write": true },
    "juntas":      { ".read": true, ".write": true },
    "relatores":   { ".read": true, ".write": true },
    "users":       { ".read": true, ".write": true },
    "mdblist-hub": {
      "addons": {
        "$token": { ".read": true, ".write": true }
      }
    }
  }
}
```

Sem `.read` no nível de `addons`, só quem conhece o token exato lê aquele nó.
Os quatro primeiros nós continuam abertos porque é como estão hoje — vale
revisá-los à parte.

O player é próprio (`ui/video-player`), não o `controls` nativo: barra de
progresso com buffer e bolha de tempo ao arrastar, volume, velocidade, legenda,
modo cinema, tela cheia e os atalhos de teclado que o YouTube consagrou —
`espaço`/`k`, `j`/`l` (±10s), setas (±5s), `m`, `f`, `t`, `c`, `0`–`9`. Os
controles somem sozinhos durante a reprodução; **OK/Enter** os traz de volta e,
com eles já visíveis, dá play/pause — um controle remoto não gera `pointermove`,
então sem isso não haveria como reexibi-los numa TV.

A escolha de legenda, a **sincronia** (arraste de −60s a +60s, com "repor"),
fonte, cor e faixa de áudio (quando o navegador reporta mais de uma) ficam
**dentro** do player, não só na barra lateral da página: em tela cheia — que é
como se assiste na TV e no celular — a barra lateral não existe, e sem isso não
haveria como trocar de legenda. A sincronia edita `startTime`/`endTime` das
cues carregadas, que são objetos vivos; o desvio zera ao trocar de legenda ou
de vídeo, para não herdar o ajuste anterior.

As sugestões na página de Addons (Torrentio, MediaFusion, Comet, AIOStreams | ElfHosted,
OpenSubtitles) foram verificadas contra os endpoints reais. As quatro de fontes
**exigem configuração**: sem ela o Torrentio devolve torrent, o MediaFusion
responde lista vazia, o Comet responde `403` e o AIOStreams sequer serve um
manifest de addon no endereço base — serve o manifest PWA do próprio site. Por
isso só o addon de legendas tem botão de instalação direta; os outros levam à
página de configuração, de onde sai a URL por usuário.

**Legendas** vêm do recurso `subtitles` dos addons e também das buscas diretas no
OpenSubtitles.com e no Wyzie. As fontes diretas consultam pt-BR, pt e en em
paralelo. Quando o vídeo começa de fato, o player seleciona português (com inglês
como fallback) e compara qualidade, origem, codec e release group da legenda com
o release que entrou em reprodução; uma escolha manual, inclusive "sem legenda",
sempre prevalece. Como `<track>` só lê WebVTT e as fontes servem SubRip, o arquivo
é baixado, convertido para VTT e entregue como `blob:`. Arquivos em windows-1252
(comum em legendas pt-BR) são detectados e decodificados certo.

O que o player toca e o que não toca está em [Limitações](#limitações-conhecidas).

Links mortos que reproduzem um clipe de aviso em vez do título também entram no
failover automático. O player reconhece a faixa típica desses avisos (30s–2min),
mas só rejeita o arquivo quando ele também tem menos da metade da duração esperada
do filme ou episódio. Assim um curta legítimo não é confundido com “vídeo
removido”; sem runtime confiável, a heurística fica desligada.

### Preferências sincronizadas por conta Google

Além da lista de addons (acima, chaveada pela chave do mdblist), um segundo
conjunto de preferências — hoje o rename/hide/reorder das listas
(`core/list-prefs.service.ts`) e a fonte da legenda (`core/subtitle-prefs.service.ts`)
— sincroniza entre aparelhos por **conta Google**, a mesma que os apps Android
e TV já usam para entrar. `core/google-auth.service.ts` troca um ID token do
Google Identity Services por uma sessão no projeto Firebase `safevault-fcbdc`
(REST puro, sem o SDK completo do Firebase Auth — o mesmo raciocínio do sync de
addons: são só algumas chamadas). O botão de vincular fica na tela de Login e
em Addons.

Cada serviço de preferência tem seu próprio serviço de sync
(`core/sync/preferences-sync.service.ts`, `core/sync/list-prefs-sync.service.ts`),
mas os dois seguem o mesmo desenho: gravam sob `users/{uid}/...` no mesmo banco,
debatem uma rajada de mudanças locais num único `PUT` (1,5s), e marcam um sinal
`applying` durante um `pull()` para a mudança que acabou de chegar de outro
aparelho não ecoar de volta como se fosse nova. Diferente do sync de addons,
aqui **é seguro fazer merge automático** — nenhuma dessas preferências tem uma
operação "remover" que um merge ingênuo perderia, então ligar a conta já basta,
sem o botão explícito de "Baixar".

## Mobile

O layout é fluido (unidades `clamp()`/`min()`/`vw`, grades que se reorganizam
sozinhas) e recebeu uma checagem dedicada em viewport de celular: busca e
filtros empilham em colunas de largura cheia, a página do título reflui para
uma coluna, e a ficha técnica desce para depois do conteúdo principal.

### APK Android para uso pessoal

Este repositório contém só o site. O empacotamento em APK (wrapper Capacitor
`mobile`/`tv` e o app nativo para Android TV) vive no repo irmão
[`mdblist-hub-apk`](../mdblist-hub-apk), que lê o build deste projeto em
`dist/mdblist-hub/browser` para montar os APKs — veja o README de lá para os
comandos de build, flavors e instalação.

O restante desta seção documenta como o *front-end* reconhece que está
rodando numa TV, o que é lógica deste repo independentemente de onde o APK é
montado.

### Android TV

O flavor `tv` declara `android.software.leanback` como obrigatório e
`android.hardware.touchscreen` como **não** obrigatório — a segunda metade é a
que costuma ser esquecida, e sem ela launchers e a Play Store tratam o app como
incompatível com aparelho sem toque. Ele também carrega banner próprio e a
categoria `LEANBACK_LAUNCHER`, sem a qual não aparece no launcher de TV.

O front-end reconhece que está numa TV por três sinais, nesta ordem: o arquivo
`tv-build.json`, presente apenas no flavor `tv`; `(pointer: none)`, que um
set-top box reporta e um celular não; e marcadores de user agent. Um override em
`localStorage` vence todos, que é o que permite testar o layout de TV no
navegador:

```js
localStorage.setItem('mdblist-hub.tv', 'on')   // 'off' desliga, remover volta ao automático
```

**Navegação pelo controle** (`core/tv/spatial-navigation.ts`) é resolvida por
geometria, não pela ordem do DOM — apertar → dentro de uma fileira tem que ir
para o pôster seguinte, não para o que vem depois no HTML. Esquerda e direita
ficam travadas na própria fileira; cima e baixo são o movimento que troca de
lista. Regiões que tratam as próprias teclas se excluem com
`data-spatial="off"` (o player, onde as setas são busca e volume), e regiões que
o D-pad deve pular usam `data-nav-skip` (a barra de filtros, o rodapé de
créditos). `data-nav-down` e irmãos permitem um destino explícito quando a
geometria não sabe a intenção.

O foco é fixo: a fileira ativa encosta o título num ponto fixo do topo
(`scroll-margin-top` nos `[data-row]`) e o pôster em foco ocupa sempre a mesma
posição horizontal, com os demais deslizando por baixo (`scroll-snap-type: x
mandatory` + `scroll-snap-align: start` nos cards).

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

Os prefixos são quatro, e os três arquivos que os declaram — `proxy.config.json`
(dev server), `vercel.json` e `worker.js` (produção) — precisam concordar:

```
/mdblist-api       → https://api.mdblist.com
/opensubtitles-api → https://api.opensubtitles.com/api/v1
/trakt-api         → https://api.trakt.tv
/trakt-auth        → https://auth.trakt.tv
```

O Trakt entra aqui por um motivo um pouco diferente do mdblist: ele não devolve
cabeçalho de CORS nenhum, nem nas leituras. Pelo proxy tudo vira same-origin, que
nunca é pré-verificado.

Se for servir o `dist/` em outro lugar, replique essas regras de proxy no
servidor (nginx, Caddy, etc.) — sem elas, as três ações de biblioteca não gravam
e o Trakt não conecta.

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

- **Trakt** — a API responde, mas não ao navegador: não manda cabeçalho de CORS
  nenhum, então tanto `api.trakt.tv` quanto `auth.trakt.tv` são chamados pelos
  proxies same-origin `/trakt-api` e `/trakt-auth` (o APK, que não tem essa
  regra, fala direto). O client id/secret são emprestados de um addon de Kodi e
  vão no bundle, como vão no APK: é a identidade de outro projeto, revogável a
  qualquer momento — se tudo do Trakt começar a falhar de uma vez, é o primeiro
  lugar para olhar. Contas Trakt gratuitas conectam **um app de terceiros por
  vez**. As reviews continuam chegando espelhadas pelo mdblist: a rota
  `/{tipo}/tmdb/{id}/comments` não existe na API do Trakt (responde `405`).
- **OMDb** — o plano gratuito tem cota de 1000 requisições por dia. Estourada a
  cota, a página apenas omite os campos que vêm dele (classificação indicativa,
  prêmios, bilheteria), sem exibir erro. As notas não dependem do OMDb.
- **Escrita sem proxy** — ver acima.
- **Torrent não toca no navegador** — o player é o `<video>` nativo, então só
  reproduz o que chegar como link HTTPS direto. Addons de torrent devolvem
  `infoHash`, e nenhum navegador fala BitTorrent: esses streams aparecem na lista
  marcados, com o magnet à mão para abrir em outro player. Para reproduzir aqui,
  configure o addon com um **debrid** (Real-Debrid, AllDebrid, Premiumize) — aí
  ele passa a devolver HTTPS direto.
- **Containers e HLS** — mesmo com link direto, MKV não é demuxado por Chrome
  nem Firefox, e HLS (`.m3u8`) só toca nativamente no Safari. O player avisa
  antes e oferece o link para um player externo em vez de falhar em silêncio.
  Suportar esses casos exigiria embarcar um demuxer (hls.js e afins), o que o
  projeto evita para manter a lista de dependências como está. **No APK Android
  isso é menos restritivo**: o stack de mídia do sistema demuxa Matroska e HLS
  nativamente, então boa parte desses avisos não se aplica no aparelho.
- **Legendas com CORS fechado** — o addon lista o arquivo, mas quem o hospeda
  nem sempre libera leitura cross-origin. Nesses casos a legenda falha com aviso;
  as outras da lista continuam disponíveis.
- **Sincronização de addons exige https ou localhost** — o token é derivado com
  `crypto.subtle`, que o navegador só expõe em contexto seguro. Netlify e o
  Capacitor (que serve de `https://localhost`) atendem; testar o dev server pelo
  celular em `http://192.168.x.x:4200` não. A tela diz isso explicitamente em vez
  de reportar erro de rede.
---

## Estrutura

```
src/app/
  core/       services, modelos, cache HTTP, normalização de notas, sessão
    stremio/  protocolo de addon: manifests, streams, legendas (SRT→VTT),
              e login da conta Stremio para importar a coleção
    sync/     lista de addons no Realtime Database, via REST
    scrobble/ pontos de reprodução (start/pause/stop/clear), mdblist ou Trakt
    trakt/    device flow, tokens e a API do Trakt como fonte de biblioteca
    tv/       detecção de Android TV e navegação espacial por D-pad
  ui/         media-card, media-row (carrossel), rating-badges, person-modal,
              video-player (player próprio), bottom-nav (tabs no celular)
  features/
    login/    chave da API do mdblist
    home/     destaque + continuar assistindo + fileiras + busca/gênero
    detail/   backdrop, notas, sinopse, episódios, elenco, reviews, recomendações
    addons/   instalar e remover addons do Stremio
    player/   fontes, seletor de episódio, legendas, <video>
```

Detalhes de implementação que valem nota:

- `core/http-cache.interceptor.ts` guarda respostas GET por 10 minutos e
  deduplica requisições simultâneas idênticas — por isso o filtro de gênero, que
  varre todas as listas, só paga a rede na primeira vez. As consultas a addons
  passam por fora dele (`noCache()`): link de debrid é gerado por requisição e
  expira, então um cacheado entregaria uma URL morta ao player.
- Os pôsteres do mdblist vêm em `w200`; a URL é reescrita para `w342`
  (`upscalePoster`) para não ficarem borrados em telas retina — **exceto na TV**,
  onde o card mede 113–178px e `w185` já é mais pixels do que chegam a ser
  pintados. Pedir `w342` ali era rede e decodificação gastas em detalhe que
  ninguém vê, o que pesa numa CPU fraca de set-top box.
- Cada fileira só busca seus itens quando entra na viewport, com teto de 120
  itens por fileira para não construir milhares de nós no DOM.
- **Não há cache de imagem próprio, de propósito.** Uma camada
  `Map<url, Blob>` chegou a existir e foi removida: o CDN do TMDB responde
  `cache-control: public, max-age=31919000` com etag, então o navegador já
  cacheia em disco entre sessões. A camada extra só duplicava esse trabalho e
  ainda perdia a decodificação progressiva, porque esperava o arquivo inteiro
  baixar antes de começar.
- O app roda **zoneless** (`provideZonelessChangeDetection()`, sem `zone.js`
  nas dependências), com `strict` e `strictTemplates` ligados.

---

## Créditos

Dados de [mdblist](https://mdblist.com), [TMDB](https://www.themoviedb.org),
[Trakt](https://trakt.tv), [OMDb](https://www.omdbapi.com) e
[Wikipedia](https://www.wikipedia.org).

Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.

## Licença

[MIT](LICENSE).
