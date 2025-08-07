export default {
  build: {
    lib: {
      entry: "src/recorder.js",
      name: "rrwebClient",
      formats: ["iife"],
      fileName: () => "recorder.min.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    target: "es2018",
  },
};
