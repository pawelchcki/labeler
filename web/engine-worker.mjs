import { createEngine } from './engine.mjs';

const engine = fetch(new URL('./pkg/labeler.wasm', import.meta.url))
  .then(response => {
    if (!response.ok) throw new Error('The label engine could not load. Refresh the page to retry.');
    return response.arrayBuffer();
  }).then(createEngine);

engine.then(() => postMessage({ ready: true }), error => postMessage({ fatal: error.message }));
self.onmessage = async ({ data: { id, request } }) => {
  try {
    const result = (await engine).dispatch(request);
    postMessage({ id, result });
  } catch (error) {
    postMessage({ id, error: error.message });
  }
};
