import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page build: one HTML entry per overlay window.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2021",
    rollupOptions: {
      input: {
        index: "index.html",
        wallpaper: "wallpaper.html",
        notch: "notch.html",
        clock: "clock.html",
        todo: "todo.html",
        statusbar: "statusbar.html",
        edgelight: "edgelight.html",
      },
    },
  },
});
