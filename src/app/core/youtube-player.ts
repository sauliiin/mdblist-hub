/**
 * Minimal surface of the YouTube IFrame Player API this app actually calls —
 * not in any stdlib types, and the full `@types/youtube` package is a lot of
 * surface for three methods.
 */
export interface YouTubePlayer {
  mute(): void;
  playVideo(): void;
  destroy(): void;
}

export interface YouTubePlayerOptions {
  videoId: string;
  width?: string | number;
  height?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: { target: YouTubePlayer }) => void;
  };
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<void> | null = null;

/**
 * Loads the IFrame Player API script once, however many previews end up
 * wanting it. Google's own async-loading recipe: the script calls a global
 * callback once `window.YT` is actually populated, rather than firing its
 * own `load` event at a useful time.
 */
export function loadYouTubeIframeApi(): Promise<void> {
  if (apiReady) return apiReady;

  apiReady = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });

  return apiReady;
}
