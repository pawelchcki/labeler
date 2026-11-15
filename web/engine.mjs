const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The same dispatch entry point used by the Android JNI bridge. */
export async function createEngine(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { memory, labeler_alloc, labeler_call, labeler_free } = instance.exports;
  return {
    dispatch(request) {
      const input = encoder.encode(JSON.stringify(request));
      const pointer = labeler_alloc(input.length);
      let output;
      try {
        new Uint8Array(memory.buffer, pointer, input.length).set(input);
        output = labeler_call(pointer, input.length);
        const length = new DataView(memory.buffer).getUint32(output, true);
        try {
          const result = JSON.parse(decoder.decode(new Uint8Array(memory.buffer, output + 4, length)));
          if (!result.ok) throw new Error(result.error || 'The label engine could not complete this request.');
          return result;
        } finally {
          labeler_free(output, length + 4);
        }
      } finally {
        labeler_free(pointer, input.length);
      }
    },
  };
}
