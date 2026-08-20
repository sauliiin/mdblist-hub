import { Injectable, Pipe, PipeTransform, computed, signal } from '@angular/core';

export type AppLanguage = 'en' | 'pt';

const STORAGE_KEY = 'mdblist-hub.language';

/**
 * English copy is used as the translation key as well as the fallback. This
 * keeps templates readable and makes missing translations fail safely in the
 * default language instead of rendering an opaque identifier.
 */
const PT: Record<string, string> = {
  'Language': 'Idioma',
  'Appearance': 'Aparência',
  'Default': 'Normal',
  'My lists on mdblist': 'Minhas listas no mdblist',
  'Sign out': 'Sair',
  'Guest': 'Convidado',
  'Browsing with the shared guest key': 'Navegando com a chave compartilhada de convidado',
  'No mdblist key is saved for this Google account yet — paste yours below and it will be saved for your other devices.':
    'Nenhuma chave do mdblist salva nesta conta Google ainda — cole a sua abaixo e ela ficará guardada para os seus outros aparelhos.',
  'The key saved for this Google account is the shared guest one — paste your own below to replace it.':
    'A chave guardada nesta conta Google é a de convidado — cole a sua abaixo para substituí-la.',
  'The key saved for this Google account no longer works — paste a current one below.':
    'A chave guardada nesta conta Google não funciona mais — cole uma atual abaixo.',
  'Data from mdblist, TMDB, Trakt and OMDb.': 'Dados de mdblist, TMDB, Trakt e OMDb.',
  'This product uses the TMDB API but is not endorsed or certified by TMDB.':
    'Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.',
  'Your mdblist lists in rows, with cast, ratings and reviews.':
    'Suas listas do mdblist em fileiras, com elenco, notas e reviews.',
  'Sign in — OmniStream': 'Entrar — OmniStream',
  'OmniStream — your lists': 'OmniStream — suas listas',
  'Details — OmniStream': 'Detalhes — OmniStream',
  'Watch — OmniStream': 'Assistir — OmniStream',

  'Sign in with your mdblist account': 'Entre com sua conta do mdblist',
  'Your lists, exactly as they are on mdblist. All you need is the API key — it is stored only in this browser and never passes through any server.':
    'Suas listas, do jeito que estão no mdblist. Basta a chave da API — ela fica salva só neste navegador e não passa por servidor nenhum.',
  'Disconnect': 'Desconectar',
  'Google account connected — your subtitle source and installed addons follow you to any device (website, APK or TV) signed in with the same account.':
    'Conta Google conectada — a fonte da legenda e os addons instalados acompanham qualquer aparelho (site, APK ou TV) que entrar com a mesma conta.',
  'Connecting…': 'Conectando…',
  'Continue with Google': 'Continuar com Google',
  'Optional — this does not replace the mdblist key below. It is only used to sync preferences and addons between this website, the APK and your TV.':
    'Opcional — não substitui a chave do mdblist abaixo. Serve só para sincronizar preferências e addons entre este site, o APK e a TV.',
  'Restoring your account from the saved key…': 'Restaurando sua conta a partir da chave salva…',
  'API key': 'Chave da API',
  'paste your key here': 'cole aqui sua chave',
  'Hide key': 'Ocultar a chave',
  'Show key': 'Mostrar a chave',
  'Hide': 'Ocultar',
  'Show': 'Mostrar',
  'Signing in…': 'Entrando…',
  'Sign in': 'Entrar',
  'You can find the key at': 'A chave está em',
  'under the': 'na seção',
  'section. No account?': 'Não tem conta?',
  'Create one for free': 'Crie uma de graça',
  'Could not reach mdblist. Check your connection.':
    'Não foi possível falar com o mdblist. Verifique sua conexão.',
  'Invalid key. Make sure you copied the entire key from your mdblist preferences.':
    'Chave inválida. Confira se copiou a chave inteira das preferências do mdblist.',

  'The hub supports the Stremio addon protocol. Paste an addon URL and it will provide streams and subtitles on each title page. Nothing comes preinstalled — the list is stored only in this browser, just like your mdblist key.':
    'O hub fala o protocolo de addon do Stremio. Cole a URL de um addon e ele passa a responder pelas fontes e legendas na página de cada título. Nada vem instalado — a lista fica salva só neste navegador, como a sua chave do mdblist.',
  'Google account connected': 'Conta Google conectada',
  'the same account used by the APK and TV.': 'a mesma conta que o APK e a TV usam.',
  'Connect Google account': 'Conectar conta Google',
  'Required to enable the addon sync below and sync the subtitle source in the player between this website, the APK and your TV. It does not replace the mdblist key.':
    'Necessário para ligar a sincronização de addons abaixo e a fonte da legenda no player entre este site, o APK e a TV. Não substitui a chave do mdblist.',
  'Connect': 'Conectar',
  'Sync addons and lists across devices': 'Sincronizar addons e listas entre aparelhos',

  'No Trakt account connected': 'Nenhuma conta Trakt conectada',
  'Connected as {handle}.': 'Conectado como {handle}.',
  'Connect it to read your watchlist, collection, watched history and playback position from Trakt instead of mdblist — the same choice the TV and phone apps offer. Free Trakt accounts connect only one third-party app at a time.':
    'Conecte para ler watchlist, coleção, assistidos e o ponto de reprodução do Trakt em vez do mdblist — a mesma escolha que os apps de TV e celular oferecem. Contas Trakt gratuitas conectam só um app de terceiros por vez.',
  'Connect Trakt': 'Conectar Trakt',
  'Asking Trakt for a code…': 'Pedindo um código ao Trakt…',
  'Go to': 'Acesse',
  'and enter:': 'e informe:',
  'Code expires in {time}': 'O código expira em {time}',
  'Connected — Trakt is now the library source.':
    'Conectado — o Trakt agora é a fonte da biblioteca.',
  'Library source': 'Fonte da biblioteca',
  'Watchlist, watched, collection and continue watching':
    'Watchlist, assistidos, coleção e continuar assistindo',
  'the lists on the home page are always mdblist’s.':
    'as listas da home são sempre do mdblist.',
  'The code expired before it was approved. Ask for a new one.':
    'O código expirou antes de ser aprovado. Peça um novo.',
  'Access was denied on Trakt.': 'O acesso foi recusado no Trakt.',
  'Could not reach Trakt. Try again.': 'Não foi possível falar com o Trakt. Tente de novo.',
  'Trakt did not recognise this title.': 'O Trakt não reconheceu este título.',
  'No Trakt account linked.': 'Conta Trakt não conectada.',
  'on': 'ligado',
  'off': 'desligado',
  'Stores your addon list and everything you renamed, hid or reordered on the home page in the cloud, linked to the Google account above. Enable it on devices signed in with that account and everything stays in sync, without requiring a Stremio account. Every change uploads automatically; there is nothing else to press.':
    'Guarda a lista de addons e o que você renomeou/ocultou/reordenou na home, na nuvem, atrelado à sua conta Google acima. Ligue nos aparelhos que entrarem com essa conta e tudo acompanha, sem depender de conta do Stremio. Toda alteração sobe sozinha; não precisa apertar nada depois.',
  'Turn off': 'Desligar',
  'Turn on': 'Ligar',
  'Make this device identical to the saved version, including removing items deleted on another device':
    'Deixa este aparelho idêntico ao que está salvo, inclusive removendo o que foi apagado em outro',
  'Download': 'Baixar',
  'Upload': 'Enviar',
  'Updated — {count} item(s) differed between addons and lists.':
    'Atualizado — {count} item(ns) de diferença entre addons e listas.',
  'Nothing changed — this device was already up to date.':
    'Nada mudou — este aparelho já estava em dia.',
  'Stremio account connected': 'Conta Stremio conectada',
  'Syncing…': 'Sincronizando…',
  'Sync now': 'Sincronizar agora',
  'Import addons from your Stremio account': 'Trazer os addons da sua conta Stremio',
  'The list below lives only in this browser. Sign in to Stremio to import your entire collection, including configured URLs and debrid keys. Your password goes directly to api.strem.io and is never stored; only the session key it returns is saved.':
    'A lista abaixo mora só neste navegador. Entrando com sua conta do Stremio, a coleção inteira vem pronta — já com as URLs configuradas, chave de debrid incluída. A senha vai direto para api.strem.io e não fica salva: o que guardamos é a chave de sessão que ela devolve.',
  'Stremio email': 'e-mail do Stremio',
  'password': 'senha',
  '{imported} of {received} addon(s) from your account imported.':
    '{imported} de {received} addon(s) da sua conta importado(s).',
  'Imported:': 'Vieram:',
  'Could not import {count}:': 'Não deu para importar {count}:',
  'The account returned no addons. If you installed one in the Stremio app while signed out, the collection remains only on that device and is not uploaded to your account.':
    'A conta respondeu sem nenhum addon. Se você instalou pelo app do Stremio sem estar logado, a coleção fica só naquele aparelho e não sobe para a conta.',
  'What the Stremio API returned ({count})': 'O que a API do Stremio respondeu ({count})',
  'This is your account collection with no filters. If an addon you installed in Stremio is not listed here, it never reached your account — usually because the app was signed out when you added it, or Stremio has not uploaded the change yet.':
    'Esta é a coleção da sua conta, sem filtro nenhum. Se um addon que você instalou no Stremio não estiver nesta lista, ele não chegou à conta — normalmente porque o app estava deslogado quando você o adicionou, ou o Stremio ainda não subiu a alteração.',
  'Or paste an addon URL': 'Ou cole a URL de um addon',
  'https://example.strem.fun/manifest.json': 'https://exemplo.strem.fun/manifest.json',
  'Reading…': 'Lendo…',
  'Install': 'Instalar',
  'Recommended starters': 'Padrão para começar',
  'configure': 'configurar',
  '{name} installed.': '{name} instalado.',
  'Installed': 'Instalados',
  'No addons yet. Start with the suggestions below.':
    'Nenhum addon ainda. Comece pelas sugestões abaixo.',
  'Configure': 'Configurar',
  'Remove': 'Remover',
  'Getting started': 'Para começar',
  'configuration required': 'precisa configurar',
  'Verified:': 'Verificado:',
  'Open configuration': 'Abrir configuração',
  'How playback works here': 'Como a reprodução funciona aqui',
  'This page uses the browser video element, so it can only play a direct HTTPS link. That is exactly what a torrent addon returns when configured with debrid: the service has already downloaded the file and serves it over HTTP.':
    'O player desta página é o <video> do navegador, então ele só toca o que chegar como link HTTPS direto. É exatamente o que um addon de torrent devolve quando configurado com debrid: o serviço já baixou o arquivo e serve por HTTP.',
  'Streams returned as infoHash appear in the list but are marked — browsers do not speak BitTorrent. For those, the button copies the magnet link so you can open it wherever you prefer.':
    'Streams que chegam como infoHash aparecem na lista, mas marcados — nenhum navegador fala BitTorrent. Para esses, o botão copia o magnet para você abrir onde preferir.',
  'Combines several stream addons, removes duplicates and reorders the results. A unique manifest URL is generated for each user during configuration.':
    'Junta vários addons de fontes num só, deduplica e reordena os resultados. A URL do manifest é gerada por usuário na configuração.',
  'only works with the generated URL': 'só funciona pela URL gerada',
  'Subtitles in dozens of languages, already indexed by IMDb ID.':
    'Legendas em dezenas de idiomas, já indexadas por IMDb ID.',
  'Searches public indexers. Configure it with your debrid key (Real-Debrid, AllDebrid, Premiumize) to receive direct HTTPS links — without debrid it returns torrents, which browsers cannot play.':
    'Busca em indexadores públicos. Configure com sua chave de debrid (Real-Debrid, AllDebrid, Premiumize) para receber links HTTPS diretos — sem debrid ele devolve torrents, que o navegador não reproduz.',
  'returns torrents when not configured': 'sem configurar, devolve torrents',
  'Aggregates several indexers and has its own catalogs, with debrid support. Accepts IMDb, TMDB and TVDB IDs.':
    'Agrega vários indexadores e tem catálogos próprios, com suporte a debrid. Aceita IDs de IMDb, TMDB e TVDB.',
  'returns an empty list when not configured': 'sem configurar, responde lista vazia',
  'A fast indexer designed for debrid. Returns a direct link as soon as the service has the file cached.':
    'Indexador rápido, pensado para debrid. Devolve link direto assim que o serviço tem o arquivo em cache.',
  'returns 403 when not configured': 'sem configurar, responde 403',
  '{name} does not declare streams or subtitles, so the player will not query it. If it requires configuration, install it using the URL generated at /configure.':
    '{name} não declara fontes nem legendas, então o player não vai consultá-lo. Se ele exige configuração, instale pela URL gerada em /configure.',

  'result': 'resultado',
  'results': 'resultados',
  'list': 'lista',
  'lists': 'listas',
  'title': 'título',
  'titles': 'títulos',
  'Search by title or theme (zombie, time travel…)':
    'Buscar por título ou tema (zombie, viagem no tempo…)',
  'Search by title or keyword': 'Buscar por título ou palavra-chave',
  'Filter by genre': 'Filtrar por gênero',
  'Clear': 'Limpar',
  'Done': 'Concluir',
  'Edit lists': 'Editar listas',
  'Media type': 'Tipo de mídia',
  'All': 'Tudo',
  'Movies': 'Filmes',
  'Shows': 'Séries',
  'Also searching for the theme': 'Também buscando pelo tema',
  'Series': 'Série',
  'Movie': 'Filme',
  'Nothing found for {label}': 'Nada encontrado para {label}',
  'Try another term or genre, or reset the filter to “All”.':
    'Tente outro termo, outro gênero, ou volte o filtro para “Tudo”.',
  'Could not load your lists': 'Não foi possível carregar suas listas',
  'Check your connection, or sign in again if the API key changed.':
    'Verifique sua conexão, ou entre de novo se a chave da API mudou.',
  'Sign in with another key': 'Entrar com outra chave',
  'Straight from your mdblist watchlist.': 'Direto da sua watchlist no mdblist.',
  'Straight from your mdblist collection.': 'Direto da sua coleção no mdblist.',
  'No lists match the filter': 'Nenhuma lista corresponde ao filtro',
  'Switch back to “All” to see all your lists.': 'Volte para “Tudo” para ver todas as suas listas.',
  'Your account has no lists yet': 'Sua conta ainda não tem listas',
  'Create one on': 'Crie uma no',
  'and it will appear here.': 'e ela aparece aqui.',
  '“{query}” in {genre}, in your lists': '“{query}” em {genre}, nas suas listas',
  '{genre}, in your lists': '{genre}, nas suas listas',
  '“{query}” in the TMDB catalog': '“{query}” no catálogo do TMDB',
  'Collection': 'Coleção',
  'Watchlist': 'Lista para assistir',
  'Untitled': 'Sem título',

  'Featured from your collection': 'Em destaque na sua coleção',
  'View details': 'Ver detalhes',
  'Surprise me': 'Surpreenda-me',
  'Continue watching': 'Continuar assistindo',
  'Pick up where you left off — the position comes from mdblist, so it works on every device.':
    'De onde você parou — o ponto vem do mdblist, então vale em qualquer aparelho.',
  'Remove {title} from continue watching': 'Remover {title} de continuar assistindo',
  '{progress}% watched': '{progress}% assistido',
  'Recently watched': 'Assistidos recentemente',
  'Straight from your mdblist history.': 'Direto do seu histórico no mdblist.',
  'Because you watched': 'Porque você assistiu',
  'A random selection from your last 45 watched titles.':
    'Um sorteio no seu histórico dos últimos 45 títulos.',
  'Based on the last 5 titles you marked as watched.':
    'A partir dos 5 últimos títulos que você marcou como vistos.',
  'Back to most recent': 'Voltar aos mais recentes',
  'More suggestions': 'Outras sugestões',
  'Because you watched {title}': 'Porque você assistiu {title}',

  'Row name': 'Nome da linha',
  'Addon catalog.': 'Catálogo de addon.',
  'Move up': 'Mover para cima',
  'Move down': 'Mover para baixo',
  'Rename': 'Renomear',
  'Remove {name} from the home page': 'Excluir {name} da home',
  'Confirm removal': 'Confirmar exclusão',
  'This only removes the row from here — the addon remains installed.':
    'Só remove esta linha daqui — o addon continua instalado.',
  'from the home page?': 'da home?',
  'Cancel': 'Cancelar',
  'This catalog did not return any titles.': 'Este catálogo não devolveu nenhum título.',
  'This only removes the row from here — your mdblist account is not affected.':
    'Só remove esta linha daqui — sua conta no mdblist não é afetada.',
  'List name': 'Nome da lista',
  'Move list up': 'Mover lista para cima',
  'Move list down': 'Mover lista para baixo',
  'Rename list': 'Renomear lista',
  'Remove list from the home page': 'Excluir lista da home',
  'Remove {name} from the home page?': 'Excluir {name} da home?',
  'This only removes it from here — your mdblist account is not affected.':
    'Só remove daqui — sua conta no mdblist não é afetada.',
  'Mixed': 'Misto',
  'dynamic': 'dinâmica',
  'Previous': 'Anterior',
  'Next': 'Próximo',
  'No items in this list.': 'Nenhum item nesta lista.',
  'Load more': 'Carregar mais',
  'IMDb rating': 'Nota IMDb',
  'Watch': 'Assistir',
  'Select source': 'Selecionar fonte',
  'Episode details': 'Detalhes do episódio',
  'Season {season} · Episode {episode}': 'Temporada {season} · Episódio {episode}',
  'No synopsis is available for this episode.': 'Sinopse indisponível para este episódio.',
  'Trailer': 'Trailer',
  'More details': 'Mais detalhes',
  'Main navigation': 'Navegação principal',
  'Home': 'Início',
  'Search': 'Buscar',

  'Title not found': 'Título não encontrado',
  'TMDB returned no data for this ID.': 'O TMDB não retornou dados para este id.',
  'Back': 'Voltar',
  'In watchlist': 'Na watchlist',
  'Remove from watchlist': 'Remover da watchlist',
  'In collection': 'Na coleção',
  'Remove from collection': 'Remover da coleção',
  'Mark as watched': 'Marcar como assistido',
  'Watched': 'Assistido',
  'Mark as unwatched': 'Desmarcar como assistido',
  'Clear progress': 'Resetar progresso',
  'Could not clear playback progress.': 'Não foi possível resetar o progresso.',
  'Ratings': 'Notas',
  'Overview': 'Sinopse',
  'Episodes': 'Episódios',
  'Episodes watched in this season': 'Episódios assistidos nesta temporada',
  'Dim unwatched': 'Escurecer não assistidos',
  'Dim the still of every episode not yet watched': 'Escurece a imagem de todo episódio ainda não assistido',
  'TMDB has no episodes listed for this season.':
    'O TMDB não tem episódios cadastrados para esta temporada.',
  'Cast': 'Elenco',
  'View {name} biography': 'Ver biografia de {name}',
  'TMDB has no cast listed for this title.': 'O TMDB não tem elenco cadastrado para este título.',
  'Mirrored by mdblist': 'Espelhada pelo mdblist',
  'Contains spoilers — click to reveal': 'Contém spoiler — clique para revelar',
  'Show less': 'Mostrar menos',
  'Read all': 'Ler tudo',
  'View all {count} reviews': 'Ver todas as {count} reviews',
  'No reviews found for this title.': 'Nenhuma review encontrada para este título.',
  'You may also like': 'Você também pode gostar',
  'Technical details': 'Ficha técnica',
  'Status': 'Status',
  'Released': 'Lançado',
  'Returning Series': 'Série em exibição',
  'Ended': 'Encerrada',
  'Canceled': 'Cancelada',
  'In Production': 'Em produção',
  'Planned': 'Planejado',
  'Post Production': 'Pós-produção',
  'Pilot': 'Piloto',
  'Original title': 'Título original',
  'Certification': 'Classificação',
  'Director': 'Direção',
  'Writing': 'Roteiro',
  'Production': 'Produção',
  'Languages': 'Idiomas',
  'Country': 'País',
  'Budget': 'Orçamento',
  'Revenue': 'Bilheteria',
  'Awards': 'Prêmios',
  'Release': 'Lançamento',
  'Identifiers': 'Identificadores',
  '{count} season': '{count} temporada',
  '{count} seasons': '{count} temporadas',
  'Could not save to mdblist. Library actions require the proxy — see the README.':
    'Não foi possível gravar no mdblist. As ações de biblioteca precisam do proxy — veja o README.',
  'Anonymous': 'Anônimo',
  'TMDB user': 'Usuário TMDB',
  'No ratings available for this title.': 'Nenhuma nota disponível para este título.',
  'votes': 'votos',
  'RT Audience': 'RT Público',

  'Close': 'Fechar',
  'Born': 'Nascimento',
  'Died': 'Falecimento',
  'Place': 'Local',
  '{count} years old': '{count} anos',
  'Biography': 'Biografia',
  'Read the full article on Wikipedia ↗': 'Ler o artigo completo na Wikipedia ↗',
  'No biography found on Wikipedia or TMDB.':
    'Nenhuma biografia encontrada na Wikipedia nem no TMDB.',
  'Known for': 'Mais conhecido por',

  'Info': 'Ficha',
  'Subtitles': 'Legendas',
  'Subtitle': 'Legenda',
  'Resumed from {point}% — the position came from mdblist.':
    'Retomado de {point}% — o ponto veio do mdblist.',
  'Preparing playback…': 'Preparando a reprodução…',
  'Up to 16 sources at once · {attempt} of {count} started':
    'Até 16 fontes ao mesmo tempo · {attempt} de {count} iniciadas',
  'Choose a source': 'Escolha uma fonte',
  'Your debrid provider is rate-limiting requests.':
    'Seu provedor debrid está limitando as requisições.',
  'Several sources returned a warning instead of the movie. Every other source was also tested before stopping.':
    'Várias fontes responderam com um aviso no lugar do filme. Todas as demais também foram testadas antes de encerrar.',
  'No source could play this title.': 'Nenhuma fonte conseguiu reproduzir.',
  'I tested all {count} available links, up to 16 at a time. The addon usually has expired links — reconfiguring its debrid setup fixes it in most cases.':
    'Testei os {count} links disponíveis, até 16 por vez. Costuma ser o addon com links vencidos — reconfigurar o debrid dele resolve na maioria das vezes.',
  'The available link did not open. Try again or check your addons.':
    'O link disponível não abriu. Tente de novo, ou verifique seus addons.',
  'Try again': 'Tentar de novo',
  'Choose a source manually': 'Escolher fonte manualmente',
  'View addons': 'Ver addons',
  'Looking for sources…': 'Procurando fontes…',
  'This title has no IMDb ID.': 'Este título não tem IMDb ID.',
  'Addons are indexed by IMDb, so they cannot be queried here.':
    'Os addons são indexados por IMDb, então não há como consultá-los aqui.',
  'No addons installed.': 'Nenhum addon instalado.',
  'Streams and subtitles come from addons.': 'É de um addon que saem as fontes e as legendas.',
  'Install addons': 'Instalar addons',
  'None of the installed addons provides streams.':
    'Nenhum addon instalado serve fontes.',
  'Installed now:': 'Instalado hoje:',
  'none declares the stream resource for': 'nenhum deles declara o recurso stream para',
  'A subtitle addon, for example, only returns subtitles.':
    'Um addon de legendas, por exemplo, só responde legenda.',
  'Installed now: {names} — none declares the stream resource for {kind}. A subtitle addon, for example, only returns subtitles.':
    'Instalado hoje: {names} — nenhum deles declara o recurso stream para {kind}. Um addon de legendas, por exemplo, só responde legenda.',
  'movies': 'filmes',
  'shows': 'séries',
  'Add a stream addon': 'Adicionar um addon de fontes',
  'The queried addon failed': 'O addon consultado falhou',
  'All addons failed': 'Todos os addons falharam',
  'I queried one addon and it did not respond. The addon may be offline, or a configured URL may have expired — reinstall it from its configuration page.':
    'Consultei 1, e ele não respondeu. Pode ser o addon fora do ar, ou uma URL configurada que expirou — reinstale a partir da página de configuração dele.',
  'I queried {count} addons and none responded. An addon may be offline, or a configured URL may have expired — reinstall it from its configuration page.':
    'Consultei {count}, e nenhum respondeu. Pode ser o addon fora do ar, ou uma URL configurada que expirou — reinstale a partir da página de configuração dele.',
  'Nothing for this title.': 'Nada para este título.',
  '{queried} addon(s) queried': '{queried} addon(s) consultado(s)',
  '({failed} failed)': '({failed} falhou/falharam)',
  'and none has {item} in a playable format.': 'e nenhum tem {item} em um formato reproduzível.',
  'this episode': 'este episódio',
  'this movie': 'este filme',
  'Season': 'Temporada',
  'Episode': 'Episódio',
  'downloading…': 'baixando…',
  'No subtitles': 'Sem legenda',

  'Loading {item}': 'Carregando {item}',
  'video': 'vídeo',
  'Loading': 'Carregando',
  'Reconnecting…': 'Reconectando…',
  'Play': 'Reproduzir',
  'Progress': 'Progresso',
  'Pause': 'Pausar',
  'Unmute': 'Ativar som',
  'Mute': 'Silenciar',
  'Sources': 'Fontes',
  'Downloading…': 'Baixando…',
  'No subtitles found.': 'Nenhuma legenda encontrada.',
  'Sync': 'Sincronia',
  'Subtitle sync': 'Sincronia da legenda',
  'Reset sync': 'Repor sincronia',
  'Font': 'Fonte',
  'Color': 'Cor',
  'Audio': 'Áudio',
  'Settings': 'Configurações',
  'Speed': 'Velocidade',
  'Normal': 'Normal',
  'Fit aspect ratio': 'Ajustar aspecto',
  'Stretch video': 'Esticar vídeo',
  'Exit fullscreen': 'Sair da tela cheia',
  'Fullscreen': 'Tela cheia',
  'Track {number}': 'Faixa {number}',
  'The browser blocked the subtitle download — this may be a connection problem or a restriction on the hosting server. Try another subtitle from the list.':
    'O navegador bloqueou o download da legenda — pode ser falta de conexão ou uma restrição do servidor que a hospeda. Tente outra legenda da lista.',
  'The server refused the subtitle download (HTTP {status}). Try another subtitle from the list.':
    'O servidor recusou o download da legenda (HTTP {status}). Tente outra legenda da lista.',
  'The subtitle was downloaded, but the file could not be read. Try another subtitle from the list.':
    'A legenda foi baixada, mas o arquivo não pôde ser lido. Tente outra legenda da lista.',
  'Browser-incompatible container (such as MKV). It will probably only play in an external player.':
    'Container que o navegador não abre (MKV e afins). Provavelmente só toca em player externo.',
  'HLS stream — only plays natively in Safari.': 'Stream HLS — só toca nativamente no Safari.',
  'The addon marked this stream as browser-incompatible.':
    'O addon marcou este stream como não compatível com navegador.',

  'Serif': 'Serifada',
  'Rounded': 'Arredondada',
  'Monospace': 'Monoespaçada',
  'Yellow': 'Amarelo',
  'White': 'Branco',
  'Red': 'Vermelho',
  'Blue': 'Azul',
  'Portuguese': 'Português',
  'Portuguese (Brazil)': 'Português (BR)',
  'English': 'Inglês',
  'Spanish': 'Espanhol',
  'French': 'Francês',
  'German': 'Alemão',
  'Italian': 'Italiano',
  'Japanese': 'Japonês',
  'Korean': 'Coreano',
  'Chinese': 'Chinês',
  'Russian': 'Russo',
  'Arabic': 'Árabe',
  'Dutch': 'Holandês',
  'Swedish': 'Sueco',
  'Norwegian': 'Norueguês',
  'Danish': 'Dinamarquês',
  'Finnish': 'Finlandês',
  'Polish': 'Polonês',
  'Turkish': 'Turco',
  'Hindi': 'Hindi',
  'Hebrew': 'Hebraico',
  'Greek': 'Grego',
  'Croatian': 'Croata',
  'Serbian': 'Sérvio',
  'Bosnian': 'Bósnio',
  'Unknown': 'Desconhecido',

  'No Google account connected.': 'Nenhuma conta Google conectada.',
  'Could not load Google Identity Services.':
    'Não foi possível carregar o Google Identity Services.',
  'Google Identity Services is unavailable.': 'Google Identity Services indisponível.',
  'Could not connect to Google.': 'Não foi possível conectar com o Google.',
  'OMDb returned no data.': 'OMDb não retornou dados.',
  'OMDb is unavailable (daily quota or network).': 'OMDb indisponível (cota diária ou rede).',
  'The Stremio API did not return a session.': 'A API do Stremio não devolveu uma sessão.',
  'Your Stremio session expired. Sign in again.': 'Sua sessão do Stremio expirou. Entre novamente.',
  'Could not reach the Stremio API.': 'Não foi possível falar com a API do Stremio.',
  'No Stremio account exists with that email.': 'Não existe conta Stremio com esse e-mail.',
  'Stremio session expired. Sign in again.': 'Sessão do Stremio expirada. Entre novamente.',
  'Sign in to your Stremio account first.': 'Entre na sua conta Stremio primeiro.',
  'Unexpected response from the Stremio API.': 'Resposta inesperada da API do Stremio.',
  'Incorrect password.': 'Senha incorreta.',
  'Invalid URL. Paste the address of the addon manifest.json.':
    'URL inválida. Cole o endereço do manifest.json do addon.',
  'Could not read the manifest. Check the URL and make sure the addon allows browser CORS requests.':
    'Não foi possível ler o manifest. Confira a URL — e note que o addon precisa liberar CORS para ser usado a partir do navegador.',
  'The address responded, but it is not a Stremio addon manifest. Many addons generate a URL for each user on their configuration page — paste that URL here, not the website address.':
    'O endereço respondeu, mas não é um manifest de addon do Stremio. Vários addons geram uma URL própria para cada usuário na página de configuração — é essa que precisa ser colada aqui, não o endereço do site.',
  'the account did not save this addon URL': 'a conta não guardou a URL deste addon',
  'the manifest had no ID': 'o manifest veio sem id',
  'URL could not be parsed': 'URL que não dá para interpretar',
  'unnamed addon': 'addon sem nome',
  '(unnamed)': '(sem nome)',
  '(no URL)': '(sem URL)',
  'The cloud returned no addons, so the local list was left unchanged. Use “Upload” first on the device with the correct addons.':
    'A nuvem não devolveu nenhum addon, então não mexi nos daqui. Use “Enviar” no aparelho que tem os addons certos primeiro.',
  'The cloud returned no list preferences, so the local preferences were left unchanged. Use “Upload” first on the device with the correct lists.':
    'A nuvem não devolveu nenhuma preferência de lista, então não mexi nas daqui. Use “Enviar” no aparelho que tem as listas certas primeiro.',
  'Could not reach Firebase. Check your connection.':
    'Não foi possível falar com o Firebase. Verifique sua conexão.',
  'Connect your Google account first.': 'Conecte sua conta Google primeiro.',
  'scrobble/{action} returned {status}: {detail}':
    'scrobble/{action} respondeu {status}: {detail}',
  'no response body': 'sem corpo',

  'Action': 'Ação',
  'Adventure': 'Aventura',
  'Animation': 'Animação',
  'Comedy': 'Comédia',
  'Crime': 'Crime',
  'Documentary': 'Documentário',
  'Drama': 'Drama',
  'Family': 'Família',
  'Fantasy': 'Fantasia',
  'History': 'História',
  'Horror': 'Terror',
  'Music': 'Música',
  'Mystery': 'Mistério',
  'Romance': 'Romance',
  'Science Fiction': 'Ficção científica',
  'TV Movie': 'Cinema TV',
  'Thriller': 'Suspense',
  'War': 'Guerra',
  'Western': 'Faroeste',
  'Action & Adventure': 'Ação e aventura',
  'Kids': 'Infantil',
  'News': 'Notícias',
  'Reality': 'Reality show',
  'Sci-Fi & Fantasy': 'Ficção científica e fantasia',
  'Soap': 'Novela',
  'Talk': 'Talk show',
  'War & Politics': 'Guerra e política',
};

const GENRES: Record<string, string> = {
  action: 'Action',
  adventure: 'Adventure',
  animation: 'Animation',
  comedy: 'Comedy',
  crime: 'Crime',
  documentary: 'Documentary',
  drama: 'Drama',
  family: 'Family',
  fantasy: 'Fantasy',
  history: 'History',
  horror: 'Horror',
  music: 'Music',
  mystery: 'Mystery',
  romance: 'Romance',
  'science-fiction': 'Science Fiction',
  'science fiction': 'Science Fiction',
  'tv-movie': 'TV Movie',
  thriller: 'Thriller',
  war: 'War',
  western: 'Western',
  'action-adventure': 'Action & Adventure',
  kids: 'Kids',
  news: 'News',
  reality: 'Reality',
  'sci-fi-fantasy': 'Sci-Fi & Fantasy',
  soap: 'Soap',
  talk: 'Talk',
  'war-politics': 'War & Politics',
};

export function currentLanguage(): AppLanguage {
  if (typeof localStorage === 'undefined') return 'en';
  return localStorage.getItem(STORAGE_KEY) === 'pt' ? 'pt' : 'en';
}

export function activeLocale(): string {
  return currentLanguage() === 'pt' ? 'pt-BR' : 'en-US';
}

export function tmdbLanguage(): string {
  return activeLocale();
}

export function wikipediaLanguage(): AppLanguage {
  return currentLanguage();
}

export function translate(key: string, params?: Record<string, unknown>): string {
  let value = currentLanguage() === 'pt' ? PT[key] ?? key : key;
  if (!params) return value;

  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}

export function translateGenre(genre: string): string {
  const normalized = genre.trim().toLowerCase().replaceAll('&', '').replace(/\s+/g, '-');
  const english = GENRES[normalized] ?? GENRES[genre.trim().toLowerCase()] ?? genre;
  return translate(english);
}

@Pipe({ name: 'i18n', standalone: true })
export class I18nPipe implements PipeTransform {
  transform(key: string, params?: Record<string, unknown>): string {
    return translate(key, params);
  }
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly selected = signal<AppLanguage>(currentLanguage());

  readonly language = this.selected.asReadonly();
  readonly locale = computed(() => (this.selected() === 'pt' ? 'pt-BR' : 'en-US'));

  constructor() {
    if (typeof document !== 'undefined') document.documentElement.lang = this.locale();
  }

  t(key: string, params?: Record<string, unknown>): string {
    return translate(key, params);
  }

  setLanguage(language: AppLanguage): void {
    if (language !== 'en' && language !== 'pt') return;
    localStorage.setItem(STORAGE_KEY, language);
    this.selected.set(language);
    document.documentElement.lang = language === 'pt' ? 'pt-BR' : 'en-US';
    location.reload();
  }
}
