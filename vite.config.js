import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // maplibre-gl resolves its worker relative to its own module URL, which no
  // longer exists once the app is bundled. MapView hands it an explicit,
  // Vite-emitted worker URL instead; this keeps that worker's own imports intact.
  worker: { format: "es" },
});
