import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import localePt from '@angular/common/locales/pt';
import {
  ApplicationConfig, LOCALE_ID, provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter, withComponentInputBinding, withInMemoryScrolling,
} from '@angular/router';

import { routes } from './app.routes';
import { httpCacheInterceptor } from './core/http-cache.interceptor';

registerLocaleData(localePt, 'pt-BR');

export const appConfig: ApplicationConfig = {
  providers: [
    /*
     * `zone.js` is not a dependency of this project, so the app was already
     * running without it — but implicitly. Declaring it makes the zoneless
     * scheduler explicit, which is what coalesces signal updates into one
     * change-detection pass per frame instead of leaving the framework to
     * infer a strategy.
     */
    provideZonelessChangeDetection(),
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
