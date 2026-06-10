import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vercel serves the build at the domain root, so base "/" is correct.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
