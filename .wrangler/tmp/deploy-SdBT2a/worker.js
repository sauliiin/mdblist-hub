// worker.js
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
