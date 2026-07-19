import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base './' so the built files work from file:// (Electron) and inside Capacitor
export default defineConfig({
  plugins: [react()],
  base: "./",
});
