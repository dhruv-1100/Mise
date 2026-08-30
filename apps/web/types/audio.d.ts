/**
 * Safari exposes AudioContext under a prefix. Declared rather than cast at the
 * call site, because `no-explicit-any` is an error in this repo and a cast
 * would be the only other way through.
 */
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
