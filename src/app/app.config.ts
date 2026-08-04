import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import localePt from '@angular/common/locales/pt';
import { ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter, withComponentInputBinding, withInMemoryScrolling,
} from '@angular/router';

import { routes } from './app.routes';
import { httpCacheInterceptor } from './core/http-cache.interceptor';

registerLocaleData(localePt, 'pt-BR');

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      // Route params arrive as component inputs on the detail page.
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
    ),
    provideHttpClient(withInterceptors([httpCacheInterceptor])),
    { provide: LOCALE_ID, useValue: 'pt-BR' },
  ],
};
