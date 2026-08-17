export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Proxy para a API do mdblist
    if (url.pathname.startsWith("/mdblist-api/")) {
      const targetUrl = "https://api.mdblist.com/" + url.pathname.slice("/mdblist-api/".length) + url.search;
      
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual"
      });

      return fetch(newRequest);
    }
    
    // Proxy para a API do opensubtitles
    if (url.pathname.startsWith("/opensubtitles-api/")) {
      const targetUrl = "https://api.opensubtitles.com/api/v1/" + url.pathname.slice("/opensubtitles-api/".length) + url.search;
      
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual"
      });

      return fetch(newRequest);
    }

    // Serve all other requests from the static assets
    return env.ASSETS.fetch(request);
  }
};
