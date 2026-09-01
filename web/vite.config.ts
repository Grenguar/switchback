import { defineConfig } from "vite";

// Local development is launched from web/, while the project-level .env stays
// at the repository root. Netlify supplies the same variables at build time.
export default defineConfig({ envDir: ".." });
