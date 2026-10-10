import { defineConfig } from "vite";
export default defineConfig({ root: "dots-phone-g2", base: "./", server: { host: "0.0.0.0", port: 5177, strictPort: true },
  build: { target: "es2022", outDir: "../dist-dots-phone-g2", emptyOutDir: true } });
