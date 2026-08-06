import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

// Cache de imagens em disco (posters/backdrops), via public/image-sw.js.
// Fora do dev para o ng serve nunca servir artwork velho durante o trabalho.
if (!isDevMode() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('image-sw.js').catch(() => {});
}
