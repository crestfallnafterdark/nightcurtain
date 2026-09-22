if (typeof window !== 'undefined') {
  const windowWithNodeShims = /** @type {Window & typeof globalThis & { global: Window | undefined, process: { env: Record<string, string>, platform: string, version: string, arch: string } | undefined }} */ (window);
  windowWithNodeShims.global = window;
  windowWithNodeShims.process = windowWithNodeShims.process || { env: {}, platform: 'browser', version: '', arch: 'x64' };
}
if (typeof globalThis !== 'undefined') {
  globalThis.process = globalThis.process || { env: {}, platform: 'browser', version: '', arch: 'x64' };
}

import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const target = document.getElementById('app');
if (!target) {
  throw new Error('Missing required #app mount target');
}

const app = mount(App, {
  target,
})

export default app
