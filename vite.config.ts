import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page build: one HTML entry per Tauri window label.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        index: "index.html",
        notch: "notch.html",
        wallpaper: "wallpaper.html",
        clock: "clock.html",
        todo: "todo.html",
        start: "start.html",
      },
    },
  },
});
